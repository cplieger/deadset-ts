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

  it("is read and written by a numeric literal element access", () => {
    const found = treeFindings({
      "main.ts": [
        "interface Read { id: number; 0?: number }",
        "interface Written { id: number; 0?: number }",
        "const r: Read = { id: 1, 0: 5 };",
        "r[0] = 6;",
        "const w: Written = { id: 1 };",
        "w[0] = 2;",
        "console.log(r[0], r.id, w.id);",
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => /Read\.|Written\./u.test(one))).toEqual(["DS1301 Written.'0'"]);
  });

  it("is read and written by a string literal on a receiver that maps strings", () => {
    const found = treeFindings({
      "main.ts": [
        "interface Read { [k: string]: number | undefined; read?: number }",
        "interface Written { [k: string]: number | undefined; written?: number }",
        "const r: Read = {};",
        'console.log(r["read"]);',
        "const w: Written = {};",
        "w[`written`] = 1;",
        "console.log(Object.keys(w).length);",
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => /Read\.|Written\./u.test(one))).toEqual([
      "DS1301 Written.written",
    ]);
  });

  it("is retained by a string literal, parenthesized or not, on a receiver that maps no strings", () => {
    const found = treeFindings({
      "main.ts": [
        "interface Payload { name: string; unread: string }",
        "interface Bare { named: string; spare: string }",
        'const p: Payload = { name: "n", unread: "u" };',
        'const b: Bare = { named: "n", spare: "s" };',
        'export const out = [p[("name")], b["named"]];',
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => /Payload\.|Bare\./u.test(one))).toEqual([
      "DS1301 Payload.unread",
      "DS1301 Bare.spare",
    ]);
  });
});
