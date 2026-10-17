import type { PartialConfig } from "./config.ts";
import type { Host } from "./host.ts";
import { inventory } from "./inventory.ts";
import { relativePath } from "./paths.ts";
import { references, type ConsumerSide, type Reference } from "./references.ts";
import { narrowedTo, type ProjectView } from "./session.ts";

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
  config: PartialConfig,
): readonly Reference[] {
  const held = inventory(
    narrowedTo(project, (file) => relativePath(targetRoot, file.fileName) !== undefined),
    host,
    targetRoot,
  );
  const found = references(project, held, targetRoot, {
    testFiles: config.ts.test_files,
    consumer,
  }).references;
  if (config.analysis.consumer_tests !== "production") {
    return found;
  }
  return found.map((reference) => (reference.test ? { ...reference, test: false } : reference));
}
