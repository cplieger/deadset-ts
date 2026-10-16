import { CONFIG_MAX_BYTES, SETTINGS } from "./contract/config.generated.ts";
import { EXIT_FAILURE, EXIT_USAGE } from "./contract/contract.generated.ts";
import { REPOSITORY_DOCUMENT, type Document, type Inputs } from "./config.ts";
import { DiscoveryError, renderDiagnostic } from "./discover.ts";
import { readTargetDocument, TargetDocumentError } from "./fs/document.ts";
import type { Host } from "./host.ts";
import { joinPath, resolvePath } from "./paths.ts";
import { readScope, ScopeError, scopeForDir, type Scope } from "./scope.ts";
import { SetupError, setupLine } from "./setup-failure.ts";
import { UsageError } from "./usage.ts";
import { openEngine, type Engine, type EngineOptions } from "./session.ts";
import { printConfigVerb } from "./verbs/print-config.ts";
import { printProjectsVerb } from "./verbs/print-projects.ts";
import { printRetainedVerb } from "./verbs/print-retained.ts";
import { printRootsVerb } from "./verbs/print-roots.ts";
import { ANALYZE_OPTIONS, analyzeVerb } from "./verbs/analyze.ts";
import { describeVerb } from "./verbs/describe.ts";
import { EXPLAIN_OPTIONS, explainVerb } from "./verbs/explain.ts";
import { type Verb, type VerbOptions } from "./verbs/verb.ts";
import { versionVerb } from "./verbs/version.ts";
import { diagnose, message, PRODUCT } from "./product.ts";

/** One output stream of the command line. `process.stdout` and `process.stderr` satisfy it. */
export interface Writer {
  write(text: string): void;
}

/** Every verb this command answers, in the order the usage text lists them. */
const VERBS: readonly {
  readonly name: string;
  readonly run: Verb;
  readonly options?: VerbOptions;
}[] = [
  { name: "analyze", run: analyzeVerb, options: ANALYZE_OPTIONS },
  { name: "explain", run: explainVerb, options: EXPLAIN_OPTIONS },
  { name: "print-config", run: printConfigVerb },
  { name: "print-projects", run: printProjectsVerb },
  { name: "print-roots", run: printRootsVerb },
  { name: "print-retained", run: printRetainedVerb },
  { name: "describe", run: describeVerb },
  { name: "version", run: versionVerb },
];

const USAGE = `usage: ${PRODUCT} <verb> [options]\nverbs: ${VERBS.map((verb) => verb.name).join(", ")}\n`;

/**
 * The tokens whose presence in an option's name makes that option a request to
 * edit a source file. The set is closed, and a token is matched in any position of
 * the name.
 */
const SOURCE_EDIT_TOKENS = ["fix", "edit", "delete", "rewrite"] as const;

/**
 * Maps an option name to the setting of the Contract's configuration schema it supplies:
 * the options contract/settings.json names for a setting this analyzer reads.
 */
export const SETTING_OPTIONS: ReadonlyMap<string, string> = new Map(
  SETTINGS.flatMap((row) => (row.option === undefined ? [] : [[row.option, row.key] as const])),
);

/** The options that take a value and are not settings. */
const PLAIN_OPTIONS: ReadonlySet<string> = new Set(["target", "config", "central", "scope"]);

/** One invocation's options, by name: the last value of each, and every value of a repeatable one. */
interface Options {
  readonly named: ReadonlyMap<string, string>;
  readonly repeated: ReadonlyMap<string, readonly string[]>;
}

/** No option beyond the ones every verb takes. */
const NO_OPTIONS: VerbOptions = { plain: [], repeatable: [] };

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

/** Reads one verb's options, refusing a name neither this command nor the verb offers. */
function readOptions(args: readonly string[], own: VerbOptions): Options {
  const named = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  for (const arg of args) {
    if (!arg.startsWith("-")) {
      throw new UsageError(`unexpected argument ${JSON.stringify(arg)}`);
    }
    const [spelled, ...rest] = arg.split("=");
    const name = (spelled ?? "").replace(/^-+/u, "");
    if (
      !PLAIN_OPTIONS.has(name) &&
      !SETTING_OPTIONS.has(name) &&
      !own.plain.includes(name) &&
      !own.repeatable.includes(name)
    ) {
      throw new UsageError(`unknown option ${JSON.stringify(spelled ?? arg)}`);
    }
    if (rest.length === 0) {
      throw new UsageError(`option ${JSON.stringify(spelled ?? arg)} takes a value`);
    }
    const value = rest.join("=");
    named.set(name, value);
    repeated.set(name, [...(repeated.get(name) ?? []), value]);
  }
  return { named, repeated };
}

/** The document an option names. */
function documentAt(host: Host, label: string): Document {
  try {
    const path = resolvePath(host.workingDirectory(), label);
    // A file past the bound reads as one byte more than it, which resolution refuses.
    return { text: host.readFile(path, CONFIG_MAX_BYTES + 1), label };
  } catch (error: unknown) {
    throw new UsageError(`${label}: ${message(error)}`);
  }
}

/**
 * The repository configuration at the target root, none where it is absent. One that
 * cannot be read is a configuration document that cannot be, refused with the usage code.
 */
function repositoryAt(host: Host, target: string): Document | undefined {
  const label = joinPath(target, REPOSITORY_DOCUMENT);
  const root = resolvePath(host.workingDirectory(), target);
  try {
    const text = readTargetDocument(host, root, REPOSITORY_DOCUMENT, label);
    return text === undefined ? undefined : { text, label };
  } catch (error: unknown) {
    throw error instanceof TargetDocumentError ? new UsageError(error.message) : error;
  }
}

/**
 * The configuration sources one invocation carries: the repository configuration at
 * the target root or the path an option named, the central configuration, and the
 * text each setting option was given.
 */
function inputsOf(host: Host, options: Options): Inputs {
  const named = options.named.get("config");
  const target = options.named.get("target") ?? ".";
  const repository = named === undefined ? repositoryAt(host, target) : documentAt(host, named);
  const centralLabel = options.named.get("central");
  const central = centralLabel === undefined ? undefined : documentAt(host, centralLabel);
  const flags = new Map<string, string>();
  for (const [name, key] of SETTING_OPTIONS) {
    const value = options.named.get(name);
    if (value !== undefined) {
      flags.set(key, value);
    }
  }
  return {
    flags,
    ...(repository === undefined ? {} : { repository }),
    ...(central === undefined ? {} : { central }),
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
 * process. A caller that watches what a run reads supplies its own `host` or `openClient`.
 */
export function run(
  args: readonly string[],
  out: Writer,
  err: Writer,
  host: Host,
  openClient: (options: EngineOptions) => Engine = openEngine,
): number {
  const editing = sourceEditOption(args);
  if (editing !== undefined) {
    diagnose(err, `${editing} is not supported: ${PRODUCT} reports and never edits a source file`);
    err.write(USAGE);
    return EXIT_USAGE;
  }

  const name = args[0];
  const verb = VERBS.find((listed) => listed.name === name);
  if (verb !== undefined) {
    return invoke(
      verb.run,
      verb.options ?? NO_OPTIONS,
      args.slice(1),
      { out, err, host },
      openClient,
    );
  }
  if (name !== undefined) {
    diagnose(err, `unknown verb ${JSON.stringify(name)}`);
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
  own: VerbOptions,
  args: readonly string[],
  streams: { readonly out: Writer; readonly err: Writer; readonly host: Host },
  openClient: (options: EngineOptions) => Engine,
): number {
  let options: Options | undefined;
  const read = (): Options => (options ??= readOptions(args, own));
  let opened: Engine | undefined;
  try {
    return verb({
      ...streams,
      args,
      inputs: () => inputsOf(streams.host, read()),
      scope: () => scopeOf(streams.host, read()),
      option: (name) => read().named.get(name),
      repeated: (name) => read().repeated.get(name) ?? [],
      openClient: (config) => {
        opened = openClient({
          collectTiming: false,
          components: { extensions: config.ts.component_extensions, host: streams.host },
        });
        return opened;
      },
    });
  } catch (error: unknown) {
    opened?.close();
    return refuse(error, streams.err);
  }
}

/** Turns one refusal into the exit code the Contract's table gives it. */
function refuse(error: unknown, err: Writer): number {
  if (error instanceof UsageError) {
    diagnose(err, error.message);
    err.write(USAGE);
    return EXIT_USAGE;
  }
  if (error instanceof DiscoveryError) {
    for (const diagnostic of error.diagnostics) {
      err.write(`${renderDiagnostic(diagnostic)}\n`);
    }
    diagnose(err, error.message);
    return EXIT_FAILURE;
  }
  if (error instanceof SetupError) {
    for (const failure of error.failures) {
      err.write(`${setupLine(failure)}\n`);
    }
    return EXIT_FAILURE;
  }
  if (error instanceof ScopeError || error instanceof TargetDocumentError) {
    diagnose(err, error.message);
    return EXIT_FAILURE;
  }
  throw error;
}
