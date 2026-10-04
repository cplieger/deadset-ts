import { runProjects } from "../analysis.ts";
import { partialNotes } from "../partial.ts";
import { resolvePath } from "../paths.ts";
import { resolveUnkinded } from "../resolve.ts";
import { EXIT_CLEAN, type Verb } from "./verb.ts";

/**
 * Writes the name of every project one run analyzes, one per line: the identifier the
 * build matrix declares for it, or, where discovery derived the project, its
 * configuration file's path below the target root. The projects are read as the
 * analysis reads them, so a project the analysis drops is named on the error stream
 * instead, and one that fails the analysis fails this command the same way.
 */
export const printProjectsVerb: Verb = ({ out, err, host, inputs, scope, openClient }) => {
  const config = resolveUnkinded(inputs());
  const scoped = scope();
  const answer = runProjects(openClient(config), host, scoped, config);
  for (const id of answer.configurations) {
    out.write(`${id}\n`);
  }
  for (const note of partialNotes({
    notBuilt: answer.notBuilt,
    unanswered: answer.unanswered,
    targetRoot: resolvePath(host.workingDirectory(), scoped.target.path),
  })) {
    err.write(`deadset-ts: ${note}\n`);
  }
  return EXIT_CLEAN;
};
