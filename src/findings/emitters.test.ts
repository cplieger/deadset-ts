import { describe, expect, it } from "vitest";
import { emitterInputOf } from "../../__test-helpers__/emitter-input.ts";
import { contractDocument, fixture } from "../../__test-helpers__/fixtures.ts";
import { resolve } from "../resolve.ts";
import type { EmitterInput } from "./emitter.ts";
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

describe("the findings a gap or a component file's markup withholds", () => {
  /** The fixture of two packages of one name, swept as an application. */
  const twin = () => {
    const { config } = resolve({
      repository: JSON.stringify({ target: { kind: "application" } }),
      repositoryLabel: "deadset.json",
    });
    return emitterInputOf(fixture("projects", "shared-package-name"), config);
  };

  /** Where each finding about `onlyTested` sits. */
  const onlyTested = (input: EmitterInput): string[] =>
    decidedFindings(input)
      .findings.filter((finding) => finding.symbol.name === "onlyTested")
      .map((finding) => `${finding.code} ${finding.position.path}`);

  it("are the held declaration's own, not one another package of one name spells alike", () => {
    const input = twin();
    const other = input.swept.matrix.union.symbols.find(
      (symbol) => symbol.name === "onlyTested" && symbol.position.path === "b/catalog.ts",
    );

    expect(other).toBeDefined();
    expect(
      onlyTested({ ...input, swept: { ...input.swept, heldByUnanswered: [other?.id ?? ""] } }),
    ).toEqual(["DS1004 a/catalog.ts"]);
  });

  it("are the live component file's own, not those of a file another package of one name spells alike", () => {
    const input = twin();

    expect(
      onlyTested({ ...input, swept: { ...input.swept, componentFiles: ["b/catalog.ts"] } }),
    ).toEqual(["DS1004 a/catalog.ts"]);
  });
});
