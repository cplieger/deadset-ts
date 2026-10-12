import { describe, expect, it } from "vitest";
import { LOAD_TIMEOUT, partsOf, tsconfigWith } from "../__test-helpers__/intra-function-parts.ts";

describe("a function written in place", () => {
  it(
    "has its unread trailing parameter reported, an arrow's and a function expression's",
    () => {
      expect(
        partsOf([
          "function make() {",
          "  return (value: number, unused: number): number => value;",
          "}",
          "",
          "function makeExpression() {",
          "  return function (value: number, unused: number): number {",
          "    return value;",
          "  };",
          "}",
          "",
          "console.log(make()(1, 2), makeExpression()(1, 2));",
        ]),
      ).toEqual(["DS1801 unused src/main.ts:2", "DS1801 unused src/main.ts:6"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is a nested function declaration with a body, never an overload or ambient signature",
    () => {
      expect(
        partsOf([
          "declare function ambient(value: number): void;",
          "",
          "function outer(): number {",
          "  function inner(value: number, unused: number): number {",
          "    return value;",
          "  }",
          "  function pick(value: number): number;",
          "  function pick(value: string): number;",
          "  function pick(value: unknown): number {",
          "    return Number(value);",
          "  }",
          "  return inner(1, 2) + pick(1);",
          "}",
          "",
          "console.log(outer(), typeof ambient);",
        ]),
      ).toEqual(["DS1801 unused src/main.ts:4"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is a method of an object literal",
    () => {
      expect(
        partsOf([
          "const box = {",
          "  run(value: number, unused: number): number {",
          "    return value;",
          "  },",
          "};",
          "",
          "console.log(box.run(1, 2));",
        ]),
      ).toEqual(["DS1801 unused src/main.ts:2"]);
    },
    LOAD_TIMEOUT,
  );
});

describe("the names a parameter binds", () => {
  it(
    "are each name of an object or array binding pattern, at any depth",
    () => {
      expect(
        partsOf([
          "function pick({ a, b }: { a: number; b: number }): number {",
          "  return a;",
          "}",
          "",
          "function nested(",
          "  { inner: { c, d } }: { inner: { c: number; d: number } },",
          "  [e, f]: number[],",
          "): number {",
          "  return c + e;",
          "}",
          "",
          "console.log(pick({ a: 1, b: 2 }), nested({ inner: { c: 1, d: 2 } }, [1, 2]));",
        ]),
      ).toEqual(["DS1801 b src/main.ts:1", "DS1801 d src/main.ts:6", "DS1801 f src/main.ts:7"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "leave out a name beside a rest element, which removing would change, but not the rest element",
    () => {
      expect(
        partsOf([
          "function rest({ dropped, ...others }: { dropped: number; kept: number }): object {",
          "  return others;",
          "}",
          "",
          "function restUnread({ a, ...others }: { a: number; b: number }): number {",
          "  return a;",
          "}",
          "",
          "console.log(rest({ dropped: 1, kept: 2 }), restUnread({ a: 1, b: 2 }));",
        ]),
      ).toEqual(["DS1801 others src/main.ts:5"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "leave out a this parameter, which receives no argument",
    () => {
      expect(
        partsOf([
          "function show(this: void, value: number): number {",
          "  return 1;",
          "}",
          "",
          "console.log(show(1));",
        ]),
      ).toEqual(["DS1801 value src/main.ts:1"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "leave out a decorated parameter, which its decorator reads",
    () => {
      expect(
        partsOf(
          [
            "function mark(target: object, key: string, index: number): void {",
            "  console.log(target, key, index);",
            "}",
            "",
            "class Plain {",
            "  run(@mark unused: number, spare: number): number {",
            "    return 1;",
            "  }",
            "}",
            "",
            "console.log(new Plain().run(1, 2));",
          ],
          { files: { "tsconfig.json": tsconfigWith({ experimentalDecorators: true }) } },
        ),
      ).toEqual(["DS1801 spare src/main.ts:6"]);
    },
    LOAD_TIMEOUT,
  );
});

describe("whether a function reads a parameter", () => {
  it(
    "is yes for every parameter of a function that reads arguments, an arrow's own aside",
    () => {
      expect(
        partsOf([
          "function variadic(first: number): number {",
          "  return arguments.length;",
          "}",
          "",
          "function outer(first: number): number {",
          "  const inner = (second: number): number => arguments.length;",
          "  return inner(1);",
          "}",
          "",
          "console.log(variadic(1), outer(1));",
        ]),
      ).toEqual(["DS1801 second src/main.ts:6"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is yes through a shorthand property of its own name only",
    () => {
      expect(
        partsOf([
          "function pack(value: number, unused: number): { value: number } {",
          "  return { value };",
          "}",
          "",
          "console.log(pack(1, 2));",
        ]),
      ).toEqual(["DS1801 unused src/main.ts:1"]);
    },
    LOAD_TIMEOUT,
  );
});

describe("an unread parameter of a declared function used as a value", () => {
  it(
    "is reported only where no read parameter follows it, since a caller passes it by position",
    () => {
      expect(
        partsOf([
          "function lead(unused: number, value: number): number {",
          "  return value;",
          "}",
          "",
          "function alone(unused: number): number {",
          "  return 0;",
          "}",
          "",
          "function neither(first: number, second: number): number {",
          "  return 0;",
          "}",
          "",
          "const table: ((x: never, y: never) => number)[] = [lead, alone, neither];",
          "console.log(table.length);",
        ]),
      ).toEqual([
        "DS1801 unused src/main.ts:5",
        "DS1801 first src/main.ts:9",
        "DS1801 second src/main.ts:9",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is reported where only a binding pattern's names come before a read parameter",
    () => {
      expect(
        partsOf([
          "function pick({ a, b }: { a: number; b: number }, next: number): number {",
          "  return a + next;",
          "}",
          "",
          "const table: ((x: never, y: never) => number)[] = [pick];",
          "console.log(table.length);",
        ]),
      ).toEqual(["DS1801 b src/main.ts:1"]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a decorated method's signature", () => {
  it(
    "stays free where the decorator exemption is off, since the decorator only receives it",
    () => {
      expect(
        partsOf(
          [
            "function logged<T>(value: T, context: ClassMethodDecoratorContext): T {",
            "  console.log(context.name);",
            "  return value;",
            "}",
            "",
            "class Plain {",
            "  @logged",
            "  run(unused: number, value: number): number {",
            "    return value;",
            "  }",
            "}",
            "",
            "console.log(new Plain().run(1, 2));",
          ],
          { repository: { exemptions: { disabled: ["decorator"] } } },
        ),
      ).toEqual(["DS1801 unused src/main.ts:8"]);
    },
    LOAD_TIMEOUT,
  );
});
