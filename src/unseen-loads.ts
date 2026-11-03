/**
 * The loads by a computed path: those whose files the analysis resolves, and those of a
 * project's production files it cannot resolve, an `import()` or `require()` call whose
 * path starts with no relative literal naming a directory below the calling file's. The
 * files such a load runs are roots the analysis does not see, so the configuration's
 * roots are never complete.
 */

import {
  isBinaryExpression,
  isCallExpression,
  isIdentifier,
  isMetaProperty,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isStringLiteral,
  isTemplateExpression,
  SyntaxKind,
  type CallExpression,
  type Identifier,
  type Node,
  type SourceFile,
} from "@typescript/native/ast";
import { literalsOf } from "./entry-points.ts";
import { hasOwnBody } from "./own-body.ts";
import { dirnamePath, relativePath, resolvePath } from "./paths.ts";
import { renderPosition, type Position } from "./position.ts";
import type { ProjectView } from "./session.ts";
import { sourceFilesOf } from "./source-files.ts";
import { unwrapped } from "./unwrap.ts";
import { globExpression } from "./text/glob.ts";

/** One load the analysis cannot resolve, in the configuration whose production file writes it. */
export interface UnseenLoad {
  readonly configuration: string;
  /** The position of the call. */
  readonly position: Position;
}

/** The literal text a computed path starts with: a template's head, or a concatenation's first literal. */
function leadingLiteral(node: Node): string | undefined {
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
 * The directory below `dir` a computed load's leading literal names, every file of which
 * the load reaches, or none where it names a package, `dir` itself or a directory holding
 * it, each of which would name every sibling.
 */
function computedLoadDirectory(dir: string, prefix: string): string | undefined {
  if (!(prefix.startsWith("./") || prefix.startsWith("../")) || !prefix.endsWith("/")) {
    return undefined;
  }
  const target = resolvePath(dir, prefix);
  return target === dir || relativePath(target, dir) !== undefined ? undefined : target;
}

/** One `import()`, `require()` or `import.meta.glob()` call, and the declaration whose code writes it. */
export interface LoadCall {
  readonly call: CallExpression;
  readonly from: string;
}

/** One file a computed load may load, by its id. */
interface Loadable {
  readonly file: SourceFile;
  readonly fileId: string;
}

/** One load by a computed path whose files the analysis resolves. */
interface ComputedLoad {
  readonly call: CallExpression;
  readonly from: string;
  /** The `require` the call names; {@link hasOwnBody} owns which one loads nothing. */
  readonly require: Identifier | undefined;
  readonly files: readonly Loadable[];
  /** Whether the load reads each file as text or as a URL, which references no declaration of it. */
  readonly asset: boolean;
  /**
   * Whether the load is an eager glob, which Vite turns into static imports at the top of
   * the calling module (https://vite.dev/guide/features.html#glob-import), so the file
   * evaluates what it loads wherever the call is written.
   */
  readonly eager: boolean;
}

/** Whether one node is a call that may load a module by a computed path. */
export function isLoadCall(node: Node): node is CallExpression {
  if (!isCallExpression(node)) {
    return false;
  }
  const callee = node.expression;
  return (
    callee.kind === SyntaxKind.ImportKeyword ||
    (isIdentifier(callee) && callee.text === "require") ||
    isMetaGlob(node)
  );
}

/**
 * The resolved computed loads among one file's load calls, each loading the `candidates`
 * but the file itself: an `import()` or `require()` whose path starts with a relative
 * literal naming a directory below the file's, every candidate below it, and an
 * `import.meta.glob` of relative literal globs, every candidate one matches, each read
 * against the file's directory, as a bundler's context module reads them.
 */
export function computedLoadsOf(
  file: SourceFile,
  calls: readonly LoadCall[],
  candidates: readonly Loadable[],
): readonly ComputedLoad[] {
  const dir = dirnamePath(file.fileName);
  const others = candidates.filter((candidate) => candidate.file !== file);
  return calls.flatMap(({ call, from }): ComputedLoad[] => {
    const [first, options] = call.arguments;
    if (first === undefined) {
      return [];
    }
    if (isMetaGlob(call)) {
      const globs = (literalsOf(first) ?? [])
        .filter((pattern) => pattern.startsWith("./") || pattern.startsWith("../"))
        .map((pattern) => globExpression(resolvePath(dir, pattern)));
      const files = others.filter((candidate) =>
        globs.some((glob) => glob.test(candidate.file.fileName)),
      );
      const asset = readsAsAsset(options);
      return [{ call, from, require: undefined, files, asset, eager: isEager(options) }];
    }
    const prefix = leadingLiteral(first);
    const target = prefix === undefined ? undefined : computedLoadDirectory(dir, prefix);
    if (target === undefined) {
      return [];
    }
    const files = others.filter(
      (candidate) => relativePath(target, candidate.file.fileName) !== undefined,
    );
    const callee = call.expression;
    const require = isIdentifier(callee) ? callee : undefined;
    return [{ call, from, require, files, asset: false, eager: false }];
  });
}

/** Whether one call is `import.meta.glob(...)`. */
function isMetaGlob(node: CallExpression): boolean {
  if (!isPropertyAccessExpression(node.expression)) {
    return false;
  }
  const { expression, name } = node.expression;
  return (
    isIdentifier(name) &&
    name.text === "glob" &&
    isMetaProperty(expression) &&
    expression.keywordToken === SyntaxKind.ImportKeyword
  );
}

/** The values an `import.meta.glob` options object assigns, each by its literal key. */
function globOptions(options: Node | undefined): readonly [string, Node][] {
  const literal = options === undefined ? undefined : unwrapped(options);
  if (literal === undefined || !isObjectLiteralExpression(literal)) {
    return [];
  }
  return literal.properties.flatMap((property): [string, Node][] =>
    isPropertyAssignment(property) &&
    (isIdentifier(property.name) || isStringLiteral(property.name))
      ? [[property.name.text, unwrapped(property.initializer)]]
      : [],
  );
}

/** Whether the options of an `import.meta.glob` set `eager` to `true`. */
function isEager(options: Node | undefined): boolean {
  return globOptions(options).some(
    ([key, value]) => key === "eager" && value.kind === SyntaxKind.TrueKeyword,
  );
}

/** The query parameters that make Vite load a file as its text or its URL, each written bare. */
const ASSET_QUERY = /(?:^\?|&)(?:raw|url|inline)(?:&|$)/u;

/**
 * Whether the options of an `import.meta.glob` read each file as text or as a URL: a
 * `query` string holding a bare `raw`, `url` or `inline`, or an `as` of `raw` or `url`,
 * which Vite reads as that query (https://vite.dev/guide/features.html#glob-import). Any
 * other query is read as loading the module, which keeps more than it may.
 */
function readsAsAsset(options: Node | undefined): boolean {
  return globOptions(options).some(([key, value]) => {
    if (!isStringLiteral(value) && !isNoSubstitutionTemplateLiteral(value)) {
      return false;
    }
    if (key === "as") {
      return value.text === "raw" || value.text === "url";
    }
    return (
      key === "query" &&
      ASSET_QUERY.test(value.text.startsWith("?") ? value.text : `?${value.text}`)
    );
  });
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
 * loads a module unless {@link hasOwnBody} reads it as the project's own function.
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
  const local = new Set<Node>();
  project.symbolsAt(requires.map((node) => project.handle(node))).forEach((symbol, at) => {
    const node = requires[at];
    if (node !== undefined && typeof symbol === "object" && hasOwnBody(project, symbol)) {
      local.add(node);
    }
  });
  return sites
    .filter((site) => site.require === undefined || !local.has(site.require))
    .map((site) => ({ configuration, position: site.position }));
}
