import { describe, expect, it } from "vitest";
import {
  GRAMMAR_FILES,
  TABLE_HEADS,
  UNKNOWN_TOKENS,
  VALUE,
  disagreementsOf,
  entriesOf,
  optionSpellings,
  readIn,
  unknownForms,
} from "../../__test-helpers__/named-files.ts";
import { TOOLS } from "../commands/tools.ts";

describe("the run places of a command", () => {
  it.each(GRAMMAR_FILES)(
    "holds or caps every file a runtime may run as its entry, drawn from %s, where a word no row's table models stands among a tool's or the runtime's options or in env's -S value, which env splits before its later words",
    (drawn) => {
      const entries = entriesOf(drawn);
      const own = drawn.slice("/pkg/".length);
      const disagreements: string[] = [];
      // A nested -S runs its value as the program, so the runtime after it is an argument.
      const envOptions = [
        "",
        ...optionSpellings(TOOLS.get("env")!.grammar!.options, VALUE).filter(
          (one) => !/S|split-string/u.test(one),
        ),
      ];
      let read = 0;
      const check = (line: (entry: string) => string, turn: number, unknown = false): void => {
        const { head, modal } = TABLE_HEADS[turn % TABLE_HEADS.length]!;
        const [entry, word] = entries[turn % entries.length]!;
        if (modal(entry)) {
          return;
        }
        read += 1;
        const got = disagreementsOf(
          {
            line: line(`${head}${entry}`),
            instance: `${head}${own}`,
            entry,
            word,
            dynamic: entry.includes("$"),
          },
          drawn,
        );
        disagreements.push(...got);
        if (
          unknown &&
          !readIn(line(`${head}${entry}`), [{ file: drawn, paths: [drawn] }]).unwritten
        ) {
          disagreements.push(`${line(`${head}${entry}`)} does not cap`);
        }
      };
      unknownForms().forEach((wrap, turn) => {
        check(wrap, turn, true);
      });
      TABLE_HEADS.forEach(({ head }, turn) => {
        const token = UNKNOWN_TOKENS[turn % UNKNOWN_TOKENS.length]!;
        const [program, ...rest] = head.trimEnd().split(" ");
        check(
          () => `${program ?? ""} ${token} ${rest.join(" ")} ${entries[turn % entries.length]![0]}`,
          turn,
          true,
        );
        check(() => `${head}${token} ${entries[turn % entries.length]![0]}`, turn, true);
      });
      TABLE_HEADS.forEach(({ head }, turn) => {
        const option = envOptions[turn % envOptions.length]!;
        const [entry] = entries[turn % entries.length]!;
        const split = `${option} ${head}`.trim();
        check(() => `env -S'${split}' ${entry}`, turn);
        check(() => `env -S '${split}' ${entry}`, turn);
        check(() => `env -u HOME --split-string='${split}' ${entry}`, turn);
        check(() => `env -S'${split} \\c' ${entry}`, turn, true);
        check(() => `env -S'${split} \${X}' ${entry}`, turn, true);
      });

      expect(read).toBeGreaterThan(2000);
      expect(disagreements.slice(0, 30)).toEqual([]);
    },
    600_000,
  );
});
