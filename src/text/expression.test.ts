import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fixture } from "../../__test-helpers__/fixtures.ts";
import { PATH_EXPRESSION } from "../suppression/records.ts";
import { REF_EXPRESSIONS, REF_SHAPE } from "../ref.ts";
import { Expression, expression } from "./expression.ts";

/** Every string value of a decoded JSON document, member names included. */
function stringsOf(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    into.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      stringsOf(item, into);
    }
  } else if (typeof value === "object" && value !== null) {
    for (const [name, member] of Object.entries(value)) {
      into.add(name);
      stringsOf(member, into);
    }
  }
}

/** Every `pattern` a schema of the Contract copy holds, and every key pattern of its setting table. */
function contractPatterns(): readonly string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (typeof value === "object" && value !== null) {
      for (const [name, member] of Object.entries(value)) {
        if ((name === "pattern" || name === "key_pattern") && typeof member === "string") {
          found.add(member);
        }
        walk(member);
      }
    }
  };
  for (const name of readdirSync(fixture("contract"))) {
    if (name.endsWith(".json")) {
      walk(JSON.parse(readFileSync(fixture("contract", name), "utf8")));
    }
  }
  return [...found].sort();
}

/** The JSON files under one fixture directory, recursively. */
function jsonFiles(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return jsonFiles(path);
    }
    return name.endsWith(".json") ? [path] : [];
  });
}

/** The strings the Contract copy's documents and vectors hold: values every pattern meets. */
const SAMPLES: readonly string[] = (() => {
  const held = new Set<string>();
  for (const file of [...jsonFiles(fixture("contract")), ...jsonFiles(fixture("vectors"))]) {
    try {
      stringsOf(JSON.parse(readFileSync(file, "utf8")), held);
    } catch {
      // A vector may hold a document that is no JSON, which is its point.
    }
  }
  return [...held].filter((sample) => sample.length <= 400);
})();

/** Characters near every edge the expressions draw: classes, escapes, controls and whitespace. */
const EDGES = [
  ..."aZ09._~-+ #%*?'[]\\:/@$()<>,.!\t\r\n\u000b\u0000\u001f\u007f",
  ..."\u0080\u0085\u009f\u00a0\u00a1\u1680\u2000\u200a\u200b\u2028\u2029\u202f\u205f\u3000\ufeff",
  ..."é€😀",
  "\ud800",
  "\udfff",
];

const PATTERNS = [...contractPatterns(), REF_SHAPE, ...REF_EXPRESSIONS, PATH_EXPRESSION];

describe("expression", () => {
  it("compiles every pattern the Contract copy publishes", () => {
    expect(contractPatterns().length).toBeGreaterThan(10);
    for (const source of PATTERNS) {
      expect(() => new Expression(source), source).not.toThrow();
    }
  });

  it.each(PATTERNS.map((source) => [source.slice(0, 60), source]))(
    "answers what RegExp with the u flag answers for every string the Contract holds, and each one-character edit of it: %s",
    (_, source) => {
      const ours = new Expression(source);
      const theirs = new RegExp(source, "u");
      for (const sample of SAMPLES) {
        expect(ours.test(sample), JSON.stringify(sample)).toBe(theirs.test(sample));
      }
      fc.assert(
        fc.property(
          fc.constantFrom(...SAMPLES),
          fc.nat(),
          fc.constantFrom(...EDGES),
          fc.constantFrom("insert", "replace", "delete"),
          (sample, at, character, edit) => {
            const cut = sample.length === 0 ? 0 : at % sample.length;
            const edited =
              edit === "insert"
                ? sample.slice(0, cut) + character + sample.slice(cut)
                : edit === "replace"
                  ? sample.slice(0, cut) + character + sample.slice(cut + 1)
                  : sample.slice(0, cut) + sample.slice(cut + 1);
            expect(ours.test(edited), JSON.stringify(edited)).toBe(theirs.test(edited));
          },
        ),
        { numRuns: 400 },
      );
    },
  );

  it.each([
    ["an alternation and its anchors", "^(?:ab|a)$", ["ab", "a", "abc", ""]],
    ["a search with no anchor", "[^ \\t\\r\\n]", ["   ", " x ", ""]],
    ["a bounded repetition", "^a{2,3}$", ["a", "aa", "aaa", "aaaa"]],
    ["an open repetition", "^(?:a{2,})?b$", ["b", "ab", "aab", "aaaab"]],
    ["an empty class and its complement", "^[^]*$|[]", ["", "x\n"]],
    ["a dot, which takes no line terminator", "^.$", ["x", "\n", "\u2028", "😀", "\ud800"]],
    [
      "escapes and class escapes",
      String.raw`^[\d\s\-]\w\S\x41\u0042\u{1F600}\uD83D\uDE00$`,
      ["9aXAB😀😀", "-_\u3000AB😀😀", "9a AB😀😀"],
    ],
    ["a lone surrogate under a class of surrogates", "^[\\uD800-\\uDFFF]$", ["\ud800", "😀"]],
    ["a pattern whose end is pending", "a$|b", ["xa", "ax", "xb"]],
  ])("answers as RegExp does for %s", (_, source, samples) => {
    const ours = new Expression(source);
    const theirs = new RegExp(source, "u");
    for (const sample of samples) {
      expect(ours.test(sample), JSON.stringify(sample)).toBe(theirs.test(sample));
    }
  });

  it.each([
    ["a lookahead", "(?=a)"],
    ["a negative lookahead", "(?!a)"],
    ["a named group", "(?<name>a)"],
    ["a back reference", "(a)\\1"],
    ["a word boundary", "\\ba"],
    ["an unclosed group", "(a"],
    ["an unmatched parenthesis", "a)"],
    ["an unclosed class", "[a"],
    ["a lone quantifier", "*a"],
    ["a quantified assertion", "^*"],
    ["a malformed repetition", "a{2,1}"],
    ["a range out of order", "[b-a]"],
    ["a range bounded by a class escape", "[\\d-z]"],
    ["an identity escape the u flag refuses", "\\q"],
    ["a malformed hexadecimal escape", "\\x4"],
  ])("refuses %s when it compiles", (_, source) => {
    expect(() => new Expression(source)).toThrow(SyntaxError);
  });

  it("matches a value of 16 Mi characters with a group repeated for each", () => {
    const long = `go://a#${"x".repeat((16 << 20) - 100)}`;

    expect(expression(REF_SHAPE).test(long)).toBe(true);
    expect(expression(REF_SHAPE).test(`${long} `)).toBe(false);
    expect(expression(REF_SHAPE).test(`go://${"%41".repeat(5 << 20)}#`)).toBe(true);
    expect(expression(PATH_EXPRESSION).test(`${"a/".repeat(4 << 20)}b.ts`)).toBe(true);
    expect(expression(PATH_EXPRESSION).test(`${"a/".repeat(4 << 20)}./b.ts`)).toBe(false);
  });

  it("compiles one source once", () => {
    expect(expression("^a$")).toBe(expression("^a$"));
  });
});
