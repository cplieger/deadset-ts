import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AFTER,
  BARE,
  BEFORE,
  DYNAMIC_LINES,
  FILES,
  GRAMMAR_FILES,
  LAUNCHERS,
  OUTSIDE_STDIN,
  PERL_ENTRIES,
  STDIN_READERS,
  TABLE_HEADS,
  WRAPPERS,
  grammarForms,
  namedAsEntry,
  oneWord,
  readIn,
  spellingsOf,
  unknownForms,
} from "../../__test-helpers__/named-files.ts";
import { heldWords } from "../commands/held.ts";
import { readCommands } from "../commands/read.ts";
import { spelledFiles } from "./named-files.ts";

describe("spelledFiles", () => {
  const spelled = FILES.map((one) => ({ file: one, paths: [one] }));

  it("names every file one of whose spellings stands in the text as a path", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FILES),
        fc.nat(),
        fc.constantFrom(...BEFORE),
        fc.constantFrom(...AFTER),
        (file, pick, before, after) => {
          const spellings = spellingsOf(file);
          const spelling = spellings[pick % spellings.length]!;
          const text = `${before}${oneWord(spelling, before + after)}${after}`;

          expect(readIn(text, spelled).files, text).toContain(file);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("names no file a bare word spells, but where a runtime may take it as its entry", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...BARE),
        fc.constantFrom(...BEFORE.filter((one) => !/[/\\]$/u.test(one))),
        fc.constantFrom(...AFTER),
        (word, before, after) => {
          const text = `${before}${word}${after}`;
          const named = readIn(text, spelled).files;
          // Only `node ` makes the word a runtime's entry; an `after` with no blank may go on with it.
          const entry = word.split(" ")[0] ?? "";
          const exact = ["", " ", " node", ";"].includes(after) && !word.includes(" ");

          if (before !== "node ") {
            expect(named, text).toEqual([]);
          } else if (exact) {
            expect(named, text).toEqual(FILES.filter((file) => namedAsEntry(entry, file)));
          } else {
            expect(
              named.filter((file) => !namedAsEntry(entry, file)),
              text,
            ).toEqual([]);
          }
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe("the run places of a command", () => {
  it("caps the package where a command or command line each row's table hands on, in every spelling, runs a program word that may be any text", () => {
    const grammar = GRAMMAR_FILES.map((one) => ({ file: one, paths: [one] }));
    const forms = grammarForms();
    // A static runtime is read in any quoted text, so only a dynamic program word shows a
    // command line the reading misses.
    const missed = [...forms, ...unknownForms()].flatMap((wrap) =>
      ["$RUNNER lint", '"$CMD"'].map(wrap).filter((one) => !readIn(one, grammar).unwritten),
    );
    const perl = PERL_ENTRIES.flatMap((write) =>
      TABLE_HEADS.map(({ head }) => write(head)).filter((one) => !readIn(one, grammar).unwritten),
    );

    expect(forms.length).toBeGreaterThan(500);
    expect(missed.slice(0, 30)).toEqual([]);
    expect(perl.slice(0, 30)).toEqual([]);
  }, 60_000);

  it("caps the package where a command that runs its standard input is handed, by each wrapper that hands on a command line, a standard input no word writes a path of", () => {
    const grammar = GRAMMAR_FILES.map((one) => ({ file: one, paths: [one] }));
    // A wrapper that feeds the line its own standard input leaves none to hand on.
    const handing = WRAPPERS.filter((wrap) => !/<<|\| *(?:sh|bash)/u.test(wrap("x")));
    const missed: string[] = [];
    let read = 0;
    for (const wrap of handing) {
      for (const [reader, shell] of STDIN_READERS) {
        for (const [give, onlyShell] of OUTSIDE_STDIN) {
          if (onlyShell && !shell) {
            continue;
          }
          read += 1;
          const line = give(wrap(reader));
          if (!readIn(line, grammar).unwritten) {
            missed.push(line);
          }
        }
      }
    }

    expect(handing.length).toBeGreaterThan(15);
    expect(read).toBeGreaterThan(1000);
    expect(missed.slice(0, 30)).toEqual([]);
  });

  it("caps the package where node runs its test runner, after every spelling of every option of its table, but in a manifest's script the test runs tests.1 roots", () => {
    const grammar = GRAMMAR_FILES.map((one) => ({ file: one, paths: [one] }));
    const heads = TABLE_HEADS.filter(({ head }) => head.startsWith("node "));
    const missed: string[] = [];
    let rooted = 0;
    for (const { head } of heads) {
      for (const wrap of WRAPPERS.slice(0, 2)) {
        const line = wrap(`${head}--test`);
        const tested = spelledFiles(
          heldWords([{ text: line, shell: true, tested: true }]),
          "/pkg",
          "/pkg",
          grammar,
        );
        const tests = readCommands(line, "/pkg").tests;
        rooted += tests.length > 0 && !tested.unwritten ? 1 : 0;
        if (!readIn(line, grammar).unwritten) {
          missed.push(`${line} outside a manifest's script`);
        }
        if (tests.length === 0 && !tested.unwritten) {
          missed.push(`${line} in a manifest's script`);
        }
      }
    }

    expect(heads.length).toBeGreaterThan(100);
    expect(rooted).toBeGreaterThan(heads.length / 2);
    expect(missed.slice(0, 30)).toEqual([]);
  });

  it.each(LAUNCHERS.map(([launcher]) => launcher))(
    "caps the package where each command after %j may run any text as its program word",
    (launcher) => {
      const grammar = GRAMMAR_FILES.map((one) => ({ file: one, paths: [one] }));
      const missed = DYNAMIC_LINES.flatMap((line) =>
        WRAPPERS.slice(0, 2)
          .map((wrap) => wrap(`${launcher}${line}`))
          .filter((one) => !readIn(one, grammar).unwritten),
      );

      expect(missed).toEqual([]);
    },
  );
});
