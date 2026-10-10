import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { emitterInputOf, findingsOf } from "../__test-helpers__/emitter-input.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { resolve } from "./resolve.ts";

/**
 * An application whose test reaches two helper files that import each other, a setup file
 * it imports for its effects, and a file production code imports too.
 */
const PROJECT: Readonly<Record<string, string>> = {
  "package.json": '{ "name": "@example/app", "type": "module", "main": "./main.ts" }\n',
  "main.ts": 'import { other } from "./shared.js";\n\nconsole.log(other());\n',
  "shared.ts":
    "export function other(): number {\n  return 1;\n}\n\nexport function shared(): number {\n  return 2;\n}\n",
  "helpers/a.ts":
    'import { b } from "./b.js";\n\nexport function a(): number {\n  return b();\n}\n',
  "helpers/b.ts":
    'import { a } from "./a.js";\n\nexport function b(): number {\n  return 1;\n}\n\nexport function twice(): number {\n  return a() + a();\n}\n\nexport function spare(): number {\n  return 3;\n}\n',
  "setup.ts": 'import { seed } from "./seeds.js";\n\nseed();\n',
  "seeds.ts": "export function seed(): void {}\n",
  "app.test.ts":
    'import { a } from "./helpers/a.js";\nimport { twice } from "./helpers/b.js";\nimport "./setup.js";\nimport { shared } from "./shared.js";\n\nconsole.log(a(), twice(), shared());\n',
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

  it("holds two files that import each other when only a test reaches them, reporting what the test references at possible", () => {
    expect(found.filter((line) => /\b(a|b|twice)\b/u.test(line.split(" ")[1] ?? ""))).toEqual([
      "DS1004 a possible",
      "DS1004 b possible",
      "DS1004 twice possible",
    ]);
  });

  it("reports a declaration of it nothing references at certain", () => {
    expect(found).toContain("DS1001 spare certain");
  });

  it("holds a file a test imports for its effects, and the file that one uses", () => {
    expect(found).toContain("DS1004 seed possible");
  });

  it("leaves out a file production code imports, so a declaration only a test references there is certain", () => {
    expect(found).toContain("DS1004 shared certain");
  });
});

/** An application whose test hands a two-member interface of test-support code to a helper. */
const SINK_PROJECT: Readonly<Record<string, string>> = {
  "package.json": '{ "name": "@example/app", "type": "module", "main": "./main.ts" }\n',
  "main.ts": "console.log(1);\n",
  "support/sink.ts":
    "export interface Sink {\n  put(v: number): void;\n  flush(): void;\n}\n\nexport function drain(sink: Sink): void {\n  sink.put(1);\n  sink.flush();\n}\n",
  "sink.test.ts":
    'import { drain } from "./support/sink.js";\n\ndrain({ put(): void {}, flush(): void {} });\n',
};

describe("a test-support interface test code references", () => {
  it("is reported at possible in a minted root component that holds the interface and its two members", () => {
    const root = writeProject(SINK_PROJECT);
    roots.push(root);
    const repository = JSON.stringify({
      target: { kind: "application" },
      analysis: { min_confidence: "possible" },
    });
    const { config } = resolve({ repository, repositoryLabel: "deadset.json" });
    const sink = findingsOf(emitterInputOf(root, config)).filter(
      (finding) => finding.symbol.name === "Sink",
    );
    expect(
      sink.map(
        ({ code, reachabilityClass, component }) =>
          `${code} ${reachabilityClass} root=${String(component.root)} symbols=${String(component.symbolCount)}`,
      ),
    ).toEqual(["DS1201 possible root=true symbols=3"]);
  });
});

describe("a file the test runner's configuration names as a setup file", () => {
  /** The findings in `registry.ts` of an application whose setup file at `setup` clears it. */
  const registryFindings = (configuration: string, setup: string): string[] => {
    const root = writeProject({
      "package.json":
        '{ "name": "@example/app", "type": "module", "main": "./main.ts", "devDependencies": { "vitest": "5.0.0" } }\n',
      "node_modules/vitest/package.json": '{ "name": "vitest", "version": "5.0.0" }\n',
      "main.ts": "console.log(1);\n",
      "vitest.config.ts": configuration,
      [setup]: `import { clear } from "${setup.includes("/") ? ".." : "."}/registry.js";\n\nclear();\n`,
      "registry.ts":
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
  const TEST_ONLY = ["DS1004 clear possible", "DS1004 held possible", "DS1004 record possible"];

  it("is a test file, so what only it and test code reference is test code", () => {
    expect(
      registryFindings(
        'export default { test: { setupFiles: ["./registry-setup.ts"] } };\n',
        "registry-setup.ts",
      ),
    ).toEqual(TEST_ONLY);
  });

  it("is read against the project root the configuration moves, test.root before root", () => {
    expect(
      registryFindings(
        'export default { root: "./test", test: { setupFiles: "./registry-setup.ts" } };\n',
        "test/registry-setup.ts",
      ),
    ).toEqual(TEST_ONLY);
    expect(
      registryFindings(
        'export default { root: "./elsewhere", test: { root: "test", setupFiles: ["./registry-setup.ts"] } };\n',
        "test/registry-setup.ts",
      ),
    ).toEqual(TEST_ONLY);
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
