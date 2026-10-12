import { describe, expect, it } from "vitest";
import { partialNotes } from "./partial.ts";

function dropped(id: string): { id: string; configFile: string; error: string } {
  return { id, configFile: `/work/${id}/tsconfig.json`, error: `${id} cannot be read` };
}

describe("the notes on a partial run", () => {
  it("name each dropped configuration once, in ascending order of its name", () => {
    const notes = partialNotes({
      notBuilt: ["d", "b", "e", "a", "c"].map(dropped),
      unanswered: [],
      targetRoot: "/work",
    });

    expect(notes).toEqual(
      ["a", "b", "c", "d", "e"].map(
        (id) =>
          `the derived configuration ${id} was not built and is not analyzed: ${id} cannot be read`,
      ),
    );
  });

  it.each([
    { count: 1, noun: "1 question" },
    { count: 2, noun: "2 questions" },
  ])("count $noun the checker left unanswered, by project", ({ count, noun }) => {
    const notes = partialNotes({
      notBuilt: [],
      unanswered: Array.from({ length: count }, (_, index) => ({
        configFile: "/work/tsconfig.json",
        accessor: "getTypeAtLocation",
        location: `/work/a.ts:${String(index)}`,
      })),
      targetRoot: "/work",
    });

    expect(notes).toEqual([
      `the checker answered ${noun} with a failure (tsconfig.json: ${String(count)}), so every declaration an answer could have kept live is kept live and reported by nothing`,
    ]);
  });
});
