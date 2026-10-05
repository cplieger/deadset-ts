/**
 * The test files no compiler configuration of a run holds. The runner executes them all
 * the same, so each module one names is a test reference: the own file a relative
 * specifier names, and the declarations that file exports under the names read from it.
 * Such a file is read without a program, so what its body references beyond the modules
 * it names is not known.
 */

import {
  isCallExpression,
  isExportDeclaration,
  isImportDeclaration,
  isNamespaceExport,
  isNamespaceImport,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
  SyntaxKind,
  type Node,
  type SourceFile,
} from "@typescript/native/unstable/ast";
import { RESOLVED_EXTENSIONS, type ParseFile } from "./configuration-files.ts";
import { emittedFrom } from "./emit-map.ts";
import type { Host } from "./host.ts";
import type { Inventory } from "./inventory.ts";
import { dirnamePath, joinPath, normalizePath, queriedModulePath } from "./paths.ts";
import { renderPosition } from "./position.ts";
import { nameComponent } from "./ref.ts";
import type { Reference } from "./references.ts";

/** The paths below the target root one relative specifier may name, written path first. */
function candidates(dir: string, specifier: string): readonly string[] {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return [];
  }
  const path = normalizePath(dir === "" ? specifier : `${dir}/${specifier}`);
  return [
    path,
    ...emittedFrom(path, { sourceDirs: [] }),
    ...RESOLVED_EXTENSIONS.map((extension) => path + extension),
    ...RESOLVED_EXTENSIONS.map((extension) => `${path}/index${extension}`),
  ];
}

/** One module a test file names, and the export names it reads from it; `evaluates` reads none. */
interface NamedModule {
  readonly specifier: Node;
  readonly text: string;
  readonly names: readonly string[];
  readonly evaluates: boolean;
}

/** The text of a specifier written as literal text, or undefined for any other expression. */
function literalText(node: Node | undefined): string | undefined {
  return node !== undefined && (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

/**
 * Every module one file names: an import declaration, a re-export, and an `import()` call
 * of literal text anywhere in the file. A namespace form, a star re-export, a bare import
 * and an `import()` evaluate the module.
 */
function modulesNamed(file: SourceFile): readonly NamedModule[] {
  const found: NamedModule[] = [];
  const name = (specifier: Node, names: readonly string[], evaluates: boolean): void => {
    const text = literalText(specifier);
    if (text !== undefined) {
      found.push({ specifier, text, names, evaluates });
    }
  };
  for (const statement of file.statements) {
    if (isImportDeclaration(statement)) {
      const clause = statement.importClause;
      const bindings = clause?.namedBindings;
      name(
        statement.moduleSpecifier,
        [
          ...(clause?.name === undefined ? [] : ["default"]),
          ...(bindings === undefined || isNamespaceImport(bindings)
            ? []
            : bindings.elements.map((one) => (one.propertyName ?? one.name).text)),
        ],
        bindings === undefined ? clause?.name === undefined : isNamespaceImport(bindings),
      );
    } else if (isExportDeclaration(statement) && statement.moduleSpecifier !== undefined) {
      const clause = statement.exportClause;
      const star = clause === undefined || isNamespaceExport(clause);
      name(
        statement.moduleSpecifier,
        star ? [] : clause.elements.map((one) => (one.propertyName ?? one.name).text),
        star,
      );
    }
  }
  const visit = (node: Node): void => {
    if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument !== undefined) {
        name(argument, [], true);
      }
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return found;
}

/** One test file read without a program. */
export interface OutsideTest {
  /** The path below the target root. */
  readonly path: string;
  readonly file: SourceFile;
}

/** Each of the given paths below the target root, parsed; one that cannot be read is skipped. */
export function testFilesAt(
  host: Host,
  targetRoot: string,
  paths: readonly string[],
  parse: ParseFile,
): readonly OutsideTest[] {
  return paths.flatMap((path) => {
    const fileName = joinPath(targetRoot, path);
    let text: string;
    try {
      text = host.readFile(fileName);
    } catch {
      return [];
    }
    return [{ path, file: parse(fileName, text) }];
  });
}

/**
 * The references the given test files make to one project's own files through the
 * modules they name ({@link modulesNamed}). A name read from a module references each
 * top-level declaration the file exports under it; an evaluating form references the
 * file. A query after the path names the file as {@link queriedModulePath} reads it.
 */
export function outsideTestReferences(
  tests: readonly OutsideTest[],
  held: Inventory,
  targetRoot: string,
): readonly Reference[] {
  const fileAt = new Map(
    held.symbols
      .filter((symbol) => symbol.kind === "file")
      .map((symbol) => [symbol.position.path, symbol.id]),
  );
  // Keyed on the reference's fragment, which spells the export name where the display
  // name of a default export is its declared name.
  const exported = new Map<string, string[]>();
  for (const symbol of held.symbols) {
    if (symbol.exported) {
      const fragment = symbol.ref.slice(symbol.ref.lastIndexOf("#") + 1).replace(/:alias$/u, "");
      const key = `${symbol.parent}\u0000${fragment}`;
      exported.set(key, [...(exported.get(key) ?? []), symbol.id]);
    }
  }
  const found: Reference[] = [];
  for (const { path, file } of tests) {
    const from = `${path}#`;
    const dir = dirnamePath(path) === "." ? "" : dirnamePath(path);
    for (const named of modulesNamed(file)) {
      const written = named.text.includes("?") ? queriedModulePath(named.text) : named.text;
      if (written === undefined) {
        continue;
      }
      const fileId = candidates(dir, written)
        .map((one) => fileAt.get(one))
        .find((one) => one !== undefined);
      if (fileId === undefined) {
        continue;
      }
      const position = renderPosition(file, targetRoot, named.specifier.getStart());
      const read = (to: string, use: Reference["use"]): void => {
        found.push({ from, to, position, use, resolution: "syntax", test: true, unheld: true });
      };
      if (named.evaluates) {
        read(fileId, "evaluation");
      }
      for (const name of named.names) {
        for (const id of exported.get(`${fileId}\u0000${nameComponent(name)}`) ?? []) {
          read(id, "read");
        }
      }
    }
  }
  return found;
}
