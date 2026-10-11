import { describe, expect, it } from "vitest";
import { treeFindings } from "../__test-helpers__/tree-findings.ts";

describe("a value stored where a serialized type holds unknown", () => {
  it("is serialized at its own static type, through an index, a property and an unknown variable", () => {
    const found = treeFindings({
      "main.ts": [
        "interface Saved { rules: string[] }",
        "interface Wrapped { inner: number }",
        "interface Boxed { size: number }",
        "interface Envelope { payload: unknown }",
        "const sections: Record<string, unknown> = {};",
        'const saved: Saved = { rules: ["en"] };',
        'sections["languages"] = saved;',
        "const wrapped: Wrapped = { inner: 1 };",
        "const envelope: Envelope = { payload: wrapped };",
        "const boxed: Boxed = { size: 3 };",
        "let box: unknown;",
        "box = boxed;",
        "export const body = JSON.stringify(sections) + JSON.stringify(envelope) + JSON.stringify(box);",
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => /Saved|Wrapped|Boxed/u.test(one))).toEqual([]);
  });

  it("is serialized at its own static type through an alias of unknown and a destructuring assignment", () => {
    const found = treeFindings({
      "main.ts": [
        "interface Aliased { used: string; extra: string }",
        "interface Listed { used: string; extra: string }",
        "interface Keyed { used: string; extra: string }",
        "interface Taken { used: string; extra: string }",
        "type Slot = unknown;",
        'const aliased: Aliased = { used: "u", extra: "e" };',
        "let slot: Slot;",
        "slot = aliased;",
        'const listed: Listed = { used: "u", extra: "e" };',
        "let first: unknown;",
        "[first] = [listed];",
        'const keyed: Keyed = { used: "u", extra: "e" };',
        "const into: { held?: unknown } = {};",
        "({ value: into.held } = { value: keyed });",
        'const pair: readonly [Taken] = [{ used: "u", extra: "e" }];',
        "let taken: unknown;",
        "[taken] = pair;",
        "interface Picked { used: string; extra: string }",
        "interface Unsent { note: string }",
        "const source: { value: Picked; skipped: Unsent } = {",
        '  value: { used: "u", extra: "e" },',
        '  skipped: { note: "n" },',
        "};",
        "let picked: unknown;",
        "({ value: picked } = source);",
        "export const body = JSON.stringify(slot) + JSON.stringify(first) + JSON.stringify(into) + JSON.stringify(taken) + JSON.stringify(picked);",
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => /Aliased|Listed|Keyed|Taken|Picked|Unsent/u.test(one))).toEqual([
      "DS1301 Unsent.note",
    ]);
  });

  it("is serialized at its own static type where the slot's type is a supertype of it", () => {
    const found = treeFindings({
      "main.ts": [
        "interface Base { id: string }",
        "interface Derived extends Base { extra: string }",
        "interface Other extends Base { spare: string }",
        "interface Box { item: Base }",
        'const derived: Derived = { id: "d", extra: "e" };',
        'const box: Box = { item: { id: "b" } };',
        "box.item = derived;",
        'const other: Other = { id: "o", spare: "s" };',
        "const base: Base = other;",
        "export const body = JSON.stringify(box) + JSON.stringify(base);",
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => /Derived|Other/u.test(one))).toEqual([]);
  });

  it("is not serialized where the container holding it is never serialized", () => {
    const found = treeFindings({
      "main.ts": [
        "interface Kept { note: string }",
        "interface Bag { [key: string]: unknown }",
        'const kept: Kept = { note: "k" };',
        "const scratch: Bag = {};",
        'scratch["kept"] = kept;',
        "export const held = Object.keys(scratch).length;",
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => one.includes("Kept."))).toEqual(["DS1301 Kept.note"]);
  });

  it("is handed to the declaring code where the unknown property's type is a dependency's", () => {
    const found = treeFindings({
      "node_modules/@example/req/package.json": JSON.stringify({
        name: "@example/req",
        version: "1.0.0",
        types: "index.d.ts",
      }),
      "node_modules/@example/req/index.d.ts":
        "export interface Request { readonly body?: unknown }\nexport declare function send(r: Request): void;\n",
      "main.ts": [
        'import { send, type Request } from "@example/req";',
        "interface Create { name: string }",
        'const create: Create = { name: "n" };',
        "const request: Request = { body: create };",
        "send(request);",
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => one.includes("Create."))).toEqual([]);
  });
});
