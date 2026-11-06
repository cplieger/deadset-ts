/**
 * The import bindings of one file: the names its import declarations bind, which only
 * the file itself can read.
 */

import {
  isExportDeclaration,
  isExportSpecifier,
  isExternalModuleReference,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isJsxElement,
  isJsxFragment,
  isJsxSelfClosingElement,
  isNamedExports,
  isNamespaceImport,
  SyntaxKind,
  type Identifier,
  type ImportDeclaration,
  type ImportEqualsDeclaration,
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

/** One name a file's top-level import declaration binds. */
interface ImportBinding {
  readonly name: Identifier;
  /** The export name it binds, `default` for a default import; absent where it binds a whole module. */
  readonly imported?: string;
  /** An `import x = …` declaration: whether it is exported, and whether it names an external module. */
  readonly equals?: { readonly exported: boolean; readonly external: boolean };
}

const bindingsCache = new WeakMap<SourceFile, readonly ImportBinding[]>();

/**
 * Every name one import declaration binds, in source order: the default, named and
 * namespace names of an `import` declaration and the name of an `import x = …` declaration.
 * A namespace import and an import assignment bind a whole module.
 */
export function declarationBindings(
  declaration: ImportDeclaration | ImportEqualsDeclaration,
): readonly ImportBinding[] {
  if (isImportEqualsDeclaration(declaration)) {
    return [
      {
        name: declaration.name,
        equals: {
          exported: (declaration.modifiers ?? []).some(
            (modifier) => modifier.kind === SyntaxKind.ExportKeyword,
          ),
          external: isExternalModuleReference(declaration.moduleReference),
        },
      },
    ];
  }
  const clause = declaration.importClause;
  const found: ImportBinding[] = [];
  if (clause?.name !== undefined) {
    found.push({ name: clause.name, imported: "default" });
  }
  const named = clause?.namedBindings;
  if (named !== undefined && isNamespaceImport(named)) {
    found.push({ name: named.name });
  } else if (named !== undefined) {
    for (const element of named.elements) {
      found.push({ name: element.name, imported: element.propertyName?.text ?? element.name.text });
    }
  }
  return found;
}

/** Every name one file's top-level import declarations bind, in source order. */
export function bindingsOf(file: SourceFile): readonly ImportBinding[] {
  const known = bindingsCache.get(file);
  if (known !== undefined) {
    return known;
  }
  const found = file.statements.flatMap((statement) =>
    isImportDeclaration(statement) || isImportEqualsDeclaration(statement)
      ? declarationBindings(statement)
      : [],
  );
  bindingsCache.set(file, found);
  return found;
}

/**
 * The export names an import or a re-export declaration reads from the module it names,
 * `undefined` standing for the whole module where a namespace or a star reads it; none for
 * any other node.
 */
export function importedNames(node: Node): readonly (string | undefined)[] {
  if (isImportDeclaration(node)) {
    return declarationBindings(node).map((binding) => binding.imported);
  }
  if (!isExportDeclaration(node)) {
    return [];
  }
  const clause = node.exportClause;
  return clause === undefined || !isNamedExports(clause)
    ? [undefined]
    : clause.elements.map((one) => (one.propertyName ?? one.name).text);
}

/** The export names {@link importedNames} gives one node, without the whole module. */
export function namesImported(node: Node): readonly string[] {
  return importedNames(node).flatMap((name) => name ?? []);
}

/**
 * The bindings of one file that are judged as imports: those of {@link bindingsOf} but an
 * `import x = …` that is exported or names no external module. None is judged in a
 * declaration file or a component file.
 */
export function importBindings(file: SourceFile): readonly Identifier[] {
  if (file.isDeclarationFile || !JUDGED.test(file.fileName)) {
    return [];
  }
  return bindingsOf(file).flatMap((binding) =>
    binding.equals !== undefined && (binding.equals.exported || !binding.equals.external)
      ? []
      : [binding.name],
  );
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
