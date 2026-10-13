import { describe, expect, it } from "vitest";
import { LOAD_TIMEOUT, partsOf, tsconfigWith } from "../__test-helpers__/intra-function-parts.ts";

describe("a local whose writes are judged", () => {
  it(
    "is a var of a nested block, whose write another one overwrites in the block before any read",
    () => {
      expect(
        partsOf([
          "function hoisted(flag: boolean): number | undefined {",
          "  if (flag) {",
          "    var value: number | undefined = 1;",
          "    value = 2;",
          "  }",
          "  return value;",
          "}",
          "",
          "function captured(flag: boolean): () => number | undefined {",
          "  if (flag) {",
          "    var held: number | undefined = 1;",
          "    held = 2;",
          "  }",
          "  return () => held;",
          "}",
          "",
          "console.log(hoisted(true), captured(true));",
        ]),
      ).toEqual(["DS1807 value src/main.ts:3"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "keeps the last write of a var of a nested block, read past the block's end, and is no using or await using declaration, which disposal reads",
    () => {
      expect(
        partsOf(
          [
            "function open(): Disposable {",
            "  return { [Symbol.dispose]() {} };",
            "}",
            "",
            "function openLater(): AsyncDisposable {",
            "  return { async [Symbol.asyncDispose]() {} };",
            "}",
            "",
            "function hoisted(flag: boolean): number | undefined {",
            "  if (flag) {",
            "    var value: number | undefined = 1;",
            "  }",
            "  return value;",
            "}",
            "",
            "function disposed(): number {",
            "  using handle = open();",
            "  return 1;",
            "}",
            "",
            "async function disposedLater(): Promise<number> {",
            "  await using handle = openLater();",
            "  return 1;",
            "}",
            "",
            "console.log(hoisted(true), disposed(), disposedLater());",
          ],
          { files: { "tsconfig.json": tsconfigWith({ lib: ["ESNext", "ESNext.Disposable"] }) } },
        ),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is written by no declaration that initializes nothing",
    () => {
      expect(
        partsOf([
          "function later(): number {",
          "  let value: number;",
          "  value = 1;",
          "  return value;",
          "}",
          "",
          "console.log(later());",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a read of a local", () => {
  it(
    "is no shorthand property of another local's name",
    () => {
      expect(
        partsOf([
          "function packed(): object {",
          "  const other = 3;",
          "  let value = 1;",
          "  console.log({ other });",
          "  value = 2;",
          "  return { value };",
          "}",
          "",
          "console.log(packed());",
        ]),
      ).toEqual(["DS1807 value src/main.ts:3"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is no name a nested block's own declaration binds",
    () => {
      expect(
        partsOf([
          "function shadowed(): number {",
          "  let value = 1;",
          "  {",
          "    const value = 2;",
          "    console.log(value);",
          "  }",
          "  value = 3;",
          "  return value;",
          "}",
          "",
          "console.log(shadowed());",
        ]),
      ).toEqual(["DS1807 value src/main.ts:2"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is a compound assignment, and the value of the next plain write",
    () => {
      expect(
        partsOf([
          "function compound(): number {",
          "  let value = 1;",
          "  value += 2;",
          "  return value;",
          "}",
          "",
          "function incremented(): number {",
          "  let value = 1;",
          "  value = value + 1;",
          "  return value;",
          "}",
          "",
          "console.log(compound(), incremented());",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is a later declarator of the statement that declares the local",
    () => {
      expect(
        partsOf([
          "function copied(): number {",
          "  let value = 1,",
          "    copy = value;",
          "  value = 2;",
          "  return copy + value;",
          "}",
          "",
          "console.log(copied());",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a write to a local no read reaches", () => {
  it(
    "is a plain assignment no later statement of the block reads",
    () => {
      expect(
        partsOf([
          "function discarded(): number {",
          "  let value = 1;",
          "  console.log(value);",
          "  value = 2;",
          "  return 0;",
          "}",
          "",
          "console.log(discarded());",
        ]),
      ).toEqual(["DS1807 value src/main.ts:4"]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a local a declaration's pattern, a loop or the function's body declares", () => {
  it(
    "is each name of an object pattern but one beside a rest element or with a default",
    () => {
      expect(
        partsOf([
          "function pick(meta: { request: number; response: number; extra: number }): number {",
          "  const { request, response } = meta;",
          "  const { request: first, ...rest } = meta;",
          "  const { extra = 1, response: second } = meta;",
          "  return request + rest.response + second;",
          "}",
          "",
          "console.log(pick({ request: 1, response: 2, extra: 3 }));",
        ]),
      ).toEqual(["DS1807 response src/main.ts:2"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is a for-of or for-in variable the loop body never reads, written at each iteration, unless its name starts with an underscore",
    () => {
      expect(
        partsOf([
          "function sum(map: Map<string, number>, obj: Record<string, number>): number {",
          "  let total = 0;",
          "  for (const [key, value] of map) total += value;",
          "  for (const k in obj) total += 1;",
          "  for (const name in obj) total += obj[name] ?? 0;",
          "  for (const _ of map) total += 1;",
          "  return total;",
          "}",
          "",
          "console.log(sum(new Map(), {}));",
        ]),
      ).toEqual(["DS1807 key src/main.ts:3", "DS1807 k src/main.ts:4"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is a var of the function's own body, judged as a let is",
    () => {
      expect(
        partsOf([
          "function hoisted(): number {",
          "  var value = 1;",
          "  value = 2;",
          "  return value;",
          "}",
          "",
          "console.log(hoisted());",
        ]),
      ).toEqual(["DS1807 value src/main.ts:2"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is a local only nested functions name, each write of which is dead where nothing reads it",
    () => {
      expect(
        partsOf([
          "function setup(): () => void {",
          "  let seen: number;",
          "  let read = 0;",
          "  const later = (): void => {",
          "    seen = 1;",
          "    read = 2;",
          "  };",
          "  return () => {",
          "    later();",
          "    console.log(read);",
          "  };",
          "}",
          "",
          "setup()();",
        ]),
      ).toEqual(["DS1807 seen src/main.ts:5"]);
    },
    LOAD_TIMEOUT,
  );
});
