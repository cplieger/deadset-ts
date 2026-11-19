import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emitterInputOf, findingsOf } from "../__test-helpers__/emitter-input.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { treeFindings } from "../__test-helpers__/tree-findings.ts";
import { resolve } from "./resolve.ts";
import { openEngine, type Engine } from "./session.ts";

/**
 * Each finding of an application tree entered at `main.ts`, as `<code> <subject name>`, the
 * compiler server panicking on every question the accessor `panicking` is asked.
 */
function panickingFindings(main: string, panicking: string): readonly string[] {
  const root = writeProject({
    "package.json": JSON.stringify({ name: "@example/tree", private: true, type: "module" }),
    "main.ts": main,
  });
  try {
    const { config } = resolve({
      repository: {
        text: JSON.stringify({
          target: { kind: "application" },
          analysis: { min_confidence: "possible" },
          ts: { entry_files: ["main.ts"] },
        }),
        label: "deadset.json",
      },
    });
    const opened = openEngine({ collectTiming: false });
    const engine: Engine = {
      ...opened,
      ask: (accessor, locations, question) => {
        if (accessor === panicking) {
          throw new Error(`panic: ${accessor}`);
        }
        return opened.ask(accessor, locations, question);
      },
    };
    return findingsOf(emitterInputOf(root, config, { engine })).map(
      (finding) => `${finding.code} ${finding.symbol.name}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

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
        "function field<T>(of: T, key: keyof T): T[keyof T] {",
        "  return of[key];",
        "}",
        'const doc: Doc = { title: "t", author: "a", draft: "d" };',
        'export const shown = [field(doc, "title"), field(doc, "author")];',
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => one.includes("Doc."))).toEqual(["DS1301 Doc.draft"]);
  });

  it("reads what a type parameter's constraint admits through every constraint it names, and every member where it admits a name no literal spells", () => {
    const found = treeFindings({
      "main.ts": [
        "interface Fields { title: string; body: string; extra: string }",
        'function chained<J extends "title", K extends J>(of: Fields, key: K): string {',
        "  return of[key];",
        "}",
        "interface Open { left: string; right: string }",
        "function open<K extends string>(of: Open & Record<K, string>, key: K): string {",
        "  return of[key];",
        "}",
        "console.log(chained, open);",
        "",
      ].join("\n"),
    });

    expect(
      found.filter((one) => /\b(?:Fields|Open)\./u.test(one)),
      "the transitive constraint names title, and a string constraint admits every name",
    ).toEqual(["DS1003 Fields.body", "DS1003 Fields.extra"]);
  });

  it("holds every member a type parameter's constraint could admit where the checker leaves it unanswered", () => {
    const found = panickingFindings(
      [
        "interface Fields { title: string; body: string; extra: string }",
        'export function pick<K extends "title">(of: Fields, key: K): string {',
        "  return of[key];",
        "}",
        "",
      ].join("\n"),
      "getBaseConstraintOfType",
    );

    expect(found.filter((one) => one.includes("Fields."))).toEqual([]);
  });
});
