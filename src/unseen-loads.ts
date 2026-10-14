/**
 * The loads of a project's production files whose target the analysis cannot resolve: an
 * `import()` or `require()` call whose path is computed and starts with no relative literal
 * naming a directory below the calling file's. The files such a load runs are roots the
 * analysis does not see, so the configuration's roots are never complete.
 */

import {
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isParenthesizedExpression,
  isSatisfiesExpression,
  isStringLiteral,
  isTemplateExpression,
  SyntaxKind,
  type Node,
} from "@typescript/native/ast";
import { dirnamePath, relativePath, resolvePath } from "./paths.ts";
import { renderPosition, type Position } from "./position.ts";
import { UNANSWERED } from "./query.ts";
import type { ProjectView } from "./session.ts";
import { sourceFilesOf } from "./source-files.ts";

/** One load the analysis cannot resolve, in the configuration whose production file writes it. */
export interface UnseenLoad {
  readonly configuration: string;
  /** The position of the call. */
  readonly position: Position;
}

/** The expression a wrapper that changes no value holds: parentheses and type assertions. */
function unwrapped(node: Node): Node {
  let at = node;
  while (isParenthesizedExpression(at) || isAsExpression(at) || isSatisfiesExpression(at)) {
    at = at.expression;
  }
  return at;
}

/** The literal text a computed path starts with: a template's head, or a concatenation's first literal. */
export function leadingLiteral(node: Node): string | undefined {
  const at = unwrapped(node);
  if (isTemplateExpression(at)) {
    return at.head.text;
  }
  if (isBinaryExpression(at) && at.operatorToken.kind === SyntaxKind.PlusToken) {
    const left = unwrapped(at.left);
    return isStringLiteral(left) || isNoSubstitutionTemplateLiteral(left)
      ? left.text
      : leadingLiteral(at.left);
  }
  return undefined;
}

/**
 * The directory below `dir` a computed load's leading literal names, which the entry
 * rules root every file of, or none where it names a package, `dir` itself or a
 * directory holding it, each of which would name files no rule roots.
 */
export function computedLoadDirectory(dir: string, prefix: string): string | undefined {
  if (!(prefix.startsWith("./") || prefix.startsWith("../")) || !prefix.endsWith("/")) {
    return undefined;
  }
  const target = resolvePath(dir, prefix);
  return target === dir || relativePath(target, dir) !== undefined ? undefined : target;
}

/** Whether a computed path's leading literal names a package, whose files are none of the target's. */
function namesPackage(prefix: string | undefined): boolean {
  return (
    prefix !== undefined &&
    prefix !== "" &&
    !prefix.startsWith(".") &&
    !prefix.startsWith("/") &&
    !/^[A-Za-z][A-Za-z\d+.-]*:/u.test(prefix)
  );
}

/**
 * Every unresolved load the project's production files write, in file then source order.
 * `testFiles` holds the test files by their path below the target root. A `require` call
 * loads a module only where the name resolves to no declaration of the project's own
 * files: one the project declares is its own function.
 */
export function unseenLoadsOf<Brand>(
  project: ProjectView<Brand>,
  configuration: string,
  targetRoot: string,
  testFiles: readonly string[],
): readonly UnseenLoad[] {
  const tests = new Set(testFiles);
  const sites: { readonly position: Position; readonly require: Node | undefined }[] = [];
  for (const [path, file] of sourceFilesOf(project, targetRoot).byPath) {
    if (tests.has(path) || file.isDeclarationFile) {
      continue;
    }
    const dir = dirnamePath(file.fileName);
    const visit = (node: Node): void => {
      if (isCallExpression(node)) {
        const callee = node.expression;
        const required = isIdentifier(callee) && callee.text === "require";
        const [first] = node.arguments;
        const argument = first === undefined ? undefined : unwrapped(first);
        if (
          (callee.kind === SyntaxKind.ImportKeyword || required) &&
          argument !== undefined &&
          !isStringLiteral(argument) &&
          !isNoSubstitutionTemplateLiteral(argument)
        ) {
          const prefix = leadingLiteral(argument);
          const seen =
            namesPackage(prefix) ||
            (prefix !== undefined && computedLoadDirectory(dir, prefix) !== undefined);
          if (!seen) {
            sites.push({
              position: renderPosition(file, targetRoot, node.getStart()),
              require: required ? callee : undefined,
            });
          }
        }
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
  }
  const requires = sites.flatMap((site) => (site.require === undefined ? [] : [site.require]));
  const own = project.ownPaths();
  const local = new Set<Node>();
  project.symbolsAt(requires.map((node) => project.handle(node))).forEach((symbol, at) => {
    const node = requires[at];
    if (
      node !== undefined &&
      symbol !== UNANSWERED &&
      symbol?.declarations.some((handle) => own.has(handle.path)) === true
    ) {
      local.add(node);
    }
  });
  return sites
    .filter((site) => site.require === undefined || !local.has(site.require))
    .map((site) => ({ configuration, position: site.position }));
}
