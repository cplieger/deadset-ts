import { describe, expect, it } from "vitest";
import { analyzeProject } from "../__test-helpers__/projects.ts";
import { declarationsByName } from "./inventory.ts";

describe("the declarations a name may spell", () => {
  it("are every declaration bearing it, a type parameter by its own name, and never a file", () => {
    const held = analyzeProject({
      "src/unit.ts":
        "export function pick<Key>(key: Key): Key {\n" +
        "  return key;\n" +
        "}\n" +
        "export interface Box {\n" +
        "  pick: number;\n" +
        "}\n" +
        "export default function chosen(): void {}\n",
    }).inventories[0];

    expect(
      [...(held === undefined ? [] : declarationsByName(held))].sort(([a], [b]) =>
        a < b ? -1 : 1,
      ),
    ).toEqual([
      ["Box", ["src/unit.ts:4:18"]],
      ["Key", ["src/unit.ts:1:22"]],
      ["chosen", ["src/unit.ts:7:25"]],
      ["default", ["src/unit.ts:7:25"]],
      ["pick", ["src/unit.ts:1:17", "src/unit.ts:5:3"]],
    ]);
  });
});
