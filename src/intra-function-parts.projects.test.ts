import { describe, expect, it } from "vitest";
import { LOAD_TIMEOUT, partsOf } from "../__test-helpers__/intra-function-parts.ts";
import { TSCONFIG } from "../__test-helpers__/projects.ts";
import { openEngine, type Engine } from "./session.ts";

/** A function written in place whose parameter `extra` is read only by its shadowing local. */
const SHADOWED = [
  "export function make() {",
  "  return [",
  "    (event: string, extra: number): void => {",
  "      {",
  "        const extra = 1;",
  "        console.log(event, extra);",
  "      }",
  "    },",
  "  ];",
  "}",
  "",
  "make();",
];

/**
 * An engine whose checker panics on the symbol of the read of the shadowing local in the
 * first project's batch that also asks for the parameter, and answers every later question.
 */
function unansweredInFirstProject(main: string): Engine {
  const opened = openEngine({ collectTiming: false });
  const at = (offset: number): string => `src/main.ts:${String(offset)}`;
  const read = at(main.indexOf("extra);") - 1);
  const parameter = at(main.indexOf(" extra: number"));
  let state: "waiting" | "panicking" | "done" = "waiting";
  return {
    ...opened,
    ask: (accessor, locations, question) => {
      const asked = locations();
      const names = (one: string): boolean => asked.some((location) => location.endsWith(one));
      if (accessor === "getSymbolAtLocation" && names(read)) {
        if (state === "waiting" && names(parameter)) {
          state = "panicking";
        }
        if (state === "panicking") {
          if (asked.length === 1) {
            state = "done";
          }
          throw new Error(`panic: ${accessor}`);
        }
      }
      return opened.ask(accessor, locations, question);
    },
  };
}

describe("a part two projects hold", () => {
  it(
    "is one finding where both find it unread",
    () => {
      expect(
        partsOf(
          [
            "function scale(value: number, unused: number): number {",
            "  return value;",
            "}",
            "",
            "console.log(scale(1, 2));",
          ],
          { files: { "tsconfig.other.json": TSCONFIG } },
        ),
      ).toEqual(["DS1401 unused src/main.ts:1"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is in use where one project's checker leaves a read of it unanswered",
    () => {
      const main = `${SHADOWED.join("\n")}\n`;
      expect(partsOf(SHADOWED, { files: { "tsconfig.other.json": TSCONFIG } })).toEqual([
        "DS1401 extra src/main.ts:3",
      ]);
      expect(
        partsOf(SHADOWED, {
          files: { "tsconfig.other.json": TSCONFIG },
          engine: unansweredInFirstProject(main),
        }),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});
