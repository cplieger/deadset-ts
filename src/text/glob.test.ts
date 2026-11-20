import { describe, expect, it } from "vitest";
import {
  braceExpanded,
  caselessGlobExpression,
  gitignoreExpression,
  globExpression,
  globOverBound,
  rewrittenGlobExpression,
} from "./glob.ts";

/** The paths of `paths` one pattern matches, in the order given. */
function matched(pattern: string, paths: readonly string[]): string[] {
  const expression = globExpression(pattern);
  return paths.filter((path) => expression.test(path));
}

describe("a glob pattern", () => {
  it("matches any run of segments with a trailing **, and only one segment with *", () => {
    const paths = ["src", "src/a.ts", "src/deep/b.ts", "lib/a.ts"];

    expect(matched("src/**", paths)).toEqual(["src/a.ts", "src/deep/b.ts"]);
    expect(matched("src/*", paths)).toEqual(["src/a.ts"]);
  });

  it("matches zero or more whole segments with **/", () => {
    expect(
      matched("**/*.test.ts", ["a.test.ts", "src/a.test.ts", "src/x/a.test.ts", "a.ts"]),
    ).toEqual(["a.test.ts", "src/a.test.ts", "src/x/a.test.ts"]);
  });

  it("matches one character of a segment with ?", () => {
    expect(matched("src/?.ts", ["src/a.ts", "src/ab.ts", "src//.ts"])).toEqual(["src/a.ts"]);
  });

  it("reads a brace list as an alternation of its members", () => {
    expect(
      matched("src/{a,b.c}.ts", ["src/a.ts", "src/b.c.ts", "src/bxc.ts", "src/{a,b.c}.ts"]),
    ).toEqual(["src/a.ts", "src/b.c.ts"]);
  });

  it("reads an opening brace no closing one follows as written", () => {
    expect(matched("src/{a.ts", ["src/{a.ts", "src/a.ts"])).toEqual(["src/{a.ts"]);
    expect(matched("{a", ["{a", "a"])).toEqual(["{a"]);
  });

  it("matches every other character as itself", () => {
    expect(matched("a.b+c(d)", ["a.b+c(d)", "aXb+c(d)", "a.bbc(d)"])).toEqual(["a.b+c(d)"]);
  });
});

describe("the bound on one glob", () => {
  const lists = (list: string, count: number): string => list.repeat(count);
  const members = (count: number): string => `{${Array<string>(count).fill("a").join(",")}}`;

  it.each([
    { name: "1,024 characters", pattern: "a".repeat(1024), over: undefined },
    {
      name: "1,024 characters outside the basic plane",
      pattern: "\u{1F600}".repeat(1024),
      over: undefined,
    },
    { name: "eight two-member lists, 256 globs", pattern: lists("{a,b}", 8), over: undefined },
    { name: "four four-member lists, 256 globs", pattern: lists("{a,b,c,d}", 4), over: undefined },
    { name: "one list of 256 members", pattern: members(256), over: undefined },
    { name: "a list inside a member", pattern: "{a{b,c},d}{e,f}", over: undefined },
  ])("admits $name", ({ pattern, over }) => {
    expect(globOverBound(pattern)).toBe(over);
  });

  it.each([
    {
      name: "1,025 unpaired surrogates",
      pattern: "\uDC00".repeat(1025),
      why: "holds 1025 characters",
    },
    {
      name: "1,025 characters",
      pattern: "a".repeat(1025),
      why: "holds 1025 characters, past the bound of 1024",
    },
    { name: "one list of 257 members", pattern: members(257), why: "more than 256 globs" },
    {
      name: "seven two-member lists and a three-member one",
      pattern: `${lists("{a,b}", 7)}{a,b,c}`,
      why: "more than 256 globs",
    },
    { name: "nine two-member lists", pattern: lists("{a,b}", 9), why: "more than 256 globs" },
    {
      name: "24 two-member lists in 120 characters",
      pattern: lists("{a,b}", 24),
      why: "more than 256 globs",
    },
    {
      name: "100,000 one-member lists",
      pattern: lists("{a}", 100_000),
      why: "holds 300000 characters",
    },
    { name: "200,000 characters", pattern: "a".repeat(200_000), why: "holds 200000 characters" },
  ])("refuses $name before expanding it", ({ pattern, why }) => {
    const started = performance.now();

    expect(globOverBound(pattern)).toContain(why);
    expect(braceExpanded(pattern)).toEqual([]);
    for (const glob of [
      globExpression(pattern),
      caselessGlobExpression(pattern),
      rewrittenGlobExpression(pattern, `**/${pattern}`),
    ]) {
      expect(glob.test("a")).toBe(false);
      expect(glob.test("")).toBe(false);
    }
    expect(gitignoreExpression(pattern, pattern).test("a")).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("holds a .gitignore line to the length alone, its braces standing for themselves", () => {
    const line = lists("{a,b}", 9);

    expect(gitignoreExpression(line, line).test(line)).toBe(true);
    expect(gitignoreExpression("a".repeat(1025), "a".repeat(1025)).test("a".repeat(1025))).toBe(
      false,
    );
  });

  it("measures a rewritten glob as its author wrote it, never as the caller rewrote it", () => {
    const written = "a".repeat(1024);
    const below = `${"d".repeat(3000)}/`;

    expect(rewrittenGlobExpression(written, `**/${written}`).test(`x/${written}`)).toBe(true);
    expect(rewrittenGlobExpression(written, `${below}${written}`).test(`${below}${written}`)).toBe(
      true,
    );
    expect(gitignoreExpression(written, `**/${written}`).test(`x/${written}`)).toBe(true);
    expect(rewrittenGlobExpression(`${written}a`, written).test(written)).toBe(false);
    expect(gitignoreExpression(`${written}a`, written).test(written)).toBe(false);
    expect(braceExpanded(written, `!${written}`)).toEqual([]);
    expect(braceExpanded(written.slice(1), `!${written.slice(1)}`)).toEqual([written.slice(1)]);
  });

  it("matches no path, and never throws, with a rewrite V8 cannot hold", () => {
    const deep = `${"a".repeat(40_000)}/*.js`;
    const wide = `${"*a".repeat(8_000)}/*.js`;
    const split = `{${"a".repeat(40_000)},b}/*.js`;

    for (const [label, glob] of [
      ["a long rootDir", rewrittenGlobExpression("*.js", deep)],
      ["the caseless form", rewrittenGlobExpression("*.js", deep, true)],
      ["a rewrite V8 refuses only for a wider subject", rewrittenGlobExpression("*.js", wide)],
      ["one long alternative of several", rewrittenGlobExpression("*.js", split)],
    ] as const) {
      expect(() => glob.test("x"), label).not.toThrow();
      expect(glob.test(`${"a".repeat(40_000)}/x.js`), label).toBe(false);
      expect(() => glob.test("\u0100"), label).not.toThrow();
    }
    expect(rewrittenGlobExpression("*.js", split).test("b/x.js")).toBe(true);
    expect(
      rewrittenGlobExpression("*.js", `${"a".repeat(1_000)}/*.js`).test(
        `${"a".repeat(1_000)}/x.js`,
      ),
    ).toBe(true);
  });

  it("expands to none a glob a caller's directory with brace lists brings past the expansions", () => {
    expect(braceExpanded(`${lists("{a,b}", 9)}/x`, "x")).toEqual([]);
    expect(braceExpanded(`${lists("{a,b}", 8)}/x`, "x")).toHaveLength(256);
  });

  it("matches a glob at the bound whose expressions are too long to join", () => {
    const glob = `${"a".repeat(800)}${lists("{b,c}", 8)}`;
    const path = `${"a".repeat(800)}bcbcbcbc`;

    expect(globExpression(glob).test(path)).toBe(true);
    expect(globExpression(glob).test(`${path}d`)).toBe(false);
  });

  it("expands a glob within the bound to the globs it counts", () => {
    expect(braceExpanded(lists("{a,b}", 8))).toHaveLength(256);
    expect(braceExpanded("{a{b,c},d}{e,f}")).toEqual([
      "abe",
      "abf",
      "ade",
      "adf",
      "c,d}e",
      "c,d}f",
    ]);
    expect(globExpression(`src/${lists("{a,b}", 8)}.ts`).test("src/abababab.ts")).toBe(true);
  });

  it("counts the globs a pattern expands to as expanding it would", () => {
    const written = (pattern: string): readonly string[] => {
      const open = pattern.indexOf("{");
      const close = open < 0 ? -1 : pattern.indexOf("}", open);
      if (close < 0) {
        return [pattern];
      }
      return pattern
        .slice(open + 1, close)
        .split(",")
        .flatMap((member) => written(pattern.slice(0, open) + member + pattern.slice(close + 1)));
    };
    let seed = 7;
    const next = (bound: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % bound;
    };
    const differing: string[] = [];
    for (let draw = 0; draw < 5000; draw += 1) {
      const pattern = Array.from({ length: next(40) }, () => "{},,a"[next(5)]).join("");
      const count = written(pattern).length;
      if ((globOverBound(pattern) !== undefined) !== count > 256) {
        differing.push(pattern);
      } else if (count <= 256 && braceExpanded(pattern).length !== count) {
        differing.push(pattern);
      }
    }
    expect(differing).toEqual([]);
  });
});
