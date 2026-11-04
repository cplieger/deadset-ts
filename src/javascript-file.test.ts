import { describe, expect, it } from "vitest";
import { minifiedBy } from "./javascript-file.ts";

describe("a JavaScript file minified by its size", () => {
  it.each([
    ["ASCII", "a".repeat(10_240), true],
    ["ASCII one byte short", "a".repeat(10_239), false],
    ["two-byte characters", "é".repeat(5_120), true],
    ["two-byte characters one byte short", `${"é".repeat(5_119)}a`, false],
    ["four-byte characters", "😀".repeat(2_560), true],
    ["four-byte characters one byte short", `${"😀".repeat(2_559)}aaa`, false],
    ["lone surrogates, three bytes each", `${"\ud800".repeat(3_413)}a`, true],
    ["lone surrogates one byte short", "\ud800".repeat(3_413), false],
  ])("counts %s in UTF-8", (_label, text, want) => {
    expect(new TextEncoder().encode(text).byteLength >= 10_240).toBe(want);
    expect(minifiedBy("bundle.js", text)).toBe(want ? "long lines" : undefined);
  });

  it("is no minified file where its lines are short", () => {
    expect(minifiedBy("bundle.js", `${"a".repeat(400)}\n`.repeat(30))).toBeUndefined();
  });
});

describe("a JavaScript file minified by its name", () => {
  it.each([
    ["vendor/lib.min.js", "*.min.js"],
    ["lib.min.cjs", "*.min.cjs"],
    ["lib.min.mjs", "*.min.mjs"],
    ["lib.mini.js", undefined],
    ["lib.min.ts", undefined],
  ])("names %s by the pattern it matches", (fileName, want) => {
    expect(minifiedBy(fileName, "export {};\n")).toBe(want);
  });
});
