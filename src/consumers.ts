import type { PartialConfig } from "./config.ts";
import type { ParseFile } from "./entries/configuration-files.ts";
import { runDirectories } from "./entries/run-directories.ts";
import type { Host } from "./host.ts";
import { inventory } from "./inventory/enumerate.ts";
import { relativePath } from "./paths.ts";
import { references, type ConsumerSide, type References } from "./references.ts";
import { narrowedTo, type ProjectView } from "./session.ts";
import { patternTestFile } from "./tests/file-class.ts";

/**
 * Every reference one consumer project's own files make to a declaration of the target.
 * The target's declarations are enumerated over the target's files the consumer's
 * program holds, against the target root, so each carries the identifier the target's
 * own projects give it. A reference from a consumer's test file is a test reference;
 * whether the run counts it as a production one is the sweep's mode.
 */
export function consumerReferences<Brand>(
  project: ProjectView<Brand>,
  host: Host,
  targetRoot: string,
  consumer: ConsumerSide,
  config: PartialConfig,
  parse: ParseFile,
): References {
  const held = inventory(
    narrowedTo(project, (file) => relativePath(targetRoot, file.fileName) !== undefined),
    host,
    targetRoot,
  );
  return references(project, held, targetRoot, {
    testFile: patternTestFile(config.ts.test_files, consumer.root),
    consumer,
    directories: runDirectories(host, consumer.root, parse),
  });
}
