import { diagnosticErrors, discoverProjects, renderDiagnostic } from "../discover.ts";
import { resolveMatrix } from "../resolve.ts";
import { diagnosticsOf, runSession } from "../session.ts";
import { EXIT_CLEAN, EXIT_FAILURE, type Verb } from "./verb.ts";

/**
 * Writes the name of every project one run analyzes, one per line, having read each
 * project's diagnostics first: the identifier the build matrix declares for it, or,
 * where discovery derived the project, its configuration file's path below the
 * target root.
 */
export const printProjectsVerb: Verb = ({ out, err, host, inputs, scope, openClient }) => {
  const matrix = resolveMatrix(inputs());
  const scoped = scope();
  const engine = openClient(false);
  const discovered = discoverProjects(engine, host, scoped, matrix);
  const ids = new Map(discovered.projects.map((project) => [project.configFile, project.id]));
  const failures: string[] = [];
  const { projects } = runSession(engine, discovered.configFiles, (project) => {
    const errors = diagnosticErrors(diagnosticsOf(project));
    failures.push(...errors.map(renderDiagnostic));
    return ids.get(project.configFile) ?? project.configFile;
  });
  if (failures.length > 0) {
    for (const line of failures) {
      err.write(`${line}\n`);
    }
    err.write(`deadset-ts: ${String(failures.length)} error(s); no answer was produced\n`);
    return EXIT_FAILURE;
  }
  for (const id of projects) {
    out.write(`${id}\n`);
  }
  return EXIT_CLEAN;
};
