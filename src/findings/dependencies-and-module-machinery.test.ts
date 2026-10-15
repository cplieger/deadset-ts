import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { emitterInputOf, findingsOf } from "../../__test-helpers__/emitter-input.ts";
import { writeProject } from "../../__test-helpers__/projects.ts";
import { contractDocument, fixture } from "../../__test-helpers__/fixtures.ts";
import type { Finding } from "../finding.ts";
import { isRef } from "../ref.ts";
import { resolve } from "../resolve.ts";
import { run, type Writer } from "../run.ts";
import type { EmitterInput } from "./emitter.ts";
import { EMITTERS } from "./emitters.ts";

/**
 * The fixture with its dependency directory in place. A tree holding one cannot be
 * committed, so the fixture keeps the installed packages under `installed/` and each
 * run moves them where the package manager would have put them.
 */
const TARGET = ((): string => {
  const root = mkdtempSync(join(tmpdir(), "deadset-ts-dependencies-"));
  cpSync(fixture("projects", "dependencies"), root, { recursive: true });
  renameSync(join(root, "installed"), join(root, "node_modules"));
  return root;
})();

afterAll(() => {
  rmSync(TARGET, { recursive: true, force: true });
});

/** The fixture swept for production under its own configuration, or the document given. */
function sweepFixture(
  target: string,
  document?: string,
): { input: EmitterInput; findings: Finding[] } {
  const path = join(target, "deadset.json");
  const { config } = resolve({
    repository: document ?? readFileSync(path, "utf8"),
    repositoryLabel: path,
  });
  const input = emitterInputOf(target, config);
  const emit = EMITTERS.get("dependencies-and-module-machinery");
  return { input, findings: emit === undefined ? [] : [...emit(input)] };
}

function names(findings: readonly Finding[]): string[] {
  return findings.map((finding) => finding.symbol.name);
}

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

describe("the dependencies-and-module-machinery emitter", () => {
  it("reports each declared dependency the target does not need, at its key in the manifest", async () => {
    const swept = sweepFixture(TARGET);
    await expect(`${JSON.stringify(swept.findings, null, 2)}\n`).toMatchFileSnapshot(
      fixture("golden", "dependencies.findings.json"),
    );
  });

  it("reports one dependency, development dependency and peer dependency, and passes over a used one of each", () => {
    const swept = sweepFixture(TARGET);
    expect(
      swept.findings.map(
        (finding) =>
          `${finding.symbol.name} ${(finding as { details?: { dependencyClass?: string } }).details?.dependencyClass ?? ""}`,
      ),
    ).toEqual([
      "left-pad dependency",
      "unused-runtime dependency",
      "@types/bundled dev-dependency",
      "unused-dev dev-dependency",
      "peer-unused peer-dependency",
    ]);
    for (const used of ["used-runtime", "test-helper", "peer-used"]) {
      expect(names(swept.findings)).not.toContain(used);
    }
  });

  it("counts a type package the compiler resolves an import to, or the configuration names, and not one it never reads", () => {
    const swept = sweepFixture(TARGET);
    expect(names(swept.findings)).not.toContain("@types/typed-only");
    expect(names(swept.findings)).not.toContain("@types/globals");
    expect(names(swept.findings)).toContain("@types/bundled");
  });

  it("holds a dependency whose command a script runs needed, and each peer a needed one names, optional or not", () => {
    const swept = sweepFixture(TARGET);
    expect(names(swept.findings)).not.toContain("dev-tool");
    expect(names(swept.findings)).not.toContain("host-peer");
    expect(names(swept.findings)).not.toContain("optional-peer");
  });

  it("never reports the manifest's bin entry, whose target no import reaches, and counts what that target imports", () => {
    const swept = sweepFixture(TARGET);
    for (const finding of swept.findings) {
      expect(finding.position.path).toBe("package.json");
      expect(finding.symbol.name).not.toBe("dependencies-cli");
    }
    expect(names(swept.findings)).not.toContain("cli-only");
  });

  it("states each finding in the finding schema's vocabulary", () => {
    const swept = sweepFixture(TARGET);
    const schema = contractDocument("finding.schema.json") as {
      properties: {
        message: { pattern: string };
        details: { properties: { dependency_class: { enum: string[] } } };
      };
    };
    const message = new RegExp(schema.properties.message.pattern, "u");
    const classes = schema.properties.details.properties.dependency_class.enum;
    for (const finding of swept.findings) {
      expect(finding.code).toBe("DS1701");
      expect(finding.symbol.kind).toBe("dependency");
      expect(isRef(finding.symbol.ref), finding.symbol.ref).toBe(true);
      expect(finding.message).toMatch(message);
      expect(classes).toContain(
        (finding as { details?: { dependencyClass?: string } }).details?.dependencyClass,
      );
    }
  });

  it("names, per deletion candidate, each declared dependency it holds the last use of, and none two declarations share", () => {
    const installedPackage = (name: string): Record<string, string> => ({
      [`node_modules/${name}/package.json`]: JSON.stringify({ name, types: "index.d.ts" }),
      [`node_modules/${name}/index.d.ts`]: "export declare const value: number;\n",
    });
    const root = writeProject({
      "package.json": JSON.stringify({
        name: "@example/app",
        type: "module",
        main: "./src/main.ts",
        dependencies: { alpha: "1", beta: "1", shared: "1" },
      }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, module: "NodeNext", types: [], noEmit: true },
        include: ["src"],
      }),
      ...installedPackage("alpha"),
      ...installedPackage("beta"),
      ...installedPackage("shared"),
      "src/main.ts": 'import "./dead.js";\n',
      "src/dead.ts": [
        'import { value as a } from "alpha";',
        'import { value as b } from "beta";',
        'import { value as s } from "shared";',
        "export function first(): number { return a + s; }",
        "export function second(): number { return b + s; }",
        "",
      ].join("\n"),
    });
    const { config } = resolve({
      repository: JSON.stringify({ target: { kind: "application" } }),
      repositoryLabel: "deadset.json",
    });
    try {
      expect(emitterInputOf(root, config).dependencies.lastUses).toEqual(
        new Map([
          ["src/dead.ts:4:17", ["alpha"]],
          ["src/dead.ts:5:17", ["beta"]],
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names on a deletable finding each dependency whose last use deleting its subject removes", () => {
    const swept = sweepFixture(TARGET);
    const padded = findingsOf(swept.input).find(
      (finding) => finding.position.path === "src/main.ts" && finding.position.line === 12,
    );

    expect(padded?.fixability).toBe("deletable");
    expect(padded?.details.removesLastUseOf).toEqual(["left-pad"]);
  });

  it("withholds every finding when the severity map sets the kind or its family to allow", () => {
    const swept = sweepFixture(TARGET);
    const allow = (severity: Record<string, string>): readonly Finding[] =>
      findingsOf(
        sweepFixture(TARGET, JSON.stringify({ target: { kind: "application" }, severity })).input,
      ).filter((finding) => finding.code === "DS1701");

    expect(allow({ DS1701: "allow" })).toEqual([]);
    expect(allow({ DS17: "allow" })).toEqual([]);
    expect(names(allow({ DS17: "allow", DS1701: "warn" }))).toEqual(names(swept.findings));
  });
});

describe("an import no package resolves and no manifest declares", () => {
  const unresolved = fixture("projects", "dependencies-unresolved");

  it("is a type error the sweep skips, so the emitter runs and reports nothing", () => {
    expect(sweepFixture(unresolved).findings).toEqual([]);
  });

  it("is no setup failure: the command line exits 0", () => {
    const out = new MemoryWriter();
    const err = new MemoryWriter();
    const code = run(["print-retained", `--target=${unresolved}`], out, err, nodeHost());

    expect(code, err.text).toBe(0);
    expect(err.text).not.toContain("setup failure");
  });
});

describe("a workspace whose members declare dependencies", () => {
  const target = mkdtempSync(join(tmpdir(), "deadset-ts-dependencies-workspace-"));
  cpSync(fixture("projects", "dependencies-workspace"), target, { recursive: true });
  renameSync(join(target, "installed"), join(target, "node_modules"));
  afterAll(() => {
    rmSync(target, { recursive: true, force: true });
  });

  it("reports an unneeded dependency of a member's manifest at its key, in the member's scope", () => {
    expect(
      sweepFixture(target).findings.map(
        (finding) =>
          `${finding.symbol.ref} ${finding.position.path}:${String(finding.position.line)}`,
      ),
    ).toEqual([
      "ts://@example/root/package.json#root-unused:dev-dependency package.json:8",
      "ts://@example/root/package.json#root-used:dev-dependency package.json:9",
      "ts://@example/app/package.json#member-unused:dev-dependency packages/app/package.json:7",
      "ts://@example/app/package.json#member-used:dev-dependency packages/app/package.json:8",
      "ts://@example/web/package.json#member-web:dev-dependency packages/web/package.json:7",
    ]);
  });

  it("judges no member whose files no built project holds", () => {
    expect(
      sweepFixture(target)
        .findings.map((finding) => finding.symbol.ref)
        .filter((ref) => ref.startsWith("ts://@example/tool/")),
      "packages/tool/scripts/run.mjs imports member-tool, and no configuration holds it",
    ).toEqual([]);
  });

  it("judges a member a built configuration holds source of, though a configuration below it was dropped", () => {
    expect(
      sweepFixture(target)
        .findings.filter((finding) => finding.symbol.ref.startsWith("ts://@example/web/"))
        .map((finding) => `${finding.symbol.name} ${finding.reachabilityClass ?? "certain"}`),
      "packages/web/tsconfig.json matches no input, and the root configuration holds packages/web/src",
    ).toEqual(["member-web certain"]);
  });
});

describe("a dependency only dead code uses", () => {
  const installed = (name: string): Record<string, string> => ({
    [`node_modules/${name}/package.json`]: JSON.stringify({ name, types: "index.d.ts" }),
    [`node_modules/${name}/index.d.ts`]: "export declare const value: number;\n",
  });

  it("is reported at the class its users' deadness carries, a dead file's top level among them, and kept where a test or an unread import uses one", () => {
    const root = writeProject({
      "package.json": JSON.stringify({
        name: "@example/app",
        type: "module",
        main: "./src/main.ts",
        dependencies: {
          bound: "1",
          "dead-only": "1",
          "file-level": "1",
          reached: "1",
          tested: "1",
          live: "1",
        },
        devDependencies: { vitest: "1" },
      }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, module: "NodeNext", types: [], noEmit: true },
        include: ["src"],
      }),
      ...installed("bound"),
      ...installed("dead-only"),
      ...installed("file-level"),
      ...installed("reached"),
      ...installed("tested"),
      ...installed("live"),
      "src/main.ts": [
        'import { value } from "live";',
        'import { value as unread } from "bound";',
        "console.log(value);",
        "",
      ].join("\n"),
      "src/dead.ts": [
        'import { value as one } from "dead-only";',
        'import { value as two } from "reached";',
        'import { value as four } from "live";',
        'import { value as five } from "file-level";',
        "void five;",
        "export function first(): number { return one + four + inner(); }",
        "export function second(): number { return one; }",
        "function inner(): number { return two; }",
        "",
      ].join("\n"),
      "node_modules/vitest/package.json": '{ "name": "vitest", "types": "./index.d.ts" }\n',
      "node_modules/vitest/index.d.ts": "export {};\n",
      "src/helped.ts":
        'import "vitest";\nimport { value } from "tested";\nexport function helper(): number { return value; }\n',
      "src/helped.test.ts": 'import { helper } from "./helped.ts";\nconsole.log(helper());\n',
    });
    const { config } = resolve({
      repository: JSON.stringify({ target: { kind: "application" } }),
      repositoryLabel: "deadset.json",
    });
    const emit = EMITTERS.get("dependencies-and-module-machinery");
    try {
      expect(
        (emit === undefined ? [] : [...emit(emitterInputOf(root, config))]).map(
          (finding) =>
            `${finding.symbol.name} ${finding.unreachableOnly === true ? "reached" : "unreferenced"}: ${finding.message}`,
        ),
      ).toEqual([
        "dead-only unreferenced: only code that is itself dead uses the declared dependency",
        "file-level unreferenced: only code that is itself dead uses the declared dependency",
        "reached reached: only code that is itself dead uses the declared dependency",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a nested package whose configurations the run could not build", () => {
  it("has its unneeded dependencies reported at possible, as an unbuilt member's are", () => {
    const root = writeProject({
      "package.json": JSON.stringify({
        name: "@example/app",
        private: true,
        type: "module",
        main: "./src/main.ts",
      }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, module: "NodeNext", types: [], noEmit: true },
        include: ["src"],
      }),
      "src/main.ts": "console.log(1);\n",
      "sample/package.json": JSON.stringify({
        name: "sample",
        private: true,
        devDependencies: { typescript: "5.0.0" },
      }),
      "sample/tsconfig.json": JSON.stringify({ extends: "./absent.json", include: ["src"] }),
      "sample/src/app.ts": "export const app = 1;\n",
      "node_modules/typescript/package.json": JSON.stringify({
        name: "typescript",
        version: "5.0.0",
      }),
    });
    const { config } = resolve({
      repository: JSON.stringify({
        target: { kind: "application" },
        analysis: { min_confidence: "possible" },
      }),
      repositoryLabel: "deadset.json",
    });
    try {
      expect(
        findingsOf(emitterInputOf(root, config))
          .filter((finding) => finding.code === "DS1701")
          .map((finding) => `${finding.symbol.name} ${finding.reachabilityClass}`),
      ).toEqual(["typescript possible"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a file no import reaches", () => {
  it("names the dependencies whose every use it writes as the last uses its deletion removes", () => {
    const root = writeProject({
      "package.json": JSON.stringify({
        name: "@example/app",
        type: "module",
        main: "./src/main.ts",
        dependencies: { live: "1", solo: "1" },
      }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, module: "NodeNext", types: [], noEmit: true },
        include: ["src"],
      }),
      "node_modules/live/package.json": JSON.stringify({ name: "live", types: "index.d.ts" }),
      "node_modules/live/index.d.ts": "export declare const value: number;\n",
      "node_modules/solo/package.json": JSON.stringify({ name: "solo", types: "index.d.ts" }),
      "node_modules/solo/index.d.ts": "export declare const value: number;\n",
      "src/main.ts": 'import { value } from "live";\nconsole.log(value);\n',
      "src/orphan.ts": [
        'import { value } from "solo";',
        'import { value as other } from "live";',
        "console.log(value, other);",
        "export function also(): number { return value; }",
        "",
      ].join("\n"),
    });
    const { config } = resolve({
      repository: JSON.stringify({ target: { kind: "application" } }),
      repositoryLabel: "deadset.json",
    });
    try {
      expect(
        findingsOf(emitterInputOf(root, config))
          .filter((finding) => finding.code === "DS1602")
          .map((finding) => `${finding.symbol.name} ${JSON.stringify(finding.details)}`),
      ).toEqual(['src/orphan.ts {"removesLastUseOf":["solo"]}']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a package a file asks the runtime to resolve", () => {
  it("is needed where import.meta.resolve or require.resolve names it by a literal", () => {
    const root = writeProject({
      "package.json": JSON.stringify({
        name: "@example/app",
        type: "module",
        main: "./src/main.ts",
        dependencies: { located: "1.0.0", required: "1.0.0", unused: "1.0.0" },
      }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, module: "NodeNext", types: [], noEmit: true },
        include: ["src"],
      }),
      "node_modules/located/package.json": '{ "name": "located", "version": "1.0.0" }',
      "node_modules/required/package.json": '{ "name": "required", "version": "1.0.0" }',
      "node_modules/unused/package.json": '{ "name": "unused", "version": "1.0.0" }',
      "src/main.ts": [
        "declare const require: { resolve(id: string): string };",
        'console.log(import.meta.resolve("located"), require.resolve("required/cli.js"));',
        "",
      ].join("\n"),
    });
    const { config } = resolve({
      repository: JSON.stringify({ target: { kind: "application" } }),
      repositoryLabel: "deadset.json",
    });
    const emit = EMITTERS.get("dependencies-and-module-machinery");
    try {
      expect(names(emit === undefined ? [] : [...emit(emitterInputOf(root, config))])).toEqual([
        "unused",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a command a workspace member's script runs", () => {
  it("uses the member's own declaration and leaves the root's of the same name unneeded", () => {
    const root = writeProject({
      "package.json": JSON.stringify({
        name: "@example/root",
        private: true,
        workspaces: ["packages/*"],
        devDependencies: { runner: "1.0.0" },
      }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, module: "NodeNext", types: [], noEmit: true },
        include: ["packages/*/src"],
      }),
      "node_modules/runner/package.json": '{ "name": "runner", "bin": { "runner": "./cli.js" } }',
      "packages/app/package.json": JSON.stringify({
        name: "@example/app",
        private: true,
        scripts: { test: "runner --all" },
        devDependencies: { runner: "1.0.0" },
      }),
      "packages/app/src/main.ts": "console.log(1);\n",
    });
    const { config } = resolve({
      repository: JSON.stringify({ target: { kind: "application" } }),
      repositoryLabel: "deadset.json",
    });
    const emit = EMITTERS.get("dependencies-and-module-machinery");
    try {
      expect(
        (emit === undefined ? [] : [...emit(emitterInputOf(root, config))]).map(
          (finding) => finding.symbol.ref,
        ),
      ).toEqual(["ts://@example/root/package.json#runner:dev-dependency"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
