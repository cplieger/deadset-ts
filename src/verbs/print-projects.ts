import {
  discoverProjects,
  DiscoveryError,
  isGuess,
  projectErrors,
  renderDiagnostic,
  targetRelative,
  type NotBuilt,
} from "../discover.ts";
import { partialNotes } from "../partial.ts";
import { relativePath, resolvePath } from "../paths.ts";
import { resolveMatrix } from "../resolve.ts";
import { diagnosticsOf, runSession } from "../session.ts";
import { EXIT_CLEAN, EXIT_FAILURE, type Verb } from "./verb.ts";

/**
 * Writes the name of every project one run analyzes, one per line, having read each
 * project's diagnostics first: the identifier the build matrix declares for it, or,
 * where discovery derived the project, its configuration file's path below the
 * target root. A derived project that does not load is not one the run analyzes, so it
 * is named on the error stream instead, as the analysis drops it.
 */
export const printProjectsVerb: Verb = ({ out, err, host, inputs, scope, openClient }) => {
  const matrix = resolveMatrix(inputs());
  const scoped = scope();
  const engine = openClient(false);
  const discovered = discoverProjects(engine, host, scoped, matrix);
  const ids = new Map(discovered.projects.map((project) => [project.configFile, project.id]));
  const root = resolvePath(host.workingDirectory(), scoped.target.path);
  const notBuilt: NotBuilt[] = [...discovered.notBuilt];
  const failures: string[] = [];
  const session = runSession(
    engine,
    discovered.configFiles,
    (project) => {
      const id = ids.get(project.configFile) ?? project.configFile;
      const errors = projectErrors(diagnosticsOf(project));
      const [unloaded] = errors.load;
      if (unloaded !== undefined && isGuess(discovered, project.configFile)) {
        const error = renderDiagnostic(unloaded, (path) => relativePath(root, path) ?? path);
        notBuilt.push({ id, configFile: project.configFile, error: targetRelative(error, root) });
        return undefined;
      }
      failures.push(...[...errors.load, ...errors.check].map((one) => renderDiagnostic(one)));
      return id;
    },
    discovered.derived ? "record" : "refuse",
  );
  for (const configFile of session.unopened) {
    if (!isGuess(discovered, configFile)) {
      throw new DiscoveryError(`${configFile} opened no project`, []);
    }
    notBuilt.push({
      id: ids.get(configFile) ?? configFile,
      configFile,
      error: "the compiler opened no project for the configuration",
    });
  }
  if (failures.length > 0) {
    for (const line of failures) {
      err.write(`${line}\n`);
    }
    err.write(`deadset-ts: ${String(failures.length)} error(s), so no answer was produced\n`);
    return EXIT_FAILURE;
  }
  const projects = session.projects.filter((id): id is string => id !== undefined);
  if (projects.length === 0 && notBuilt.length > 0) {
    for (const note of partialNotes({ notBuilt, unanswered: [] })) {
      err.write(`deadset-ts: ${note}\n`);
    }
    err.write("deadset-ts: no configuration discovery derived could be built\n");
    return EXIT_FAILURE;
  }
  for (const id of projects) {
    out.write(`${id}\n`);
  }
  for (const note of partialNotes({ notBuilt, unanswered: [] })) {
    err.write(`deadset-ts: ${note}\n`);
  }
  return EXIT_CLEAN;
};
