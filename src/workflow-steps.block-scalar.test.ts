import { describe, expect, it } from "vitest";
import { runCommands } from "./workflow-steps.ts";

describe("runCommands, where a block scalar ends", () => {
  it("ends at the end of the file with no line after its last", () => {
    expect(runCommands(["    run: |", "      node a.ts"].join("\n"))).toEqual(["      node a.ts"]);
  });

  it("keeps a line of white space shallower than the run key inside the block", () => {
    expect(
      runCommands(["    run: |", "      node a.ts", "  ", "      node b.ts"].join("\n")),
    ).toEqual(["      node a.ts", "  ", "      node b.ts"]);
  });
});
