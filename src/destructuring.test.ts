import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitterInputOf } from "../__test-helpers__/emitter-input.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { analyzeProject, analyzeRoot } from "../__test-helpers__/projects.ts";
import { findingsOf } from "./findings/emitters.ts";
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
    (cost?.contextualLookups ?? 0)
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
    expect(readsAt(70), "a plain target").toEqual(["src/readers.ts:70:6 assign -> Row.key read"]);
    expect(readsAt(72), "a target nested in a tuple element").toEqual([
      "src/readers.ts:72:5 assign -> Row.pair read",
      "src/readers.ts:72:14 assign -> Inner.deep read",
    ]);
    expect(
      readsAt(74),
      "a defaulted nested target reads the member's type, not the default's",
    ).toEqual([
      "src/readers.ts:74:6 assign -> Invocation.nested read",
      "src/readers.ts:74:16 assign -> Inner.deep read",
    ]);
    expect(readsAt(75), "an optional member's value, without its undefined").toEqual([
      "src/readers.ts:75:6 assign -> Invocation.extra read",
      "src/readers.ts:75:15 assign -> Extra.note read",
    ]);
    expect(readsAt(76), "an array literal's element").toEqual([
      "src/readers.ts:76:6 assign -> Row.value read",
    ]);
    expect(readsAt(77), "and an iterated array's element").toEqual([
      "src/readers.ts:77:10 assign -> Row.key read",
    ]);
  });

  it("accounts for every request it makes", () => {
    expect(RESOLVED?.cost.patternBatches, "one batch for the one module holding patterns").toBe(1);
    expect(ANALYZED.referenceRequests, "and the client measured no other").toBe(
      accounted(RESOLVED?.cost),
    );
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

describe("the unused members of a destructured tree", () => {
  it("are the members no pattern, access or rest copy reads", () => {
    const config = resolve({
      repository: readFileSync(join(TARGET, "deadset.json"), "utf8"),
      repositoryLabel: "deadset.json",
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
