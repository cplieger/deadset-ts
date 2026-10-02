import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sha256Hex, utf8Bytes } from "./sha256.ts";

describe("sha256Hex", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
  ])("digests the published vector %j", (input, digest) => {
    expect(sha256Hex(input)).toBe(digest);
  });

  it("digests the UTF-8 encoding of any string as the platform's SHA-256 does", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 200 }), (text) => {
        expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
      }),
    );
  });

  it("digests a message of any length across several blocks as the platform does", () => {
    fc.assert(
      fc.property(fc.nat({ max: 300 }), (length) => {
        const text = "x".repeat(length);
        expect(sha256Hex(text)).toBe(createHash("sha256").update(text).digest("hex"));
      }),
    );
  });
});

describe("utf8Bytes", () => {
  it("encodes every code point as the platform's encoder does", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 50 }), (text) => {
        expect(utf8Bytes(text)).toEqual([...Buffer.from(text, "utf8")]);
      }),
    );
  });

  it("encodes a lone surrogate as the replacement character", () => {
    expect(utf8Bytes("a\uD800b")).toEqual([0x61, 0xef, 0xbf, 0xbd, 0x62]);
  });
});
