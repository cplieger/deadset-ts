import { describe, expect, it } from "vitest";
import { lineHashes } from "./fingerprint.ts";

describe("lineHashes over a file that begins with a line feed", () => {
  it("counts the empty first line, and hashes the second as it would after any other line", () => {
    const hashes = lineHashes("\nb");

    expect(hashes).toHaveLength(2);
    expect(hashes[1]).toBe(lineHashes("a\nb")[1]);
  });
});
