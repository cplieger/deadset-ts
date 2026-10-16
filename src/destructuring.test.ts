import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitterInputOf, findingsOf } from "../__test-helpers__/emitter-input.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { analyzeProject, analyzeRoot } from "../__test-helpers__/projects.ts";
import { positionKey } from "./position.ts";
import { resolve } from "./resolve.ts";
import type { ReferenceCost } from "./references.ts";

/** The fixture holding one instance of every destructuring form, resolved once for every case. */
const TARGET = fixture("projects", "destructuring");
const ANALYZED = analyzeRoot(TARGET, { references: { testFiles: [] } });
const SYMBOLS = ANALYZED.inventories[0]?.symbols ?? [];
const RESOLVED = ANALYZED.references[0];

/** The display name of the declaration one identifier names. */
function named(id: string): string {
  return SYMBOLS.find((symbol) => symbol.id === id)?.name ?? id;
}

/** Every read a pattern makes, one line each: where, from which declaration, of which member. */
const READS: readonly string[] = (RESOLVED?.references ?? [])
  .filter((reference) => reference.resolution === "destructured")
  .map(
    (reference) =>
      `${positionKey(reference.position)} ${named(reference.from)} -> ${named(reference.to)} ${reference.use}`,
  );

/** The reads written on one line of the readers module. */
function readsAt(line: number): string[] {
  return READS.filter((read) => read.startsWith(`src/readers.ts:${String(line)}:`));
}

/** Every request the reference pass accounts for. */
function accounted(cost: ReferenceCost | undefined): number {
  return (
    (cost?.fileBatches ?? 0) +
    (cost?.residueFallbacks ?? 0) +
    (cost?.shorthandLookups ?? 0) +
    (cost?.aliasSteps ?? 0) +
    (cost?.patternBatches ?? 0) +
    (cost?.patternLookups ?? 0) +
    (cost?.contextualBatches ?? 0) +
    (cost?.contextualLookups ?? 0) +
    (cost?.typedLookups ?? 0)
  );
}

describe("the members a destructuring reads", () => {
  it("is the committed golden table, read for read", async () => {
    await expect(
      `${READS.join("\n")}\n`,
      "regenerate with `npx vitest --run src/destructuring.test.ts -u` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "destructuring.references.txt"));
  });

  it("reads a parameter's shorthand, renamed, nested, defaulted and quoted elements", () => {
    expect(readsAt(5), "a shorthand reads the member its local is named for").toEqual([
      "src/readers.ts:5:3 invoke -> Invocation.name read",
    ]);
    expect(readsAt(6), "a renamed element reads the member, not the local").toEqual([
      "src/readers.ts:6:3 invoke -> Invocation.stores read",
    ]);
    expect(readsAt(7), "a nested pattern reads its member, and the member's own").toEqual([
      "src/readers.ts:7:3 invoke -> Invocation.nested read",
      "src/readers.ts:7:13 invoke -> Inner.deep read",
    ]);
    expect(readsAt(8), "a default leaves the read in place").toEqual([
      "src/readers.ts:8:3 invoke -> Invocation.fallback read",
    ]);
    expect(readsAt(9), "a quoted key names the member it spells").toEqual([
      "src/readers.ts:9:3 invoke -> Invocation.'quoted-key' read",
    ]);
    expect(readsAt(10), "a rest element names no member").toEqual([]);
  });

  it("reads nothing where a pattern binds nothing when the program runs", () => {
    expect(
      READS.filter((read) => read.includes("typedOnly")),
      "a function type's parameter pattern",
    ).toEqual([]);
    expect(
      READS.filter((read) => read.includes(" failure ")),
      "and a catch clause's pattern over a type that declares no member",
    ).toEqual([]);
  });

  it("reads through a union, a type parameter, a class, a callback and an iteration", () => {
    expect(readsAt(20), "each constituent's member").toEqual([
      "src/readers.ts:20:11 sizeOf -> Circle.size read",
      "src/readers.ts:20:11 sizeOf -> Square.size read",
    ]);
    expect(readsAt(26), "the constraint's member").toEqual([
      "src/readers.ts:26:11 storesOf -> Invocation.stores read",
    ]);
    expect(readsAt(32)).toEqual(["src/readers.ts:32:11 slotOf -> Holder.slot read"]);
    expect(readsAt(38), "the parameter type the call supplies").toEqual([
      "src/readers.ts:38:22 keysOf -> Row.key read",
    ]);
    expect([...readsAt(45), ...readsAt(46)], "and the element an iteration binds").toEqual([
      "src/readers.ts:45:5 total -> Row.value read",
      "src/readers.ts:46:5 total -> Row.pair read",
      "src/readers.ts:46:14 total -> Inner.deep read",
    ]);
  });

  it("reads an assignment target's members off the value assigned", () => {
    expect(readsAt(76), "a plain target").toEqual(["src/readers.ts:76:6 assign -> Row.key read"]);
    expect(readsAt(78), "a target nested in a tuple element").toEqual([
      "src/readers.ts:78:5 assign -> Row.pair read",
      "src/readers.ts:78:14 assign -> Inner.deep read",
    ]);
    expect(
      readsAt(80),
      "a defaulted nested target reads the member's type, not the default's",
    ).toEqual([
      "src/readers.ts:80:6 assign -> Invocation.nested read",
      "src/readers.ts:80:16 assign -> Inner.deep read",
    ]);
    expect(readsAt(81), "an optional member's value, without its undefined").toEqual([
      "src/readers.ts:81:6 assign -> Invocation.extra read",
      "src/readers.ts:81:15 assign -> Extra.note read",
    ]);
    expect(readsAt(82), "an array literal's element").toEqual([
      "src/readers.ts:82:6 assign -> Row.value read",
    ]);
    expect(readsAt(83), "an iterated array's element").toEqual([
      "src/readers.ts:83:10 assign -> Row.key read",
    ]);
    expect(readsAt(86), "an iterated set's element, which the iteration protocol answers").toEqual([
      "src/readers.ts:86:10 assign -> Row.key read",
    ]);
    expect(readsAt(89), "and a target nested in the entry a map iterates").toEqual([
      "src/readers.ts:89:13 assign -> Row.key read",
    ]);
  });

  it("accounts for every request it makes", () => {
    expect(RESOLVED?.cost.patternBatches, "one batch for the one module holding patterns").toBe(1);
    expect(RESOLVED?.cost.typedLookups, "and the typed reads' batches of argument types").toBe(14);
    expect(ANALYZED.referenceRequests, "and the client measured no other").toBe(
      accounted(RESOLVED?.cost),
    );
  });

  it("reads an iterable's element through the iteration protocol, and by name where the protocol answers two", () => {
    const analyzed = analyzeProject(
      {
        "unit.ts": [
          "export interface Row {\n  key: string;\n}",
          "export interface Other {\n  key: string;\n}",
          'export class Bag {\n  *[Symbol.iterator](): Generator<Row> {\n    yield { key: "a" };\n  }\n}',
          'export function* mixed(): Generator<Row, Other> {\n  yield { key: "a" };\n  return { key: "b" };\n}',
          'export function read(bag: Bag): string {\n  let key = "";\n  for ({ key } of bag) {\n  }\n  for ({ key } of mixed()) {\n  }\n  return key;\n}\n',
        ].join("\n"),
      },
      { references: { testFiles: [] } },
    );
    const held = analyzed.inventories[0]?.symbols ?? [];
    const name = (id: string): string => held.find((symbol) => symbol.id === id)?.name ?? id;

    expect(
      (analyzed.references[0]?.references ?? [])
        .filter((reference) => reference.position.line >= 18 && reference.position.line <= 20)
        .filter((reference) => reference.resolution !== "batch")
        .map(
          (reference) =>
            `${positionKey(reference.position)} ${name(reference.to)} ${reference.resolution}`,
        ),
      "a generator's yielded value, and both values a generator yields and returns",
    ).toEqual([
      "unit.ts:18:10 Row.key destructured",
      "unit.ts:18:19 Bag.[Symbol.iterator] keyed",
      "unit.ts:20:10 Row.key by-name",
      "unit.ts:20:10 Other.key by-name",
    ]);
  });

  it("finds an iterable's iterator by its symbol key, and reads by name where two symbols spell it", () => {
    const analyzed = analyzeProject(
      {
        "unit.ts": [
          "export interface Row {\n  key: string;\n}",
          "export interface Other {\n  key: string;\n}",
          'export class Forged {\n  *"__@iterator@fake"(): Generator<Other> {\n    yield { key: "b" };\n  }\n  *[Symbol.iterator](): Generator<Row> {\n    yield { key: "a" };\n  }\n}',
          "declare const iterator: unique symbol;",
          'export class Named {\n  *[iterator](): Generator<Other> {\n    yield { key: "b" };\n  }\n  *[Symbol.iterator](): Generator<Row> {\n    yield { key: "a" };\n  }\n}',
          'export function read(forged: Forged, named: Named): string {\n  let key = "";\n  for ({ key } of forged) {\n  }\n  for ({ key } of named) {\n  }\n  return key;\n}\n',
        ].join("\n"),
      },
      { references: { testFiles: [] } },
    );
    const held = analyzed.inventories[0]?.symbols ?? [];
    const name = (id: string): string => held.find((symbol) => symbol.id === id)?.name ?? id;

    expect(
      (analyzed.references[0]?.references ?? [])
        .filter((reference) => reference.position.line === 26 || reference.position.line === 28)
        .filter((reference) => reference.resolution !== "batch")
        .map(
          (reference) =>
            `${positionKey(reference.position)} ${name(reference.to)} ${reference.resolution}`,
        ),
      "a string key spelled as the checker's symbol key, and a unique symbol named iterator",
    ).toEqual([
      "unit.ts:26:10 Row.key destructured",
      "unit.ts:26:19 Forged.[Symbol.iterator] keyed",
      "unit.ts:28:10 Row.key by-name",
      "unit.ts:28:10 Other.key by-name",
      "unit.ts:28:19 Named.[Symbol.iterator] keyed",
    ]);
  });

  it("reads one property table per destructured type, whatever the patterns over it", () => {
    const over = (count: number): ReferenceCost | undefined =>
      analyzeProject(
        {
          "unit.ts": [
            "export interface Shape {\n  readonly a: number;\n  readonly b: number;\n}\n",
            ...Array.from(
              { length: count },
              (_, index) =>
                `export function read${String(index)}({ a, b }: Shape): number {\n  return a + b;\n}\n`,
            ),
          ].join("\n"),
        },
        { references: { testFiles: [] } },
      ).references[0]?.cost;

    expect(over(1), "one pattern costs one batch and one table").toMatchObject({
      patternBatches: 1,
      patternLookups: 1,
    });
    expect(over(6), "and six over the same type cost the same").toMatchObject({
      patternBatches: 1,
      patternLookups: 1,
    });
  });
});

/** The shapes the written modules below destructure. */
const SHAPES = [
  "export interface Inner {\n  deep: string;\n  spare: string;\n}",
  "export interface Row {\n  key: string;\n  value: number;\n  pair: [Inner];\n}",
  "export interface Other {\n  key: string;\n  value: number;\n}",
  "export interface Extra {\n  note: string;\n}",
  "export interface Bag {\n  key: string;\n  rest: string;\n  extra?: Extra;\n}",
].join("\n");

/**
 * Each read a pattern of one written module makes, as its line, the member and how it
 * was resolved, and what resolving them cost.
 */
function patternReads(
  body: string,
  panicsOn?: (accessor: string) => boolean,
): { readonly reads: readonly string[]; readonly cost: ReferenceCost | undefined } {
  const analyzed = analyzeProject(
    { "unit.ts": `${SHAPES}\n${body}` },
    {
      references: { testFiles: [] },
      ...(panicsOn === undefined ? {} : { panicsOn: (accessor: string) => panicsOn(accessor) }),
    },
  );
  const symbols = analyzed.inventories[0]?.symbols ?? [];
  const offset = SHAPES.split("\n").length;
  return {
    reads: (analyzed.references[0]?.references ?? [])
      .filter((one) => one.resolution === "destructured" || one.resolution === "by-name")
      .map(
        (one) =>
          `${String(one.position.line - offset)} ${symbols.find((symbol) => symbol.id === one.to)?.name ?? one.to} ${one.resolution}`,
      ),
    cost: analyzed.references[0]?.cost,
  };
}

describe("the members an assignment target reads", () => {
  it("are read through a property and then a tuple element, in that order", () => {
    expect(
      patternReads(
        'export function assign(row: Row): string {\n  let deep = "";\n  ({ pair: [{ deep }] } = row);\n  return deep;\n}',
      ).reads,
    ).toEqual(["3 Row.pair destructured", "3 Inner.deep destructured"]);
  });

  it("are read through the element an iteration assigns, and then into it", () => {
    expect(
      patternReads(
        'export function iterate(rows: readonly Row[]): string {\n  let deep = "";\n  for ({ pair: [{ deep }] } of rows) {\n    console.log(deep);\n  }\n  return deep;\n}',
      ).reads,
    ).toEqual(["3 Row.pair destructured", "3 Inner.deep destructured"]);
  });

  it("are read off the tuple element at the target's own place", () => {
    const { reads, cost } = patternReads(
      'export function second(pair: [Other, Row]): string {\n  let key = "";\n  [, { key }] = pair;\n  return key;\n}',
    );

    expect(reads).toEqual(["3 Row.key destructured"]);
    expect(
      cost,
      "one batch and the tuple's element types: the row's table is the one an earlier pass read",
    ).toMatchObject({ patternBatches: 1, patternLookups: 1 });
  });

  it("are read off an array's element type, asking once whether it is an array and once for the element", () => {
    const { reads, cost } = patternReads(
      "export function first(rows: Row[]): number {\n  let value = 0;\n  [{ value }] = rows;\n  return value;\n}",
    );

    expect(reads).toEqual(["3 Row.value destructured"]);
    expect(cost).toMatchObject({ patternBatches: 1, patternLookups: 2 });
  });

  it("are read by name where the checker does not answer whether the value is an array", () => {
    expect(
      patternReads(
        "export function first(rows: Row[]): number {\n  let value = 0;\n  [{ value }] = rows;\n  return value;\n}",
        (accessor) => accessor === "isArrayType",
      ).reads,
    ).toEqual(["3 Other.value by-name", "3 Row.value by-name"]);
  });

  it("cost only the iteration protocol's lookups where the iterated value is no type reference", () => {
    const { reads, cost } = patternReads(
      'export function count(): number {\n  let length = 0;\n  for ({ length } of "ab") {\n    console.log(length);\n  }\n  return length;\n}',
    );

    expect(reads).toEqual([]);
    expect(cost).toMatchObject({ patternBatches: 1, patternLookups: 14 });
  });

  it("cost no non-nullable lookup where the value is no union, and one where it is", () => {
    expect(
      patternReads(
        'export function plain(row: Row): string {\n  let key = "";\n  ({ key } = row);\n  return key;\n}',
      ).cost,
      "no lookup of its own: the row's table is the one an earlier pass read",
    ).toMatchObject({ patternBatches: 1, patternLookups: 0 });
    const optional = patternReads(
      'export function optional(bag: Bag): string {\n  let note = "";\n  ({ extra: { note } = { note: "" } } = bag);\n  return note;\n}',
    );
    expect(optional.reads).toEqual(["3 Bag.extra destructured", "3 Extra.note destructured"]);
    expect(
      optional.cost,
      "the member's type, its non-nullable part and that part's table",
    ).toMatchObject({ patternBatches: 1, patternLookups: 3 });
  });

  it("is read where the assignment is a property's value in a literal that is no target", () => {
    expect(
      patternReads(
        'export function held(row: Row): string {\n  let key = "";\n  const out = { last: ({ key } = row) };\n  return key + out.last.key;\n}',
      ).reads,
    ).toEqual(["3 Row.key destructured"]);
  });

  it("are none for a literal on the right of an assignment or the left of another operator", () => {
    const { reads, cost } = patternReads(
      'export class Holder {\n  static key = "";\n}\nexport function make(): boolean {\n  let row: { key: string };\n  row = { key: "a" };\n  return { key: row.key } instanceof Holder;\n}',
    );

    expect(reads).toEqual([]);
    expect(cost).toMatchObject({ patternBatches: 0, patternLookups: 0 });
  });
});

describe("the members a binding pattern reads", () => {
  it("are none for a nested pattern in a function type's parameter list", () => {
    expect(
      patternReads("export type Reader = ({ pair: [{ deep }] }: Row) => string;").reads,
    ).toEqual([]);
  });

  it("are none for a rest element, whatever member its local's name matches", () => {
    expect(
      patternReads(
        "export function take({ key, ...rest }: Bag): string {\n  return key + String(Object.keys(rest).length);\n}",
      ).reads,
    ).toEqual(["1 Bag.key destructured"]);
  });

  it("cost no property table for a value of type any", () => {
    const { reads, cost } = patternReads(
      "export function loose({ key }: any): string {\n  return String(key);\n}",
    );

    expect(reads).toEqual([]);
    expect(cost).toMatchObject({ patternBatches: 1, patternLookups: 0 });
  });
});

describe("the unused members of a destructured tree", () => {
  it("are the members no pattern, access or rest copy reads", () => {
    const config = resolve({
      repository: {
        text: readFileSync(join(TARGET, "deadset.json"), "utf8"),
        label: "deadset.json",
      },
    }).config;
    const findings = findingsOf(emitterInputOf(TARGET, config));

    expect(
      findings
        .filter((finding) => finding.code === "DS1003" || finding.code === "DS1301")
        .map((finding) => `${finding.code} ${finding.symbol.name}`)
        .sort(),
      "a member only an object literal writes is written and never read",
    ).toEqual([
      "DS1003 Holder.spare",
      "DS1301 Circle.kind",
      "DS1301 Inner.untouched",
      "DS1301 Invocation.typedOnly",
      "DS1301 Invocation.unread",
      "DS1301 Square.kind",
    ]);
  });
});
