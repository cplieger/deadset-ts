import type { BuildConfiguration, ProjectConfiguration } from "../config.ts";
import { LANGUAGE_ROWS } from "../contract/contract.generated.ts";
import { filesBelow } from "../fs/tree.ts";
import type { Host } from "../host.ts";
import { packageScope } from "../inventory.ts";
import { dirnamePath, joinPath, relativePath, resolvePath } from "../paths.ts";
import { LANGUAGE, message } from "../product.ts";
import type { Module, Scope } from "../scope.ts";
import type { Engine } from "../session.ts";
import { globExpression } from "../text/glob.ts";
import { failureExit } from "../failure.ts";

/** The names of the files a program of the language is read from. */
export const MARKERS = LANGUAGE_ROWS[LANGUAGE].markers;
const MARKER_EXPRESSIONS = MARKERS.map(globExpression);

/** Whether one file name is a compiler configuration's: one of the language row's markers. */
export function isConfigFile(name: string): boolean {
  return MARKER_EXPRESSIONS.some((marker) => marker.test(name));
}

/**
 * Where one configuration of a run comes from, which decides what a failure to build it
 * does: a guess discovery derived is dropped, any other ends the run.
 */
export type Origin = "declared" | "scope" | "derived" | "consumer";

/** One consumer the run loads. */
export interface LoadedConsumer {
  /** The name the consumer publishes itself under, which every finding names it by. */
  readonly id: string;
  /** The consumer's directory, absolute. */
  readonly path: string;
}

/** One compiler configuration a run opens. */
export interface Configuration {
  /**
   * The name a run gives the project: the identifier the build matrix declares for it, or,
   * for a derived one, its configuration file's path below the target root, else its
   * absolute path. A consumer's is its configuration file's absolute path.
   */
  readonly id: string;
  /** The compiler configuration file, absolute. */
  readonly configFile: string;
  readonly origin: Origin;
  /** The compiler's parse of the configuration, which discovery could read and found not circular. */
  readonly parsed: Parsed;
  /** The consumer the configuration loads, for one whose origin is `consumer`. */
  readonly consumer?: LoadedConsumer | undefined;
}

/** Whether the run analyzes one configuration as the target's. */
export function isTargetConfiguration(configuration: Configuration): boolean {
  return configuration.origin !== "consumer";
}

/**
 * One project discovery derived and the run could not build, with the first line of the
 * error that dropped it.
 */
export interface NotBuilt {
  /** The name the project would have carried, as {@link Configuration.id} spells it. */
  readonly id: string;
  /** The compiler configuration file, absolute. */
  readonly configFile: string;
  /** The error's first line, every path below the target root spelled relative to it. */
  readonly error: string;
}

/** Every configuration a run opens, the target's in discovery order, then each consumer's. */
export interface Discovery {
  /** Whether the matrix is the configuration document's or one discovery derived. */
  readonly mode: "declared" | "derived";
  readonly configurations: readonly Configuration[];
  /** The derived configurations the compiler could not read, in discovery order. */
  readonly notBuilt: readonly NotBuilt[];
  /** Every declared consumer, in the scope's order. */
  readonly consumers: readonly LoadedConsumer[];
}

/**
 * The first line of one error about the target, every mention of the target root spelled
 * relative to it: a path below the root loses the root and its separator, and the root
 * itself is `.`.
 */
export function targetRelative(text: string, targetRoot: string): string {
  const root = targetRoot.endsWith("/") ? targetRoot.slice(0, -1) : targetRoot;
  const [first = ""] = text.split(/\r?\n/u);
  const spelled = first.split(`${root}/`).join("").split(root).join(".").trim();
  return spelled === "" ? "the configuration could not be built" : spelled;
}

/** The configuration files below `root`, by absolute path in ascending order. */
function configFilesUnder(host: Host, root: string): readonly string[] {
  return filesBelow(host, root, isConfigFile).map((path) => joinPath(root, path));
}

export type Parsed = ReturnType<Engine["parseConfigFile"]>;

/** The configuration files one parsed configuration's `references` name. */
function referencesOf(parsed: Parsed): readonly string[] {
  // The parse answers a directory reference as the directory; the compiler reads a
  // path not ending `.json` as its `tsconfig.json`:
  // https://github.com/microsoft/typescript-go/blob/89d5d5b2849a0db0957065889ca58536fa6d2e4a/internal/core/projectreference.go#L18
  return (parsed.projectReferences ?? []).map(({ path }) =>
    path.endsWith(".json") ? path : joinPath(path, "tsconfig.json"),
  );
}

/**
 * The code of a configuration whose `extends` chain returns to a configuration it already
 * passed. A snapshot that opens two configurations whose `extends` chains reach one such
 * cycle panics (`OwnerCache.AddOwner: entry not found`, typescript 7.1.0-dev.20261014.1),
 * so the analysis refuses one before any snapshot is asked to open it.
 */
const CIRCULAR_EXTENDS = 18000;

/** One configuration file's parse, or why it cannot be read. */
function readConfiguration(
  engine: Engine,
  configFile: string,
): { readonly parsed: Parsed } | { readonly reason: string } {
  try {
    const parsed = engine.parseConfigFile(configFile);
    const circular = parsed.errors.find(({ code }) => code === CIRCULAR_EXTENDS);
    // The compiler leaves the message's `{0}` unfilled:
    // https://github.com/microsoft/TypeScript/pull/64755
    return circular === undefined
      ? { parsed }
      : { reason: `TS${String(circular.code)}: ${circular.text.replace("{0}", () => configFile)}` };
  } catch (error: unknown) {
    return { reason: message(error) };
  }
}

/** One configuration file the compiler parsed with no circular `extends`, and its parse. */
interface Read {
  readonly configFile: string;
  readonly parsed: Parsed;
}

/**
 * Every configuration file reached from `pending`, each once, each followed by the
 * configurations it references that `follows` admits, transitively. `unreadable` is told
 * each configuration the compiler cannot read, which the walk then goes on without.
 */
function derivedFrom(
  engine: Engine,
  host: Host,
  pending: string[],
  follows: (reference: string) => boolean,
  unreadable: (configFile: string, reason: string) => void,
): Read[] {
  const seen = new Set<string>();
  const found: Read[] = [];
  for (let configFile = pending.shift(); configFile !== undefined; configFile = pending.shift()) {
    const path = resolvePath(host.workingDirectory(), configFile);
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    const read = readConfiguration(engine, path);
    if ("reason" in read) {
      unreadable(path, read.reason);
      continue;
    }
    found.push({ configFile: path, parsed: read.parsed });
    pending.push(...referencesOf(read.parsed).filter(follows));
  }
  return found;
}

/** The name one module publishes itself under: the scope's, else its manifest's. */
export function moduleIdentity(host: Host, module: Module): string {
  return module.id === "" ? packageScope(host, module.path)("index.ts").package : module.id;
}

/**
 * The compiler configurations one consumer is loaded through: every one under its root and
 * each one those reference, transitively. A consumer that is absent, no directory, holds no
 * configuration or holds one the compiler cannot read ends the run naming it, because a
 * finding computed without a declared consumer would claim a reference set the run never read.
 */
function consumerProjects(engine: Engine, host: Host, root: string): readonly Read[] {
  const kind = host.kindOf(root);
  if (kind === "absent") {
    throw failureExit(
      "missing-consumer",
      `the scope declares the consumer ${root}, and nothing is at that path: check the consumer out at ${root} and install its dependencies`,
    );
  }
  if (kind !== "directory") {
    throw failureExit(
      "missing-consumer",
      `the scope declares the consumer ${root}, which is not a directory: check the consumer out at ${root}`,
    );
  }
  const found = derivedFrom(
    engine,
    host,
    [...configFilesUnder(host, root)],
    () => true,
    (configFile, reason) => {
      throw failureExit(
        "missing-consumer",
        `the consumer ${root} does not load, ${configFile} cannot be read as a compiler configuration: ${reason}`,
      );
    },
  );
  if (found.length === 0) {
    throw failureExit(
      "missing-consumer",
      `the consumer ${root} holds no compiler configuration, so none of its references can be read: check the consumer out at ${root} with its ${MARKERS.join(", ")}`,
    );
  }
  return found;
}

/** A target configuration a matrix or the invocation names that cannot be built, ending the run. */
function unbuilt(named: string, reason: string): never {
  throw failureExit(
    "no-program",
    `${named} ${reason}: correct the configuration, or name the configurations to analyze`,
  );
}

/**
 * The projects a build matrix declares, in its order, each entry a file below the target
 * root: an entry naming an absent file, a directory or a file the compiler cannot read ends
 * the run naming it, and one naming an earlier entry's file adds nothing. A reference below
 * the root the matrix does not name ends the run naming both, because the compiler builds a
 * referenced project's sources into the referencing program without reporting their
 * diagnostics. A reference outside the root is an outside project.
 */
function declaredProjects(
  engine: Engine,
  host: Host,
  targetRoot: string,
  entries: readonly ProjectConfiguration[],
): readonly Configuration[] {
  const projects: Configuration[] = [];
  const references = new Map<string, readonly string[]>();
  for (const entry of entries) {
    const configFile = joinPath(targetRoot, entry.project);
    const named = `the project ${JSON.stringify(entry.id)} (${configFile})`;
    const kind = host.kindOf(configFile);
    if (kind !== "file") {
      unbuilt(
        named,
        kind === "absent"
          ? "does not exist"
          : "is a directory, and a project names its compiler configuration file",
      );
    }
    if (references.has(configFile)) {
      continue;
    }
    const read = readConfiguration(engine, configFile);
    if ("reason" in read) {
      unbuilt(named, `cannot be read as a compiler configuration: ${read.reason}`);
    }
    references.set(configFile, referencesOf(read.parsed));
    projects.push({ id: entry.id, configFile, origin: "declared", parsed: read.parsed });
  }
  for (const project of projects) {
    const unnamed = references
      .get(project.configFile)
      ?.find((path) => !references.has(path) && relativePath(targetRoot, path) !== undefined);
    if (unnamed !== undefined) {
      unbuilt(
        `the project ${JSON.stringify(project.id)} (${project.configFile})`,
        `references ${unnamed}, which the build matrix does not name. A referenced project is built into the program that references it, so the matrix names it too`,
      );
    }
  }
  return projects;
}

/**
 * The projects a run derives where the matrix declares none: the configuration the scope
 * names for the target where its path names one, every compiler configuration under the
 * target root outside a skipped directory, then each configuration below the root those
 * reference, transitively, each once. A configuration the scope names ends the run where it
 * cannot be read; one the walk found is dropped and named.
 */
function derivedProjects(
  engine: Engine,
  host: Host,
  scope: Scope,
): { readonly configurations: readonly Configuration[]; readonly notBuilt: readonly NotBuilt[] } {
  const targetRoot = scope.target.path;
  const fromScope = scope.target.path.endsWith(".json")
    ? [resolvePath(host.workingDirectory(), scope.target.path)]
    : [];
  const absoluteRoot = resolvePath(host.workingDirectory(), targetRoot);
  const rootDir = resolvePath(
    host.workingDirectory(),
    fromScope.length > 0 ? dirnamePath(targetRoot) : targetRoot,
  );
  const idOf = (configFile: string): string => relativePath(targetRoot, configFile) ?? configFile;
  const notBuilt: NotBuilt[] = [];
  const found = derivedFrom(
    engine,
    host,
    [...fromScope, ...configFilesUnder(host, targetRoot)],
    (reference) => relativePath(rootDir, reference) !== undefined,
    (configFile, reason) => {
      if (fromScope.includes(configFile)) {
        unbuilt(configFile, `cannot be read as a compiler configuration: ${reason}`);
      }
      notBuilt.push({
        id: idOf(configFile),
        configFile,
        error: targetRelative(reason, absoluteRoot),
      });
    },
  );
  return {
    configurations: found.map(({ configFile, parsed }) => ({
      id: idOf(configFile),
      configFile,
      origin: fromScope.includes(configFile) ? "scope" : "derived",
      parsed,
    })),
    notBuilt,
  };
}

/**
 * Every configuration one run opens: the build matrix's project entries in its order, or,
 * where it holds none, those derived from the scope and the target tree, then each declared
 * consumer's, a configuration the target or an earlier consumer opens being theirs alone. A
 * target holding none ends the run with the setup failure `no-program`. No build output is
 * read: a project is the files its configuration names.
 */
export function discoverProjects(
  engine: Engine,
  host: Host,
  scope: Scope,
  configurations: readonly BuildConfiguration[] = [],
): Discovery {
  const declared = configurations.filter(
    (entry): entry is ProjectConfiguration => "project" in entry,
  );
  const target =
    declared.length > 0
      ? {
          mode: "declared" as const,
          configurations: declaredProjects(engine, host, scope.target.path, declared),
          notBuilt: [],
        }
      : { mode: "derived" as const, ...derivedProjects(engine, host, scope) };
  if (target.configurations.length === 0 && target.notBuilt.length === 0) {
    throw failureExit(
      "no-program",
      `${scope.target.path} holds no compiler configuration, no file named ${MARKERS.join(", ")}: run from the directory that holds one, or name the languages to analyze`,
    );
  }
  const opened = new Set(target.configurations.map((one) => one.configFile));
  const consumers: LoadedConsumer[] = [];
  const consumed: Configuration[] = [];
  for (const module of scope.consumers) {
    const read = consumerProjects(engine, host, module.path);
    const consumer = { id: moduleIdentity(host, module), path: module.path };
    consumers.push(consumer);
    for (const { configFile, parsed } of read.filter((one) => !opened.has(one.configFile))) {
      opened.add(configFile);
      consumed.push({ id: configFile, configFile, origin: "consumer", parsed, consumer });
    }
  }
  return {
    mode: target.mode,
    configurations: [...target.configurations, ...consumed],
    notBuilt: target.notBuilt,
    consumers,
  };
}
