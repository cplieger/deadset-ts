import { describe, expect, it } from "vitest";
import { utf8Bytes } from "./sha256.ts";

describe("utf8Bytes at each edge of an encoding width", () => {
  it.each([
    ["U+007F", "\u007f"],
    ["U+0080", "\u0080"],
    ["U+07FF", "\u07ff"],
    ["U+0800", "\u0800"],
    ["U+D7FF", "\ud7ff"],
    ["U+E000", "\ue000"],
    ["U+FFFF", "\uffff"],
    ["U+10000", "\u{10000}"],
    ["U+10FFFF", "\u{10ffff}"],
    ["a lone U+D800", "\ud800"],
    ["a lone U+DFFF", "\udfff"],
  ])("encodes %s as the platform's encoder does", (_what, text) => {
    expect(utf8Bytes(text)).toEqual([...Buffer.from(text, "utf8")]);
  });
});
