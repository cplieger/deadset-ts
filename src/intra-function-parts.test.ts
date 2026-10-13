import { describe, expect, it } from "vitest";
import { LOAD_TIMEOUT, partsOf } from "../__test-helpers__/intra-function-parts.ts";

describe("an unreachable statement", () => {
  it(
    "follows a block that leaves, and an if statement both of whose branches leave",
    () => {
      expect(
        partsOf([
          "function inBlock(): number {",
          "  {",
          '    console.log("first");',
          "    return 1;",
          "  }",
          '  console.log("after the block");',
          "}",
          "",
          "function bothBranches(flag: boolean): number {",
          "  if (flag) {",
          "    return 1;",
          "  } else {",
          "    return 2;",
          "  }",
          '  console.log("after the if");',
          "}",
          "",
          "function thenOnly(flag: boolean): number {",
          "  if (flag) {",
          "    return 1;",
          "  }",
          '  console.log("reached");',
          "  return 2;",
          "}",
          "",
          "console.log(inBlock(), bothBranches(true), thenOnly(true));",
        ]),
      ).toEqual(["DS1805 statement src/main.ts:6", "DS1805 statement src/main.ts:15"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is reported once per statement list, at the first, and never again inside the code it starts",
    () => {
      expect(
        partsOf([
          "function twice(): number {",
          "  return 1;",
          '  console.log("first");',
          '  console.log("second");',
          "}",
          "",
          "function nested(flag: boolean): number {",
          "  return 1;",
          "  if (flag) {",
          "    return 2;",
          '    console.log("deeper");',
          "  }",
          "}",
          "",
          "console.log(twice(), nested(true));",
        ]),
      ).toEqual(["DS1805 statement src/main.ts:3", "DS1805 statement src/main.ts:9"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is no var that initializes nothing, and is a var that initializes any name or a let",
    () => {
      expect(
        partsOf([
          "function hoistedVar(): number {",
          "  return 1;",
          "  var spare;",
          "}",
          "",
          "function initializedVar(): number {",
          "  return 1;",
          "  var set = 2;",
          "}",
          "",
          "function partlyInitialized(): number {",
          "  return 1;",
          "  var first,",
          "    second = 2;",
          "}",
          "",
          "function blockScoped(): number {",
          "  return 1;",
          "  let later;",
          "}",
          "",
          "console.log(hoistedVar(), initializedVar(), partlyInitialized(), blockScoped());",
        ]),
      ).toEqual([
        "DS1805 statement src/main.ts:8",
        "DS1807 set src/main.ts:8",
        "DS1805 statement src/main.ts:13",
        "DS1807 second src/main.ts:14",
        "DS1805 statement src/main.ts:19",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "still makes the calls written in it, which leave the callee's signature free",
    () => {
      expect(
        partsOf([
          "function helper(value: number, unused: number): number {",
          "  return value;",
          "}",
          "",
          "function early(): number {",
          "  return 1;",
          "  helper(1, 2);",
          "}",
          "",
          "console.log(early());",
        ]),
      ).toEqual([
        "DS1801 unused src/main.ts:1",
        "DS1803 result src/main.ts:1",
        "DS1805 statement src/main.ts:7",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds no dead store, duplicate case or unread catch binding of its own",
    () => {
      expect(
        partsOf([
          "function silenced(kind: string): number {",
          "  return 1;",
          "  {",
          "    let value = 1;",
          "    value = 2;",
          "    console.log(value);",
          "    switch (kind) {",
          '      case "a":',
          "        break;",
          '      case "a":',
          "        break;",
          "    }",
          "    try {",
          "      console.log(kind);",
          "    } catch (error) {",
          '      console.log("failed");',
          "    }",
          "  }",
          "}",
          "",
          'console.log(silenced("a"));',
        ]),
      ).toEqual(["DS1805 statement src/main.ts:3"]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a case an earlier case of the same switch covers", () => {
  it(
    "is a number literal of the same value, a negated one included",
    () => {
      expect(
        partsOf([
          "function classify(value: number): number {",
          "  switch (value) {",
          "    case 1:",
          "      return 1;",
          "    case 1.0:",
          "      return 2;",
          "    case -1:",
          "      return 3;",
          "    case -1:",
          "      return 4;",
          "    case +2:",
          "      return 5;",
          "    case -2:",
          "      return 6;",
          "    default:",
          "      return 0;",
          "  }",
          "}",
          "",
          "console.log(classify(1));",
        ]),
      ).toEqual(["DS1809 1.0 src/main.ts:5", "DS1809 -1 src/main.ts:9"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is a bigint literal of the same value, however it is written",
    () => {
      expect(
        partsOf([
          "function classify(value: bigint): number {",
          "  switch (value) {",
          "    case 10n:",
          "      return 1;",
          "    case 1n:",
          "      return 2;",
          "    case 0x1n:",
          "      return 3;",
          "    default:",
          "      return 0;",
          "  }",
          "}",
          "",
          "console.log(classify(1n));",
        ]),
      ).toEqual(["DS1809 0x1n src/main.ts:7"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is the same keyword literal, and never a different name",
    () => {
      expect(
        partsOf([
          "const first = 1;",
          "const second = 2;",
          "",
          "function classify(value: unknown): number {",
          "  switch (value) {",
          "    case true:",
          "    case true:",
          "    case false:",
          "    case false:",
          "    case null:",
          "    case null:",
          "      return 1;",
          "    case first:",
          "      return 2;",
          "    case second:",
          "      return 3;",
          "    default:",
          "      return 0;",
          "  }",
          "}",
          "",
          "console.log(classify(1));",
        ]),
      ).toEqual([
        "DS1809 true src/main.ts:7",
        "DS1809 false src/main.ts:9",
        "DS1809 null src/main.ts:11",
      ]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a parameter of a free function", () => {
  it(
    "is read through a shorthand property, and not through a declaration that shadows it",
    () => {
      expect(
        partsOf([
          "function pack(value: number, label: string): { value: number; label: string } {",
          "  return { value, label };",
          "}",
          "",
          "function shadowed(value: number, unused: number): number {",
          "  {",
          "    const unused = value;",
          "    return unused;",
          "  }",
          "}",
          "",
          "console.log(pack(1, 'a'), shadowed(1, 2));",
        ]),
      ).toEqual(["DS1801 unused src/main.ts:5"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is not read by a member named arguments",
    () => {
      expect(
        partsOf([
          "interface Call {",
          "  arguments: number[];",
          "}",
          "",
          "function forwarded(unused: number, call: Call): number[] {",
          "  return call.arguments;",
          "}",
          "",
          "console.log(forwarded(1, { arguments: [] }));",
        ]),
      ).toEqual(["DS1801 unused src/main.ts:5"]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a method's signature", () => {
  it(
    "is free in a class nothing extends, a static method's and a function property's included",
    () => {
      expect(
        partsOf([
          "class Plain {",
          "  run(value: number, unused: number): number {",
          "    return value;",
          "  }",
          "",
          "  static make(value: number, unused: number): number {",
          "    return value;",
          "  }",
          "}",
          "",
          "class Base {",
          "  greet(): string {",
          '    return "hi";',
          "  }",
          "}",
          "",
          "class Child extends Base {",
          "  handle = (value: number, unused: number): number => value;",
          "}",
          "",
          "class Implemented {",
          "  run(value: number, unused: number): number {",
          "    return value;",
          "  }",
          "}",
          "",
          "class Mock implements Implemented {",
          "  run(value: number, unused: number): number {",
          "    return value * 2;",
          "  }",
          "}",
          "",
          "console.log(new Plain().run(1, 2), Plain.make(1, 2), new Base().greet());",
          "console.log(new Child().handle(1, 2), new Implemented().run(1, 2), new Mock().run(1, 2));",
        ]),
      ).toEqual([
        "DS1801 unused src/main.ts:2",
        "DS1801 unused src/main.ts:6",
        "DS1801 unused src/main.ts:18",
        "DS1801 unused src/main.ts:22",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is fixed in a class that extends another or is abstract",
    () => {
      expect(
        partsOf([
          "class Base {",
          "  greet(): string {",
          '    return "hi";',
          "  }",
          "}",
          "",
          "class Child extends Base {",
          "  run(value: number, unused: number): number {",
          "    return value;",
          "  }",
          "}",
          "",
          "abstract class Tools {",
          "  static scale(value: number, unused: number): number {",
          "    return value;",
          "  }",
          "}",
          "",
          "console.log(new Base().greet(), new Child().run(1, 2), Tools.scale(1, 2));",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});

describe("an imported function", () => {
  it(
    "keeps its signature free through the specifiers that import and export it",
    () => {
      expect(
        partsOf(
          [
            'import shiftBy, { scale as resize } from "./lib.js";',
            'import { spread } from "./lib.js";',
            "",
            "console.log(resize(1, 2), shiftBy(1, 2), spread(1, 2));",
          ],
          {
            files: {
              "src/lib.ts": [
                "export function scale(unused: number, value: number): number {",
                "  return value;",
                "}",
                "",
                "function shift(unused: number, value: number): number {",
                "  return value;",
                "}",
                "",
                "export default shift;",
                "",
                "export function spread(unused: number, value: number): number {",
                "  return value;",
                "}",
                "",
              ].join("\n"),
            },
          },
        ),
      ).toEqual([
        "DS1801 unused src/lib.ts:1",
        "DS1801 unused src/lib.ts:5",
        "DS1801 unused src/lib.ts:11",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "keeps its signature free through an export specifier, renamed or not, and a re-export",
    () => {
      expect(
        partsOf(
          [
            'import { local, renamed } from "./lib.js";',
            'import { scale, resize } from "./index.js";',
            "",
            "console.log(local(1, 2), renamed(1, 2), scale(1, 2), resize(1, 2));",
          ],
          {
            files: {
              "src/lib.ts": [
                "function local(unused: number, value: number): number {",
                "  return value;",
                "}",
                "",
                "function other(unused: number, value: number): number {",
                "  return value;",
                "}",
                "",
                "export { local, other as renamed };",
                "",
              ].join("\n"),
              "src/scale.ts": [
                "export function scale(unused: number, value: number): number {",
                "  return value;",
                "}",
                "",
              ].join("\n"),
              "src/index.ts": [
                'export { scale } from "./scale.js";',
                'export { scale as resize } from "./scale.js";',
                "",
              ].join("\n"),
            },
          },
        ),
      ).toEqual([
        "DS1801 unused src/lib.ts:1",
        "DS1801 unused src/lib.ts:5",
        "DS1801 unused src/scale.ts:1",
      ]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a result every call discards", () => {
  it(
    "is one a function returns: an expression body's, or a return with a value at any depth",
    () => {
      expect(
        partsOf([
          "function bare(): number | undefined {",
          '  console.log("a");',
          "  return;",
          "}",
          "",
          "const arrow = (): number => 1;",
          "",
          "function branchOnly(flag: boolean): number {",
          "  if (flag) {",
          "    return 1;",
          "  }",
          '  throw new Error("no");',
          "}",
          "",
          "function outer(): number | undefined {",
          "  const inner = (): number => {",
          "    return 1;",
          "  };",
          "  console.log(inner());",
          "  return;",
          "}",
          "",
          "bare();",
          "arrow();",
          "branchOnly(true);",
          "outer();",
        ]),
      ).toEqual(["DS1803 result src/main.ts:6", "DS1803 result src/main.ts:8"]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a write to a local", () => {
  it(
    "is dead where a later statement only spells the local as a property name",
    () => {
      expect(
        partsOf([
          "function overwritten(): number {",
          "  let value = 1;",
          "  console.log({ value: 2 });",
          "  value = 3;",
          "  return value;",
          "}",
          "",
          "console.log(overwritten());",
        ]),
      ).toEqual(["DS1807 value src/main.ts:2"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is read by a statement that starts with the local, or ends with it",
    () => {
      expect(
        partsOf([
          "function startsWithRead(): number {",
          '  const text = " a ";',
          "  text.trim();",
          "  return 1;",
          "}",
          "",
          "function endsWithRead(): string {",
          '  const text = " a ";',
          "  return text",
          "}",
          "",
          "console.log(startsWithRead(), endsWithRead());",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is no subject where a function expression or an accessor names the local",
    () => {
      expect(
        partsOf([
          "function viaFunction(): () => number {",
          "  let value = 1;",
          "  value = 2;",
          "  const read = function (): number {",
          "    return value;",
          "  };",
          "  return read;",
          "}",
          "",
          "function viaGetter(): { readonly current: number } {",
          "  let value = 1;",
          "  value = 2;",
          "  return {",
          "    get current(): number {",
          "      return value;",
          "    },",
          "  };",
          "}",
          "",
          "function viaSetter(): { current: number } {",
          "  let value = 1;",
          "  value = 2;",
          "  return {",
          "    set current(next: number) {",
          "      console.log(value, next);",
          "    },",
          "  };",
          "}",
          "",
          "console.log(viaFunction(), viaGetter(), viaSetter());",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a catch binding", () => {
  it(
    "is a dead store where the catch block never reads it, a property spelled as it aside",
    () => {
      expect(
        partsOf([
          "function ignored(): void {",
          "  try {",
          '    console.log("work");',
          "  } catch (error) {",
          '    console.log("failed");',
          "  }",
          "}",
          "",
          "function logged(): void {",
          "  try {",
          '    console.log("work");',
          "  } catch (error) {",
          "    console.log(error, { error: 1 });",
          "  }",
          "}",
          "",
          "function spelled(): void {",
          "  try {",
          '    console.log("work");',
          "  } catch (error) {",
          "    console.log({ error: 1 });",
          "  }",
          "}",
          "",
          "ignored();",
          "logged();",
          "spelled();",
        ]),
      ).toEqual(["DS1807 error src/main.ts:4", "DS1807 error src/main.ts:20"]);
    },
    LOAD_TIMEOUT,
  );
});
