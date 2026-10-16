import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { runRoots, runSweep, type RunSweep } from "./analysis.ts";
import { resolve } from "./resolve.ts";
import { run, type Writer } from "./run.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine } from "./session.ts";

const TARGET = fixture("projects", "two-configurations");

/** The fixture's configuration document, resolved. */
function fixtureConfig(): ReturnType<typeof resolve> {
  const document = join(TARGET, "deadset.json");
  return resolve({ repository: { text: readFileSync(document, "utf8"), label: document } });
}

/** One sweep of the fixture, with each declaration spelled by its file and display name. */
interface Swept {
  readonly swept: RunSweep;
  readonly names: ReadonlyMap<string, string>;
}

/**
 * The fixture whose two compiler configurations share one module, swept in the mode a
 * report is built in.
 */
function sweptFixture(): Swept {
  const host = nodeHost();
  const swept = runSweep(
    openEngine({ collectTiming: false }),
    host,
    scopeForDir(host, TARGET),
    fixtureConfig().config,
    { marked: [], mode: { production: true } },
  );
  return {
    swept,
    names: new Map(
      swept.matrix.union.symbols.map((symbol) => [
        symbol.id,
        `${symbol.position.path}#${symbol.name}`,
      ]),
    ),
  };
}

/** Each candidate of the run, with the configurations it is dead in. */
function candidates({ swept, names }: Swept): string[] {
  return swept.sweep.candidates.map(
    (candidate) =>
      `${names.get(candidate.id) ?? candidate.id} ${candidate.configurations.join(",")}`,
  );
}

describe("a run over two compiler configurations", () => {
  it("names the configurations in the order the matrix lists them", () => {
    expect(
      sweptFixture().swept.matrix.configurations,
      "the scripts' configuration first, as declared",
    ).toEqual(["scripts", "app"]);
  });

  it("reports only what is dead in every configuration that holds it, naming each", () => {
    expect(
      candidates(sweptFixture()),
      "a function only the script uses is dead in the application and live in the " +
        "scripts' configuration, so it is no candidate, and the same holds the other way",
    ).toEqual([
      "src/main.ts#appOnlyDead app",
      "src/shared.ts#deadEverywhere scripts,app",
      "src/shared.ts#deadCaller scripts,app",
      "src/shared.ts#deadCallee scripts,app",
    ]);
  });

  it("records the relations that hold a declaration live in any configuration", () => {
    const { swept, names } = sweptFixture();
    const id = [...names].find(([, name]) => name === "src/shared.ts#usedByScript")?.[0] ?? "";

    expect(
      swept.sweep.liveUnder.get(id),
      "dead under both in the application, live under both in the scripts' configuration",
    ).toEqual(["reference-counting", "reachability"]);
  });

  it("holds each declaration in the configurations whose project compiles its file", () => {
    const { swept } = sweptFixture();
    const heldIn = (name: string): readonly string[] => {
      const at = swept.matrix.union.symbols.findIndex(
        (symbol) => `${symbol.position.path}#${symbol.name}` === name,
      );
      return swept.matrix.heldIn[at] ?? [];
    };

    expect(heldIn("src/shared.ts#usedByScript")).toEqual(["scripts", "app"]);
    expect(heldIn("src/main.ts#appOnlyLive"), "judged in the one project that holds it").toEqual([
      "app",
    ]);
  });

  it("counts a reference both configurations make at one position once", () => {
    const { swept, names } = sweptFixture();
    const callee = swept.sweep.candidates.find(
      (candidate) => names.get(candidate.id) === "src/shared.ts#deadCallee",
    );

    expect(callee?.productionRefs, "one call, compiled by both configurations").toBe(1);
    expect(callee?.relation).toBe("reachability");
  });

  it("groups the run's dead set into components once, each identifier once", () => {
    const { swept, names } = sweptFixture();
    const components = swept.sweep.components;
    const ids = components.map((component) => component.id);

    expect(new Set(ids).size, `one identifier per component of the run: ${ids.join(" ")}`).toBe(
      ids.length,
    );
    expect(
      components.map((component) => component.members.map((id) => names.get(id) ?? id)),
    ).toEqual([
      ["src/main.ts#appOnlyDead"],
      ["src/shared.ts#deadEverywhere"],
      ["src/shared.ts#deadCaller", "src/shared.ts#deadCallee"],
    ]);
    expect(components.map((component) => component.id)).toEqual([
      "deadset-ts/c-0001",
      "deadset-ts/c-0002",
      "deadset-ts/c-0003",
    ]);
  });

  it("admits a test of dead code only when its subjects are dead in the whole run", () => {
    const target = fixture("projects", "test-of-code-live-elsewhere");
    const host = nodeHost();
    const document = join(target, "deadset.json");
    const swept = runSweep(
      openEngine({ collectTiming: false }),
      host,
      scopeForDir(host, target),
      resolve({ repository: { text: readFileSync(document, "utf8"), label: document } }).config,
      { marked: [], mode: { production: true } },
    );
    const names = new Map(swept.matrix.union.symbols.map((symbol) => [symbol.id, symbol.name]));
    const admitted = swept.sweep.candidates
      .filter((candidate) => candidate.testOfDeadCode)
      .map((candidate) => names.get(candidate.id));

    expect(
      admitted,
      "the application's configuration alone finds usedByScript dead, while the scripts' " +
        "configuration uses it, so the test of it is no test of dead code",
    ).toEqual(["checksTheDeadValue"]);
  });

  it("names the configurations of the root set in the same order", () => {
    const host = nodeHost();
    const { config, provenance } = fixtureConfig();

    expect(
      runRoots(
        openEngine({ collectTiming: false }),
        host,
        scopeForDir(host, TARGET),
        config,
        provenance,
      ).configurations,
    ).toEqual(["scripts", "app"]);
  });
});

const LOAD_TIMEOUT = 60_000;

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

function tsconfig(include: readonly string[], paths?: Readonly<Record<string, string[]>>): string {
  return `${JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ESNext",
      lib: ["ESNext"],
      types: [],
      module: "NodeNext",
      moduleResolution: "nodenext",
      noEmit: true,
      allowImportingTsExtensions: true,
      ...(paths === undefined ? {} : { paths }),
    },
    include,
  })}\n`;
}

function application(
  configurations: readonly (readonly [string, string])[],
  files: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return {
    "package.json": '{ "name": "@example/written", "private": true, "type": "module" }\n',
    "deadset.json": `${JSON.stringify({
      target: { kind: "application" },
      analysis: {
        configurations: configurations.map(([id, project]) => ({ id, project })),
      },
      ts: { entry_files: ["src/main.ts"] },
    })}\n`,
    ...files,
  };
}

function explained(files: Readonly<Record<string, string>>, ...names: readonly string[]): string[] {
  const root = writeProject(files);
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return names.map((name) => {
    const out = new MemoryWriter();
    run(["explain", "--target=.", `--why=${name}`], out, new MemoryWriter(), {
      ...nodeHost(),
      workingDirectory: () => root,
    });
    return out.text;
  });
}

const ENTRY = 'import { live } from "./a.ts";\n\nconsole.log(live());\n';
const LIVE_AND_DEAD =
  "export function dead(): number {\n  return 1;\n}\n\nexport function live(): number {\n  return 0;\n}\n";

describe("a run whose configurations answer one declaration differently", () => {
  it(
    "names a configuration once where two of the run's projects share its id",
    () => {
      const [unused] = explained(
        application(
          [
            ["app", "tsconfig.json"],
            ["app", "tsconfig.other.json"],
          ],
          {
            "tsconfig.json": tsconfig(["src/*.ts"]),
            "tsconfig.other.json": tsconfig(["src/*.ts"]),
            "src/main.ts": "console.log(1);\n",
            "src/a.ts": "export function unused(): number {\n  return 1;\n}\n",
          },
        ),
        "unused",
      );

      expect(unused).toContain("\nconfigurations: app\nanswer: reported\n");
    },
    LOAD_TIMEOUT,
  );

  it(
    "finds a declaration by reachability where one configuration counts a reference to it and another none",
    () => {
      const [used] = explained(
        application(
          [
            ["first", "tsconfig.json"],
            ["second", "tsconfig.second.json"],
          ],
          {
            "tsconfig.json": tsconfig(["src/main.ts", "src/a.ts", "src/caller.ts"]),
            "tsconfig.second.json": tsconfig(["src/main.ts", "src/a.ts"]),
            "src/main.ts": "console.log(1);\n",
            "src/a.ts": "export function used(): number {\n  return 1;\n}\n",
            "src/caller.ts":
              'import { used } from "./a.ts";\n\nexport function caller(): number {\n  return used();\n}\n',
          },
        ),
        "used",
      );

      expect(used).toContain("  liveness relation: reachability\n  configurations: first second\n");
    },
    LOAD_TIMEOUT,
  );
});

describe("a declaration dead in every configuration that holds it", () => {
  it(
    "is kept where a configuration compiles a reference to it from a declaration the run keeps",
    () => {
      const root = writeProject({
        "package.json": '{ "name": "@example/compiled", "private": true, "type": "module" }\n',
        "deadset.json": `${JSON.stringify({
          target: { kind: "application" },
          analysis: {
            configurations: [
              { id: "a", project: "tsconfig.json" },
              { id: "b", project: "tsconfig.b.json" },
            ],
          },
          ts: { entry_files: ["src/main-a.ts", "src/main-b.ts"] },
        })}\n`,
        "tsconfig.json": tsconfig(["src/main-a.ts"], { "#impl": ["./src/impl-a.ts"] }),
        "tsconfig.b.json": tsconfig(["src/main-b.ts", "src/shared.ts"], {
          "#impl": ["./src/impl-b.ts"],
        }),
        "src/main-a.ts": 'import { s } from "./shared.ts";\n\nconsole.log(s());\n',
        "src/main-b.ts": "console.log(1);\n",
        "src/shared.ts":
          'import { g } from "#impl";\n\nexport function s(): number {\n  return g();\n}\n',
        "src/impl-a.ts": "export function g(): number {\n  return 1;\n}\n",
        "src/impl-b.ts":
          "export function g(): number {\n  return 2;\n}\n\nexport function spare(): number {\n  return 3;\n}\n",
      });
      onTestFinished(() => {
        rmSync(root, { recursive: true, force: true });
      });
      run(
        ["analyze", "--target=.", "--report=report.json"],
        new MemoryWriter(),
        new MemoryWriter(),
        {
          ...nodeHost(),
          workingDirectory: () => root,
        },
      );
      const { findings } = JSON.parse(readFileSync(join(root, "report.json"), "utf8")) as {
        findings: { code: string; position: { path: string }; symbol: { name: string } }[];
      };

      expect(findings.map((one) => `${one.code} ${one.position.path} ${one.symbol.name}`)).toEqual([
        "DS1001 src/impl-b.ts spare",
      ]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a test of dead code across configurations", () => {
  it(
    "is no test of dead code where one production subject it names is live in another configuration",
    () => {
      const [checks] = explained(
        application(
          [
            ["tests", "tsconfig.json"],
            ["app", "tsconfig.app.json"],
          ],
          {
            "tsconfig.json": tsconfig(["src/a.ts", "src/a.test.ts"]),
            "tsconfig.app.json": tsconfig(["src/a.ts", "src/main.ts"]),
            "src/main.ts": 'import { elsewhere } from "./a.ts";\n\nconsole.log(elsewhere());\n',
            "src/a.ts":
              "export function dead(): number {\n  return 1;\n}\n\nexport function elsewhere(): number {\n  return 2;\n}\n",
            "src/a.test.ts":
              'import { dead, elsewhere } from "./a.ts";\n\nfunction checks(): boolean {\n  return dead() + elsewhere() === 3;\n}\n',
          },
        ),
        "checks",
      );

      expect(checks).toContain("answer: reported\n  code: DS1002 unused-unexported\n");
    },
    LOAD_TIMEOUT,
  );

  it(
    "is a test of dead code whose only other reads are of live test code, live test-support code and a production file",
    () => {
      const [checks] = explained(
        application([["app", "tsconfig.json"]], {
          "tsconfig.json": tsconfig(["src/*.ts"]),
          "src/main.ts": `import "./setup.ts";\n${ENTRY}`,
          "src/setup.ts": "console.log(0);\n",
          "src/a.ts": LIVE_AND_DEAD,
          "src/runner.test.ts":
            "// deadset:ignore DS1001 -- Called by the test runner's plugin.\nexport function runner(): number {\n  return 2;\n}\n",
          "node_modules/vitest/package.json": '{ "name": "vitest", "types": "./index.d.ts" }\n',
          "node_modules/vitest/index.d.ts": "export {};\n",
          "src/support.ts":
            'import "vitest";\n\n// deadset:ignore DS1102 -- Loaded by the test runner\'s setup.\nexport function helper(): number {\n  return 3;\n}\n',
          "src/a.test.ts":
            'import { dead } from "./a.ts";\nimport { runner } from "./runner.test.ts";\nimport { helper } from "./support.ts";\n\nfunction checks(): unknown {\n  return [dead(), runner(), helper(), import("./setup.ts")];\n}\n',
        }),
        "checks",
      );

      expect(checks).toContain("answer: reported\n  code: DS1103 test-of-dead-code\n");
    },
    LOAD_TIMEOUT,
  );

  it(
    "is no test of dead code where a configuration holding it holds none of its subjects",
    () => {
      const [checks] = explained(
        application(
          [
            ["first", "tsconfig.json"],
            ["second", "tsconfig.second.json"],
          ],
          {
            // Each configuration resolves `#subject` to its own file, so the second holds
            // the test but not the production declaration it reads in the first.
            "tsconfig.json": tsconfig(["src/main.ts", "src/a.ts", "src/a.test.ts"], {
              "#subject": ["./src/a.ts"],
            }),
            "tsconfig.second.json": tsconfig(["src/b.test.ts", "src/a.test.ts"], {
              "#subject": ["./src/b.test.ts"],
            }),
            "src/main.ts": ENTRY,
            "src/a.ts": LIVE_AND_DEAD,
            "src/b.test.ts": "export function dead(): number {\n  return 2;\n}\n",
            "src/a.test.ts":
              'import { dead } from "#subject";\n\nfunction checks(): boolean {\n  return dead() === 1;\n}\n',
          },
        ),
        "checks",
      );

      expect(checks).toContain("answer: reported\n  code: DS1002 unused-unexported\n");
    },
    LOAD_TIMEOUT,
  );
});

describe("a test-file declaration the run that counts test references does not reach", () => {
  const UNREACHED = application([["app", "tsconfig.json"]], {
    "tsconfig.json": tsconfig(["src/*.ts"]),
    "src/main.ts": "console.log(1);\n",
    "src/a.ts":
      'import { Box } from "./a.test.ts";\n\nexport function deadCaller(): number {\n  return Box.both();\n}\n',
    // The test runner calls the exported class, which reaches none of its members.
    "src/a.test.ts":
      "function alone(): number {\n  return 1;\n}\n\nfunction caller(): number {\n  return once() + Box.both();\n}\n\nfunction once(): number {\n  return 2;\n}\n\nexport class Box {\n  static both(): number {\n    return 3;\n  }\n}\n\n// deadset:ignore DS1002 -- Called by the test runner's plugin.\nfunction suppressed(): number {\n  return reached();\n}\n\nfunction reached(): number {\n  return 4;\n}\n",
  });

  it(
    "is reported as an unreferenced production declaration of its shape would be",
    () => {
      const [alone, caller, once] = explained(UNREACHED, "alone", "caller", "once");

      expect(alone).toContain(
        "  code: DS1002 unused-unexported\n  message: unexported function has no reference in the target\n",
      );
      expect(caller).toContain("  code: DS1002 unused-unexported\n");
      expect(once).toContain(
        "  message: unexported function is referenced only from declarations that are themselves dead\n",
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "is found by reachability where production code and test code each reference it once",
    () => {
      const [both] = explained(UNREACHED, "Box.both");

      expect(both).toContain(
        "  candidate: dead under reachability, with 1 production and 1 test references\n",
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "is not reported where a suppressed test declaration reads it",
    () => {
      const [reached] = explained(UNREACHED, "reached");

      expect(reached).toContain("answer: dead\n  live under: reachability\n");
    },
    LOAD_TIMEOUT,
  );
});
