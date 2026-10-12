import { describe, expect, it } from "vitest";
import { analyzeProject, type AnalyzeOptions } from "../__test-helpers__/projects.ts";
import { positionKey } from "./position.ts";

const ESM = '{ "name": "@example/stores", "type": "module" }\n';

function usesOf(
  lines: readonly string[],
  names: readonly string[],
  others: Readonly<Record<string, string>> = { "package.json": ESM },
): string[] {
  const analyzed = analyzeProject(
    { ...others, "main.ts": `${lines.join("\n")}\n` },
    { references: { testFiles: [] } },
  );
  const named = new Map(
    (analyzed.inventories[0]?.symbols ?? []).map((symbol) => [symbol.id, symbol.name]),
  );
  return (analyzed.references[0]?.references ?? []).flatMap((reference) => {
    const name = named.get(reference.to) ?? "";
    return reference.position.path === "main.ts" && names.includes(name)
      ? [`${positionKey(reference.position).slice("main.ts:".length)} ${name} ${reference.use}`]
      : [];
  });
}

describe("a store", () => {
  it("only writes its target where its value is discarded", () => {
    expect(
      usesOf(
        [
          "export let a = 0, b = 0, c = 0, d = 0, e = 0;",
          "(a += 1);",
          "for (b += 1; ; ) break;",
          "for (; ; c += 1) break;",
          "d += 1, void 0;",
          "e--;",
        ],
        ["a", "b", "c", "d", "e"],
      ),
      "a parenthesized statement, a loop's initializer and incrementor, a comma's left " +
        "operand, and a decrement statement",
    ).toEqual(["2:2 a write", "3:6 b write", "4:10 c write", "5:1 d write", "6:1 e write"]);
  });

  it("writes and reads its target where its value is used", () => {
    expect(
      usesOf(
        [
          "export let a = 0, b = 0, c = 0, d = 0, e = 0, f = false;",
          "export const first = (a += 1);",
          "export const second = b++;",
          "for (; c += 1; ) break;",
          "export const fourth = (d += 1) + 1;",
          "void 0, e += 1;",
          "f ||= true;",
        ],
        ["a", "b", "c", "d", "e", "f"],
      ),
      "an initializer, a loop's condition, an operand, a comma's right operand, and a " +
        "logical assignment, which reads its target to decide whether to store",
    ).toEqual([
      "2:23 a read",
      "2:23 a write",
      "3:23 b read",
      "3:23 b write",
      "4:8 c read",
      "4:8 c write",
      "5:24 d read",
      "5:24 d write",
      "6:9 e read",
      "6:9 e write",
      "7:1 f read",
      "7:1 f write",
    ]);
  });

  it("only writes the target of a plain assignment whose value is used", () => {
    expect(
      usesOf(["export let a = 0;", "export const stored = (a = 1);"], ["a"]),
      "the value is the one assigned, so nothing reads the target",
    ).toEqual(["2:24 a write"]);
  });

  it("is no operator that only reads its operands", () => {
    expect(
      usesOf(
        [
          "export let a = 0;",
          "export const negated = !a, minus = -a;",
          "export const compared = a === 1, summed = a + 1;",
        ],
        ["a"],
      ),
      "a unary operator, a comparison and an arithmetic operator",
    ).toEqual(["2:25 a read", "2:37 a read", "3:25 a read", "3:43 a read"]);
  });

  it("writes every name a destructuring assignment or a loop binds into", () => {
    expect(
      usesOf(
        [
          "export let a = 0, b = 0, c = 0, d = 0, e = {}, f = 0, g: number[] = [];",
          "[a, b] = [1, 2];",
          "({ key: c } = { key: 1 });",
          "({ d } = { d: 1 });",
          "({ ...e } = { other: 1 });",
          "for (f of [1]) break;",
          "[...g] = [1];",
        ],
        ["a", "b", "c", "d", "e", "f", "g"],
      ),
      "an array pattern, a property, a shorthand, an object rest, a loop's variable " +
        "declared elsewhere, and an array rest",
    ).toEqual([
      "2:2 a write",
      "2:5 b write",
      "3:9 c write",
      "4:4 d write",
      "5:7 e write",
      "6:6 f write",
      "7:5 g write",
    ]);
  });

  it("through an element access reads the member it stores into, and a delete writes the member", () => {
    expect(
      usesOf(
        [
          "export class Box {",
          "  items: number[] = [];",
          "  spare?: number;",
          "}",
          "export const box = new Box();",
          "box.items[0] = 1;",
          "delete box.spare;",
        ],
        ["Box.items", "Box.spare"],
      ),
      "a store through a member's value lands in storage every holder of the value reads",
    ).toEqual(["6:5 Box.items read", "7:12 Box.spare write"]);
  });
});

describe("an object literal", () => {
  const SHAPE = [
    "export interface Inner {",
    "  b: number;",
    "}",
    "export interface Shape {",
    "  a: number;",
    "  inner: Inner;",
    "}",
    "export declare const shape: Shape;",
    "export let x = 0;",
  ];

  it("destructured by an assignment reads the members it names and writes none", () => {
    expect(
      usesOf(
        [
          ...SHAPE,
          "({ a: x } = shape);",
          "[{ a: x }] = [shape];",
          "({ inner: { b: x } } = shape);",
          "for ({ a: x } of [shape]) break;",
        ],
        ["Shape.a", "Shape.inner", "Inner.b"],
      ),
      "parenthesized, inside an array pattern, nested in a property, and a loop's pattern",
    ).toEqual([
      "10:4 Shape.a read",
      "10:13 Shape.a read",
      "11:4 Shape.a read",
      "11:14 Shape.a read",
      "11:15 Shape.a read",
      "12:4 Shape.inner read",
      "12:13 Inner.b read",
      "12:24 Shape.inner read",
      "13:8 Shape.a read",
    ]);
  });

  it("destructured by an assignment is no literal the checker is asked a contextual type for", () => {
    const analyzed = analyzeProject(
      {
        "package.json": ESM,
        "main.ts": [
          ...SHAPE,
          "[{ a: x }] = [shape];",
          "({ inner: { b: x } } = shape);",
          "for ({ a: x } of [shape]) break;",
          "",
        ].join("\n"),
      },
      { references: { testFiles: [] } },
    );

    expect(
      analyzed.references[0]?.cost.contextualBatches,
      "one batch for the type of each value the patterns destructure and one for the type " +
        "its position expects; no literal is asked about, because the file writes none",
    ).toBe(2);
  });

  it("written where a type is expected writes the members of that type", () => {
    expect(
      usesOf(
        [
          ...SHAPE,
          "let kept: Shape = shape;",
          "kept = { a: 3, inner: { b: 4 } };",
          "export const either: Shape = { a: 5, inner: { b: 6 } } || kept;",
        ],
        ["Shape.a", "Shape.inner", "Inner.b"],
      ),
      "as an assignment's value, and as a logical operator's left operand",
    ).toEqual([
      "11:10 Shape.a write",
      "11:16 Shape.inner write",
      "11:25 Inner.b write",
      "12:32 Shape.a write",
      "12:38 Shape.inner write",
      "12:47 Inner.b write",
    ]);
  });
});

describe("a write's alone bindings", () => {
  function aloneOf(files: Readonly<Record<string, string>>): string[] {
    const analyzed = analyzeProject(files, { references: { testFiles: [] } });
    return (analyzed.references[0]?.references ?? []).flatMap((reference) =>
      reference.alone === undefined
        ? []
        : [`${positionKey(reference.position)} ${reference.alone.join(" ")}`],
    );
  }

  it("name each import binding only the values the write stores use", () => {
    expect(
      aloneOf({
        "package.json": ESM,
        "helper.ts": "export const named = 1;\nexport default 2;\n",
        "main.ts": [
          'import { named } from "./helper.js";',
          'import fallback from "./helper.js";',
          'import * as space from "./helper.js";',
          "export let slot: unknown;",
          "slot = [named, fallback, space];",
          "",
        ].join("\n"),
      }),
      "a named, a default and a namespace import",
    ).toEqual(["main.ts:5:1 fallback named space"]);
  });

  function helper(...names: readonly string[]): string {
    return names.map((name) => `export const ${name} = 1;\n`).join("");
  }

  it("name what a plain assignment stores through a member or parentheses, and nothing a compound one does", () => {
    expect(
      aloneOf({
        "package.json": ESM,
        "helper.ts": helper("one", "two", "three", "four"),
        "main.ts": [
          'import { one, two, three, four } from "./helper.js";',
          "class Box {",
          "  slot: unknown = 0;",
          "  other: unknown = 0;",
          "}",
          "export const box = new Box();",
          "export let slot: unknown;",
          "export let count = 0;",
          "box.slot = [one];",
          "(box.other) = [two];",
          "(slot) = [three];",
          "count += four;",
          "",
        ].join("\n"),
      }),
    ).toEqual(["main.ts:9:5 one", "main.ts:10:6 two", "main.ts:11:2 three"]);
  });

  it("name no binding the file uses anywhere but the values written into the one declaration", () => {
    expect(
      aloneOf({
        "package.json": ESM,
        "helper.ts": helper("before", "after", "shared", "kept"),
        "main.ts": [
          'import { before, after, shared, kept } from "./helper.js";',
          "class Holder {",
          "  kept = 1;",
          "}",
          "const holder = new Holder();",
          "const local = 2;",
          "export let a: unknown;",
          "export let b: unknown;",
          "export let c: unknown;",
          "export let d: unknown;",
          "console.log(before);",
          "a = [before];",
          "b = [after];",
          "console.log(after);",
          "c = [shared];",
          "d = [shared, local, holder.kept];",
          "",
        ].join("\n"),
      }),
      "a binding used before or after the write, one stored into another declaration as " +
        "well, a local that is no binding, and a member named like a binding",
    ).toEqual([]);
  });

  it("name a binding at each write into one declaration that uses it, and at no write that does not", () => {
    expect(
      aloneOf({
        "package.json": ESM,
        "helper.ts": helper("first", "second"),
        "main.ts": [
          'import { first, second } from "./helper.js";',
          'import * as space from "./helper.js";',
          "export let a: unknown;",
          "export let b: unknown;",
          "export let c: unknown;",
          "a = [first];",
          "a = [first, second];",
          "b = [second];",
          "b = 3;",
          "c = [space.first];",
          "",
        ].join("\n"),
      }),
      "`second` reaches `a` and `b` both, so it is alone in neither, and the member a " +
        "property access names is no binding while the namespace it is read from is",
    ).toEqual(["main.ts:6:1 first", "main.ts:7:1 first", "main.ts:10:1 space"]);
  });

  it("name nothing at a read a position's type makes of a value it is handed", () => {
    expect(
      aloneOf({
        "package.json": ESM,
        "helper.ts": [
          "export interface Target {",
          "  id: number;",
          "}",
          "export function take(target: Target): number {",
          "  return target.id;",
          "}",
          "",
        ].join("\n"),
        "main.ts": [
          'import { take } from "./helper.js";',
          "interface Source {",
          "  id: number;",
          "  extra: number;",
          "}",
          "const source: Source = { id: 1, extra: 2 };",
          "take(source);",
          "",
        ].join("\n"),
      }),
      "the call reads `Source.id` through `take`, which stores nothing",
    ).toEqual([]);
  });

  it("name an import assignment the values the write stores use", () => {
    expect(
      aloneOf({
        "package.json": '{ "name": "@example/stores" }\n',
        "helper.ts": "export const named = 1;\n",
        "main.ts":
          'import whole = require("./helper");\nexport let slot: unknown;\nslot = whole;\n',
      }),
    ).toEqual(["main.ts:3:1 whole"]);
  });
});

function onLine(
  lines: readonly string[],
  line: number,
  options: Omit<AnalyzeOptions, "references"> = {},
): string[] {
  const analyzed = analyzeProject(
    { "package.json": ESM, "main.ts": `${lines.join("\n")}\n` },
    { ...options, references: { testFiles: [] } },
  );
  const named = new Map(
    (analyzed.inventories[0]?.symbols ?? []).map((symbol) => [symbol.id, symbol.name]),
  );
  return (analyzed.references[0]?.references ?? []).flatMap((reference) =>
    reference.position.path === "main.ts" && reference.position.line === line
      ? [
          `${String(reference.position.column)} ${named.get(reference.to) ?? reference.to} ${reference.use} ${reference.resolution}`,
        ]
      : [],
  );
}

describe("a use of a property an object literal declares", () => {
  it("reads each member the literal's property writes, once, and nothing where it writes none", () => {
    expect(
      onLine(
        [
          "interface Shape {",
          "  a: number;",
          "  b?: number;",
          "}",
          "interface Other {",
          "  a: number;",
          "}",
          "declare const flag: boolean;",
          "export const one = { a: 1 } satisfies Shape;",
          "export const plain = { a: 2 };",
          "export const either = (flag ? { a: 3 } : { a: 4, b: 5 }) satisfies Shape;",
          "export const both = { a: 6 } satisfies Shape | Other;",
          "console.log(one.a, plain.a, either.a, both.a);",
        ],
        13,
      ),
      "a literal a type checks, one no type checks, two literals of one value's union, and " +
        "a literal two types check",
    ).toEqual([
      "13 one read batch",
      "17 Shape.a read alias",
      "20 plain read batch",
      "29 either read batch",
      "36 Shape.a read alias",
      "39 both read batch",
      "44 Shape.a read alias",
      "44 Other.a read alias",
    ]);
  });
});

describe("a destructured property the checker leaves unanswered", () => {
  it("reads by name every declaration bearing its name, and nothing where none does", () => {
    expect(
      onLine(
        [
          "export const length = 1;",
          "declare const source: { length: number; size: number };",
          "export const { length: count, size: total } = source;",
        ],
        3,
        { panicsOn: (accessor) => accessor === "getTypeAtLocation" },
      ),
    ).toEqual(["16 length read by-name", "47 source read batch"]);
  });
});
