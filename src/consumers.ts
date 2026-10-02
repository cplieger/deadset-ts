/**
 * The consumers a scope declares, loaded beside the target: each a directory on the
 * local filesystem whose compiler configurations open as projects of the run's one
 * snapshot, and whose references to the target's declarations count against them.
 */

import type { Config } from "./config.ts";
import { consumerProjects } from "./discover.ts";
import type { Host } from "./host.ts";
import { inventory, packageScope } from "./inventory.ts";
import { relativePath } from "./paths.ts";
import { references, type ConsumerSide, type Reference } from "./references.ts";
import type { Module, Scope } from "./scope.ts";
import { narrowedTo, type Engine, type ProjectView } from "./session.ts";

/** One consumer the run loaded. */
export interface LoadedConsumer {
  /** The name the consumer publishes itself under, which every finding names it by. */
  readonly id: string;
  /** The consumer's directory, absolute. */
  readonly path: string;
}

/** One declared consumer and the compiler configurations it opens as. */
interface ConsumerLoad {
  readonly consumer: LoadedConsumer;
  /** The configuration files, absolute, in discovery order, none a target project's. */
  readonly configFiles: readonly string[];
}

/** The name one module publishes itself under: the scope's, else its manifest's. */
export function moduleIdentity(host: Host, module: Module): string {
  return module.id === "" ? packageScope(host, module.path)("index.ts").package : module.id;
}

/**
 * Every consumer the scope declares, in its order, with the projects it opens as. A
 * configuration that is also one of the target's projects, or an earlier consumer's, is
 * that project's alone. A consumer whose directory is absent, is no directory or holds
 * no configuration ends the run naming it, before any project opens.
 */
export function consumerLoads(
  engine: Engine,
  host: Host,
  scope: Scope,
  targetConfigFiles: readonly string[],
): readonly ConsumerLoad[] {
  const opened = new Set(targetConfigFiles);
  return scope.consumers.map((module) => {
    const configFiles = consumerProjects(engine, host, module.path).filter((configFile) => {
      const fresh = !opened.has(configFile);
      opened.add(configFile);
      return fresh;
    });
    return { consumer: { id: moduleIdentity(host, module), path: module.path }, configFiles };
  });
}

/**
 * Every reference one consumer project's own files make to a declaration of the target.
 * The target's declarations are enumerated over the target's files the consumer's
 * program holds, against the target root, so each carries the identifier the target's
 * own projects give it. A reference from a consumer's test file is a test reference
 * unless the configuration counts it as a production one.
 */
export function consumerReferences<Brand>(
  project: ProjectView<Brand>,
  host: Host,
  targetRoot: string,
  consumer: ConsumerSide,
  config: Config,
): readonly Reference[] {
  const held = inventory(
    narrowedTo(project, (file) => relativePath(targetRoot, file.fileName) !== undefined),
    host,
    targetRoot,
  );
  const found = references(project, held, targetRoot, {
    testFiles: config.ts.testFiles,
    consumer,
  }).references;
  if (config.analysis.consumerTests !== "production") {
    return found;
  }
  return found.map((reference) => (reference.test ? { ...reference, test: false } : reference));
}
