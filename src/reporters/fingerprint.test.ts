import { describe, expect, it } from "vitest";
import { lineHashes, symbolFingerprint } from "./fingerprint.ts";

/** The Contract's five-line vector file, its fourth line indented by `indent`. */
function vectorFile(indent: string): string {
  return `package fixture\n\nfunc Ünused() {\n${indent}return\n}\n`;
}

describe("lineHashes", () => {
  it.each([
    ["a tab", "\t"],
    ["four spaces", "    "],
  ])("renders the Contract's vector for each line, the indentation being %s", (_what, indent) => {
    expect(lineHashes(vectorFile(indent)).slice(0, 5)).toEqual([
      "7a0e51a45e6d7320:1",
      "3134adfd1bbad887:1",
      "247cff8f02e0b919:1",
      "58228fc5cbc49530:1",
      "32dce9ccfdbc9d3e:1",
    ]);
  });

  it("counts identical windows, until the sentinel and the zero padding enter them", () => {
    const hashes = lineHashes("y\n".repeat(200));

    expect(hashes[0]).toBe("43762f342805c306:1");
    expect(hashes[1]).toBe("43762f342805c306:2");
    expect(hashes[150]).toBe("43762f342805c306:151");
    expect(hashes[151]).not.toMatch(/^43762f342805c306:/u);
  });

  it("reads CR LF and a lone CR as the line feed it ends a line with", () => {
    const lf = lineHashes(vectorFile("\t"));

    expect(lineHashes(vectorFile("\t").replaceAll("\n", "\r\n"))).toEqual(lf);
    expect(lineHashes(vectorFile("\t").replaceAll("\n", "\r"))).toEqual(lf);
  });

  it("counts a line break after a space following a carriage return as a line of its own", () => {
    expect(lineHashes("a\r \nb")).toHaveLength(3);
  });
});

describe("symbolFingerprint", () => {
  it.each([
    [
      "go://example.com/fixture#Ünused",
      "d073714ada8cfcbee49bd5430446d6be7b837b6fd1fc34e6aa82be03b589c18d",
    ],
    [
      "go://example.com/app#Catalog.ResolveAlias",
      "3969945e4504f5d8a52415a6f7b4f233d1ba4820a2fe24617a3611e2535d5e32",
    ],
  ])("digests DS1001 and %s to the Contract's value", (ref, digest) => {
    expect(symbolFingerprint("DS1001", ref)).toBe(digest);
  });
});
