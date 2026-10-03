import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { CHUNK_LENGTH, coalesced, jsonChunks } from "./json-chunks.ts";

/** A report-shaped value whose document is past `length` characters: many small findings. */
function largeDocument(length: number): { findings: Record<string, unknown>[] } {
  const finding = {
    code: "DS1001",
    symbol: { ref: "ts://@example/app/src/a.ts#helper", name: "helper", kind: "function" },
    position: { path: "src/a.ts", line: 12, column: 3, end_line: 14 },
    message: "function helper is never used",
    severity: "error",
  };
  const each = JSON.stringify(finding, null, 2).length;
  return { findings: Array.from({ length: Math.ceil(length / each) }, () => finding) };
}

describe("a document written in pieces", () => {
  it("joins back to the document JSON.stringify writes, for any plain value", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.integer({ min: 0, max: 4 }), (value, indent) => {
        expect([...jsonChunks(value, indent)].join("")).toBe(
          `${JSON.stringify(value, null, indent)}\n`,
        );
      }),
    );
  });

  it("leaves out an object member that holds nothing, as JSON.stringify does", () => {
    expect([...jsonChunks({ kept: 1, gone: undefined, also: [undefined] }, 2)].join("")).toBe(
      '{\n  "kept": 1,\n  "also": [\n    null\n  ]\n}\n',
    );
  });

  it("holds no piece longer than twice the chunk length, however large the document", () => {
    const pieces = [...jsonChunks(largeDocument(16 * CHUNK_LENGTH * 16), 2)];

    const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
    const longest = Math.max(...pieces.map((piece) => piece.length));
    expect(total, "the document is past the threshold").toBeGreaterThan(256 * CHUNK_LENGTH);
    expect(longest).toBeLessThanOrEqual(2 * CHUNK_LENGTH);
  });

  it("hands on a piece shorter than the chunk length only at the end", () => {
    const pieces = [...coalesced(Array.from({ length: 300 }, () => "x".repeat(1000)))];

    expect(pieces.slice(0, -1).every((piece) => piece.length >= CHUNK_LENGTH)).toBe(true);
    expect(pieces.join("")).toBe("x".repeat(300_000));
  });

  it("is written to its path as the pieces it came in, joined", () => {
    const dir = mkdtempSync(join(tmpdir(), "deadset-ts-chunks-"));
    onTestFinished(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const path = join(dir, "report.json");
    const value = largeDocument(4 * CHUNK_LENGTH);

    nodeHost().writeDocument(path, jsonChunks(value, 2));

    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(value, null, 2)}\n`);
  });
});
