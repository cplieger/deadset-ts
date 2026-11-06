import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitterInputOf, findingsOf } from "../../__test-helpers__/emitter-input.ts";
import { writeProject } from "../../__test-helpers__/projects.ts";
import { resolve } from "../resolve.ts";
import { openEngine, type Engine } from "../session.ts";

const TSCONFIG = `${JSON.stringify({
  compilerOptions: { strict: true, target: "ESNext", module: "NodeNext", noEmit: true },
  include: ["**/*.ts"],
})}\n`;

/**
 * Where the checker panics: an accessor, asked about the node written at the first `marker`
 * of `main.ts`, or with no marker asked anything.
 */
interface Panic {
  readonly accessor: string;
  readonly marker?: string;
}

/**
 * Each finding of the application `main.ts` is the one file and entry of, as `<code> <name>`,
 * while the checker panics on every question through the panic's accessor that names the
 * node written at its marker. A node's location is its full start, which a node after a
 * space starts one before the marker.
 */
function findings(main: string, panic?: Panic): readonly string[] {
  const root = writeProject({
    "tsconfig.json": TSCONFIG,
    "package.json": '{ "name": "@example/rules", "private": true, "type": "module" }\n',
    "main.ts": main,
  });
  try {
    const opened = openEngine({ collectTiming: false });
    const at = panic?.marker === undefined ? -1 : main.indexOf(panic.marker);
    const file = join(root, "main.ts");
    const engine: Engine = {
      ...opened,
      ask: (accessor, locations, question) => {
        if (
          panic !== undefined &&
          accessor === panic.accessor &&
          (panic.marker === undefined ||
            locations().some(
              (one) => one === `${file}:${String(at)}` || one === `${file}:${String(at - 1)}`,
            ))
        ) {
          throw new Error(`panic: ${accessor}`);
        }
        return opened.ask(accessor, locations, question);
      },
    };
    const { config } = resolve({
      repository: {
        text: JSON.stringify({
          target: { kind: "application" },
          analysis: { min_confidence: "possible" },
          ts: { entry_files: ["main.ts"] },
        }),
        label: "deadset.json",
      },
    });
    return findingsOf(emitterInputOf(root, config, { engine })).map(
      (finding) => `${finding.code} ${finding.symbol.name}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The findings among `found` about the declaration `name`. */
function about(found: readonly string[], name: string): readonly string[] {
  return found.filter((one) => one.endsWith(` ${name}`));
}

describe("a read rule whose question the checker leaves unanswered", () => {
  it("holds the members an element access's index could name", () => {
    const main = [
      "interface Box {",
      "  a: number;",
      "  b: number;",
      "}",
      "const box: Box = { a: 1, b: 2 };",
      'const key: "a" = "a";',
      "console.log(box[key]);",
      "",
    ].join("\n");

    expect(
      about(findings(main), "Box.a"),
      "answered, the access reads the member its index names",
    ).toEqual([]);
    expect(
      about(findings(main, { accessor: "getTypeAtLocation", marker: "key]" }), "Box.a"),
      "unanswered, it holds what the index could name",
    ).toEqual([]);
  });

  it("holds the members an indexed-access type could name", () => {
    const main = [
      "interface Box {",
      "  a: number;",
      "  b: number;",
      "}",
      'export const value: Box["a"] = 1;',
      "",
    ].join("\n");

    expect(about(findings(main), "Box.a")).toEqual([]);
    expect(
      about(findings(main, { accessor: "getTypeAtLocation", marker: 'Box["a"]' }), "Box.a"),
    ).toEqual([]);
  });

  it("holds the members a key comparison's literal could name", () => {
    const main = [
      "interface Box {",
      "  a: number;",
      "  b: number;",
      "}",
      "export function pick(key: keyof Box): boolean {",
      '  return key === "a";',
      "}",
      "",
    ].join("\n");

    expect(about(findings(main), "Box.a")).toEqual([]);
    expect(
      about(findings(main, { accessor: "getTypeAtLocation", marker: '"a";' }), "Box.a"),
    ).toEqual([]);
  });

  it("holds the iteration member an iterated value could have", () => {
    const main = [
      "class Bag {",
      "  *[Symbol.iterator](): Generator<number> {",
      "    yield 1;",
      "  }",
      "}",
      "const bag = new Bag();",
      "for (const one of bag) {",
      "  console.log(one);",
      "}",
      "",
    ].join("\n");

    expect(about(findings(main), "Bag.[Symbol.iterator]")).toEqual([]);
    expect(
      about(
        findings(main, { accessor: "getTypeAtLocation", marker: "bag) {" }),
        "Bag.[Symbol.iterator]",
      ),
    ).toEqual([]);
  });

  it("holds the members a read through a type parameter could name", () => {
    const main = [
      "interface Shape {",
      "  kind: string;",
      "  size: number;",
      "}",
      "function kindOf<T extends { kind: string }>(value: T): string {",
      "  return value.kind;",
      "}",
      'const shape: Shape = { kind: "a", size: 1 };',
      "console.log(kindOf(shape), shape.size);",
      "",
    ].join("\n");

    expect(about(findings(main), "Shape.kind")).toEqual([]);
    expect(about(findings(main, { accessor: "getParameterType" }), "Shape.kind")).toEqual([]);
  });

  it("holds every member of the type an outside value is handed over as", () => {
    const main = [
      "interface Scope {",
      "  onconnect: (() => void) | null;",
      "  spare: number;",
      "}",
      "(globalThis as unknown as Scope).onconnect = () => {",
      '  console.log("connected");',
      "};",
      "",
    ].join("\n");

    expect(about(findings(main), "Scope.spare")).toEqual([]);
    expect(
      about(
        findings(main, { accessor: "getTypeAtLocation", marker: "globalThis as" }),
        "Scope.spare",
      ),
    ).toEqual([]);
  });

  it("holds the members of a class whose base goes unanswered", () => {
    const main = [
      "class Base {",
      "  run(): void {}",
      "}",
      "class Child extends Base {",
      "  override run(): void {}",
      "}",
      "const base: Base = new Child();",
      "base.run();",
      "",
    ].join("\n");

    expect(about(findings(main), "Child.run")).toEqual([]);
    expect(
      about(
        findings(main, { accessor: "getSymbolAtLocation", marker: "Base {\n  override" }),
        "Child.run",
      ),
    ).toEqual([]);
  });
});
