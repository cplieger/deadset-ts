import { DiagnosticCategory } from "@typescript/native/unstable/sync";
import type { Diagnostic } from "@typescript/native/unstable/sync";
import type { Host } from "./host.ts";
import { dirnamePath, isAbsolutePath, joinPath, resolvePath } from "./paths.ts";
import type { Scope } from "./scope.ts";
import type { Engine } from "./session.ts";

/** Directory names discovery does not descend into. */
const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules", ".git"]);

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

/** Every compiler configuration file discovery found, and where each came from. */
export interface Discovery {
  /** The configuration files, in discovery order, each once. */
  readonly configFiles: readonly string[];
  /** The files the scope named, which are the ones discovery read first. */
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
 * Every project one run analyzes, in the order discovery reads them: the paths the
 * scope names, then every compiler configuration under the target root that is not
 * inside an ignored directory, then the configurations each of those references,
 * transitively. Each configuration appears once.
 *
 * A configuration file the compiler cannot read ends the run with the failure code,
 * so a project that would have been analyzed with no type information is never
 * analyzed at all. What a configuration's own contents say is refused once its
 * project is open, by {@link diagnosticErrors} over the three sets a program
 * reports, because a resolution carries no diagnostics.
 *
 * Nothing reads a build output: a project is the files its configuration names, so a
 * package whose sources ship as TypeScript is analyzed as it stands.
 */
export function discoverProjects(engine: Engine, host: Host, scope: Scope): Discovery {
  const fromScope = scopeConfigFiles(host, scope);
  const seen = new Set<string>();
  const configFiles: string[] = [];
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
    try {
      engine.parseConfigFile(path);
    } catch (error: unknown) {
      throw new DiscoveryError(
        `${path} cannot be read as a compiler configuration: ` +
          (error instanceof Error ? error.message : String(error)),
        [],
      );
    }
    configFiles.push(path);
    pending.push(...referencesOf(host, path));
  }
  return { configFiles, fromScope };
}
