import { describe, expect, it } from "vitest";
import { LOAD_TIMEOUT, partsOf } from "../__test-helpers__/intra-function-parts.ts";

describe("a result no call uses", () => {
  it(
    "is no generator's, whose calls hand back an iterator",
    () => {
      expect(
        partsOf([
          "function* count(): Generator<number, number> {",
          "  yield 1;",
          "  return 2;",
          "}",
          "",
          "count();",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is none whose type carries no value",
    () => {
      expect(
        partsOf([
          "const log = (message: string): void => console.log(message);",
          "",
          "function nothing(): undefined {",
          "  return undefined;",
          "}",
          "",
          'log("a");',
          "nothing();",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is kept by any one call that uses it",
    () => {
      expect(
        partsOf([
          "function compute(): number {",
          "  return 1;",
          "}",
          "",
          "compute();",
          "console.log(compute());",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});
