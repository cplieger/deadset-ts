import { describe, expect, it } from "vitest";
import {
  GRAMMAR_FILES,
  TABLE_HEADS,
  WRAPPERS,
  disagreementsOf,
  entriesOf,
  grammarForms,
} from "../../__test-helpers__/named-files.ts";

describe("the run places of a command", () => {
  it.each(GRAMMAR_FILES)(
    "holds or caps every file a runtime may run as its entry, drawn from %s, after every spelling of every option of each row's table, and with every spelling of each option of a runtime's own",
    (drawn) => {
      const entries = entriesOf(drawn);
      const own = drawn.slice("/pkg/".length);
      const disagreements: string[] = [];
      const runtimes = TABLE_HEADS;
      let read = 0;
      const check = (
        wrap: (line: string) => string,
        { head, modal }: (typeof runtimes)[number],
        turn: number,
      ): void => {
        for (const step of [0, 1]) {
          const [entry, word] = entries[(turn * 2 + step) % entries.length]!;
          if (modal(entry)) {
            continue;
          }
          read += 1;
          disagreements.push(
            ...disagreementsOf(
              {
                line: wrap(`${head}${entry}`),
                instance: `${head}${own}`,
                entry,
                word,
                dynamic: entry.includes("$"),
              },
              drawn,
            ),
          );
        }
      };
      grammarForms().forEach((wrap, turn) => {
        check(wrap, runtimes[turn % runtimes.length]!, turn);
      });
      runtimes.forEach((head, turn) => {
        check(WRAPPERS[turn % WRAPPERS.length]!, head, turn);
      });

      expect(read).toBeGreaterThan(2000);
      expect(disagreements.slice(0, 30)).toEqual([]);
    },
    600_000,
  );
});
