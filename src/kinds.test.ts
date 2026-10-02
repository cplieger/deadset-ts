import { describe, expect, it } from "vitest";
import { contractDocument } from "../__test-helpers__/fixtures.ts";
import { FIXED_SEVERITY_CODES, KINDS, LIVE_CODES } from "./kinds.ts";

/** One live row of the Contract's issue-kind vocabulary, as the document spells it. */
interface ContractRow {
  readonly code: string;
  readonly name: string;
  readonly languages: readonly string[];
  readonly rule: string;
  readonly precondition?: string;
  readonly default_severity: string;
  readonly max_class: string;
  readonly fixability: string;
  readonly fixed: boolean;
  readonly overlap?: { readonly ts: readonly string[] };
}

function contractRows(): ContractRow[] {
  return contractDocument("kinds.json")["kinds"] as ContractRow[];
}

describe("the issue-kind vocabulary table", () => {
  it("holds every live row of the Contract's vocabulary as it states each, in ascending code order", () => {
    const rows = contractRows()
      .map((kind) => ({
        code: kind.code,
        name: kind.name,
        languages: kind.languages,
        rule: kind.rule,
        ...(kind.precondition === undefined ? {} : { precondition: kind.precondition }),
        defaultSeverity: kind.default_severity,
        maxClass: kind.max_class,
        fixability: kind.fixability,
        fixed: kind.fixed,
        ...(kind.overlap === undefined ? {} : { overlap: kind.overlap.ts }),
      }))
      .sort((a, b) => (a.code < b.code ? -1 : 1));

    expect([...KINDS.values()]).toEqual(rows);
    expect([...KINDS.keys()]).toEqual(rows.map((one) => one.code));
  });

  it("holds no code the vocabulary retired", () => {
    const retired = contractDocument("kinds.json")["retired"] as { code: string }[];

    expect([...KINDS.keys()].filter((code) => retired.some((row) => row.code === code))).toEqual(
      [],
    );
  });
});

describe("the codes of the live issue kinds", () => {
  it("is the list the Contract's issue-kind vocabulary declares, in ascending order", () => {
    expect([...LIVE_CODES]).toEqual(
      contractRows()
        .map((kind) => kind.code)
        .sort(),
    );
  });
});

describe("the codes whose severity the Contract fixes", () => {
  it("is the list the Contract's issue-kind vocabulary declares, in ascending order", () => {
    expect([...FIXED_SEVERITY_CODES]).toEqual(
      contractRows()
        .filter((kind) => kind.fixed)
        .map((kind) => kind.code)
        .sort(),
    );
  });
});
