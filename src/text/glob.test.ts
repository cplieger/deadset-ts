import { describe, expect, it } from "vitest";
import { globExpression } from "./glob.ts";

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
