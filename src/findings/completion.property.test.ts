import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { emitterInputOf } from "../../__test-helpers__/emitter-input.ts";
import { fixture } from "../../__test-helpers__/fixtures.ts";
import type { Confidence } from "../config.ts";
import type { Finding } from "../finding.ts";
import type { InventorySymbol } from "../inventory.ts";
import { KINDS, type KindRow } from "../kinds.ts";
import { resolve } from "../resolve.ts";
import type { Boundary } from "./boundary.ts";
import { completed } from "./completion.ts";
import type { EmitterInput } from "./emitter.ts";

/** A library whose published API, private members and unpublished file the classes tell apart. */
const TARGET = fixture("projects", "unused-declarations-library");

/** The fixture swept once per target kind, which decides whether a published API exists. */
const SWEPT = {
  application: emitterInputOf(TARGET, configOf("application")),
  library: emitterInputOf(TARGET, configOf("library")),
};

function configOf(kind: "application" | "library"): EmitterInput["config"] {
  return resolve({
    repository: JSON.stringify({ target: { kind } }),
    repositoryLabel: "deadset.json",
  }).config;
}

/**
 * The declarations of the fixture a library publishes: what the manifest's `exports`
 * reaches, and the public members of a class it reaches. A private member, a `#private`
 * name and a declaration of a file the manifest does not reach are not published.
 */
const PUBLISHED = new Set(["Published", "Published.visible", "makePublished"]);

/** What the run knows about the target's consumers, as each draw states it. */
type Consumers = "none declared" | "every one loaded" | "one unavailable";

const BOUNDARIES: Readonly<Record<Consumers, Boundary["consumers"]>> = {
  "none declared": { declared: [], loaded: [] },
  "every one loaded": { declared: ["@example/web"], loaded: ["@example/web"] },
  "one unavailable": { declared: ["@example/cli", "@example/web"], loaded: ["@example/web"] },
};

/**
 * The class one declaration of one run carries: `certain` for an application and for what a
 * library does not publish; for a published declaration, `possible` with no consumer
 * declared, `certain` with every declared one loaded, and `probable` with one unavailable.
 */
function expectedClass(kind: keyof typeof SWEPT, name: string, consumers: Consumers): Confidence {
  if (kind === "application" || !PUBLISHED.has(name)) {
    return "certain";
  }
  return {
    "none declared": "possible",
    "every one loaded": "certain",
    "one unavailable": "probable",
  }[consumers] as Confidence;
}

const RANK: Readonly<Record<Confidence, number>> = { possible: 1, probable: 2, certain: 3 };

function subjects(input: EmitterInput): readonly InventorySymbol[] {
  const union = input.swept.matrix.union;
  return union.symbols.filter((_symbol, at) => union.subject[at] === true);
}

function findingAbout(symbol: InventorySymbol, code: string): Finding {
  return {
    code,
    position: { ...symbol.position, endLine: symbol.endLine },
    symbol: { ref: symbol.ref, kind: symbol.kind, name: symbol.name, sizeLines: 1 },
    message: `${symbol.name} is reported`,
  };
}

const CLASSES: readonly Confidence[] = ["certain", "probable", "possible"];

const draw = fc.record({
  kind: fc.constantFrom<keyof typeof SWEPT>("application", "library"),
  pick: fc.nat(),
  consumers: fc.constantFrom<Consumers>("none declared", "every one loaded", "one unavailable"),
  code: fc.constantFrom(...KINDS.keys()),
  ceiling: fc.constantFrom(...CLASSES),
});

describe("the confidence of a finding", () => {
  it("is drawn over a fixture whose declarations reach every visibility", () => {
    expect(subjects(SWEPT.library).map((symbol) => symbol.name)).toEqual([
      "Published",
      "Published.visible",
      "Published.#secret",
      "Published.hidden",
      "makePublished",
      "internalUnused",
      "internalRetired",
    ]);
  });

  /**
   * Property dead-code-suite/P12: for any declaration, target kind, consumer availability,
   * issue kind and ceiling, a finding's reachability class is the one derived from the
   * declaration's visibility, the target kind and the consumers, and its confidence is
   * that class capped by the kind's ceiling: the weaker of the two. No
   * shipped kind declares a ceiling below `certain`, so the ceiling is drawn into the
   * vocabulary the completion reads.
   */
  it("is the derived class capped by the kind's ceiling", () => {
    fc.assert(
      fc.property(draw, ({ kind, pick, consumers, code, ceiling }) => {
        const swept = SWEPT[kind];
        const held = subjects(swept);
        const symbol = held[pick % held.length] as InventorySymbol;
        const input: EmitterInput = {
          ...swept,
          boundary: { ...swept.boundary, consumers: BOUNDARIES[consumers] },
        };
        const row = KINDS.get(code) as KindRow;
        const vocabulary = new Map([[code, { ...row, maxClass: ceiling }]]);

        const [finding] = completed(input, [findingAbout(symbol, code)], vocabulary);
        const derived = expectedClass(kind, symbol.name, consumers);

        expect(finding?.reachabilityClass).toBe(derived);
        expect(finding?.confidence).toBe(RANK[ceiling] < RANK[derived] ? ceiling : derived);
      }),
    );
  });
});
