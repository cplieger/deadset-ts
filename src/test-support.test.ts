import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { emitterInputOf, findingsOf } from "../__test-helpers__/emitter-input.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import type { InventorySymbol } from "./inventory.ts";
import type { Reference } from "./references.ts";
import { resolve } from "./resolve.ts";
import type { Root } from "./roots.ts";
import { testSupportFiles, type TestEvidence } from "./test-support.ts";

/**
 * An application whose test reaches two helper files that import each other, a setup file
 * it imports for its effects, a file production code imports too, and a file with no test
 * evidence. Each helper imports the test runner.
 */
const PROJECT: Readonly<Record<string, string>> = {
  "package.json":
    '{ "name": "@example/app", "type": "module", "main": "./main.ts", "devDependencies": { "vitest": "5.0.0" } }\n',
  "node_modules/vitest/package.json":
    '{ "name": "vitest", "version": "5.0.0", "types": "./index.d.ts" }\n',
  "node_modules/vitest/index.d.ts": "export {};\n",
  "plain.ts": "export function plain(): number {\n  return 4;\n}\n",
  "main.ts": 'import { other } from "./shared.js";\n\nconsole.log(other());\n',
  "shared.ts":
    "export function other(): number {\n  return 1;\n}\n\nexport function shared(): number {\n  return 2;\n}\n",
  "helpers/a.ts":
    'import "vitest";\nimport { b } from "./b.js";\n\nexport function a(): number {\n  return b();\n}\n',
  "helpers/b.ts":
    'import "vitest";\nimport { a } from "./a.js";\n\nexport function b(): number {\n  return 1;\n}\n\nexport function twice(): number {\n  return a() + a();\n}\n\nexport function spare(): number {\n  return 3;\n}\n',
  "setup.ts": 'import "vitest";\nimport { seed } from "./seeds.js";\n\nseed();\n',
  "seeds.ts": 'import "vitest";\n\nexport function seed(): void {}\n',
  "app.test.ts":
    'import { a } from "./helpers/a.js";\nimport { twice } from "./helpers/b.js";\nimport "./setup.js";\nimport { shared } from "./shared.js";\nimport { plain } from "./plain.js";\n\nconsole.log(a(), twice(), shared(), plain());\n',
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Every finding outside the test file, as `code name reachability-class`. */
function reported(): string[] {
  const root = writeProject(PROJECT);
  roots.push(root);
  const repository = JSON.stringify({
    target: { kind: "application" },
    analysis: { min_confidence: "possible" },
  });
  const { config } = resolve({ repository, repositoryLabel: "deadset.json" });
  return findingsOf(emitterInputOf(root, config))
    .filter((finding) => finding.position.path !== "app.test.ts")
    .map((finding) => `${finding.code} ${finding.symbol.name} ${finding.reachabilityClass}`)
    .sort();
}

describe("test-support code", () => {
  const found = reported();

  it("holds two files that import each other when only a test reaches them, which are test code a test reference keeps live", () => {
    expect(found.filter((line) => /\b(a|b|twice)\b/u.test(line.split(" ")[1] ?? ""))).toEqual([]);
  });

  it("reports a declaration of it nothing references at certain", () => {
    expect(found).toContain("DS1001 spare certain");
  });

  it("holds a file a test imports for its effects, and the file that one uses, beside production files", () => {
    expect(found.filter((line) => line.includes(" seed "))).toEqual([]);
  });

  it("leaves out a file production code imports, so a declaration only a test references there is certain", () => {
    expect(found).toContain("DS1004 shared certain");
  });

  it("leaves out a file only a test reaches that carries no test evidence, which stays production code", () => {
    expect(found).toContain("DS1004 plain certain");
  });
});

/** An application whose test hands a two-member interface of test-support code to a helper. */
const SINK_PROJECT: Readonly<Record<string, string>> = {
  "package.json":
    '{ "name": "@example/app", "type": "module", "main": "./main.ts", "devDependencies": { "vitest": "5.0.0" } }\n',
  "node_modules/vitest/package.json":
    '{ "name": "vitest", "version": "5.0.0", "types": "./index.d.ts" }\n',
  "node_modules/vitest/index.d.ts": "export {};\n",
  "main.ts": "console.log(1);\n",
  "support/sink.ts":
    'import "vitest";\n\n' +
    "export interface Sink {\n  put(v: number): void;\n  flush(): void;\n}\n\nexport function drain(sink: Sink): void {\n  sink.put(1);\n  sink.flush();\n}\n",
  "sink.test.ts":
    'import { drain } from "./support/sink.js";\n\ndrain({ put(): void {}, flush(): void {} });\n',
};

describe("a test-support interface test code references", () => {
  it("is test code a test reference keeps live, with its members, and only its own file names it", () => {
    const root = writeProject(SINK_PROJECT);
    roots.push(root);
    const repository = JSON.stringify({
      target: { kind: "application" },
      analysis: { min_confidence: "possible" },
    });
    const { config } = resolve({ repository, repositoryLabel: "deadset.json" });
    expect(
      findingsOf(emitterInputOf(root, config)).map(
        (finding) => `${finding.code} ${finding.symbol.name}`,
      ),
    ).toEqual(["DS1104 Sink"]);
  });
});

describe("a file the test runner's configuration names as a setup file", () => {
  /** The findings in `registry.ts` of an application whose setup file at `setup` clears it. */
  const registryFindings = (configuration: string, setup: string): string[] => {
    const root = writeProject({
      "package.json":
        '{ "name": "@example/app", "type": "module", "main": "./main.ts", "devDependencies": { "vitest": "5.0.0" } }\n',
      "node_modules/vitest/package.json":
        '{ "name": "vitest", "version": "5.0.0", "types": "./index.d.ts" }\n',
      "node_modules/vitest/index.d.ts": "export {};\n",
      "main.ts": "console.log(1);\n",
      "vitest.config.ts": configuration,
      [setup]: `import { clear } from "${setup.includes("/") ? ".." : "."}/registry.js";\n\nclear();\n`,
      "registry.ts":
        'import "vitest";\n\n' +
        "const held: number[] = [];\n\nexport function record(one: number): void {\n  held.push(one);\n}\n\nexport function clear(): void {\n  held.length = 0;\n}\n",
      "app.test.ts": 'import { record } from "./registry.js";\n\nrecord(1);\n',
    });
    roots.push(root);
    const repository = JSON.stringify({
      target: { kind: "application" },
      analysis: { min_confidence: "possible" },
    });
    const { config } = resolve({ repository, repositoryLabel: "deadset.json" });
    return findingsOf(emitterInputOf(root, config))
      .filter((finding) => finding.position.path === "registry.ts")
      .map((finding) => `${finding.code} ${finding.symbol.name} ${finding.reachabilityClass}`)
      .sort();
  };
  const TEST_CODE: string[] = [];

  it("is a test file, so what only it and test code reference is test code", () => {
    expect(
      registryFindings(
        'export default { test: { setupFiles: ["./registry-setup.ts"] } };\n',
        "registry-setup.ts",
      ),
    ).toEqual(TEST_CODE);
  });

  it("is a test file where the configuration names it as a global setup file", () => {
    expect(
      registryFindings(
        'export default { test: { globalSetup: "./registry-setup.ts" } };\n',
        "registry-setup.ts",
      ),
    ).toEqual(TEST_CODE);
  });

  it("is read against the project root the configuration moves, test.root before root", () => {
    expect(
      registryFindings(
        'export default { root: "./test", test: { setupFiles: "./registry-setup.ts" } };\n',
        "test/registry-setup.ts",
      ),
    ).toEqual(TEST_CODE);
    expect(
      registryFindings(
        'export default { root: "./elsewhere", test: { root: "test", setupFiles: ["./registry-setup.ts"] } };\n',
        "test/registry-setup.ts",
      ),
    ).toEqual(TEST_CODE);
  });

  it("is not read where the project root is not a string literal", () => {
    expect(
      registryFindings(
        'export default { root: process.cwd(), test: { setupFiles: "./test/registry-setup.ts" } };\n',
        "test/registry-setup.ts",
      ),
    ).toEqual(["DS1004 record certain"]);
  });
});

function fileAt(path: string): InventorySymbol {
  return {
    id: `${path}:1:1`,
    ref: `ts://@example/app/${path}#`,
    name: path,
    kind: "file",
    position: { path, line: 1, column: 1 },
    endLine: 1,
    parent: "",
    exported: false,
    visibility: "public",
    static: false,
  };
}

function imports(from: string, to: string, consumer?: string): Reference {
  return {
    from: `${from}:1:1`,
    to: `${to}:1:1`,
    position: { path: from, line: 1, column: 1 },
    use: "read",
    resolution: "batch",
    test: from.endsWith(".test.ts"),
    ...(consumer === undefined ? {} : { consumer }),
  };
}

/** Evidence where every file imports the test runner. */
function runnerEverywhere(paths: readonly string[]): TestEvidence {
  return {
    imports: new Map(paths.map((path) => [path, ["vitest"]])),
    devDependency: () => true,
  };
}

function supportOf(
  paths: readonly string[],
  references: readonly Reference[],
  roots: readonly Root[] = [],
  evidence: TestEvidence = runnerEverywhere(paths),
): string[] {
  const tests = paths.filter((path) => path.endsWith(".test.ts"));
  return [...testSupportFiles(paths.map(fileAt), references, roots, tests, evidence)];
}

describe("the test-support files of a run", () => {
  it("are the files a test reaches, and no other", () => {
    expect(
      supportOf(["a.test.ts", "helper.ts", "main.ts"], [imports("a.test.ts", "helper.ts")]),
    ).toEqual(["helper.ts"]);
  });

  it("keep a file a loaded consumer also imports", () => {
    expect(
      supportOf(
        ["a.test.ts", "helper.ts"],
        [imports("a.test.ts", "helper.ts"), imports("consumer/use.ts", "helper.ts", "consumer")],
      ),
    ).toEqual(["helper.ts"]);
  });

  it("keep a file whose declaration only a type-error skip roots, and drop one another root names", () => {
    const paths = ["a.test.ts", "skipped.ts", "configured.ts"];
    const references = [imports("a.test.ts", "skipped.ts"), imports("a.test.ts", "configured.ts")];

    expect(
      supportOf(paths, references, [
        { id: "skipped.ts:1:1", kind: "type-error", source: "" },
        { id: "configured.ts:1:1", kind: "configured", source: "configured.ts" },
      ]),
    ).toEqual(["skipped.ts"]);
  });

  it("drop a file whose only users beside the tests are files dropped before it", () => {
    expect(
      supportOf(
        ["a.test.ts", "inner.ts", "outer.ts", "main.ts"],
        [
          imports("a.test.ts", "inner.ts"),
          imports("a.test.ts", "outer.ts"),
          imports("outer.ts", "inner.ts"),
          imports("main.ts", "outer.ts"),
        ],
      ),
    ).toEqual([]);
  });

  it("hold only files carrying test evidence: a test runner or library import, or only test-used devDependencies", () => {
    const paths = [
      "a.test.ts",
      "runner.ts",
      "library.ts",
      "mocks.ts",
      "shared-dev.ts",
      "runtime.ts",
      "bare.ts",
      "main.ts",
    ];
    const references = paths
      .filter((path) => path !== "a.test.ts" && path !== "main.ts")
      .map((path) => imports("a.test.ts", path));
    const evidence: TestEvidence = {
      imports: new Map([
        ["a.test.ts", ["vitest", "msw"]],
        ["runner.ts", ["node:test", "./bare.js"]],
        ["library.ts", ["@testing-library/dom"]],
        ["mocks.ts", ["msw", "msw/node"]],
        ["shared-dev.ts", ["msw", "esbuild"]],
        ["runtime.ts", ["zod"]],
        ["bare.ts", ["./runtime.js"]],
        ["main.ts", ["esbuild"]],
      ]),
      devDependency: (_path, name) => name !== "zod",
    };

    expect(supportOf(paths, references, [], evidence).sort()).toEqual([
      "library.ts",
      "mocks.ts",
      "runner.ts",
    ]);
  });

  it("drop a file whose devDependency another file imports that production code turns out to use", () => {
    const paths = ["a.test.ts", "shared.ts", "support.ts", "main.ts"];
    const evidence: TestEvidence = {
      imports: new Map([
        ["shared.ts", ["msw"]],
        ["support.ts", ["msw"]],
      ]),
      devDependency: () => true,
    };

    expect(
      supportOf(
        paths,
        [
          imports("a.test.ts", "shared.ts"),
          imports("a.test.ts", "support.ts"),
          imports("main.ts", "shared.ts"),
        ],
        [],
        evidence,
      ),
    ).toEqual([]);
  });

  it("read a Node built-in, bare or under the node: scheme, as no package", () => {
    const paths = ["a.test.ts", "bare.ts", "scheme.ts"];
    const evidence: TestEvidence = {
      imports: new Map([
        ["bare.ts", ["fs", "fs/promises", "msw"]],
        ["scheme.ts", ["node:fs", "msw"]],
      ]),
      devDependency: (_path, name) => name === "msw",
    };

    expect(
      supportOf(
        paths,
        [imports("a.test.ts", "bare.ts"), imports("a.test.ts", "scheme.ts")],
        [],
        evidence,
      ).sort(),
    ).toEqual(["bare.ts", "scheme.ts"]);
  });
});
