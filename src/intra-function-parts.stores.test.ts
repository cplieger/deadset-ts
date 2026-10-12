import { describe, expect, it } from "vitest";
import { LOAD_TIMEOUT, partsOf, tsconfigWith } from "../__test-helpers__/intra-function-parts.ts";

describe("a local whose writes are judged", () => {
  it(
    "is no var, which the function scope holds, and no using or await using declaration, which disposal reads",
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
            "function hoisted(): number {",
            "  var value = 1;",
            "  value = 2;",
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
            "console.log(hoisted(), disposed(), disposedLater());",
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
