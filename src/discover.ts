import { DiagnosticCategory } from "@typescript/native/unstable/sync";
import type { Diagnostic } from "@typescript/native/unstable/sync";
import type { BuildConfiguration, ProjectConfiguration } from "./config.ts";
import type { Host } from "./host.ts";
import { dirnamePath, isAbsolutePath, joinPath, relativePath, resolvePath } from "./paths.ts";
import type { Scope } from "./scope.ts";
import type { Engine, ProjectDiagnostics } from "./session.ts";

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
  readonly diagnostics: readonly LocatedDiagnostic[];

  constructor(message: string, diagnostics: readonly LocatedDiagnostic[]) {
    super(message);
    this.name = "DiscoveryError";
    this.diagnostics = diagnostics;
  }
}

/** The category an error diagnostic carries, which the protocol sends as a number. */
const ERROR_CATEGORY: number = DiagnosticCategory.Error;

/** Whether one diagnostic is an error, which is what fails a run closed. */
export function isError(diagnostic: Diagnostic): boolean {
  return diagnostic.category === ERROR_CATEGORY;
}

/** One diagnostic, with the line and column its offset falls on where it names a file. */
export interface LocatedDiagnostic {
  readonly diagnostic: Diagnostic;
  /** Where the diagnostic starts, counted from one; absent where it names no position. */
  readonly at?: { readonly line: number; readonly column: number } | undefined;
}

/**
 * One diagnostic as a line naming its file, its line and column, its code and its
 * message: `path:line:column: TScode: message`, the position left out where the
 * diagnostic names none and the file where it names none. `display` spells the
 * file's path; it answers the path itself where it is not given.
 */
export function renderDiagnostic(
  located: LocatedDiagnostic,
  display: (path: string) => string = (path) => path,
): string {
  const { diagnostic, at } = located;
  const message = `TS${String(diagnostic.code)}: ${diagnostic.text}`;
  if (diagnostic.fileName === undefined) {
    return message;
  }
  const where = display(diagnostic.fileName);
  return at === undefined
    ? `${where}: ${message}`
    : `${where}:${String(at.line)}:${String(at.column)}: ${message}`;
}

/** Each diagnostic with the line and column its offset falls on. */
function locatedIn(
  diagnostics: readonly Diagnostic[],
  locate: (fileName: string, offset: number) => { line: number; column: number } | undefined,
): readonly LocatedDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    diagnostic,
    at: diagnostic.fileName === undefined ? undefined : locate(diagnostic.fileName, diagnostic.pos),
  }));
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

/** Why one open project cannot be analyzed, split by whether it loaded at all. */
interface ProjectErrors {
  /**
   * The errors in the configuration itself: no input matched, an option that does not
   * parse. A project carrying one did not load, whatever its files say.
   */
  readonly load: readonly LocatedDiagnostic[];
  /** The errors in the files of a project that loaded: their syntax and their types. */
  readonly check: readonly LocatedDiagnostic[];
}

/** The errors one open project carries, each located in the file it names. */
export function projectErrors(sets: ProjectDiagnostics): ProjectErrors {
  const load = sets.configParsing.filter(isError);
  return {
    load: locatedIn(load, sets.locate),
    check: load.length > 0 ? [] : locatedIn(diagnosticErrors(sets), sets.locate),
  };
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

/**
 * One project discovery derived and the run could not build, with the first line of
 * the error that dropped it.
 */
export interface NotBuilt {
  /** The name the project would have carried, as {@link DiscoveredProject.id} spells it. */
  readonly id: string;
  /** The compiler configuration file, absolute. */
  readonly configFile: string;
  /**
   * The error's first line, every path below the target root spelled relative to it, so
   * a report naming it carries no path of the machine it ran on.
   */
  readonly error: string;
}

/**
 * The first line of one error about the target, every mention of the target root
 * spelled relative to it: a path below the root loses the root and its separator, and
 * the root itself is `.`.
 */
export function targetRelative(text: string, targetRoot: string): string {
  const root = targetRoot.endsWith("/") ? targetRoot.slice(0, -1) : targetRoot;
  const [first = ""] = text.split(/\r?\n/u);
  const spelled = first.split(`${root}/`).join("").split(root).join(".").trim();
  return spelled === "" ? "the configuration could not be built" : spelled;
}

/**
 * Whether one configuration is the analyzer's own guess: discovery derived it and the
 * scope did not name it. A guess that does not load is dropped; any other ends the run.
 */
export function isGuess(discovery: Discovery, configFile: string): boolean {
  return discovery.derived && !discovery.fromScope.includes(configFile);
}

/** Every project discovery found, and where each came from. */
export interface Discovery {
  /** The projects, in discovery order, each once. */
  readonly projects: readonly DiscoveredProject[];
  /**
   * Whether discovery derived the projects rather than reading them from a declared
   * matrix. A derived project that fails to load is dropped and named in
   * {@link Discovery.notBuilt}; a declared one ends the run.
   */
  readonly derived: boolean;
  /** The derived configurations the compiler could not read, in discovery order. */
  readonly notBuilt: readonly NotBuilt[];
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
 * The configuration file the scope names for the target directly, where its path
 * names one rather than a directory. A target naming a directory is reached by the
 * walk over that directory instead. A consumer's projects are a consumer's, never the
 * target's, so no consumer path is read here.
 */
function scopeConfigFiles(host: Host, scope: Scope): string[] {
  return [scope.target.path]
    .filter((path) => path.endsWith(".json"))
    .map((path) => resolvePath(host.workingDirectory(), path));
}

/**
 * Every configuration file reached from `pending`, in the order discovery reads them:
 * each once, each followed by the configurations it references, transitively. A
 * configuration the compiler cannot read ends the run naming it, unless `unreadable`
 * is given, which is then told the configuration and why, and the walk goes on
 * without it.
 */
function derivedFrom(
  engine: Engine,
  host: Host,
  pending: string[],
  unreadable?: (configFile: string, reason: string) => void,
): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
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
    const reason = unreadableReason(engine, path);
    if (reason !== undefined) {
      if (unreadable === undefined) {
        throw new DiscoveryError(
          `${path} cannot be read as a compiler configuration: ${reason}`,
          [],
        );
      }
      unreadable(path, reason);
      continue;
    }
    found.push(path);
    pending.push(...referencesOf(host, path));
  }
  return found;
}

/**
 * The compiler configurations one consumer is loaded through: every one under its
 * root that is not inside an ignored directory, and the configurations each of those
 * references, transitively, in that order. A root that is absent, that is no
 * directory, or that holds no configuration ends the run naming it, because a
 * finding computed without a declared consumer would claim a reference set the run
 * never read.
 */
export function consumerProjects(engine: Engine, host: Host, root: string): readonly string[] {
  const kind = host.kindOf(root);
  if (kind !== "directory") {
    throw new DiscoveryError(
      kind === "absent"
        ? `the consumer ${root} does not exist`
        : `the consumer ${root} is not a directory`,
      [],
    );
  }
  const found = derivedFrom(engine, host, configFilesUnder(host, root));
  if (found.length === 0) {
    throw new DiscoveryError(
      `the consumer ${root} holds no compiler configuration, so none of its references can be read`,
      [],
    );
  }
  return found;
}

/**
 * The name a derived project carries: its configuration file's path below the target
 * root, or the absolute path of a file outside it.
 */
function derivedId(targetRoot: string, configFile: string): string {
  return relativePath(targetRoot, configFile) ?? configFile;
}

/** Why the compiler cannot read one configuration file, or undefined where it can. */
function unreadableReason(engine: Engine, configFile: string): string | undefined {
  try {
    engine.parseConfigFile(configFile);
    return undefined;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Resolves one compiler configuration file, or ends the run naming it: a project
 * opened from a configuration the compiler cannot read would be analyzed with no
 * type information.
 */
function parseOrRefuse(engine: Engine, configFile: string, named: string): void {
  const reason = unreadableReason(engine, configFile);
  if (reason !== undefined) {
    throw new DiscoveryError(`${named} cannot be read as a compiler configuration: ${reason}`, []);
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
  return {
    projects,
    derived: false,
    notBuilt: [],
    configFiles: projects.map((project) => project.configFile),
    fromScope: [],
  };
}

/**
 * The projects a run derives where the matrix declares none, in the order discovery
 * reads them: the paths the scope names, then every compiler configuration under
 * the target root that is not inside an ignored directory, then the configurations
 * each of those references, transitively. Each configuration appears once. A
 * configuration the scope names directly is the caller's own and ends the run where
 * it cannot be read; one the walk found is dropped and named.
 */
function derivedProjects(engine: Engine, host: Host, scope: Scope): Discovery {
  const targetRoot = scope.target.path;
  const fromScope = scopeConfigFiles(host, scope);
  const notBuilt: NotBuilt[] = [];
  const configFiles = derivedFrom(
    engine,
    host,
    [...fromScope, ...configFilesUnder(host, targetRoot)],
    (configFile, reason) => {
      if (fromScope.includes(configFile)) {
        throw new DiscoveryError(
          `${configFile} cannot be read as a compiler configuration: ${reason}`,
          [],
        );
      }
      notBuilt.push({
        id: derivedId(targetRoot, configFile),
        configFile,
        error: targetRelative(reason, resolvePath(host.workingDirectory(), targetRoot)),
      });
    },
  );
  const projects = configFiles.map((configFile) => ({
    id: derivedId(targetRoot, configFile),
    configFile,
  }));
  return { projects, derived: true, notBuilt, configFiles, fromScope };
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
 * A configuration file the compiler cannot read is never analyzed. One the matrix or
 * the scope names ends the run with the failure code; a guess is dropped and named in
 * {@link Discovery.notBuilt}. What a configuration's own contents say is read once its
 * project is open, by {@link diagnosticErrors}, because a resolution carries none.
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
