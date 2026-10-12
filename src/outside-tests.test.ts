import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { emitterInputOf, findingsOf } from "../__test-helpers__/emitter-input.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { resolve } from "./resolve.ts";

const DECLARED_MATRIX = JSON.stringify({
  target: { kind: "application" },
  analysis: { configurations: [{ id: "app", project: "tsconfig.json" }] },
});

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function findingsBeside(files: Readonly<Record<string, string>>): string[] {
  const root = writeProject({
    "package.json": '{ "name": "@example/app", "type": "module", "main": "./src/main.ts" }\n',
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: { strict: true, module: "NodeNext", noEmit: true },
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    })}\n`,
    "src/main.ts": "console.log(1);\n",
    ...files,
  });
  roots.push(root);
  const { config } = resolve({ repository: DECLARED_MATRIX, repositoryLabel: "deadset.json" });
  return findingsOf(emitterInputOf(root, config)).map(
    (finding) => `${finding.code} ${finding.symbol.name}`,
  );
}

const HOOKS = "export function forTests(): number {\n  return 1;\n}\n";

const UNREFERENCED = ["DS1001 forTests", "DS1502 src/hooks.ts"];

describe("a test file no configuration of the run holds", () => {
  it.each([
    [
      "a sibling file the specifier names from a subdirectory",
      "src/sub/main.test.ts",
      "../hooks.js",
    ],
    [
      "a file below the target root, from a test file at the root",
      "main.test.ts",
      "./src/hooks.js",
    ],
  ])("references %s", (_, path, specifier) => {
    expect(
      findingsBeside({
        "src/hooks.ts": HOOKS,
        [path]: `import { forTests } from "${specifier}";\n\nconsole.log(forTests());\n`,
      }),
    ).toEqual([]);
  });

  it("references no own file through a bare specifier spelled as its name", () => {
    expect(
      findingsBeside({
        "src/hooks.ts": HOOKS,
        "src/main.test.ts": 'import { forTests } from "hooks";\n\nconsole.log(forTests());\n',
      }),
    ).toEqual(UNREFERENCED);
  });

  it("references nothing through a call other than import() whose argument is a path", () => {
    expect(
      findingsBeside({
        "src/hooks.ts": HOOKS,
        "src/main.test.ts":
          'declare function register(path: string): void;\n\nregister("./hooks.js");\n',
      }),
    ).toEqual(UNREFERENCED);
  });

  it("evaluates the file a star re-export names, and reads no export of it", () => {
    expect(
      findingsBeside({
        "src/hooks.ts": HOOKS,
        "src/main.test.ts": 'export * from "./hooks.js";\n',
      }),
    ).toEqual(["DS1001 forTests"]);
  });

  it.each([
    ["a named import", 'import { other } from "./hooks.js";\n\nconsole.log(other);\n'],
    ["a default import", 'import other from "./hooks.js";\n\nconsole.log(other);\n'],
    ["a named re-export", 'export { other } from "./hooks.js";\n'],
  ])("references nothing through %s of a name the file does not export", (_, test) => {
    expect(findingsBeside({ "src/hooks.ts": HOOKS, "src/main.test.ts": test })).toEqual(
      UNREFERENCED,
    );
  });

  it("reads no default export through a named import", () => {
    expect(
      findingsBeside({
        "src/hooks.ts": `${HOOKS}\nexport default function page(): number {\n  return 2;\n}\n`,
        "src/main.test.ts": 'import { forTests } from "./hooks.js";\n\nconsole.log(forTests());\n',
      }),
    ).toEqual(["DS1001 page"]);
  });

  it("references nothing through a named import of an unexported declaration", () => {
    expect(
      findingsBeside({
        "src/hooks.ts":
          "function hidden(): number {\n  return 0;\n}\n\nexport function forTests(): number {\n  return hidden();\n}\n",
        "src/main.test.ts": 'import { hidden } from "./hooks.js";\n\nconsole.log(hidden());\n',
      }),
    ).toEqual(["DS1002 hidden", ...UNREFERENCED]);
  });

  it("references an export whose name is a string through an import of that name", () => {
    expect(
      findingsBeside({
        "src/hooks.ts": 'const value = 1;\n\nexport { value as "a:aliased" };\n',
        "src/main.test.ts":
          'import { "a:aliased" as value } from "./hooks.js";\n\nconsole.log(value);\n',
      }),
    ).toEqual([]);
  });

  it("makes an export production code also imports used only by tests, with what only it calls", () => {
    expect(
      findingsBeside({
        "src/lib.ts":
          "export function a(): number {\n  return 1;\n}\n\nfunction c(): number {\n  return 3;\n}\n\nexport function b(): number {\n  return c();\n}\n",
        "src/main.ts": 'import { a } from "./lib.js";\n\nconsole.log(a());\n',
        "src/main.test.ts": 'import { b } from "./lib.js";\n\nconsole.log(b());\n',
      }),
    ).toEqual(["DS1002 c", "DS1004 b"]);
  });
});
