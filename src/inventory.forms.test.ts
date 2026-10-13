import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitterInputOf, findingsOf } from "../__test-helpers__/emitter-input.ts";
import { analyzeProject, analyzeRoot, writeProject } from "../__test-helpers__/projects.ts";
import type { InventorySymbol } from "./inventory.ts";
import { resolve } from "./resolve.ts";

/** One project's declarations as `<kind> <name> <line>-<end line>`, in inventory order. */
function declared(files: Readonly<Record<string, string>>): string[] {
  return (analyzeProject(files).inventories[0]?.symbols ?? []).map(
    (symbol) =>
      `${symbol.kind} ${symbol.name} ${String(symbol.position.line)}-${String(symbol.endLine)}`,
  );
}

function refsOf(symbols: readonly InventorySymbol[] | undefined, kind: string): string[] {
  return (symbols ?? []).filter((symbol) => symbol.kind === kind).map((symbol) => symbol.ref);
}

describe("a declaration form", () => {
  it("is a variable for each name a destructuring pattern binds, but one beside a rest element or with a default", () => {
    expect(
      declared({
        "src/unit.ts":
          "export const { a, b: { c } } = { a: 1, b: { c: 2 } };\nexport const [d, [e]] = [3, [4]];\nexport const { f, ...g } = { f: 5, h: 6 };\nexport const { i = 7 } = {} as { i?: number };\n",
      }),
    ).toEqual([
      "file src/unit.ts 1-4",
      "variable a 1-1",
      "variable c 1-1",
      "variable d 2-2",
      "variable e 2-2",
      "variable g 3-3",
    ]);
  });

  it("reports a name an exported destructuring binds that nothing imports", () => {
    const root = writeProject({
      "package.json": '{ "name": "@example/forms", "private": true, "type": "module" }\n',
      "src/main.ts": 'import { a } from "./unit.js";\nconsole.log(a);\n',
      "src/unit.ts": "export const { a, b } = { a: 1, b: 2 };\n",
    });
    try {
      const { config } = resolve({
        repository: JSON.stringify({
          target: { kind: "application" },
          ts: { entry_files: ["src/main.ts"] },
        }),
        repositoryLabel: "deadset.json",
      });
      expect(
        findingsOf(emitterInputOf(root, config)).map(
          (finding) => `${finding.code} ${finding.symbol.ref} ${finding.fixability}`,
        ),
      ).toEqual(["DS1001 ts://@example/forms/src/unit.ts#b deletable"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names a numeric and a quoted key by the value it denotes", () => {
    const analyzed = analyzeProject({
      "src/unit.ts":
        "export interface Keys {\n" +
        "  10: number;\n" +
        '  "quoted name": string;\n' +
        "  'single': boolean;\n" +
        "}\n",
    });

    expect(refsOf(analyzed.inventories[0]?.symbols, "type-member")).toEqual([
      "ts://./src/unit.ts#Keys.'10'",
      "ts://./src/unit.ts#Keys.'quoted name'",
      "ts://./src/unit.ts#Keys.single",
    ]);
  });

  it("ends a type parameter on the line its own text ends", () => {
    expect(
      declared({
        "src/unit.ts": "export function pick<\n  Key\n>(key: Key): Key {\n  return key;\n}\n",
      }),
    ).toEqual(["file src/unit.ts 1-5", "function pick 1-5", "type-parameter pick<Key> 2-2"]);
  });

  it("declares each namespace of a dotted name, and what the innermost one declares", () => {
    expect(
      declared({ "src/unit.ts": "export namespace Outer.Inner {\n  export const deep = 1;\n}\n" }),
    ).toEqual([
      "file src/unit.ts 1-3",
      "namespace Outer 1-3",
      "namespace Outer.Inner 1-3",
      "variable Outer.Inner.deep 2-2",
    ]);
  });

  it("makes one member of an interface's or a type literal's accessor pair, spanning both", () => {
    expect(
      declared({
        "src/unit.ts":
          "export interface Gauge {\n" +
          "  get level(): number;\n" +
          "  set level(value: number);\n" +
          "  read(): number;\n" +
          "}\n" +
          "export type Dial = {\n" +
          "  get angle(): number;\n" +
          "  set angle(value: number);\n" +
          "  turn(): void;\n" +
          "};\n",
      }),
    ).toEqual([
      "file src/unit.ts 1-10",
      "interface Gauge 1-5",
      "type-member Gauge.level 2-3",
      "interface-method Gauge.read 4-4",
      "type Dial 6-10",
      "type-member Dial.angle 7-8",
      "type-member Dial.turn 9-9",
    ]);
  });

  it("is an export alias whose reference names the ambient module that writes it", () => {
    const analyzed = analyzeProject({
      "src/wire.d.ts": 'declare module "wire" {\n  const port: number;\n  export { port };\n}\n',
    });

    expect(refsOf(analyzed.inventories[0]?.symbols, "export-alias")).toEqual([
      "ts://./src/wire.d.ts#'wire'.port:alias",
    ]);
  });
});

describe("a member of a declaration another file merges with", () => {
  it("is kept under the declaration that writes it alone, wherever its offset falls", () => {
    const analyzed = analyzeProject({
      "src/base.ts": `export interface Registry {\n  base: number;\n${"  // padding\n".repeat(20)}}\n`,
      "src/augment.ts":
        'import "./base.ts";\ndeclare module "./base.ts" {\n  interface Registry {\n    extra: number;\n  }\n}\n',
    });

    expect(
      (analyzed.inventories[0]?.symbols ?? [])
        .filter((symbol) => symbol.kind === "type-member")
        .map((symbol) => `${symbol.ref} ${symbol.position.path}:${String(symbol.position.line)}`),
    ).toEqual([
      "ts://./src/augment.ts#'./base.ts'.Registry.extra src/augment.ts:4",
      "ts://./src/base.ts#Registry.base src/base.ts:2",
    ]);
  });
});

describe("an accessor pair's setter", () => {
  it("holds the code written in it, so what only a dead setter calls is dead", () => {
    const root = writeProject({
      "package.json": '{ "name": "@example/gauge", "private": true, "type": "module" }\n',
      "src/main.ts":
        "class Gauge {\n" +
        "  get level(): number {\n" +
        "    return 1;\n" +
        "  }\n" +
        "  set level(value: number) {\n" +
        "    record(value);\n" +
        "  }\n" +
        "}\n" +
        "function record(value: number): void {\n" +
        "  console.log(value);\n" +
        "}\n" +
        "console.log(new Gauge());\n",
    });
    try {
      const { config } = resolve({
        repository: JSON.stringify({
          target: { kind: "application" },
          ts: { entry_files: ["src/main.ts"] },
        }),
        repositoryLabel: "deadset.json",
      });

      expect(
        findingsOf(emitterInputOf(root, config)).map(
          (finding) => `${finding.code} ${finding.symbol.name} ${String(finding.position.line)}`,
        ),
      ).toEqual(["DS1003 Gauge.level 2", "DS1002 record 9"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a file its program holds outside the target root", () => {
  it("ends the enumeration, naming the file and the root", () => {
    const root = writeProject({
      "app/tsconfig.json": JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "nodenext", noEmit: true },
        include: ["*.ts", "../lib/*.ts"],
      }),
      "app/main.ts": "export const main = 1;\n",
      "lib/shared.ts": "export const shared = 2;\n",
    });
    try {
      expect(() => analyzeRoot(join(root, "app"))).toThrow(
        `${join(root, "lib", "shared.ts")} is not below ${join(root, "app")}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
