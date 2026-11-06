/**
 * The file classes the run counts references by. A test file is one a `ts.test_files`
 * pattern or a test runner's row names (the test-runner entry source decides which), a test
 * file no project holds, or a consumer's file a pattern names below the consumer's root.
 * A test-support file is test code as well, decided once the references are known
 * (`support.ts`), so a reference carries only whether a test file made it and the counters
 * read the support class beside it.
 */

import type { SourceFile } from "@typescript/native/ast";
import type { Edge } from "../graph.ts";
import { renderPosition } from "../position.ts";
import type { Reference } from "../references.ts";
import type { ProjectView } from "../session.ts";
import type { Mode } from "../sweep.ts";
import { bytewise } from "../text/compare.ts";
import { globExpression } from "../text/glob.ts";

/** One rule that classified files as test files, and how many files it matched. */
export interface TestFileRule {
  /** The rule's name, as a report's own rule list spells one. */
  readonly rule: string;
  readonly matched: number;
}

/** Whether one file of a side is a test file. */
export type TestFile = (file: SourceFile) => boolean;

/** The test files of the target: each file the test-runner source names, by its file name. */
export function targetTestFile(named: ReadonlySet<string>): TestFile {
  return (file) => named.has(file.fileName);
}

/** The test files a pattern names, each by its path below `root`: a consumer's, below the consumer's root. */
export function patternTestFile(patterns: readonly string[], root: string): TestFile {
  const expressions = patterns.map(globExpression);
  return (file) => {
    const path = renderPosition(file, root, 0).path;
    return expressions.some((expression) => expression.test(path));
  };
}

/** The own files of a project that are test files, by their path below `root`, ascending. */
export function testFilePaths<Brand>(
  project: ProjectView<Brand>,
  root: string,
  testFile: TestFile,
): readonly string[] {
  return project
    .ownSourceFiles()
    .filter(testFile)
    .map((file) => renderPosition(file, root, 0).path)
    .sort(bytewise);
}

/** Whether test code made one reference: a test file, or a test-support file of the target. */
export function madeByTestCode(reference: Reference, support: ReadonlySet<string>): boolean {
  return (
    reference.test || (reference.consumer === undefined && support.has(reference.position.path))
  );
}

/** Whether the mode classes a reference test code made as a test one: any but a loaded consumer's it classes as production. */
export function classedAsTest(test: boolean, consumer: boolean, mode: Mode): boolean {
  return test && !(consumer && mode.consumerTestsProduction === true);
}

/** Whether a production mode counts no reference of this one: test code made it, as the mode classes it. */
export function withheldBy(
  mode: Mode,
  reference: Reference,
  support: ReadonlySet<string>,
): boolean {
  return (
    mode.production &&
    classedAsTest(madeByTestCode(reference, support), reference.consumer !== undefined, mode)
  );
}

/** Whether a production mode follows no edge like this one: {@link withheldBy} for a graph edge. */
export function edgeWithheldBy(mode: Mode, edge: Edge): boolean {
  return mode.production && classedAsTest(edge.test, edge.consumer, mode);
}

/** The rule a file the analysis classified as test-support code is counted under. */
const TEST_SUPPORT_RULE = "test-support";

/**
 * The name one test-file rule takes. A rule's name is a word list the report's own
 * vocabulary spells, which cannot carry a pattern, so a rule is named by the place of
 * its pattern in the configured list.
 */
function patternRule(index: number): string {
  return `test-file-pattern-${String(index + 1)}`;
}

/**
 * The rules over the test files of several projects at once, ordered by rule: a file two
 * projects hold is one file, so each rule counts the distinct paths it matches.
 */
export function testFileRulesOf(
  testFiles: readonly string[],
  paths: readonly string[],
  supportFiles: readonly string[] = [],
): readonly TestFileRule[] {
  const distinct = [...new Set(paths)];
  const support = new Set(supportFiles).size;
  return [
    ...testFiles.map((pattern, index) => {
      const expression = globExpression(pattern);
      return {
        rule: patternRule(index),
        matched: distinct.filter((path) => expression.test(path)).length,
      };
    }),
    ...(support === 0 ? [] : [{ rule: TEST_SUPPORT_RULE, matched: support }]),
  ].sort((a, b) => bytewise(a.rule, b.rule));
}
