import { describe, expect, it } from "vitest";
import { minified } from "./javascript-file.ts";

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
    expect(minified("bundle.js", text)).toBe(want);
  });

  it("is no minified file where its lines are short", () => {
    expect(minified("bundle.js", `${"a".repeat(400)}\n`.repeat(30))).toBe(false);
  });
});
