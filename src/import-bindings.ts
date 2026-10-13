/**
 * The import bindings of one file: the names its import declarations bind, which only
 * the file itself can read.
 */

import {
  isExportSpecifier,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isJsxElement,
  isJsxFragment,
  isJsxSelfClosingElement,
  isNamespaceImport,
  SyntaxKind,
  type Identifier,
  type Node,
  type SourceFile,
} from "@typescript/native/ast";

/** The extensions of the files whose import bindings are judged: no markup can read them. */
const JUDGED = /\.(?:[mc]?ts|tsx|[mc]?js|jsx)$/u;

/** The compiler's `jsx` settings whose emit calls no factory the file must hold. */
const AUTOMATIC_RUNTIME: ReadonlySet<unknown> = new Set([4, 5, "react-jsx", "react-jsxdev"]);

/** A doc comment, where a JavaScript file names the types it imports. */
const DOC_COMMENT = /\/\*\*[\s\S]*?\*\//gu;

/** The parts of a doc comment the compiler resolves names in: a `{…}` type or link, a `@see` target. */
const DOC_REFERENCE = /\{[^{}]*\}|@see\s+[A-Za-z_$][\w$.]*/gu;

/** The factory a pragma comment names: `@jsx h` or `@jsxFrag Fragment`. */
const PRAGMA = /@jsx(?:Frag)?\s+([A-Za-z_$][\w$]*)/gu;

/** The compiler options the JSX rule reads. */
export interface JsxOptions {
  readonly jsx?: unknown;
  readonly jsxFactory?: unknown;
  readonly jsxFragmentFactory?: unknown;
}

/**
 * The names one file's import declarations bind: the default, named and namespace names of
 * an `import` declaration, and the name of an `import x = require()` declaration that is
 * not exported. None is judged in a declaration file or a component file.
 */
export function importBindings(file: SourceFile): readonly Identifier[] {
  if (file.isDeclarationFile || !JUDGED.test(file.fileName)) {
    return [];
  }
  const found: Identifier[] = [];
  for (const statement of file.statements) {
    if (isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name !== undefined) {
        found.push(clause.name);
      }
      const named = clause?.namedBindings;
      if (named !== undefined && isNamespaceImport(named)) {
        found.push(named.name);
      } else if (named !== undefined) {
        for (const element of named.elements) {
          found.push(element.name);
        }
      }
    } else if (
      isImportEqualsDeclaration(statement) &&
      isExternalModuleReference(statement.moduleReference) &&
      isIdentifier(statement.name) &&
      !(statement.modifiers ?? []).some((modifier) => modifier.kind === SyntaxKind.ExportKeyword)
    ) {
      found.push(statement.name);
    }
  }
  return found;
}

/** Whether one identifier names a binding in a local export, which reads it whatever it resolves to. */
export function exportsLocally(use: Identifier): boolean {
  return isExportSpecifier(use.parent);
}

/**
 * The names a file reads without an identifier the program resolves: each name a type, a
 * link or a `@see` tag of its doc comments spells, and, where it writes JSX the compiler
 * turns into factory calls, the factories the configuration or a pragma names.
 */
export function implicitReads(file: SourceFile, options: JsxOptions): ReadonlySet<string> {
  const names = new Set<string>();
  for (const comment of file.text.match(DOC_COMMENT) ?? []) {
    for (const reference of comment.match(DOC_REFERENCE) ?? []) {
      for (const word of reference.match(/[A-Za-z_$][\w$]*/gu) ?? []) {
        names.add(word);
      }
    }
  }
  if (AUTOMATIC_RUNTIME.has(options.jsx) || !writesJsx(file)) {
    return names;
  }
  for (const factory of [options.jsxFactory, options.jsxFragmentFactory]) {
    names.add(typeof factory === "string" ? (factory.split(".")[0] ?? factory) : "React");
  }
  for (const match of file.text.matchAll(PRAGMA)) {
    if (match[1] !== undefined) {
      names.add(match[1]);
    }
  }
  return names;
}

/** Whether a file holds a JSX element or fragment. */
function writesJsx(file: SourceFile): boolean {
  let found = false;
  const visit = (node: Node): void => {
    if (found) {
      return;
    }
    if (isJsxElement(node) || isJsxSelfClosingElement(node) || isJsxFragment(node)) {
      found = true;
      return;
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return found;
}
