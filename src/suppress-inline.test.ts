import { describe, expect, it } from "vitest";
import { readFixture } from "../__test-helpers__/fixtures.ts";
import { classifyComment, DIRECTIVE_EXPRESSIONS, tokenStart } from "./suppress-inline.ts";

/** One case of the published suppression token corpus. */
interface CorpusCase {
  readonly input: { readonly comment?: string; readonly line_offset?: number };
  readonly kind: string;
  readonly accepted: boolean;
  readonly rule: string;
  readonly reason: string;
  readonly reports?: readonly string[];
}

const CORPUS = JSON.parse(
  readFixture("contract", "grammar", "suppression-corpus.json"),
) as readonly CorpusCase[];

/** The outcome the grammar page's rule vocabulary gives a refused case under its rule. */
const REFUSED: Readonly<Record<string, string>> = {
  namespace: "not a directive",
  "first-token": "not a directive",
  "line-comment-only": "not a directive",
  "directive-name": "exit 2",
  "reason-separator": "exit 2",
  "code-list": "exit 2",
  "reason-required": "DS1701",
  "line-above": "DS1703",
};

/** What the grammar declares one inline case to be. */
function declared(one: CorpusCase): string {
  if (one.accepted) {
    return "accepted";
  }
  const outcome = REFUSED[one.rule] ?? `no outcome for ${one.rule}`;
  return one.reports === undefined ? outcome : one.reports.join(" ");
}

/** What this analyzer makes of one inline case: the comment, at its line offset. */
function outcome(one: CorpusCase): string {
  const directive = classifyComment(one.input.comment ?? "");
  switch (directive.is) {
    case "none":
      return "not a directive";
    case "malformed":
      return "exit 2";
    case "no-reason":
      return directive.codes.map(() => "DS1701").join(" ");
    case "directive":
      return one.input.line_offset === -1 ? "accepted" : "DS1703";
  }
}

describe("the inline directive's three expressions", () => {
  it("are the three the grammar page publishes, byte for byte", () => {
    const published = readFixture("contract", "grammar", "suppression.md")
      .split("\n")
      .filter((line) => line.startsWith(String.raw`^//[ \t]*deadset:`));

    expect(published).toEqual([
      DIRECTIVE_EXPRESSIONS.candidate,
      DIRECTIVE_EXPRESSIONS.wellFormed,
      DIRECTIVE_EXPRESSIONS.noReason,
    ]);
  });
});

describe("every inline case of the published token corpus", () => {
  const inline = CORPUS.filter((one) => one.kind === "inline");

  it.each(inline.map((one) => [one.input.comment ?? "", one] as const))(
    "%j has the outcome the grammar declares",
    (_comment, one) => {
      expect(outcome(one)).toBe(declared(one));
    },
  );

  it("is read, and none of it is left out", () => {
    expect(inline.length).toBe(33);
  });
});

describe("a well-formed directive", () => {
  it("carries every code it names and its reason, trailing whitespace trimmed", () => {
    expect(
      classifyComment("// deadset:ignore DS1001,DS1101 -- kept -- for the plugin loader.   "),
    ).toEqual({
      is: "directive",
      codes: ["DS1001", "DS1101"],
      reason: "kept -- for the plugin loader.",
    });
  });
});

describe("the first token at or after an offset", () => {
  it("is past whitespace, line comments, block comments and a leading hashbang", () => {
    const text = "#!/usr/bin/env node\n  // note\n  /* block */\n  export const x = 1;";

    expect(text.slice(tokenStart(text, 0))).toBe("export const x = 1;");
  });
});
