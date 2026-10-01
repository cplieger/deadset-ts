import { describe, expect, it } from "vitest";
import { contractDocument } from "../../__test-helpers__/fixtures.ts";
import { EMITTERS } from "./emitters.ts";

interface Range {
  readonly start: string;
  readonly end: string;
  readonly family: string;
}

interface Kind {
  readonly code: string;
  readonly languages: readonly string[];
}

describe("the findings emitter table", () => {
  it("holds one emitter per family of the Contract's live TypeScript kinds, in code order", () => {
    const vocabulary = contractDocument("kinds.json");
    const ranges = vocabulary["ranges"] as Range[];
    const kinds = (vocabulary["kinds"] as Kind[]).filter((kind) => kind.languages.includes("ts"));
    const families = ranges
      .filter((range) => kinds.some((kind) => kind.code >= range.start && kind.code <= range.end))
      .sort((a, b) => (a.start < b.start ? -1 : 1))
      .map((range) => range.family);

    expect([...EMITTERS.keys()]).toEqual(families);
  });
});
