import { describe, expect, it } from "vitest";
import {
  GRAMMAR_FILES,
  LAUNCHERS,
  RUNTIMES,
  WRAPPERS,
  disagreementsOf,
  entriesOf,
} from "../../__test-helpers__/named-files.ts";
import { readCommands } from "../commands/read.ts";

describe("the run places of a command", () => {
  it.each(GRAMMAR_FILES)(
    "holds or caps every file the runtime of each drawn command may run as its entry, drawn from %s, as the second layer reads the command, whichever shell it is handed to",
    (drawn) => {
      const entries = entriesOf(drawn);
      const own = drawn.slice("/pkg/".length);
      const disagreements: string[] = [];
      let read = 0;
      let byLayer2 = 0;
      let turn = 0;
      for (const [launcher, packaged] of LAUNCHERS) {
        for (const runtime of RUNTIMES) {
          const versions = packaged && !runtime.name.includes(" ") ? ["", "@4"] : [""];
          for (const version of versions) {
            for (const option of [...runtime.read, ...runtime.unread]) {
              for (const after of ["", " --flag", " out.txt"]) {
                const [program, ...mode] = runtime.name.split(" ");
                const head = `${launcher}${program ?? ""}${version}${mode.map((one) => ` ${one}`).join("")} ${option}`;
                byLayer2 += readCommands(`${head}${own}${after}`, "/pkg").runs.some(
                  (one) => one.entry !== undefined,
                )
                  ? 1
                  : 0;
                for (const wrap of WRAPPERS) {
                  turn += 1;
                  const [entry, word] = entries[turn % entries.length]!;
                  read += 1;
                  disagreements.push(
                    ...disagreementsOf(
                      {
                        line: wrap(`${head}${entry}${after}`),
                        instance: `${head}${own}${after}`,
                        entry,
                        word,
                        dynamic: entry.includes("$"),
                      },
                      drawn,
                    ),
                  );
                }
              }
            }
          }
        }
      }

      expect(read).toBeGreaterThan(10_000);
      expect(byLayer2 * WRAPPERS.length).toBeGreaterThan(read / 4);
      expect(disagreements.slice(0, 30)).toEqual([]);
    },
    900_000,
  );
});
