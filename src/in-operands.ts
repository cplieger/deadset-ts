/**
 * The property names `in` tests in a project's production files. A value narrowed by
 * `"name" in value` is read back by that name, often through `unknown`, where no type
 * links the read to a declaration, so only a text match can tell which member it reads.
 */

import {
  isBinaryExpression,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
  SyntaxKind,
  type Node,
} from "@typescript/native/ast";
import type { ProjectView } from "./session.ts";
import { sourceFilesOf } from "./source-files.ts";
import { bytewise } from "./text/compare.ts";

/**
 * The text of each string literal, or template literal with no substitution, written as
 * the left operand of an `in` expression in a file of the project that is no test file.
 * `testFiles` holds the test files by their path below the target root.
 */
export function inOperandNames<Brand>(
  project: ProjectView<Brand>,
  targetRoot: string,
  testFiles: readonly string[],
): readonly string[] {
  const tests = new Set(testFiles);
  const found = new Set<string>();
  const visit = (node: Node): void => {
    if (
      isBinaryExpression(node) &&
      node.operatorToken.kind === SyntaxKind.InKeyword &&
      (isStringLiteral(node.left) || isNoSubstitutionTemplateLiteral(node.left))
    ) {
      found.add(node.left.text);
    }
    node.forEachChild(visit);
  };
  for (const [path, file] of sourceFilesOf(project, targetRoot).byPath) {
    if (!tests.has(path)) {
      file.forEachChild(visit);
    }
  }
  return [...found].sort(bytewise);
}
