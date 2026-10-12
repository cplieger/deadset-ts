import { describe, expect, it } from "vitest";
import { treeFindings } from "../__test-helpers__/tree-findings.ts";

describe("a member a literal index names", () => {
  it("is read by a string, a parenthesized union and a numeric literal index", () => {
    const found = treeFindings({
      "main.ts": [
        "interface Payload { a: string; b: number; c: boolean; 0: string; 1: string; unread: string }",
        'type ByString = Payload["a"];',
        'type ByUnion = Payload[("b" | "c")];',
        "type ByNumber = Payload[0];",
        'export const read: [ByString, ByUnion, ByNumber] = ["a", 1, "0"];',
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => one.includes("Payload."))).toEqual([
      "DS1003 Payload.'1'",
      "DS1003 Payload.unread",
    ]);
  });

  it("is read where a call passes a numeric literal for a key type parameter", () => {
    const found = treeFindings({
      "main.ts": [
        "declare function createStore<M>(): { get<K extends keyof M>(key: K): M[K] };",
        "interface ByIndex { 0: string; 1: string }",
        "export const first = createStore<ByIndex>().get(0);",
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => one.includes("ByIndex."))).toEqual(["DS1003 ByIndex.'1'"]);
  });
});
