import { ConfigError, type Inputs } from "./config.ts";
import {
  diagnosticErrors,
  discoverProjects,
  DiscoveryError,
  renderDiagnostic,
} from "./discover.ts";
import type { Host } from "./host.ts";
import { joinPath, resolvePath } from "./paths.ts";
import { printConfig } from "./print.ts";
import { resolve } from "./resolve.ts";
import { readScope, ScopeError, scopeForDir, type Scope } from "./scope.ts";
import { diagnosticsOf, openEngine, runSession, type Engine } from "./session.ts";
import { CONTRACT_VERSION } from "./version.ts";

/** One output stream of the command line. `process.stdout` and `process.stderr` satisfy it. */
export interface Writer {
  write(text: string): void;
}

/** The repository configuration's name at the target root. */
const REPOSITORY_DOCUMENT = "deadset.json";

/** The exit codes the Contract's exit-code table names. */
const EXIT_CLEAN = 0;
const EXIT_USAGE = 2;
const EXIT_FAILURE = 3;

const VERBS = [
  "analyze",
  "explain",
  "print-config",
  "print-projects",
  "print-roots",
  "print-retained",
  "describe",
  "version",
] as const;

const USAGE = `usage: deadset-ts <verb> [options]\nverbs: ${VERBS.join(", ")}\n`;

/**
 * The tokens whose presence in an option's name makes that option a request to
 * edit a source file. The set is closed, and a token is matched in any position of
 * the name.
 */
const SOURCE_EDIT_TOKENS = ["fix", "edit", "delete", "rewrite"] as const;

/**
 * Maps an option name to the setting it supplies, so one entry registers the
 * option, supplies the document resolution reads, and gives the spelling the
 * setting's provenance names.
 *
 * An option's name is this command's own vocabulary, chosen for how it reads on a
 * command line, and its path is the setting of the Contract's configuration schema
 * that option supplies. The two are mapped here and never derived from one
 * another, so this table is the authority for both: a setting reaches the command
 * line only by an entry, and a path names a key the schema declares.
 */
export const SETTING_OPTIONS: ReadonlyMap<string, string> = new Map([
  ["min-confidence", "analysis.min_confidence"],
  ["sort", "reporters.sort"],
  ["cascade", "reporters.cascade"],
  ["max-findings", "reporters.max_findings"],
  ["fail-on", "reporters.fail_on"],
]);

/** The options that take a value and are not settings. */
const PLAIN_OPTIONS: ReadonlySet<string> = new Set(["target", "config", "central", "scope"]);

/** The setting options whose value is a number rather than a string. */
const NUMBER_OPTIONS: ReadonlySet<string> = new Set(["max-findings"]);

/** One invocation's options, by name, with the verb's remaining arguments. */
interface Options {
  readonly named: ReadonlyMap<string, string>;
}

/**
 * The first option whose name carries a source-edit token, because every verb
 * reports and never edits. The match is on the name alone, so an option whose
 * value carries a token is not a request.
 */
function sourceEditOption(args: readonly string[]): string | undefined {
  for (const arg of args) {
    if (!arg.startsWith("-")) {
      continue;
    }
    const spelled = arg.split("=", 1)[0] ?? arg;
    const name = spelled.replace(/^-+/u, "");
    if (SOURCE_EDIT_TOKENS.some((token) => name.includes(token))) {
      return spelled;
    }
  }
  return undefined;
}

/** Reads one verb's options, refusing a name this command does not offer. */
function readOptions(args: readonly string[]): Options {
  const named = new Map<string, string>();
  for (const arg of args) {
    if (!arg.startsWith("-")) {
      throw new ConfigError("malformed", "", `unexpected argument ${JSON.stringify(arg)}`);
    }
    const [spelled, ...rest] = arg.split("=");
    const name = (spelled ?? "").replace(/^-+/u, "");
    if (!PLAIN_OPTIONS.has(name) && !SETTING_OPTIONS.has(name)) {
      throw new ConfigError("malformed", "", `unknown option ${JSON.stringify(spelled ?? arg)}`);
    }
    if (rest.length === 0) {
      throw new ConfigError(
        "malformed",
        "",
        `option ${JSON.stringify(spelled ?? arg)} takes a value`,
      );
    }
    named.set(name, rest.join("="));
  }
  return { named };
}

function readFileOr(host: Host, path: string, orUndefined: boolean): string | undefined {
  try {
    return host.readFile(resolvePath(host.workingDirectory(), path));
  } catch (error: unknown) {
    if (orUndefined) {
      return undefined;
    }
    throw new ConfigError(
      "malformed",
      "",
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The configuration documents one invocation reads: the repository configuration
 * at the target root or the path an option named, the central configuration, and
 * the settings the options supply as one flag document.
 */
function inputsOf(host: Host, options: Options): Inputs {
  const target = options.named.get("target") ?? ".";
  const named = options.named.get("config");
  const repositoryLabel = named ?? joinPath(target, REPOSITORY_DOCUMENT);
  const repository = readFileOr(host, repositoryLabel, named === undefined);
  const centralLabel = options.named.get("central");
  const central = centralLabel === undefined ? undefined : readFileOr(host, centralLabel, false);

  const flat: Record<string, unknown> = {};
  const flagLabels = new Map<string, string>();
  for (const [name, path] of SETTING_OPTIONS) {
    const value = options.named.get(name);
    if (value === undefined) {
      continue;
    }
    flat[path] = NUMBER_OPTIONS.has(name) ? Number(value) : value;
    flagLabels.set(path, `--${name}`);
  }
  const flags = Object.keys(flat).length === 0 ? undefined : JSON.stringify(flat);

  return {
    ...(flags === undefined ? {} : { flags }),
    ...(repository === undefined ? {} : { repository, repositoryLabel }),
    ...(central === undefined || centralLabel === undefined ? {} : { central, centralLabel }),
    flagLabels,
  };
}

/** The scope one invocation analyzes: the document an option named, or the target. */
function scopeOf(host: Host, options: Options): Scope {
  const document = options.named.get("scope");
  if (document !== undefined) {
    return readScope(host, document);
  }
  return scopeForDir(host, options.named.get("target") ?? ".");
}

/**
 * Runs the deadset-ts command line over `args` (the arguments after the program
 * name) and returns the process exit code: 0 for a completed verb, 2 for a usage
 * error or a configuration this analyzer refuses, 3 for a failure that produced no
 * answer. It writes nothing outside `out` and `err` and never exits the process,
 * so a caller decides what the code means.
 *
 * An option asking for a source edit is refused before the verb is read: this
 * analyzer reports and never edits a source file.
 *
 * `host` is the platform the run reads, the version it reports included;
 * `openClient` opens the compiler client a verb that reads projects needs.
 * Both are parameters because both are the platform, which no module below this one
 * names: the command entry binds them, and a caller that wants to watch what a run
 * reads supplies its own.
 */
export function run(
  args: readonly string[],
  out: Writer,
  err: Writer,
  host: Host,
  openClient: (collectTiming: boolean) => Engine = (collectTiming) => openEngine({ collectTiming }),
): number {
  const editing = sourceEditOption(args);
  if (editing !== undefined) {
    err.write(
      `deadset-ts: ${editing} is not supported: deadset-ts reports and never edits a source file\n`,
    );
    err.write(USAGE);
    return EXIT_USAGE;
  }

  const verb = args[0];
  if (verb === "version") {
    out.write(`deadset-ts ${host.analyzerVersion()}\ncontract ${CONTRACT_VERSION}\n`);
    return EXIT_CLEAN;
  }
  if (verb === "print-config") {
    return printConfigVerb(args.slice(1), out, err, host);
  }
  if (verb === "print-projects") {
    return printProjectsVerb(args.slice(1), out, err, host, openClient);
  }
  if (verb !== undefined && (VERBS as readonly string[]).includes(verb)) {
    err.write(`deadset-ts: ${verb} is not implemented\n`);
    return EXIT_USAGE;
  }
  if (verb !== undefined) {
    err.write(`deadset-ts: unknown verb ${JSON.stringify(verb)}\n`);
  }
  err.write(USAGE);
  return EXIT_USAGE;
}

/** Writes the resolved configuration with the source of every setting. */
function printConfigVerb(args: readonly string[], out: Writer, err: Writer, host: Host): number {
  try {
    const options = readOptions(args);
    const { config, provenance } = resolve(inputsOf(host, options));
    out.write(printConfig(config, provenance));
    return EXIT_CLEAN;
  } catch (error: unknown) {
    return refuse(error, err);
  }
}

/**
 * Writes the compiler configuration of every project one run analyzes, one per
 * line, in discovery order, having read each project's diagnostics first.
 */
function printProjectsVerb(
  args: readonly string[],
  out: Writer,
  err: Writer,
  host: Host,
  openClient: (collectTiming: boolean) => Engine,
): number {
  let engine: Engine | undefined;
  try {
    const options = readOptions(args);
    const scope = scopeOf(host, options);
    engine = openClient(false);
    const discovered = discoverProjects(engine, host, scope);
    const failures: string[] = [];
    const { projects } = runSession(engine, discovered.configFiles, (project) => {
      const errors = diagnosticErrors(diagnosticsOf(project));
      failures.push(...errors.map(renderDiagnostic));
      return project.configFile;
    });
    if (failures.length > 0) {
      for (const line of failures) {
        err.write(`${line}\n`);
      }
      err.write(`deadset-ts: ${String(failures.length)} error(s); no answer was produced\n`);
      return EXIT_FAILURE;
    }
    for (const configFile of projects) {
      out.write(`${configFile}\n`);
    }
    return EXIT_CLEAN;
  } catch (error: unknown) {
    engine?.close();
    return refuse(error, err);
  }
}

/** Turns one refusal into the exit code the Contract's table gives it. */
function refuse(error: unknown, err: Writer): number {
  if (error instanceof ConfigError) {
    err.write(`deadset-ts: ${error.message}\n`);
    err.write(USAGE);
    return EXIT_USAGE;
  }
  if (error instanceof DiscoveryError) {
    for (const diagnostic of error.diagnostics) {
      err.write(`${renderDiagnostic(diagnostic)}\n`);
    }
    err.write(`deadset-ts: ${error.message}\n`);
    return EXIT_FAILURE;
  }
  if (error instanceof ScopeError) {
    err.write(`deadset-ts: ${error.message}\n`);
    return EXIT_FAILURE;
  }
  throw error;
}
