import { describe, expect, it } from "vitest";
import {
  GRAMMAR_FILES,
  STDIN_READERS,
  TABLE_HEADS,
  WRAPPERS,
  WRITERS,
  disagreementsOf,
  entriesOf,
} from "../../__test-helpers__/named-files.ts";

describe("the run places of a command", () => {
  it.each(GRAMMAR_FILES)(
    "holds or caps every file a runtime may run as its entry, drawn from %s, where echo or printf before a pipe writes the command line a shell reads, as the second layer reads that line",
    (drawn) => {
      const entries = entriesOf(drawn);
      const own = drawn.slice("/pkg/".length);
      const shells = STDIN_READERS.filter(([, shell]) => shell).map(([reader]) => reader);
      const handing = WRAPPERS.filter((wrap) => !/<<|\| *(?:sh|bash)/u.test(wrap("x")));
      const disagreements: string[] = [];
      let read = 0;
      TABLE_HEADS.forEach(({ head, modal }, turn) => {
        for (const [step, write] of WRITERS.entries()) {
          const [entry, word] = entries[(turn + step) % entries.length]!;
          if (modal(entry)) {
            continue;
          }
          const reader = shells[(turn + step) % shells.length]!;
          const wrap = handing[(turn + step) % handing.length]!;
          read += 1;
          disagreements.push(
            ...disagreementsOf(
              {
                line: `${write(`${head}${entry}`)} | ${wrap(reader)}`,
                instance: `${head}${own}`,
                entry,
                word,
                dynamic: entry.includes("$"),
              },
              drawn,
            ),
          );
        }
      });

      expect(read).toBeGreaterThan(1000);
      expect(disagreements.slice(0, 30)).toEqual([]);
    },
    600_000,
  );
});
