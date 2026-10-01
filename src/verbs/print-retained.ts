import { runSweep } from "../analysis.ts";
import { retainedLines } from "../exempt.ts";
import { resolve } from "../resolve.ts";
import { EXIT_CLEAN, type Verb } from "./verb.ts";

/**
 * Writes every declaration an exemption held back in the production sweep a report is
 * built from, one per line, and nothing where no exemption held one back. One fact
 * several configurations found is one record, so the line names no configuration. The
 * line shape is this command's own rather than a Contract format, so that sort and cut
 * read it.
 */
export const printRetainedVerb: Verb = ({ out, host, inputs, scope, openClient }) => {
  const { config } = resolve(inputs());
  const scoped = scope();
  const swept = runSweep(openClient(false), host, scoped, config, {
    marked: [],
    mode: { production: true },
  });
  for (const line of retainedLines(swept.matrix.union.symbols, swept.retained)) {
    out.write(`${line}\n`);
  }
  return EXIT_CLEAN;
};
