import { describe, expect, it } from "vitest";
import {
  APPENDERS,
  GRAMMAR_FILES,
  RUNTIMES,
  type Segment,
  disagreementsOf,
  wordsOf,
  written,
} from "../../__test-helpers__/named-files.ts";

describe("the run places of a command", () => {
  it.each(GRAMMAR_FILES)(
    "holds or caps every file a runtime after a tool that hands it the paths it finds may run, its entry written with the tool's replacement text for each part, drawn from %s",
    (drawn) => {
      const own = drawn.slice("/pkg/".length);
      const words = [...new Set(wordsOf(drawn).map((one) => JSON.stringify(one)))].map(
        (one) => JSON.parse(one) as Segment[],
      );
      const disagreements: string[] = [];
      let read = 0;
      for (const [at, segments] of words.entries()) {
        for (const [appender, part, tail] of APPENDERS) {
          const runtime = RUNTIMES[at % RUNTIMES.length]!;
          const option = runtime.read[at % runtime.read.length] ?? "";
          const entry = written(segments, part, "/", "", "plain");
          if (entry === undefined) {
            continue;
          }
          read += 1;
          const head = `${runtime.name} ${option}`;
          disagreements.push(
            ...disagreementsOf(
              {
                line: `${appender}${head}${entry}${tail}`,
                instance: `${head}${own}`,
                entry,
                word: { segments, directory: false },
                dynamic: true,
              },
              drawn,
            ),
          );
        }
      }

      expect(read).toBeGreaterThan(100);
      expect(disagreements.slice(0, 30)).toEqual([]);
    },
    300_000,
  );
});
