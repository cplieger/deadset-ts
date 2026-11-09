import { describe, expect, it } from "vitest";
import {
  ARGUMENT_PROGRAMS,
  GRAMMAR_FILES,
  RUNTIMES,
  WRAPPERS,
  entriesOf,
  readIn,
} from "../../__test-helpers__/named-files.ts";
import { readCommands } from "../commands/read.ts";

describe("the run places of a command", () => {
  it.each(GRAMMAR_FILES)(
    "reads a runtime's name an argument of another program writes, before an entry drawn from %s, as any other word, and the second layer runs no entry there",
    (drawn) => {
      const grammar = GRAMMAR_FILES.map((one) => ({ file: one, paths: [one] }));
      const entries = entriesOf(drawn);
      const disagreements: string[] = [];
      let read = 0;
      for (const [at, [entry]] of entries.entries()) {
        for (const before of ARGUMENT_PROGRAMS) {
          const runtime = RUNTIMES[at % RUNTIMES.length]!;
          const options = [...runtime.read, ...runtime.unread];
          const option = options[(at + read) % options.length] ?? "";
          for (const wrap of WRAPPERS.slice(0, 2)) {
            read += 1;
            const line = (name: string): string => wrap(`${before}${name} ${option}${entry}`);
            const got = readIn(line(runtime.name), grammar);
            const plain = readIn(line(runtime.name.replace(/^\S+/u, "zz")), grammar);
            if (JSON.stringify(got) !== JSON.stringify(plain)) {
              disagreements.push(`${line(runtime.name)} reads otherwise than a word`);
            }
            if (
              readCommands(line(runtime.name), "/pkg").runs.some((one) => one.entry !== undefined)
            ) {
              disagreements.push(`${line(runtime.name)} second layer runs an entry`);
            }
          }
        }
      }

      expect(read).toBeGreaterThan(500);
      expect(disagreements.slice(0, 30)).toEqual([]);
    },
    300_000,
  );
});
