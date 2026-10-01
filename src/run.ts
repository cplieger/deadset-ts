import { ConfigError, REPOSITORY_DOCUMENT, type Inputs } from "./config.ts";
import { DiscoveryError, renderDiagnostic } from "./discover.ts";
import { EMITTERS } from "./findings/emitters.ts";
import type { Host } from "./host.ts";
import { joinPath, resolvePath } from "./paths.ts";
import { readScope, ScopeError, scopeForDir, type Scope } from "./scope.ts";
import { openEngine, type Engine } from "./session.ts";
import { printConfigVerb } from "./verbs/print-config.ts";
import { printProjectsVerb } from "./verbs/print-projects.ts";
import { printRetainedVerb } from "./verbs/print-retained.ts";
import { printRootsVerb } from "./verbs/print-roots.ts";
import { EXIT_FAILURE, EXIT_USAGE, type Verb } from "./verbs/verb.ts";
import { versionVerb } from "./verbs/version.ts";

/** One output stream of the command line. `process.stdout` and `process.stderr` satisfy it. */
export interface Writer {
  write(text: string): void;
}

/**
 * Every verb this command answers, in the order the usage text lists them. A verb
 * with no `run` is listed, and invoking it is a usage error.
 */
const VERBS: readonly { readonly name: string; readonly run?: Verb }[] = [
  { name: "analyze" },
  { name: "explain" },
  { name: "print-config", run: printConfigVerb },
  { name: "print-projects", run: printProjectsVerb },
  { name: "print-roots", run: printRootsVerb },
  { name: "print-retained", run: printRetainedVerb },
  { name: "describe" },
  { name: "version", run: versionVerb },
];

const USAGE = `usage: deadset-ts <verb> [options]\nverbs: ${VERBS.map((verb) => verb.name).join(", ")}\n`;

/**
 * The tokens whose presence in an option's name makes that option a request to
 * edit a source file. The set is closed, and a token is matched in any position of
 * the name.
 */
const SOURCE_EDIT_TOKENS = ["fix", "edit", "delete", "rewrite"] as const;

/**
 * Maps an option name to the setting of the Contract's configuration schema it supplies,
 * so one entry registers the option, supplies the document resolution reads, and gives
 * the spelling the setting's provenance names. The name is this command's vocabulary and
 * is never derived from the path: a setting reaches the command line only by an entry,
 * and a path names a key the schema declares.
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
 * Runs the command line over `args`, the arguments after the program name, and returns
 * the exit code: 0 for a completed verb, 1 for a finding that fails the run, 2 for a
 * usage error, a requested source edit or a refused configuration, 3 for a failure that
 * produced no answer. It writes nothing outside `out` and `err` and never exits the
 * process. `host` is the platform the run reads, the version it reports included, and
 * `openClient` opens the compiler client; a caller that watches what a run reads
 * supplies its own of either.
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

  const name = args[0];
  const verb = VERBS.find((listed) => listed.name === name);
  if (verb?.run !== undefined) {
    return invoke(verb.run, args.slice(1), { out, err, host }, openClient);
  }
  if (verb !== undefined) {
    err.write(`deadset-ts: ${verb.name} is not implemented\n`);
    return EXIT_USAGE;
  }
  if (name !== undefined) {
    err.write(`deadset-ts: unknown verb ${JSON.stringify(name)}\n`);
  }
  err.write(USAGE);
  return EXIT_USAGE;
}

/**
 * Runs one verb over the arguments after its name. The options are read the first
 * time the verb asks for what they name, and a refusal the verb throws is written
 * and turned into its exit code once the client the verb opened is closed.
 */
function invoke(
  verb: Verb,
  args: readonly string[],
  streams: { readonly out: Writer; readonly err: Writer; readonly host: Host },
  openClient: (collectTiming: boolean) => Engine,
): number {
  let options: Options | undefined;
  const read = (): Options => (options ??= readOptions(args));
  let opened: Engine | undefined;
  try {
    return verb({
      ...streams,
      inputs: () => inputsOf(streams.host, read()),
      scope: () => scopeOf(streams.host, read()),
      openClient: (collectTiming) => {
        opened = openClient(collectTiming);
        return opened;
      },
      emitters: EMITTERS,
    });
  } catch (error: unknown) {
    opened?.close();
    return refuse(error, streams.err);
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
