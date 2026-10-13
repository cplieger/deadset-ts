import { DiagnosticCategory } from "@typescript/native/sync";
import type { Diagnostic } from "@typescript/native/sync";
import { baseUrlPaths } from "./base-url.ts";
import type { BuildConfiguration, ProjectConfiguration } from "./config.ts";
import type { Host } from "./host.ts";
import { dirnamePath, isAbsolutePath, joinPath, relativePath, resolvePath } from "./paths.ts";
import type { Scope } from "./scope.ts";
import { SetupError } from "./setup-failure.ts";
import type { Engine, ProjectDiagnostics } from "./session.ts";
import { writtenPath, type WorkspaceProgram } from "./workspace-programs.ts";

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
function isError(diagnostic: Diagnostic): boolean {
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
   * The errors in the configuration itself, and the errors the compiler places in no file
   * that leave its checker without a type it needs: no input matched, an option that
   * does not parse, a missing global type. A project carrying one did not load, whatever
   * its files say.
   */
  readonly load: readonly LocatedDiagnostic[];
  /** The errors in the files of a project that loaded: their syntax and their types. */
  readonly check: readonly LocatedDiagnostic[];
  /**
   * The libraries the configuration names that the compiler cannot find, which leave it
   * loaded: a use of a name only such a library declares is an error in its file.
   */
  readonly unfound: readonly LocatedDiagnostic[];
}

/**
 * The codes of a type library and a lib the configuration names that the compiler
 * cannot find, which it reports while it gathers the program's files,
 * https://github.com/microsoft/typescript-go/blob/89d5d5b2849a0db0957065889ca58536fa6d2e4a/internal/compiler/processingDiagnostic.go,
 * and {@link MISSING_GLOBAL_TYPE}, which the checker reports.
 */
const UNFOUND_LIBRARY: ReadonlySet<number> = new Set([2318, 2688, 2726, 2727]);

/**
 * The code of a global type the checker finds in no library the program holds. The checker
 * types every use of one against nothing and places no error in the file, so the analysis
 * skips each file of such a project whole.
 */
export const MISSING_GLOBAL_TYPE = 2318;

/** The errors one open project carries, each located in the file it names. */
export function projectErrors(sets: ProjectDiagnostics): ProjectErrors {
  // The compiler numbers its semantic messages from 2000 and its option messages from
  // 5000. A file-less option error, a removed option or an output layout, leaves the
  // program whole, and the compiler checks it all the same:
  // https://github.com/microsoft/TypeScript/wiki/Coding-guidelines#diagnostic-message-codes
  const semantic = sets.unplaced.filter(
    (diagnostic) => isError(diagnostic) && diagnostic.code >= 2000 && diagnostic.code < 3000,
  );
  const unfound = semantic.filter(({ code }) => UNFOUND_LIBRARY.has(code));
  const load = [
    ...sets.configParsing.filter(isError),
    ...semantic.filter(({ code }) => !UNFOUND_LIBRARY.has(code)),
  ];
  return {
    load: locatedIn(load, sets.locate),
    check: load.length > 0 ? [] : locatedIn(diagnosticErrors(sets), sets.locate),
    unfound: load.length > 0 ? [] : locatedIn(unfound, sets.locate),
  };
}

/** One project a run analyzes. */
interface DiscoveredProject {
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
interface Discovery {
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
 * each once, each followed by the configurations it references that `follows` admits,
 * transitively. A configuration the compiler cannot read ends the run naming it, unless
 * `unreadable` is given, which is then told the configuration and why, and the walk
 * goes on without it.
 */
function derivedFrom(
  engine: Engine,
  host: Host,
  pending: string[],
  follows: (reference: string) => boolean,
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
    const read = readConfiguration(engine, path);
    if ("reason" in read) {
      if (unreadable === undefined) {
        throw new DiscoveryError(
          `${path} cannot be read as a compiler configuration: ${read.reason}`,
          [],
        );
      }
      unreadable(path, read.reason);
      continue;
    }
    found.push(path);
    pending.push(...read.references.filter(follows));
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
  if (kind === "absent") {
    throw new SetupError([
      {
        setupClass: "missing-consumer",
        detail: `the scope declares the consumer ${root}, and nothing is at that path: check the consumer out at ${root} and install its dependencies`,
      },
    ]);
  }
  if (kind !== "directory") {
    throw new DiscoveryError(`the consumer ${root} is not a directory`, []);
  }
  const found = derivedFrom(engine, host, configFilesUnder(host, root), () => true);
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

/**
 * The code of a configuration whose `extends` chain returns to a configuration it already
 * passed. The parse reports it and returns, and a snapshot opened from it never answers:
 * https://github.com/microsoft/TypeScript/issues/64754
 */
const CIRCULAR_EXTENDS = 18000;

type Parsed = ReturnType<Engine["parseConfigFile"]>;

/** The configuration files one parsed configuration's own `extends` names by path. */
function extendedPaths(parsed: Parsed, configFile: string): readonly string[] {
  const { raw } = parsed as { readonly raw?: unknown };
  const named: unknown = typeof raw === "object" && raw !== null ? Reflect.get(raw, "extends") : [];
  return (Array.isArray(named) ? named : [named])
    .filter((one): one is string => typeof one === "string")
    .filter((one) => one.startsWith("./") || one.startsWith("../") || isAbsolutePath(one))
    .map((one) => resolvePath(dirnamePath(configFile), one));
}

/**
 * The `extends` chain from `configFile` to the first configuration it reaches twice, each
 * link by path, or undefined where no chain written by path returns.
 */
function extendsCycle(
  engine: Engine,
  configFile: string,
  parsed: Parsed,
): readonly string[] | undefined {
  const walk = (chain: readonly string[], at: Parsed): readonly string[] | undefined => {
    for (const next of extendedPaths(at, chain.at(-1) ?? configFile)) {
      if (chain.includes(next)) {
        return [...chain, next];
      }
      let read: Parsed;
      try {
        read = engine.parseConfigFile(next);
      } catch {
        continue;
      }
      const cycle = walk([...chain, next], read);
      if (cycle !== undefined) {
        return cycle;
      }
    }
    return undefined;
  };
  return walk([configFile], parsed);
}

/** The configuration files one parsed configuration's `references` name. */
function referencesOf(parsed: Parsed): readonly string[] {
  // The parse answers a directory reference as the directory; the compiler reads a
  // path not ending `.json` as its `tsconfig.json`:
  // https://github.com/microsoft/typescript-go/blob/89d5d5b2849a0db0957065889ca58536fa6d2e4a/internal/core/projectreference.go#L18
  return (parsed.projectReferences ?? []).map(({ path }) =>
    path.endsWith(".json") ? path : joinPath(path, "tsconfig.json"),
  );
}

/** Why one parsed configuration's own `extends` chain cannot be opened, where it is circular. */
function circularity(engine: Engine, configFile: string, parsed: Parsed): string | undefined {
  const chain = extendsCycle(engine, configFile, parsed);
  if (chain === undefined && !parsed.errors.some(({ code }) => code === CIRCULAR_EXTENDS)) {
    return undefined;
  }
  return `TS${String(CIRCULAR_EXTENDS)}: Circularity detected while resolving configuration: ${(chain ?? [configFile]).join(" -> ")}`;
}

/**
 * Why a configuration the `references` reach, transitively, cannot be opened, where one's
 * `extends` chain is circular: the compiler opens every referenced project with the one
 * that references it.
 */
function referencedCircularity(
  engine: Engine,
  references: readonly string[],
  visited: Set<string>,
): string | undefined {
  for (const reference of references) {
    if (visited.has(reference)) {
      continue;
    }
    visited.add(reference);
    let parsed: Parsed;
    try {
      parsed = engine.parseConfigFile(reference);
    } catch {
      continue;
    }
    const reason =
      circularity(engine, reference, parsed) ??
      referencedCircularity(engine, referencesOf(parsed), visited);
    if (reason !== undefined) {
      return reason;
    }
  }
  return undefined;
}

/**
 * The configuration files one configuration's `references` name, or why the compiler
 * cannot read the configuration: it throws, or its `extends` chain or that of a
 * configuration it references is circular, which the analysis refuses before any
 * snapshot is asked to open it.
 */
function readConfiguration(
  engine: Engine,
  configFile: string,
): { readonly references: readonly string[] } | { readonly reason: string } {
  try {
    const parsed = engine.parseConfigFile(configFile);
    const references = referencesOf(parsed);
    const reason =
      circularity(engine, configFile, parsed) ??
      referencedCircularity(engine, references, new Set([configFile]));
    return reason === undefined ? { references } : { reason };
  } catch (error: unknown) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The references of one compiler configuration file, or ends the run naming it: a
 * project opened from a configuration the compiler cannot read would be analyzed with
 * no type information.
 */
function parseOrRefuse(engine: Engine, configFile: string, named: string): readonly string[] {
  const read = readConfiguration(engine, configFile);
  if ("reason" in read) {
    throw new DiscoveryError(
      `${named} cannot be read as a compiler configuration: ${read.reason}`,
      [],
    );
  }
  return read.references;
}

/**
 * The projects a build matrix declares, in its order, each entry a file below the target
 * root: an entry naming an absent file, a directory or a file the compiler cannot read
 * ends the run naming it, and one naming an earlier entry's file adds nothing. A
 * reference below the root the matrix does not name ends the run naming both, because the
 * compiler builds a referenced project's sources into the referencing program without
 * reporting their diagnostics. A reference outside the root is an outside project.
 */
function declaredProjects(
  engine: Engine,
  host: Host,
  targetRoot: string,
  entries: readonly ProjectConfiguration[],
): Discovery {
  const seen = new Set<string>();
  const projects: DiscoveredProject[] = [];
  const references = new Map<string, readonly string[]>();
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
    references.set(configFile, parseOrRefuse(engine, configFile, named));
    projects.push({ id: entry.id, configFile });
  }
  for (const project of projects) {
    const unnamed = references
      .get(project.configFile)
      ?.find((path) => !seen.has(path) && relativePath(targetRoot, path) !== undefined);
    if (unnamed !== undefined) {
      throw new DiscoveryError(
        `the project ${JSON.stringify(project.id)} (${project.configFile}) references ` +
          `${unnamed}, which the build matrix does not name. A referenced project is built ` +
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
 * The projects a run derives where the matrix declares none, in discovery order: the
 * paths the scope names, every compiler configuration under the target root outside an
 * ignored directory, then each configuration below the root those reference,
 * transitively, each once. A reference outside the root is an outside project, whose
 * sources the compiler builds into the referencing program. A configuration the scope
 * names ends the run where it cannot be read; one the walk found is dropped and named.
 */
function derivedProjects(engine: Engine, host: Host, scope: Scope): Discovery {
  const targetRoot = scope.target.path;
  const fromScope = scopeConfigFiles(host, scope);
  const notBuilt: NotBuilt[] = [];
  const rootDir = resolvePath(
    host.workingDirectory(),
    fromScope.length > 0 ? dirnamePath(targetRoot) : targetRoot,
  );
  const configFiles = derivedFrom(
    engine,
    host,
    [...fromScope, ...configFilesUnder(host, targetRoot)],
    (reference) => relativePath(rootDir, reference) !== undefined,
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

/**
 * How the snapshot reads each configuration of `configFiles` that sets `baseUrl` and
 * `programs` does not already describe: a configuration only the snapshot holds, which
 * extends it and states the `paths` {@link baseUrlPaths} gives, so its imports resolve as
 * the compilers before version 7 resolve them. A configuration the compiler cannot read is
 * left for its project to refuse.
 */
export function withBaseUrlPaths(
  engine: Engine,
  host: Host,
  configFiles: readonly string[],
  programs: ReadonlyMap<string, WorkspaceProgram>,
): ReadonlyMap<string, WorkspaceProgram> {
  const found = new Map(programs);
  for (const configFile of configFiles) {
    if (found.has(configFile)) {
      continue;
    }
    let paths: Record<string, string[]> | undefined;
    try {
      paths = baseUrlPaths(engine.parseConfigFile(configFile).options);
    } catch {
      continue;
    }
    if (paths !== undefined) {
      found.set(configFile, {
        kind: "configuration",
        file: writtenPath(host, configFile),
        text: `${JSON.stringify({ extends: configFile, compilerOptions: { paths } }, null, 2)}\n`,
      });
    }
  }
  return found;
}
