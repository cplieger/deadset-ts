import { describe, expect, it } from "vitest";
import { emitterInputOf } from "../../__test-helpers__/emitter-input.ts";
import { fixture } from "../../__test-helpers__/fixtures.ts";
import { resolve } from "../resolve.ts";
import type { EmitterInput } from "./emitter.ts";
import { decidedFindings } from "./emitters.ts";

describe("decidedFindings", () => {
  /** A library with no consumer declared, decided under the given configuration document. */
  const decide = (document: unknown) => {
    const { config } = resolve({
      repository: { text: JSON.stringify(document), label: "deadset.json" },
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

  it("counts a withheld finding an edge side names, which the lowest minimum holds pending", () => {
    const { config } = resolve({
      repository: { text: JSON.stringify({ target: { kind: "library" } }), label: "deadset.json" },
    });
    const input = emitterInputOf(fixture("projects", "unused-declarations-library"), config);
    const symbol = "ts://@example/unused-declarations-library/src/index.ts#makePublished";
    const decided = decidedFindings({
      ...input,
      boundary: { ...input.boundary, edges: [{ edge: "e", side: "used_by", symbol }] },
    });

    expect(decided.withheld).toEqual({ certain: 0, probable: 0, possible: 2 });
    expect(decided.evaluations.map((one) => one.state)).toEqual(["live"]);
  });
});

describe("the findings a gap or a component file's markup withholds", () => {
  /** The fixture of two packages of one name, swept as an application. */
  const twin = () => {
    const { config } = resolve({
      repository: {
        text: JSON.stringify({ target: { kind: "application" } }),
        label: "deadset.json",
      },
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
    ).toEqual(["DS1102 a/catalog.ts"]);
  });

  it("are the live component file's own, not those of a file another package of one name spells alike", () => {
    const input = twin();

    expect(
      onlyTested({ ...input, swept: { ...input.swept, componentFiles: ["b/catalog.ts"] } }),
    ).toEqual(["DS1102 a/catalog.ts"]);
  });

  it("include every one about a top-level declaration of a live component file", () => {
    const input = twin();

    expect(
      onlyTested({ ...input, swept: { ...input.swept, componentFiles: ["a/catalog.ts"] } }),
    ).toEqual([]);
  });
});
