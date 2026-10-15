import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { Snapshot } from "@typescript/native/sync";
import { nodeHost } from "../bin/node-host.ts";
import { TSCONFIG, writeProject } from "../__test-helpers__/projects.ts";
import {
  readEmitterRun,
  runAnalysis,
  runBaselineWrite,
  runProjects,
  runRoots,
  runSweep,
  unansweredCounts,
  DETECTORS,
  type RunAnalysis,
  type RunSweep,
} from "./analysis.ts";
import type { Inputs } from "./config.ts";
import type { Detector, Detectors } from "./exempt.ts";
import type { TSExemptionClass } from "./exempt-classes.ts";
import { DiscoveryError } from "./discover.ts";
import type { Host } from "./host.ts";
import { Unanswerable } from "./query.ts";
import { resolve } from "./resolve.ts";
import { scopeForDir } from "./scope.ts";
import { SetupError } from "./setup-failure.ts";
import { openEngine, type Engine } from "./session.ts";

/** Writes one tree for the case, removed when the case ends. */
function written(files: Readonly<Record<string, string>>): string {
  const root = writeProject(files);
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** The configuration and provenance a repository document resolves to, beside any other input. */
function configured(repository: unknown, inputs: Inputs = {}): ReturnType<typeof resolve> {
  return resolve({
    repository: JSON.stringify(repository),
    repositoryLabel: "deadset.json",
    ...inputs,
  });
}

/** An application whose only entry is `src/main.ts`. */
const APPLICATION = { target: { kind: "application" }, ts: { entry_files: ["src/main.ts"] } };

const PRODUCTION = { production: true };

/** A compiler configuration holding the files its include names. */
function including(...include: readonly string[]): string {
  return TSCONFIG.replace('"**/*.ts"', include.map((one) => JSON.stringify(one)).join(", "));
}

/** An engine whose snapshot opens no project for one configuration file. */
function hiding(configFile: string): Engine {
  const real = openEngine({ collectTiming: false });
  return {
    ...real,
    createSnapshot: (...args) => {
      const snapshot = real.createSnapshot(...args);
      const short: Snapshot = Object.create(snapshot) as Snapshot;
      short.getProjects = () =>
        snapshot.getProjects().filter((project) => project.configFileName !== configFile);
      return short;
    },
  };
}

/**
 * An engine whose checker fails, as a server panic, every question about the name at one
 * of `sites`, each a file below the root and the text the name follows.
 */
function failingAt(
  root: string,
  files: Readonly<Record<string, string>>,
  sites: readonly (readonly [string, string])[],
): Engine {
  const real = openEngine({ collectTiming: false });
  // A location is a node's full start, before the space that leads it.
  const locations = sites.map(
    ([path, before]) =>
      `${join(root, path)}:${String((files[path] ?? "").indexOf(before) + before.length)}`,
  );
  return {
    ...real,
    ask: (accessor, asked, question) => {
      if (
        accessor === "getSymbolAtLocation" &&
        asked().some((location) => locations.includes(location))
      ) {
        throw new Error("panic: interface conversion: checker.TypeData is *checker.TypeReference");
      }
      return real.ask(accessor, asked, question);
    },
  };
}

/** A detector holding back each declaration of the project named, at its own site. */
function holding(detail: string, ...names: readonly string[]): Detector {
  return ({ held }) =>
    held.symbols
      .filter((symbol) => names.includes(symbol.name))
      .map((symbol) => ({ id: symbol.id, detail, site: symbol.position }));
}

/** The reference of every declaration one sweep names by its identifier, in order. */
function refsOf(swept: RunSweep, ids: readonly string[]): readonly string[] {
  return ids.map((id) => swept.matrix.union.symbols[swept.matrix.union.at(id)]?.ref ?? id);
}

describe("the projects a run composes", () => {
  it("are the ones the matrix declares, each named by its declared identifier", () => {
    // A derived run would open the second project too, so naming one configuration shows
    // the run reads the declared matrix.
    const root = writeProject({
      "tsconfig.json": TSCONFIG.replace('"**/*.ts"', '"src/**/*.ts"'),
      "src/main.ts": "export const value = 1;\n",
      "broken/tsconfig.json": TSCONFIG,
      "broken/broken.ts": "export const wrong: number = 'text';\n",
    });
    try {
      const { config, provenance } = resolve({
        repository: JSON.stringify({
          target: { kind: "application" },
          analysis: { configurations: [{ id: "app", project: "tsconfig.json" }] },
        }),
        repositoryLabel: "deadset.json",
      });
      const host = nodeHost();
      const scope = scopeForDir(host, root);
      const rooted = runRoots(
        openEngine({ collectTiming: false }),
        host,
        scope,
        config,
        provenance,
      );
      const swept = runSweep(openEngine({ collectTiming: false }), host, scope, config, {
        marked: [],
        mode: { production: true },
      });

      expect(rooted.configurations, "the root set's configurations").toEqual(["app"]);
      expect(swept.matrix.configurations, "the sweep's configurations").toEqual(["app"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skip the statement a type error is in and analyze every project", () => {
    const root = writeProject({
      "tsconfig.json": TSCONFIG.replace('"**/*.ts"', '"src/**/*.ts"'),
      "src/main.ts": "export const value = 1;\n",
      "broken/tsconfig.json": TSCONFIG,
      "broken/broken.ts": "export const wrong: number = 'text';\n",
    });
    try {
      const { config } = resolve({
        repository: JSON.stringify({
          target: { kind: "application" },
          analysis: {
            configurations: [
              { id: "app", project: "tsconfig.json" },
              { id: "broken", project: "broken/tsconfig.json" },
            ],
          },
        }),
        repositoryLabel: "deadset.json",
      });
      const host = nodeHost();
      const swept = runSweep(
        openEngine({ collectTiming: false }),
        host,
        scopeForDir(host, root),
        config,
        { marked: [], mode: { production: true } },
      );
      const dead = swept.sweep.candidates.map(
        (candidate) => swept.matrix.union.symbols[swept.matrix.union.at(candidate.id)]?.name,
      );

      expect(swept.matrix.configurations).toEqual(["app", "broken"]);
      expect(dead).toEqual(["value"]);
      expect(swept.skipped).toEqual([{ path: "broken/broken.ts", fromLine: 1, toLine: 1 }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("name the derived configurations the compiler could not read or load among those the run dropped", () => {
    const root = written({
      "tsconfig.json": including("src/**/*.ts"),
      "src/main.ts": "export const one = 1;\n",
      "broken/tsconfig.json": '{ "compilerOptions": ',
      "broken/broken.ts": "export const two = 2;\n",
      "unread/tsconfig.json": including("*.ts"),
      "unread/unread.ts": "export const three = 3;\n",
    });
    const host = nodeHost();
    const { config } = configured({ target: { kind: "application" } });
    const unread = join(root, "unread", "tsconfig.json");
    const real = openEngine({ collectTiming: false });
    const engine: Engine = {
      ...real,
      parseConfigFile: (configFile) => {
        if (configFile === unread) {
          throw new Error("the file is locked");
        }
        return real.parseConfigFile(configFile);
      },
    };

    const run = runProjects(engine, host, scopeForDir(host, root), config);

    expect(run.configurations).toEqual(["tsconfig.json"]);
    expect(run.notBuilt).toEqual([
      { id: "unread/tsconfig.json", configFile: unread, error: "the file is locked" },
      {
        id: "broken/tsconfig.json",
        configFile: join(root, "broken", "tsconfig.json"),
        error: "broken/tsconfig.json: TS1109: Expression expected.",
      },
    ]);
  });

  it("drop a derived configuration whose extends chain is circular and build one referencing it", () => {
    const root = written({
      "tsconfig.json": including("*.ts"),
      "main.ts": "export const one = 1;\n",
      "cycle/tsconfig.json": '{ "extends": "./a.json", "include": ["*.ts"] }\n',
      "cycle/a.json": '{ "extends": "./tsconfig.json" }\n',
      "cycle/main.ts": "export const two = 2;\n",
      "outer/tsconfig.json": '{ "extends": "../cycle/a.json", "include": ["*.ts"] }\n',
      "outer/main.ts": "export const three = 3;\n",
      "user/tsconfig.json": '{ "include": ["*.ts"], "references": [{ "path": "../cycle" }] }\n',
      "user/main.ts": "export const four = 4;\n",
    });
    const host = nodeHost();
    const { config } = configured({ target: { kind: "application" } });

    const run = runProjects(
      openEngine({ collectTiming: false }),
      host,
      scopeForDir(host, root),
      config,
    );

    expect(run.configurations).toEqual(["tsconfig.json", "user/tsconfig.json"]);
    expect(run.notBuilt.map((one) => one.id)).toEqual([
      "cycle/tsconfig.json",
      "outer/tsconfig.json",
    ]);
    for (const one of run.notBuilt) {
      expect(one.error, one.id).toMatch(
        /^TS18000: Circularity detected while resolving configuration/u,
      );
    }
  });

  it("fail naming the first derived configuration when none of them could be built", () => {
    const root = written({
      "app/broken/tsconfig.json": '{ "compilerOptions": ',
      "app/broken/broken.ts": "export const two = 2;\n",
    });
    const host = nodeHost();
    const { config } = configured({ target: { kind: "application" } });

    expect(() =>
      runProjects(
        openEngine({ collectTiming: false }),
        host,
        scopeForDir(host, join(root, "app")),
        config,
      ),
    ).toThrow(
      new DiscoveryError(
        "no configuration discovery derived could be built; broken/tsconfig.json: broken/tsconfig.json: TS1109: Expression expected.",
        [],
      ),
    );
  });

  it("drop a derived configuration the compiler opened no project for", () => {
    const root = written({
      "tsconfig.json": including("src/**/*.ts"),
      "src/main.ts": "export const one = 1;\n",
      "tools/tsconfig.json": including("*.ts"),
      "tools/tool.ts": "export const two = 2;\n",
    });
    const host = nodeHost();
    const { config } = configured({ target: { kind: "application" } });
    const hidden = join(root, "tools", "tsconfig.json");

    const run = runProjects(hiding(hidden), host, scopeForDir(host, root), config);

    expect(run.configurations).toEqual(["tsconfig.json"]);
    expect(run.notBuilt).toEqual([
      {
        id: "tools/tsconfig.json",
        configFile: hidden,
        error: "the compiler opened no project for the configuration",
      },
    ]);
  });

  it("fail where the compiler opened no project for a consumer's configuration", () => {
    const root = written({
      "target/tsconfig.json": TSCONFIG,
      "target/main.ts": "export const one = 1;\n",
      "consumer/tsconfig.json": TSCONFIG,
      "consumer/main.ts": 'import { one } from "../target/main.js";\n\nconsole.log(one);\n',
    });
    const host = nodeHost();
    const { config } = configured({ target: { kind: "library" } });
    const hidden = join(root, "consumer", "tsconfig.json");
    const scope = {
      target: { id: "", path: join(root, "target") },
      consumers: [{ id: "", path: join(root, "consumer") }],
    };

    expect(() => runProjects(hiding(hidden), host, scope, config)).toThrow(
      new DiscoveryError(`${hidden} opened no project`, []),
    );
  });

  it("are read for the nested packages their files sit in, in path order", () => {
    const root = written({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, module: "NodeNext", noEmit: true },
        files: ["pkgs/zeta/main.ts", "pkgs/alpha/main.ts"],
      }),
      "pkgs/zeta/package.json": '{ "name": "zeta" }\n',
      "pkgs/zeta/main.ts": "export const zeta = 1;\n",
      "pkgs/alpha/package.json": '{ "name": "alpha" }\n',
      "pkgs/alpha/main.ts": "export const alpha = 1;\n",
    });
    const host = nodeHost();
    const { config } = configured({ target: { kind: "application" } });

    const run = readEmitterRun(
      openEngine({ collectTiming: false }),
      host,
      scopeForDir(host, root),
      config,
      PRODUCTION,
      DETECTORS,
    );

    expect(run.nestedDirs).toEqual([join(root, "pkgs", "alpha"), join(root, "pkgs", "zeta")]);
    expect(run.memberDirs).toEqual([]);
  });
});

describe("the root set of a run", () => {
  it("orders the roots by site, then by what named them, each naming every configuration that holds it", () => {
    const root = written({
      "src/lib.ts": "export function shared(): number {\n  return 1;\n}\n",
      "src/a-entry.ts": 'export { shared } from "./lib.js";\n',
      "src/z-entry.ts": 'export { shared } from "./lib.js";\n',
      "one/tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, module: "NodeNext", noEmit: true },
        files: ["../src/z-entry.ts"],
      }),
    });
    const host = nodeHost();
    const { config, provenance } = configured({
      target: { kind: "application" },
      ts: { entry_files: ["src/a-entry.ts", "src/z-entry.ts"] },
      analysis: {
        configurations: [
          { id: "one", project: "one/tsconfig.json" },
          { id: "two", project: "tsconfig.json" },
        ],
      },
    });

    const rooted = runRoots(
      openEngine({ collectTiming: false }),
      host,
      scopeForDir(host, root),
      config,
      provenance,
    );

    expect(
      rooted.roots.map((one) => `${one.ref} ${one.source} ${one.configurations.join(",")}`),
    ).toEqual([
      "ts://./src/a-entry.ts# src/a-entry.ts two",
      "ts://./src/a-entry.ts#shared:alias src/a-entry.ts two",
      "ts://./src/lib.ts#shared src/a-entry.ts two",
      "ts://./src/lib.ts#shared src/z-entry.ts one,two",
      "ts://./src/z-entry.ts# src/z-entry.ts one,two",
      "ts://./src/z-entry.ts#shared:alias src/z-entry.ts one,two",
    ]);
  });

  it("reports a root a flag names and nothing holds at the conventional document", () => {
    const root = written({ "src/main.ts": "export const one = 1;\n" });
    const host: Host = { ...nodeHost(), workingDirectory: () => root };
    const { config, provenance } = configured(
      { target: { kind: "application" } },
      {
        flags: JSON.stringify({ "roots.patterns": ["ts://./src/main.ts#absent"] }),
        flagLabels: new Map([["roots.patterns", "--roots"]]),
      },
    );

    const rooted = runRoots(
      openEngine({ collectTiming: false }),
      host,
      scopeForDir(host, root),
      config,
      provenance,
    );

    expect(rooted.findings.map((one) => `${one.symbol.ref} ${one.position.path}`)).toEqual([
      "ts://./src/main.ts#absent deadset.json",
    ]);
  });
});

describe("the gap an unanswered question leaves", () => {
  const WORK = [
    "export function run(): number {",
    "  return helper();",
    "}",
    "function helper(): number {",
    "  return inner();",
    "}",
    "function inner(): number {",
    "  return 1;",
    "}",
    "export function deadCaller(): number {",
    "  return zed();",
    "}",
    "function zed(): number {",
    "  return 2;",
    "}",
    "export function unused(): number {",
    "  return 3;",
    "}",
    "export function other(): number {",
    "  return 4;",
    "}",
    "",
  ].join("\n");
  const FILES = {
    "src/main.ts": 'import { other, run } from "./work.js";\n\nconsole.log(run() + other());\n',
    "src/work.ts": WORK,
  };

  it("holds what an unanswered reference names, what makes it, and what only it keeps live", () => {
    const root = written(FILES);
    const host = nodeHost();
    const { config } = configured(APPLICATION);
    const engine = failingAt(root, FILES, [
      ["src/work.ts", "  return"],
      ["src/work.ts", "deadCaller(): number {\n  return"],
    ]);

    const swept = runSweep(engine, host, scopeForDir(host, root), config, {
      marked: [],
      mode: PRODUCTION,
    });

    expect(refsOf(swept, swept.heldByUnanswered)).toEqual([
      "ts://./src/work.ts#helper",
      "ts://./src/work.ts#zed",
      "ts://./src/work.ts#run",
      "ts://./src/work.ts#deadCaller",
      "ts://./src/work.ts#inner",
    ]);
    expect(
      refsOf(
        swept,
        swept.sweep.candidates.map((one) => one.id),
      ),
    ).toEqual(["ts://./src/work.ts#deadCaller", "ts://./src/work.ts#unused"]);
  });

  it("holds every declaration whose deprecation marker went unread", () => {
    const files = {
      "src/main.ts": 'import { old } from "./old.js";\n\nconsole.log(old());\n',
      "src/old.ts":
        "/** @deprecated Use another. */\nexport function old(): number {\n  return 1;\n}\n\nexport function other(): number {\n  return 2;\n}\n",
    };
    const root = written(files);
    const host = nodeHost();
    const { config } = configured(APPLICATION);
    const real = openEngine({ collectTiming: false });
    const engine: Engine = {
      ...real,
      ask: (accessor, asked, question) => {
        if (accessor === "getJsDocTags") {
          throw new Error(
            "panic: interface conversion: checker.TypeData is *checker.TypeReference",
          );
        }
        return real.ask(accessor, asked, question);
      },
    };

    const run = readEmitterRun(
      engine,
      host,
      scopeForDir(host, root),
      config,
      PRODUCTION,
      DETECTORS,
    );

    expect(run.unansweredHeld).toEqual(["src/old.ts:2:17", "src/old.ts:6:17"]);
  });
});

describe("the gap a detector that could not finish leaves", () => {
  it("holds what the stopped class holds back and what only that keeps live, beside what the records that hold keep", () => {
    const root = written({
      "src/main.ts": "console.log(1);\n",
      "src/held.ts": [
        "export function kept(): number {",
        "  return keptDep();",
        "}",
        "function keptDep(): number {",
        "  return 1;",
        "}",
        "export class Widget {",
        "  render(): number {",
        "    return paint();",
        "  }",
        "}",
        "function paint(): number {",
        "  return 2;",
        "}",
        "",
      ].join("\n"),
    });
    const host = nodeHost();
    const { config } = configured(APPLICATION);
    const detectors: Detectors = new Map<TSExemptionClass, Detector>([
      ["decorator", holding("named by @register", "kept")],
      [
        "framework-lifecycle",
        () => {
          throw new Unanswerable();
        },
      ],
    ]);

    const swept = runSweep(
      openEngine({ collectTiming: false }),
      host,
      scopeForDir(host, root),
      config,
      { marked: [], mode: PRODUCTION },
      detectors,
    );

    expect(refsOf(swept, swept.heldByUnanswered)).toEqual([
      "ts://./src/held.ts#Widget.render",
      "ts://./src/held.ts#paint",
    ]);
    expect(
      refsOf(
        swept,
        swept.sweep.candidates.map((one) => one.id),
      ),
    ).toEqual(["ts://./src/held.ts#Widget"]);
    expect(swept.retained.map((one) => `${refsOf(swept, [one.id]).join("")} ${one.class}`)).toEqual(
      ["ts://./src/held.ts#kept decorator", "ts://./src/held.ts#Widget.render framework-lifecycle"],
    );
  });
});

describe("the records a run retains", () => {
  it("retain a live declaration nothing the mode counts reads, beside the dead ones", () => {
    const root = written({
      "src/main.ts": [
        'import { Settings } from "./settings.js";',
        "",
        "const made = new Settings();",
        "made.level = 1;",
        "made.shown = 2;",
        "made.tested = 3;",
        "console.log(made.shown);",
        "",
      ].join("\n"),
      "src/settings.ts":
        "export class Settings {\n  level = 0;\n  shown = 0;\n  tested = 0;\n  unset = 0;\n}\n",
      "src/settings.test.ts":
        'import { Settings } from "./settings.js";\n\nconsole.log(new Settings().tested);\n',
    });
    const host = nodeHost();
    const { config } = configured(APPLICATION);
    const detectors: Detectors = new Map<TSExemptionClass, Detector>([
      [
        "serialization-contract",
        holding(
          "passed to JSON.stringify",
          "Settings.level",
          "Settings.shown",
          "Settings.tested",
          "Settings.unset",
        ),
      ],
    ]);

    const swept = runSweep(
      openEngine({ collectTiming: false }),
      host,
      scopeForDir(host, root),
      config,
      { marked: [], mode: PRODUCTION },
      detectors,
    );

    expect(
      refsOf(
        swept,
        swept.retained.map((one) => one.id),
      ),
    ).toEqual([
      "ts://./src/settings.ts#Settings.level",
      "ts://./src/settings.ts#Settings.tested",
      "ts://./src/settings.ts#Settings.unset",
    ]);
  });

  it("count evidence a test file holds as that file's test read under a production mode", () => {
    const root = written({
      "src/main.ts": "console.log(1);\n",
      "src/lib.ts": "export function heldInATest(): number {\n  return 1;\n}\n",
      "src/lib.test.ts": "export const checked = 1;\n",
    });
    const host = nodeHost();
    const { config } = configured(APPLICATION);
    const detectors: Detectors = new Map<TSExemptionClass, Detector>([
      [
        "decorator",
        ({ held }) => {
          const site = held.symbols.find((symbol) => symbol.position.path === "src/lib.test.ts");
          return held.symbols
            .filter((symbol) => symbol.name === "heldInATest" && site !== undefined)
            .map((symbol) => ({
              id: symbol.id,
              detail: "named by @register",
              site: site?.position ?? symbol.position,
            }));
        },
      ],
    ]);

    const swept = runSweep(
      openEngine({ collectTiming: false }),
      host,
      scopeForDir(host, root),
      config,
      { marked: [], mode: PRODUCTION },
      detectors,
    );

    expect(
      swept.sweep.candidates.map(
        (one) =>
          `${refsOf(swept, [one.id]).join("")} ${String(one.productionRefs)} ${String(one.testRefs)} ${String(one.testOfDeadCode)}`,
      ),
    ).toEqual([
      "ts://./src/lib.test.ts#checked 0 0 false",
      "ts://./src/lib.ts#heldInATest 0 1 false",
    ]);
  });
});

describe("the test code of a run", () => {
  it("is every test file a project holds or none does, and the code only test code imports, each project naming what it holds", () => {
    const root = written({
      "tsconfig.json": including("src/**/*.ts"),
      "src/main.ts": 'import { used } from "./lib.js";\n\nconsole.log(used());\n',
      "src/lib.ts": [
        "export function used(): number {",
        "  return 1;",
        "}",
        "export function testedOnly(): number {",
        "  return 2;",
        "}",
        "export function outsideOnly(): number {",
        "  return 3;",
        "}",
        "export function toolOnly(): number {",
        "  return 4;",
        "}",
        "",
      ].join("\n"),
      "src/lib.test.ts": [
        'import { testedOnly } from "./lib.js";',
        'import { zeta } from "./zeta-fixture.js";',
        'import { alpha } from "./alpha-fixture.js";',
        "",
        "console.log(testedOnly() + zeta + alpha);",
        "",
      ].join("\n"),
      "node_modules/vitest/package.json":
        '{ "name": "vitest", "version": "1.0.0", "types": "./index.d.ts" }\n',
      "node_modules/vitest/index.d.ts": "export {};\n",
      "src/zeta-fixture.ts": 'import "vitest";\n\nexport const zeta = 1;\n',
      "src/alpha-fixture.ts": 'import "vitest";\n\nexport const alpha = 2;\n',
      "scripts/outside.test.ts":
        'import { outsideOnly } from "../src/lib.js";\n\nconsole.log(outsideOnly());\n',
      "scripts/tool.ts": 'import { toolOnly } from "../src/lib.js";\n\nconsole.log(toolOnly());\n',
      "tools/tsconfig.json": including("*.ts"),
      "tools/main.ts": "console.log(5);\n",
    });
    const host = nodeHost();
    const { config, provenance } = configured({
      ...APPLICATION,
      analysis: {
        configurations: [
          { id: "app", project: "tsconfig.json" },
          { id: "tools", project: "tools/tsconfig.json" },
        ],
      },
    });

    const analysis = runAnalysis(
      openEngine({ collectTiming: false }),
      host,
      scopeForDir(host, root),
      config,
      provenance,
      PRODUCTION,
    );
    const { swept } = analysis;

    expect(
      analysis.configured.map(
        (one) =>
          `${one.configuration}: ${one.testFiles.join(" ")}; ${(one.supportFiles ?? []).join(" ")}`,
      ),
    ).toEqual([
      "app: src/lib.test.ts scripts/outside.test.ts src/alpha-fixture.ts src/zeta-fixture.ts; src/alpha-fixture.ts src/zeta-fixture.ts",
      "tools: scripts/outside.test.ts; ",
    ]);
    expect(analysis.run.testFileRules.filter((one) => one.matched > 0)).toEqual([
      { rule: "test-file-pattern-1", matched: 2 },
      { rule: "test-support", matched: 2 },
    ]);
    expect(
      swept.sweep.candidates.map(
        (one) =>
          `${refsOf(swept, [one.id]).join("")} ${String(one.productionRefs)} ${String(one.testRefs)}`,
      ),
    ).toEqual([
      "ts://./src/alpha-fixture.ts#alpha 0 1",
      "ts://./src/lib.ts#testedOnly 0 1",
      "ts://./src/lib.ts#outsideOnly 0 1",
      "ts://./src/lib.ts#toolOnly 0 0",
      "ts://./src/zeta-fixture.ts#zeta 0 1",
    ]);
  });
});

describe("the findings of a run", () => {
  it("report a configured declaration no project holds, and none a single project holds", () => {
    const root = written({
      "tsconfig.json": including("src/**/*.ts"),
      "src/main.ts":
        'import { encode } from "./codec.js";\n\nconsole.log(JSON.stringify(encode));\n',
      "src/codec.ts": 'export function encode(): string {\n  return "";\n}\n',
      "tools/tsconfig.json": including("*.ts"),
      "tools/main.ts": "console.log(1);\n",
    });
    const host = nodeHost();
    const { config, provenance } = configured({
      ...APPLICATION,
      analysis: {
        configurations: [
          { id: "app", project: "tsconfig.json" },
          { id: "tools", project: "tools/tsconfig.json" },
        ],
      },
      ts: {
        ...APPLICATION.ts,
        serializers: [
          { symbol: "ts://./src/codec.ts#encode" },
          { symbol: "ts://./src/codec.ts#absent" },
        ],
      },
    });

    const analysis = runAnalysis(
      openEngine({ collectTiming: false }),
      host,
      scopeForDir(host, root),
      config,
      provenance,
      PRODUCTION,
    );

    expect(
      analysis.result.findings.map((one) => `${one.code} ${one.symbol.ref} ${one.position.path}`),
    ).toEqual([
      "DS1706 ts://./src/codec.ts#absent deadset.json",
      "DS1502 ts://./tools/main.ts# tools/main.ts",
    ]);
  });

  it("read a part's suppression as marking nothing live", () => {
    const root = written({
      "src/main.ts": "console.log(1);\n",
      "src/hooks.ts": [
        "// deadset:ignore DS1801 -- the hook signature is fixed",
        "export function hook(event: number): number {",
        "  return helper();",
        "}",
        "export function helper(): number {",
        "  return 1;",
        "}",
        "",
      ].join("\n"),
    });
    const host = nodeHost();
    const { config, provenance } = configured(APPLICATION);

    const analysis = runAnalysis(
      openEngine({ collectTiming: false }),
      host,
      scopeForDir(host, root),
      config,
      provenance,
      PRODUCTION,
    );

    expect(analysis.result.findings.map((one) => `${one.code} ${one.symbol.ref}`)).toEqual([
      "DS1502 ts://./src/hooks.ts#",
      "DS1001 ts://./src/hooks.ts#hook",
      "DS1001 ts://./src/hooks.ts#helper",
    ]);
    expect(analysis.result.totals.suppressionsInEffect).toBe(1);
  });
});

describe("the conventions of a run", () => {
  it("are read from the target's manifest and the members below it, each once, and not from a member beside it", () => {
    const manifest = (name: string): string =>
      `${JSON.stringify({ name, private: true, type: "module", devDependencies: { eslint: "10.0.0" } })}\n`;
    const root = written({
      "tsconfig.json": TSCONFIG,
      "package.json":
        '{ "name": "@example/root", "private": true, "workspaces": ["app", "app/inner", "other"] }\n',
      "node_modules/eslint/package.json": '{ "name": "eslint", "version": "10.0.0" }\n',
      "app/package.json": manifest("@example/app"),
      "app/tsconfig.json": TSCONFIG,
      "app/main.ts": "console.log(1);\n",
      "app/inner/package.json": manifest("@example/inner"),
      "app/inner/main.ts": "console.log(2);\n",
      "other/package.json": manifest("@example/other"),
      "other/tsconfig.json": TSCONFIG,
      "other/main.ts": "console.log(3);\n",
    });
    const host = nodeHost();
    const { config, provenance } = configured({ target: { kind: "application" } });

    const analysis = runAnalysis(
      openEngine({ collectTiming: false }),
      host,
      scopeForDir(host, join(root, "app")),
      config,
      provenance,
      PRODUCTION,
    );

    expect(analysis.run.conventionsApplied.map((one) => `${one.name} ${one.manifest}`)).toEqual([
      "eslint inner/package.json",
      "eslint package.json",
    ]);
  });
});

describe("the consumers of a run", () => {
  /** A manifest naming one package. */
  const manifest = (name: string, more: Readonly<Record<string, unknown>> = {}): string =>
    `${JSON.stringify({ name, private: true, version: "0.0.0", type: "module", ...more })}\n`;

  it("read a workspace consumer's own files for its references, and fail it on no convention of a member below the target", () => {
    const root = written({
      "package.json": manifest("@example/root", {
        workspaces: ["target", "target/extra", "consumer"],
      }),
      "target/package.json": manifest("@example/target", { main: "./src/lib.ts" }),
      "target/tsconfig.json": including("src/**/*.ts"),
      "target/src/lib.ts":
        "export function used(): number {\n  return 1;\n}\n\nexport function dead(): number {\n  return 2;\n}\n",
      "target/extra/package.json": manifest("@example/extra", {
        devDependencies: { eslint: "10.0.0" },
      }),
      "target/extra/helper.ts": "export const helper = 1;\n",
      "consumer/package.json": manifest("@example/consumer"),
      "consumer/tsconfig.json": including("*.ts"),
      "consumer/main.ts": [
        'import { used } from "../target/src/lib.js";',
        'import { helper } from "../target/extra/helper.js";',
        "",
        "console.log(used() + helper);",
        "",
      ].join("\n"),
    });
    const host = nodeHost();
    const { config } = configured({ target: { kind: "library" } });

    const swept = runSweep(
      openEngine({ collectTiming: false }),
      host,
      {
        target: { id: "@example/target", path: join(root, "target") },
        consumers: [{ id: "@example/consumer", path: join(root, "consumer") }],
      },
      config,
      { marked: [], mode: PRODUCTION },
    );

    expect(swept.notBuilt).toEqual([]);
    expect(
      refsOf(
        swept,
        swept.sweep.candidates.map((one) => one.id),
      ),
    ).toEqual(["ts://@example/target/src/lib.ts#dead"]);
  });

  it("fail on a consumer whose configuration does not load", () => {
    const root = written({
      "target/package.json": manifest("@example/target", { main: "./lib.ts" }),
      "target/tsconfig.json": TSCONFIG,
      "target/lib.ts": "export const one = 1;\n",
      "consumer/package.json": manifest("@example/consumer"),
      "consumer/tsconfig.json": '{ "compilerOptions": ',
      "consumer/main.ts": 'import { one } from "../target/lib.js";\n\nconsole.log(one);\n',
    });
    const host = nodeHost();
    const { config } = configured({ target: { kind: "library" } });
    const scope = {
      target: { id: "@example/target", path: join(root, "target") },
      consumers: [{ id: "@example/consumer", path: join(root, "consumer") }],
    };

    expect(() => runProjects(openEngine({ collectTiming: false }), host, scope, config)).toThrow(
      /^4 error\(s\), so no answer was produced$/u,
    );
  });

  it("hold what a consumer's unanswered reference names", () => {
    const files = {
      "target/package.json": manifest("@example/target", { main: "./lib.ts" }),
      "target/tsconfig.json": TSCONFIG,
      "target/lib.ts":
        "export function used(): number {\n  return 1;\n}\n\nexport function dead(): number {\n  return 2;\n}\n",
      "consumer/package.json": manifest("@example/consumer"),
      "consumer/tsconfig.json": TSCONFIG,
      "consumer/main.ts": 'import { used } from "../target/lib.js";\n\nconsole.log(used());\n',
    };
    const root = written(files);
    const host = nodeHost();
    const { config } = configured({ target: { kind: "library" } });

    const swept = runSweep(
      failingAt(root, files, [["consumer/main.ts", "console.log("]]),
      host,
      {
        target: { id: "@example/target", path: join(root, "target") },
        consumers: [{ id: "@example/consumer", path: join(root, "consumer") }],
      },
      config,
      { marked: [], mode: PRODUCTION },
    );

    expect(refsOf(swept, swept.heldByUnanswered)).toContain("ts://@example/target/lib.ts#used");
    expect(
      refsOf(
        swept,
        swept.sweep.candidates.map((one) => one.id),
      ),
    ).toEqual(["ts://@example/target/lib.ts#dead"]);
  });

  it("read a consumer's write as a read of what it writes, so no record retains it", () => {
    const root = written({
      "target/package.json": manifest("@example/target", { main: "./lib.ts" }),
      "target/tsconfig.json": TSCONFIG,
      "target/lib.ts":
        "export class Settings {\n  level = 0;\n}\n\nexport function make(): Settings {\n  return new Settings();\n}\n",
      "consumer/package.json": manifest("@example/consumer"),
      "consumer/tsconfig.json": TSCONFIG,
      "consumer/main.ts": 'import { make } from "../target/lib.js";\n\nmake().level = 1;\n',
    });
    const host = nodeHost();
    const { config } = configured({ target: { kind: "library" } });

    const swept = runSweep(
      openEngine({ collectTiming: false }),
      host,
      {
        target: { id: "@example/target", path: join(root, "target") },
        consumers: [{ id: "@example/consumer", path: join(root, "consumer") }],
      },
      config,
      { marked: [], mode: PRODUCTION },
      new Map<TSExemptionClass, Detector>([
        ["serialization-contract", holding("passed to JSON.stringify", "Settings.level")],
      ]),
    );

    expect(
      refsOf(
        swept,
        swept.retained.map((one) => one.id),
      ),
    ).toEqual([]);
    expect(
      refsOf(
        swept,
        swept.sweep.candidates.map((one) => one.id),
      ),
    ).toEqual([]);
  });

  it("fail on a consumer whose import of a workspace member names no file", () => {
    const root = written({
      "package.json": manifest("@example/root", {
        workspaces: ["target", "target/extra", "consumer"],
      }),
      "target/package.json": manifest("@example/target", { main: "./src/lib.ts" }),
      "target/tsconfig.json": including("src/**/*.ts"),
      "target/src/lib.ts": "export const one = 1;\n",
      "target/extra/package.json": manifest("@example/extra"),
      "target/extra/helper.ts": 'export { made } from "./generated.js";\n',
      "consumer/package.json": manifest("@example/consumer"),
      "consumer/tsconfig.json": including("*.ts"),
      "consumer/main.ts":
        'import { made } from "../target/extra/helper.js";\n\nconsole.log(made);\n',
    });
    const host = nodeHost();
    const { config } = configured({ target: { kind: "library" } });
    const scope = {
      target: { id: "@example/target", path: join(root, "target") },
      consumers: [{ id: "@example/consumer", path: join(root, "consumer") }],
    };

    expect(() => runProjects(openEngine({ collectTiming: false }), host, scope, config)).toThrow(
      new SetupError([
        {
          setupClass: "missing-consumer",
          detail: `the consumer ${join(root, "consumer")} does not build, its dependencies not installed: ${join(root, "target", "extra", "helper.ts")}:1: ${join(root, "target", "extra", "helper.ts")} imports "./generated.js", which names no file of the target: run the generator or the build that writes it`,
        },
      ]),
    );
  });
});

describe("the component files of a run", () => {
  it("are listed once each in path order, beside every script start tag no block was read for", () => {
    const root = written({
      "tsconfig.json": including("src/a/*.ts", "src/a/*.vue", "src/z/*.vue"),
      "one/tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, module: "NodeNext", noEmit: true },
        include: ["../src/z/*.vue"],
      }),
      "src/a/main.ts": "console.log(1);\n",
      "src/a/Alpha.vue": '<script lang="ts">\nexport const alpha = 1;\n</script>\n',
      "src/z/Zed.vue": [
        "<template>",
        "<div>",
        "<script>const notABlock = 1;</script>",
        "</div>",
        "</template>",
        '<script lang="ts">',
        "const kept = 1;",
        "</script>",
        "",
      ].join("\n"),
    });
    const host = nodeHost();
    const { config, provenance } = configured({
      target: { kind: "application" },
      ts: { entry_files: ["src/a/main.ts"] },
      analysis: {
        configurations: [
          { id: "one", project: "one/tsconfig.json" },
          { id: "two", project: "tsconfig.json" },
        ],
      },
    });

    const analysis = runAnalysis(
      openEngine({ collectTiming: false, components: { extensions: [".vue"], host } }),
      host,
      scopeForDir(host, root),
      config,
      provenance,
      PRODUCTION,
    );

    expect(analysis.swept.componentFiles).toEqual(["src/a/Alpha.vue", "src/z/Zed.vue"]);
    expect(analysis.run.componentWarnings).toEqual([
      { path: "src/z/Zed.vue", line: 3, reason: "it is inside an element" },
    ]);
  });
});

describe("a baseline write", () => {
  /** The rows a baseline write over one tree records, each as its code and subject. */
  const recorded = (files: Readonly<Record<string, string>>): readonly string[] => {
    const root = written(files);
    const host = nodeHost();
    const { config, provenance } = configured(APPLICATION);
    const write = runBaselineWrite(
      openEngine({ collectTiming: false }),
      host,
      scopeForDir(host, root),
      config,
      provenance,
      PRODUCTION,
      "recorded by the write",
    );
    return write.rows.map((row) => `${row.code} ${row.symbol} ${row.path}`);
  };

  it("drops a row a later round finds no finding for, and records it no more", () => {
    expect(
      recorded({
        "src/main.ts": [
          'import { Level, live } from "./levels.js";',
          "",
          "console.log(Level.Low, live());",
          "",
        ].join("\n"),
        "src/levels.ts": [
          "export enum Level {",
          "  Low,",
          "}",
          "",
          "export enum Unused {",
          "  First,",
          "  Second,",
          "}",
          "",
          "// deadset:ignore DS1001 -- loaded by name",
          "export function live(): number {",
          "  return 1;",
          "}",
          "",
        ].join("\n"),
      }),
    ).toEqual(["DS1001 ts://./src/levels.ts#Unused src/levels.ts"]);
  });

  it("keeps a row one declaration of a merged pair claims and the other does not", () => {
    expect(
      recorded({
        "src/main.ts": 'import { scaled } from "./scale.js";\n\nconsole.log(scaled(1));\n',
        "src/scale.ts": [
          "export function scaled(value: number): number;",
          "export function scaled(value: number, factor?: number): number {",
          "  return 1;",
          "}",
          "",
        ].join("\n"),
      }),
    ).toEqual([
      "DS1801 ts://./src/scale.ts#scaled(value) src/scale.ts",
      "DS1801 ts://./src/scale.ts#scaled(factor) src/scale.ts",
    ]);
  });
});

describe("the unanswered-question counts of a run", () => {
  it("are one per configuration the checker failed in, counting its questions and its own held declarations", () => {
    const symbol = (id: string): { id: string } => ({ id });
    // A fake of the slice of a run the counts read: two projects, questions in one of them.
    const analysis = {
      run: {
        projects: [
          { id: "app", configFile: "/t/tsconfig.json" },
          { id: "tools", configFile: "/t/tools/tsconfig.json" },
        ],
        unanswered: [
          { configFile: "/t/tsconfig.json", accessor: "typeAt", location: "a.ts:1" },
          { configFile: "/t/tsconfig.json", accessor: "symbolAt", location: "a.ts:9" },
        ],
      },
      swept: { heldByUnanswered: ["a#held", "a#also", "tools#held"] },
      configured: [
        { configuration: "app", symbols: [symbol("a#held"), symbol("a#also"), symbol("a#free")] },
        { configuration: "tools", symbols: [symbol("tools#held")] },
      ],
    } as unknown as RunAnalysis;

    expect(unansweredCounts(analysis)).toEqual([
      { configuration: "app", questions: 2, declarations: 2 },
    ]);
  });

  it("count the held declarations of the configuration the questions were asked in", () => {
    const symbol = (id: string): { id: string } => ({ id });
    const analysis = {
      run: {
        projects: [
          { id: "app", configFile: "/t/tsconfig.json" },
          { id: "tools", configFile: "/t/tools/tsconfig.json" },
        ],
        unanswered: [
          { configFile: "/t/tools/tsconfig.json", accessor: "typeAt", location: "b.ts:1" },
        ],
      },
      swept: { heldByUnanswered: ["a#held", "a#also", "tools#held"] },
      configured: [
        { configuration: "app", symbols: [symbol("a#held"), symbol("a#also")] },
        { configuration: "tools", symbols: [symbol("tools#held"), symbol("tools#free")] },
      ],
    } as unknown as RunAnalysis;

    expect(unansweredCounts(analysis)).toEqual([
      { configuration: "tools", questions: 1, declarations: 1 },
    ]);
  });
});
