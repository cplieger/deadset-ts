import { describe, expect, it } from "vitest";
import { emitterInputOf } from "../../__test-helpers__/emitter-input.ts";
import { contractDocument, fixture } from "../../__test-helpers__/fixtures.ts";
import { resolve } from "../resolve.ts";
import { decidedFindings, EMITTERS } from "./emitters.ts";

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

describe("decidedFindings", () => {
  /** A library with no consumer declared, decided under the given configuration document. */
  const decide = (document: unknown) => {
    const { config } = resolve({
      repository: JSON.stringify(document),
      repositoryLabel: "deadset.json",
    });
    return decidedFindings(
      emitterInputOf(fixture("projects", "unused-declarations-library"), config),
    );
  };

  it("counts each finding the minimum confidence withheld, which the lowest minimum shows", () => {
    const atDefault = decide({ target: { kind: "library" } });
    const atPossible = decide({
      target: { kind: "library" },
      analysis: { min_confidence: "possible" },
    });

    expect(atDefault.withheld).toEqual({ certain: 0, probable: 0, possible: 2 });
    expect(atPossible.withheld).toEqual({ certain: 0, probable: 0, possible: 0 });
    expect(atPossible.findings.length - atDefault.findings.length).toBe(2);
  });
});
