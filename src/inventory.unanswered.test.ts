import { describe, expect, it } from "vitest";
import { analyzeProject } from "../__test-helpers__/projects.ts";

/**
 * A type alias that writes members, which no symbol is asked for, ahead of two classes, so a
 * container's answer read from the wrong slot of the batch names the wrong class.
 */
const UNIT =
  "export type Shape = { side: number };\n" +
  "export class Plain {\n" +
  "  size = 1;\n" +
  "}\n" +
  "export class Lost {\n" +
  "  weight = 2;\n" +
  "}\n";

/** The declarations recorded unanswered where the checker panics on the questions `panics` names. */
function unansweredWhere(panics: (accessor: string, locations: readonly string[]) => boolean): {
  readonly unanswered: readonly string[];
  readonly names: readonly string[];
} {
  const held = analyzeProject({ "src/unit.ts": UNIT }, { panicsOn: panics }).inventories[0];
  return {
    unanswered: held?.unanswered ?? [],
    names: (held?.symbols ?? []).map((symbol) => symbol.name),
  };
}

const ALL = ["src/unit.ts", "Shape", "Shape.side", "Plain", "Plain.size", "Lost", "Lost.weight"];

describe("a class the checker leaves unanswered", () => {
  it("is recorded unanswered with its members where its own symbol goes unanswered", () => {
    const at = `src/unit.ts:${String(UNIT.indexOf(" Lost"))}`;

    expect(
      unansweredWhere(
        (accessor, locations) =>
          accessor === "getSymbolAtLocation" && locations.some((one) => one.endsWith(at)),
      ),
    ).toEqual({ unanswered: ["src/unit.ts:5:14", "src/unit.ts:6:3"], names: ALL });
  });

  it.each(["getMembers", "getExports"])(
    "is recorded unanswered with its members where its %s table goes unanswered",
    (table) => {
      expect(
        unansweredWhere(
          (accessor, locations) =>
            accessor === table && locations.some((one) => one.endsWith(" Lost")),
        ),
      ).toEqual({ unanswered: ["src/unit.ts:5:14", "src/unit.ts:6:3"], names: ALL });
    },
  );
});
