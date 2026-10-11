import { describe, expect, it } from "vitest";
import { treeFindings } from "../__test-helpers__/tree-findings.ts";

describe("an element access whose index the compiler types as literals", () => {
  it("reads and writes each member a union of literal types names, and no other", () => {
    const found = treeFindings({
      "main.ts": [
        "interface Tally { total: number; working: number; waiting: number; idle: number }",
        'type Status = "working" | "waiting";',
        "export function count(statuses: readonly Status[]): number {",
        "  const tally: Tally = { total: 0, working: 0, waiting: 0, idle: 0 };",
        "  for (const status of statuses) {",
        "    tally[status] += 1;",
        "  }",
        "  return tally.total;",
        "}",
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => one.includes("Tally."))).toEqual(["DS1301 Tally.idle"]);
  });

  it("reads at each call the members its argument names, where every call is visible", () => {
    const found = treeFindings({
      "main.ts": [
        "interface Fields { title: string; body: string; extra: string }",
        'const fields: Fields = { title: "t", body: "b", extra: "e" };',
        "const at = (key: keyof Fields) => fields[key];",
        'export const shown = [at("title"), at("body")];',
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => one.includes("Fields."))).toEqual(["DS1301 Fields.extra"]);
  });

  it("reads at the access where the body destructures into the parameter or loops over it", () => {
    const found = treeFindings({
      "main.ts": [
        "interface Fields { title: string; body: string; extra: string }",
        'const fields: Fields = { title: "t", body: "b", extra: "e" };',
        'function at(key: "title" | "body"): string {',
        '  [key] = ["body"];',
        "  return fields[key];",
        "}",
        "interface Looped { left: string; right: string; spare: string }",
        'const looped: Looped = { left: "l", right: "r", spare: "s" };',
        'function pick(key: "left" | "right"): string {',
        '  for (key of ["right"] as const) {',
        "    break;",
        "  }",
        "  return looped[key];",
        "}",
        'export const shown = [at("title"), pick("left")];',
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => one.includes("Fields.") || one.includes("Looped."))).toEqual([
      "DS1301 Fields.title",
      "DS1301 Fields.extra",
      "DS1301 Looped.spare",
    ]);
  });

  it("reads every member its index's type admits where the function escapes a call", () => {
    const found = treeFindings({
      "main.ts": [
        "interface Picked { left: string; right: string }",
        'const picked: Picked = { left: "l", right: "r" };',
        "const pick = (key: keyof Picked) => picked[key];",
        "export const handed = [pick];",
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => one.includes("Picked."))).toEqual([]);
  });

  it("writes the members it names where it is the target of an assignment", () => {
    const found = treeFindings({
      "main.ts": [
        "interface Draft { a: number; b: number }",
        "const draft: Draft = { a: 0, b: 0 };",
        'export function reset(keys: readonly ("a" | "b")[]): void {',
        "  for (const k of keys) {",
        "    draft[k] = 1;",
        "  }",
        "}",
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => one.includes("Draft."))).toEqual([
      "DS1301 Draft.a",
      "DS1301 Draft.b",
    ]);
  });

  it("reads at each call the members of the object the call passes, where the object is a parameter", () => {
    const found = treeFindings({
      "main.ts": [
        "interface Doc { title: string; author: string; draft: string }",
        "function field<T>(of: T, key: keyof T): unknown {",
        "  return of[key];",
        "}",
        'const doc: Doc = { title: "t", author: "a", draft: "d" };',
        'export const shown = [field(doc, "title"), field(doc, "author")];',
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => one.includes("Doc."))).toEqual(["DS1301 Doc.draft"]);
  });
});
