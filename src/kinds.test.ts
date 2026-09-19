import { describe, expect, it } from "vitest";
import { contractDocument } from "../__test-helpers__/fixtures.ts";
import { FIXED_SEVERITY_CODES } from "./kinds.ts";

describe("the codes whose severity the Contract fixes", () => {
  it("is the list the Contract's issue-kind vocabulary declares, in ascending order", () => {
    const kinds = contractDocument("kinds.json")["kinds"] as { code: string; fixed: boolean }[];

    expect([...FIXED_SEVERITY_CODES]).toEqual(
      kinds
        .filter((kind) => kind.fixed)
        .map((kind) => kind.code)
        .sort(),
    );
  });

  it("names a code the vocabulary holds", () => {
    const kinds = contractDocument("kinds.json")["kinds"] as { code: string }[];
    const codes = new Set(kinds.map((kind) => kind.code));

    expect(FIXED_SEVERITY_CODES.filter((code) => !codes.has(code))).toEqual([]);
  });
});
