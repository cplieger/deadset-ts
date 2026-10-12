import { describe, expect, it } from "vitest";
import { treeFindings } from "../__test-helpers__/tree-findings.ts";

const PAYLOAD = "interface Payload { a: string; b: number; c: boolean; unread: string }";

/** The findings about a member of `Payload` in a tree whose `main.ts` is `lines`. */
function payloadFindings(lines: readonly string[]): readonly string[] {
  return treeFindings({ "main.ts": [PAYLOAD, ...lines, ""].join("\n") }).filter((one) =>
    one.includes("Payload."),
  );
}

describe("a member a type argument fixes the index of", () => {
  it("is read where a call of a function, a method or an arrow writes the type argument and passes no argument", () => {
    expect(
      payloadFindings([
        "function byFunction<K extends keyof Payload>(): Payload[K] { return undefined as never; }",
        "class Store { byMethod<K extends keyof Payload>(): Payload[K] { return undefined as never; } }",
        "const byArrow = <K extends keyof Payload>(): Payload[K] => undefined as never;",
        'export const read = [byFunction<"a">(), new Store().byMethod<"b">(), byArrow<"c">()];',
      ]),
    ).toEqual(["DS1003 Payload.unread"]);
  });

  it("is read by the innermost generic declaring the type parameter a call passes on", () => {
    expect(
      payloadFindings([
        "function leaf<K extends keyof Payload>(): Payload[K] { return undefined as never; }",
        'function outer<K extends "a" | "c">(key: K): string {',
        '  function inner<K extends "b">(): Payload[K] { return leaf<K>(); }',
        '  return `${key}${String(inner<"b">())}`;',
        "}",
        'export const got = outer("a");',
      ]),
    ).toEqual(["DS1003 Payload.a", "DS1003 Payload.c", "DS1003 Payload.unread"]);
  });

  it("is not read through a generic callback no site fixes the type argument of", () => {
    expect(
      payloadFindings([
        "declare function register(read: <K extends keyof Payload>(key: K) => Payload[K]): void;",
        "register(<K extends keyof Payload>(key: K): Payload[K] => undefined as never);",
      ]),
    ).toEqual([
      "DS1003 Payload.a",
      "DS1003 Payload.b",
      "DS1003 Payload.c",
      "DS1003 Payload.unread",
    ]);
  });
});
