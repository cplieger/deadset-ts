import { describe, expect, it } from "vitest";
import { contractDocument } from "../../__test-helpers__/fixtures.ts";
import { RULE_TEXTS } from "./rules.ts";

/** One live row of the Contract's issue-kind vocabulary, as far as a rule's text reads it. */
interface ContractRow {
  readonly code: string;
  readonly languages: readonly string[];
  readonly rule: string;
  readonly precondition?: string;
}

describe("the rule texts", () => {
  it("hold the rule and precondition of every live TypeScript kind the Contract states, in code order", () => {
    const rows = (contractDocument("kinds.json")["kinds"] as ContractRow[])
      .filter((row) => row.languages.includes("ts"))
      .sort((a, b) => (a.code < b.code ? -1 : 1))
      .map((row) => [
        row.code,
        row.precondition === undefined
          ? { rule: row.rule }
          : { rule: row.rule, precondition: row.precondition },
      ]);

    expect([...RULE_TEXTS]).toEqual(rows);
  });
});
