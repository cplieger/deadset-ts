import { DiagnosticCategory } from "@typescript/native/unstable/sync";
import type { Diagnostic } from "@typescript/native/unstable/sync";
import type { BuildConfiguration, ProjectConfiguration } from "./config.ts";
import type { Host } from "./host.ts";
import { dirnamePath, isAbsolutePath, joinPath, relativePath, resolvePath } from "./paths.ts";
import type { Scope } from "./scope.ts";
import type { Engine } from "./session.ts";

/** Directory names discovery does not descend into. */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules", ".git"]);

/** A compiler configuration file discovery recognises under a root. */
const CONFIG_FILE = /^tsconfig.*\.json$/u;

/**
 * A run that cannot read what it was asked to analyze. It ends the run with the
 * failure code and no finding list: a configuration file the compiler cannot read,
 * or a project carrying an error, leaves the analysis without the type information
 * every answer rests on, and a partial answer is never printed as a complete one.
 */
export class DiscoveryError extends Error {
  /** The diagnostics the compiler reported, in the order it reported them. */
  readonly diagnostics: readonly Diagnostic[];

  constructor(message: string, diagnostics: readonly Diagnostic[]) {
    super(message);
    this.name = "DiscoveryError";
    this.diagnostics = diagnostics;
  }
}

/** Whether one diagnostic is an error, which is what fails a run closed. */
export function isError(diagnostic: Diagnostic): boolean {
  return diagnostic.category === DiagnosticCategory.Error;
}

/** One diagnostic as a line naming its position, its code and its message. */
export function renderDiagnostic(diagnostic: Diagnostic): string {
  const where = diagnostic.fileName ?? "<no file>";
  return `${where}:${String(diagnostic.pos)}: TS${String(diagnostic.code)}: ${diagnostic.text}`;
}

/**
 * Every error a project's three diagnostic sets carry, in the order the compiler
 * reported them: a configuration whose options do not parse, a file whose syntax
 * does not, and a program that does not type-check. A resolved configuration
 * carries no diagnostics of its own, so a configuration written with an unreadable
 * option resolves and is refused here, once its project is open.
 */
export function diagnosticErrors(sets: {
  readonly syntactic: readonly Diagnostic[];
  readonly semantic: readonly Diagnostic[];
  readonly configParsing: readonly Diagnostic[];
}): readonly Diagnostic[] {
  return [...sets.configParsing, ...sets.syntactic, ...sets.semantic].filter(isError);
}

/** One project a run analyzes. */
export interface DiscoveredProject {
  /**
   * The name a run gives the project: the identifier the build matrix declares for
   * it, or, for a project discovery derived, its configuration file's path below the
   * target root. A derived project whose file is not below the target root is named
   * by the file's absolute path, the one spelling it has.
   */
  readonly id: string;
  /** The compiler configuration file the project is opened from, absolute. */
  readonly configFile: string;
}

/** Every project discovery found, and where each came from. */
export interface Discovery {
  /** The projects, in discovery order, each once. */
  readonly projects: readonly DiscoveredProject[];
  /** The configuration file of each project, in the same order. */
  readonly configFiles: readonly string[];
  /**
   * The files the scope named, which are the ones a derivation reads first. A
   * declared matrix reads none of them.
   */
  readonly fromScope: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The configuration files below `root`, in ascending path order, skipping an
 * ignored directory. A directory that cannot be read is skipped: a tree the
 * analysis may not enter names no project.
 */
function configFilesUnder(host: Host, root: string): string[] {
  const found: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (dir === undefined) {
      break;
    }
    let entries: readonly { readonly name: string; readonly directory: boolean }[];
    try {
      entries = host.readDirectory(dir);
    } catch {
      continue;
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = joinPath(dir, entry.name);
      if (entry.directory) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          pending.push(path);
        }
        continue;
      }
      if (CONFIG_FILE.test(entry.name)) {
        found.push(path);
      }
    }
  }
  return found.sort();
}

/**
 * The configuration files one configuration's `references` name, resolved against
 * that configuration's own directory. A reference naming a directory names the
 * `tsconfig.json` in it, which is the compiler's own rule.
 */
function referencesOf(host: Host, configFile: string): string[] {
  let text: string;
  try {
    text = host.readFile(configFile);
  } catch {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // What a configuration's contents say is refused by the compiler's own
    // diagnostics, which name the position; nothing is inferred from it here.
    return [];
  }
  if (!isRecord(value) || !Array.isArray(value["references"])) {
    return [];
  }
  const dir = dirnamePath(configFile);
  const found: string[] = [];
  for (const entry of value["references"] as unknown[]) {
    if (!isRecord(entry)) {
      continue;
    }
    const path = entry["path"];
    if (typeof path !== "string" || path === "") {
      continue;
    }
    const resolved = isAbsolutePath(path) ? path : joinPath(dir, path);
    found.push(resolved.endsWith(".json") ? resolved : joinPath(resolved, "tsconfig.json"));
  }
  return found;
}

/**
 * The configuration files the scope names directly: one per module the scope
 * declares whose path names a configuration file rather than a directory. A module
 * naming a directory is reached by the walk over that directory instead.
 */
function scopeConfigFiles(host: Host, scope: Scope): string[] {
  return [scope.target, ...scope.consumers]
    .map((module) => module.path)
    .filter((path) => path.endsWith(".json"))
    .map((path) => resolvePath(host.workingDirectory(), path));
}

/**
 * The name a derived project carries: its configuration file's path below the target
 * root, or the absolute path of a file outside it.
 */
function derivedId(targetRoot: string, configFile: string): string {
  return relativePath(targetRoot, configFile) ?? configFile;
}

/**
 * Resolves one compiler configuration file, or ends the run naming it: a project
 * opened from a configuration the compiler cannot read would be analyzed with no
 * type information.
 */
function parseOrRefuse(engine: Engine, configFile: string, named: string): void {
  try {
    engine.parseConfigFile(configFile);
  } catch (error: unknown) {
    throw new DiscoveryError(
      `${named} cannot be read as a compiler configuration: ` +
        (error instanceof Error ? error.message : String(error)),
      [],
    );
  }
}

/**
 * The projects a build matrix declares, in the order it lists them. Each entry
 * names a file below the target root, and an entry naming a file that is absent,
 * that is a directory, or that the compiler cannot read ends the run naming it.
 *
 * A declared project's `references` are not followed, because the entries are the
 * matrix, and a reference to a configuration the matrix does not name ends the run
 * naming both: the compiler builds a referenced project's sources into the program
 * that references it without reporting their diagnostics, so the project the matrix
 * left out would be analyzed with its errors unread. An entry naming a file an
 * earlier entry named adds nothing, so the earlier identifier stands.
 */
function declaredProjects(
  engine: Engine,
  host: Host,
  targetRoot: string,
  entries: readonly ProjectConfiguration[],
): Discovery {
  const seen = new Set<string>();
  const projects: DiscoveredProject[] = [];
  for (const entry of entries) {
    const configFile = joinPath(targetRoot, entry.project);
    const named = `the project ${JSON.stringify(entry.id)} (${configFile})`;
    const kind = host.kindOf(configFile);
    if (kind !== "file") {
      throw new DiscoveryError(
        kind === "absent"
          ? `${named} does not exist`
          : `${named} is a directory, and a project names its compiler configuration file`,
        [],
      );
    }
    if (seen.has(configFile)) {
      continue;
    }
    seen.add(configFile);
    parseOrRefuse(engine, configFile, named);
    projects.push({ id: entry.id, configFile });
  }
  for (const project of projects) {
    const unnamed = referencesOf(host, project.configFile).find((path) => !seen.has(path));
    if (unnamed !== undefined) {
      throw new DiscoveryError(
        `the project ${JSON.stringify(project.id)} (${project.configFile}) references ` +
          `${unnamed}, which the build matrix does not name; a referenced project is built ` +
          "into the program that references it, so the matrix names it too",
        [],
      );
    }
  }
  return { projects, configFiles: projects.map((project) => project.configFile), fromScope: [] };
}

/**
 * The projects a run derives where the matrix declares none, in the order discovery
 * reads them: the paths the scope names, then every compiler configuration under
 * the target root that is not inside an ignored directory, then the configurations
 * each of those references, transitively. Each configuration appears once.
 */
function derivedProjects(engine: Engine, host: Host, scope: Scope): Discovery {
  const fromScope = scopeConfigFiles(host, scope);
  const seen = new Set<string>();
  const projects: DiscoveredProject[] = [];
  const pending = [...fromScope, ...configFilesUnder(host, scope.target.path)];
  while (pending.length > 0) {
    const configFile = pending.shift();
    if (configFile === undefined) {
      break;
    }
    const path = resolvePath(host.workingDirectory(), configFile);
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    parseOrRefuse(engine, path, path);
    projects.push({ id: derivedId(scope.target.path, path), configFile: path });
    pending.push(...referencesOf(host, path));
  }
  return { projects, configFiles: projects.map((project) => project.configFile), fromScope };
}

/**
 * Every project one run analyzes.
 *
 * The project entries of the build matrix, where it holds any, are the projects:
 * exactly those, in the order the matrix lists them, each named by its declared
 * identifier, as {@link declaredProjects} reads them. A matrix holding no project
 * entry, the empty one included, leaves discovery to derive the projects from the
 * scope and the target tree. A platform entry names a configuration of another
 * language and plays no part here.
 *
 * A configuration file the compiler cannot read ends the run with the failure code,
 * so a project that would have been analyzed with no type information is never
 * analyzed at all, whether the matrix declared it or discovery derived it. What a
 * configuration's own contents say is refused once its project is open, by
 * {@link diagnosticErrors} over the three sets a program reports, because a
 * resolution carries no diagnostics.
 *
 * Nothing reads a build output: a project is the files its configuration names, so a
 * package whose sources ship as TypeScript is analyzed as it stands.
 */
export function discoverProjects(
  engine: Engine,
  host: Host,
  scope: Scope,
  configurations: readonly BuildConfiguration[] = [],
): Discovery {
  const declared = configurations.filter(
    (entry): entry is ProjectConfiguration => entry.shape === "project",
  );
  if (declared.length > 0) {
    return declaredProjects(engine, host, scope.target.path, declared);
  }
  return derivedProjects(engine, host, scope);
}
