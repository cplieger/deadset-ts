import { runRoots, type RunRoot } from "../analysis.ts";
import { resolve } from "../resolve.ts";
import { EXIT_CLEAN, EXIT_FINDINGS, type Verb } from "./verb.ts";

/**
 * One root as a line: the declaration's reference, why it is a root, and the string
 * that named it, separated by tabs. A run of several configurations adds the ones
 * whose project holds the root as a fourth field, and writes the third present and
 * empty where no string named the root, so every line of one run holds the same
 * fields.
 */
function rootLine(root: RunRoot, several: boolean): string {
  const line = `${root.ref}\t${root.kind}`;
  if (several) {
    return `${line}\t${root.source}\t${root.configurations.join(" ")}`;
  }
  return root.source === "" ? line : `${line}\t${root.source}`;
}

/**
 * Writes the root set of the run, one root per line, and then names on the error
 * stream, by its issue kind, every configured root or pattern that named nothing;
 * one such string fails the run. The line shape is this command's own rather than a
 * Contract format, so that sort and cut read it.
 */
export const printRootsVerb: Verb = ({ out, err, host, inputs, scope, openClient }) => {
  const { config, provenance } = resolve(inputs());
  const scoped = scope();
  const answer = runRoots(openClient(false), host, scoped, config, provenance);
  const several = answer.configurations.length > 1;
  for (const root of answer.roots) {
    out.write(`${rootLine(root, several)}\n`);
  }
  for (const finding of answer.findings) {
    err.write(`${finding.code}: roots.patterns names nothing: ${finding.symbol.ref}\n`);
  }
  return answer.findings.length > 0 ? EXIT_FINDINGS : EXIT_CLEAN;
};
