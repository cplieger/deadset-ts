/**
 * The loads by a computed path: those whose files the analysis resolves, and those it
 * cannot, whose files are roots the analysis does not see, so the configuration's roots
 * are never complete.
 */

import {
  isBinaryExpression,
  isCallExpression,
  isIdentifier,
  isMetaProperty,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
  isTemplateExpression,
  SyntaxKind,
  type CallExpression,
  type Identifier,
  type Node,
  type SourceFile,
} from "@typescript/native/ast";
import { membersNamed, textsOf, writtenValue, type Value } from "../entries/static-module.ts";
import { writtenName } from "../platform-calls.ts";
import { dirnamePath, relativePath, resolvePath } from "../paths.ts";
import type { Position } from "../position.ts";
import { unwrapped } from "../unwrap.ts";
import { globExpression } from "../text/glob.ts";

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
  /** The name a `require()` call is written with; {@link callsPlatform} owns which one loads. */
  readonly require: Identifier | undefined;
  readonly files: readonly Loadable[];
  /** Whether the load reads each file as text or as a URL, which references no declaration of it. */
  readonly asset: boolean;
  /**
   * Whether the analysis names every file the load may load. An unresolved load names none,
   * and leaves the configuration's roots incomplete (confidence.26).
   */
  readonly resolved: boolean;
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
  return (
    node.expression.kind === SyntaxKind.ImportKeyword ||
    writtenName(node.expression) !== undefined ||
    isMetaGlob(node)
  );
}

/**
 * The files one `import.meta.glob` call loads, as Vite's `toAbsoluteGlob` reads its globs
 * (https://vite.dev/guide/features.html#glob-import): `/` against the project root, `./`
 * and `../` against a literal `base` (read against the root where it starts with `/`) or the
 * calling file's directory, `**` as written, and `!` removing what it matches. Undefined
 * where Vite reads a glob through an alias, the root is unknown, or a glob or base is computed.
 */
function globbed(
  file: SourceFile,
  first: Node,
  options: Node | undefined,
  others: readonly Loadable[],
  rootOf: (fileName: string) => string | undefined,
): readonly Loadable[] | undefined {
  const patterns = textsOf(writtenValue(first), true);
  const bases = globOption(options, "base");
  const [written, ...more] = bases ?? [];
  const base = written === undefined ? undefined : textsOf(written, false);
  if (
    patterns === undefined ||
    bases === undefined ||
    more.length > 0 ||
    (written !== undefined && base === undefined)
  ) {
    return undefined;
  }
  const dir = dirnamePath(file.fileName);
  const root = (): string | undefined => rootOf(file.fileName);
  const against = (at: string): string | undefined => {
    if (!at.startsWith("/")) {
      return resolvePath(dir, at);
    }
    const top = root();
    return top === undefined ? undefined : resolvePath(top, `.${at}`);
  };
  const from = base?.[0] === undefined ? dir : against(base[0]);
  const keep: RegExp[] = [];
  const drop: RegExp[] = [];
  for (const written of patterns) {
    const negated = written.startsWith("!");
    const pattern = negated ? written.slice(1) : written;
    let path: string | undefined;
    if (pattern.startsWith("/")) {
      path = against(pattern);
    } else if (pattern.startsWith("./") || pattern.startsWith("../")) {
      path = from === undefined ? undefined : resolvePath(from, pattern);
    } else if (pattern.startsWith("**")) {
      path = pattern;
    }
    if (path === undefined) {
      return undefined;
    }
    (negated ? drop : keep).push(globExpression(path));
  }
  return others.filter(
    (candidate) =>
      keep.some((glob) => glob.test(candidate.file.fileName)) &&
      !drop.some((glob) => glob.test(candidate.file.fileName)),
  );
}

/**
 * The computed loads among one file's load calls, each loading the `candidates` but the
 * file itself: an `import()` or `require()` whose path starts with a relative literal naming
 * a directory below the file's loads every candidate below it, as a bundler's context module
 * reads it, and an `import.meta.glob` every candidate its globs match ({@link globbed}). A
 * call of a computed path that names no such directory and no package is an unresolved load.
 */
export function computedLoadsOf(
  file: SourceFile,
  calls: readonly LoadCall[],
  candidates: readonly Loadable[],
  rootOf: (fileName: string) => string | undefined,
): readonly ComputedLoad[] {
  const dir = dirnamePath(file.fileName);
  const others = candidates.filter((candidate) => candidate.file !== file);
  return calls.flatMap(({ call, from }): ComputedLoad[] => {
    const [first, options] = call.arguments;
    if (first === undefined) {
      return [];
    }
    if (isMetaGlob(call)) {
      const files = globbed(file, first, options, others, rootOf);
      const asset = readsAsAsset(options);
      return [
        {
          call,
          from,
          require: undefined,
          files: files ?? [],
          resolved: files !== undefined,
          asset,
          eager: isEager(options),
        },
      ];
    }
    const argument = unwrapped(first);
    const require =
      call.expression.kind === SyntaxKind.ImportKeyword ? undefined : writtenName(call.expression);
    if (!mayNamePath(argument)) {
      return [];
    }
    const prefix = leadingLiteral(argument);
    if (namesPackage(prefix)) {
      return [];
    }
    const target = prefix === undefined ? undefined : computedLoadDirectory(dir, prefix);
    const files =
      target === undefined
        ? []
        : others.filter((candidate) => relativePath(target, candidate.file.fileName) !== undefined);
    return [
      { call, from, require, files, resolved: target !== undefined, asset: false, eager: false },
    ];
  });
}

/**
 * Whether a computed argument may be a module path: anything but a string, which names its
 * module, and a value no path is, a number, a boolean, `null`, an object, an array, a
 * function or a class.
 */
function mayNamePath(argument: Node): boolean {
  return !NO_PATH.has(argument.kind);
}

const NO_PATH: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.ObjectLiteralExpression,
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ClassExpression,
  SyntaxKind.RegularExpressionLiteral,
]);

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

/** The values the options of an `import.meta.glob` write for one key, undefined where a spread may hide one. */
function globOption(options: Node | undefined, key: string): readonly Value[] | undefined {
  return options === undefined ? [] : membersNamed(writtenValue(options), key);
}

/** Whether the options of an `import.meta.glob` set `eager` to `true`. */
function isEager(options: Node | undefined): boolean {
  return (
    globOption(options, "eager")?.some((value) => value.kind === "boolean" && value.value) === true
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
  const texts = (key: string): readonly string[] =>
    (globOption(options, key) ?? []).flatMap((value) =>
      value.kind === "text" ? [value.text] : [],
    );
  return (
    texts("as").some((text) => text === "raw" || text === "url") ||
    texts("query").some((text) => ASSET_QUERY.test(text.startsWith("?") ? text : `?${text}`))
  );
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
