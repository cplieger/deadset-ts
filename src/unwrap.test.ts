import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { enclosing, sources } from "../__test-helpers__/source-sites.ts";

const SOURCE = import.meta.dirname;

/**
 * The places below `src/` that test a node for an array or object literal's kind and are
 * no question of what a value evaluates to: a destructuring pattern, a parent a walk goes
 * up through, a node a visitor meets, or a bare literal whose contextual type is the
 * position's, where a wrapped one is a value of the wrapper's type. Every other question
 * of whether a value is written as a literal goes through `literalOf`.
 */
const SHAPES: readonly string[] = [
  "contextual-uses.ts contextualUses.carried",
  "contextual-uses.ts contextualUses.literalProperty",
  "destructuring.ts isElement",
  "destructuring.ts propertyReadsOf",
  "destructuring.ts sourceOf",
  "entries/static-module.ts isWriteTarget",
  "exemptions/sites.ts functionOf",
  "exemptions/sites.ts resetsThis",
  "exposure.ts printedAsWritten",
  "index/sites.ts isAssignmentPattern",
  "index/sites.ts markWrite",
  "index/sites.ts sitesOf.visit",
  "index/values.ts handedOn",
  "intra-function-parts.ts calleeSteers",
  "intra-function-parts.ts valueSignature",
];

/**
 * Files that keep deadset-ts 8.0.0-dev.23's literal reads until their rule is rebuilt on its
 * own: the serializer's (references-ts.41), and the unimplemented-callee read
 * (references-ts.18), where a literal behind an assertion claims the asserted type.
 */
const DEV23_READS = new Set([
  "exemptions/erased-stores.ts",
  "exemptions/serialization-contract.ts",
  "exemptions/value-reach.ts",
  "unimplemented-callees.ts",
]);

/** Each place below `src/`, but `unwrap.ts` and the files above, that tests a literal's kind. */
function literalChecks(): readonly string[] {
  const found: string[] = [];
  for (const path of sources(SOURCE)) {
    const file = relative(SOURCE, path).split("\\").join("/");
    if (file === "unwrap.ts" || DEV23_READS.has(file)) {
      continue;
    }
    const lines = readFileSync(join(SOURCE, file), "utf8").split("\n");
    lines.forEach((line, at) => {
      if (/\bis(?:Object|Array)LiteralExpression\(/u.test(line)) {
        found.push(`${file} ${enclosing(lines, at)}`);
      }
    });
  }
  return [...new Set(found)].sort();
}

describe("whether a value is written as a literal", () => {
  // A literal behind parentheses, an assertion, `satisfies` or `!` read as no literal is
  // the bug this guards against: one function strips every wrapper that keeps the value.
  it("is asked only of the one unwrap", () => {
    const outside = literalChecks().filter((site) => !SHAPES.includes(site));
    expect(outside, "a literal-kind check outside unwrap.ts").toEqual([]);
    expect(literalChecks()).toEqual([...SHAPES].sort());
  });
});
