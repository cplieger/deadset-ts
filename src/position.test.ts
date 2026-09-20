import { describe, expect, it } from "vitest";
import { analyzeProject } from "../__test-helpers__/projects.ts";
import { byPosition, positionKey, type Position } from "./position.ts";

function at(path: string, line: number, column: number): Position {
  return { path, line, column };
}

describe("positionKey", () => {
  it.each([
    { position: at("src/a.ts", 1, 1), want: "src/a.ts:1:1" },
    {
      position: at("src/features/tabs/index.ts", 4320, 12),
      want: "src/features/tabs/index.ts:4320:12",
    },
    { position: at("a b.ts", 2, 3), want: "a b.ts:2:3" },
  ])("renders $want", ({ position, want }) => {
    expect(positionKey(position)).toBe(want);
  });
});

describe("byPosition", () => {
  it.each([
    { a: at("a.ts", 1, 1), b: at("b.ts", 1, 1), sign: -1 },
    { a: at("b.ts", 1, 1), b: at("a.ts", 9, 9), sign: 1 },
    { a: at("a.ts", 1, 5), b: at("a.ts", 2, 1), sign: -1 },
    { a: at("a.ts", 2, 1), b: at("a.ts", 2, 4), sign: -1 },
    { a: at("a.ts", 2, 4), b: at("a.ts", 2, 4), sign: 0 },
  ])("orders by file, then line, then column", ({ a, b, sign }) => {
    expect(Math.sign(byPosition(a, b))).toBe(sign);
    expect(Math.sign(byPosition(b, a))).toBe(sign === 0 ? 0 : -sign);
  });
});

describe("a rendered position", () => {
  it("counts the column in UTF-16 code units, not in bytes and not in code points", () => {
    // Two declarations on one line, the second behind text whose byte count, code
    // point count and UTF-16 code unit count are all different: `é` is two bytes and
    // one code unit, and the astral character is four bytes, one code point and two
    // code units.
    const analyzed = analyzeProject({
      "unit.ts": 'export const é = "\u{1F600}", after = 0;\n',
    });
    const columns = (analyzed.inventories[0]?.symbols ?? [])
      .filter((symbol) => symbol.kind === "variable")
      .map((symbol) => `${symbol.name}:${String(symbol.position.column)}`);

    // Up to `after` the line is `export const é = "<astral>", `: 23 UTF-16 code
    // units, 26 bytes and 22 code points, so a byte column would answer 27 and a
    // code-point column 23 where the reported column answers 24.
    expect(columns).toEqual(["é:14", "after:24"]);
  });
});
