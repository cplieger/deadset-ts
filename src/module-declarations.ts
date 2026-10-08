/**
 * The imports that name a `declare module` declaration whose name is a string literal: an
 * augmentation or an ambient module, a wildcard one included. An import names it when its
 * specifier equals the name, matches it with the one `*` standing for any run, or resolves
 * to the same module. One that names it by name or pattern also reads the members it
 * imports, whatever file the specifier resolves to, as a compiler reading no such file does.
 */

import {
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isModuleDeclaration,
  isNamespaceExport,
  isNamespaceImport,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
  SyntaxKind,
  type Node,
  type SourceFile,
} from "@typescript/native/unstable/ast";
import { nodeKey, type Inventory, type InventorySymbol } from "./inventory.ts";
import { renderPosition } from "./position.ts";
import { UNANSWERED } from "./query.ts";
import { aliasFragment, nameComponent } from "./ref.ts";
import type { Reference } from "./references.ts";
import type { ProjectView } from "./session.ts";

/** Whether a node is a specifier's text: a string literal or a template with no substitution. */
function literalText(node: Node | undefined): node is Node & { readonly text: string } {
  return node !== undefined && (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node));
}

/** The specifier one node writes, where it is an import of any form. */
function specifierOf(node: Node): (Node & { readonly text: string }) | undefined {
  if (isImportDeclaration(node) || isExportDeclaration(node)) {
    const specifier = node.moduleSpecifier;
    return literalText(specifier) ? specifier : undefined;
  }
  if (isImportEqualsDeclaration(node)) {
    const reference = node.moduleReference;
    return isExternalModuleReference(reference) && literalText(reference.expression)
      ? reference.expression
      : undefined;
  }
  if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
    const [argument] = node.arguments;
    return literalText(argument) ? argument : undefined;
  }
  if (isImportTypeNode(node) && isLiteralTypeNode(node.argument)) {
    const literal = node.argument.literal;
    return literalText(literal) ? literal : undefined;
  }
  return undefined;
}

/**
 * The export names an import or a re-export reads from the module it names: none for a
 * namespace, a star or a bare form.
 */
export function namesImported(node: Node): readonly string[] {
  if (isImportDeclaration(node)) {
    const clause = node.importClause;
    const bindings = clause?.namedBindings;
    return [
      ...(clause?.name === undefined ? [] : ["default"]),
      ...(bindings === undefined || isNamespaceImport(bindings)
        ? []
        : bindings.elements.map((one) => (one.propertyName ?? one.name).text)),
    ];
  }
  const clause = isExportDeclaration(node) ? node.exportClause : undefined;
  return clause === undefined || isNamespaceExport(clause)
    ? []
    : clause.elements.map((one) => (one.propertyName ?? one.name).text);
}

/**
 * Whether a specifier matches a declaration's name, the name's one `*` standing for any run.
 * A relative name is resolved against its own file, so no specifier names it by its text.
 */
function namesModule(specifier: string, name: string): boolean {
  if (/^(?:\.{1,2}(?:\/|$)|\/)/u.test(name)) {
    return false;
  }
  const star = name.indexOf("*");
  if (star < 0 || name.slice(star + 1).includes("*")) {
    return specifier === name;
  }
  const prefix = name.slice(0, star);
  const suffix = name.slice(star + 1);
  return (
    specifier.length >= prefix.length + suffix.length &&
    specifier.startsWith(prefix) &&
    specifier.endsWith(suffix)
  );
}

/** One module declaration a specifier names, and the members of it the import reads. */
interface Named {
  readonly id: string;
  readonly members: readonly string[];
}

/**
 * The module declarations of an inventory a specifier names by name or pattern, each with
 * the members that hold the export names given.
 */
function namedBy(
  held: Inventory,
): (specifier: string, names: readonly string[]) => readonly Named[] {
  if (held.modules.size === 0) {
    return () => [];
  }
  const refs = new Map<string, string>();
  const children = new Map<string, InventorySymbol[]>();
  for (const symbol of held.symbols) {
    if (held.modules.has(symbol.id)) {
      refs.set(symbol.id, symbol.ref);
    }
    if (held.modules.has(symbol.parent)) {
      const siblings = children.get(symbol.parent) ?? [];
      siblings.push(symbol);
      children.set(symbol.parent, siblings);
    }
  }
  return (specifier, names) =>
    [...held.modules].flatMap(([id, name]) => {
      if (!namesModule(specifier, name)) {
        return [];
      }
      // A member is named by its declaration's reference, or an export alias's.
      const ref = refs.get(id) ?? "";
      const scope = ref.slice(0, ref.indexOf("#"));
      const wanted = new Set(
        names.flatMap((one) => [
          `${ref}.${nameComponent(one)}`,
          `${scope}#${aliasFragment(one, name)}`,
        ]),
      );
      const members = (children.get(id) ?? []).filter((child) => wanted.has(child.ref));
      return [{ id, members: members.map((child) => child.id) }];
    });
}

/** One import of a project's own files, and the declaration or file that holds it. */
interface Import {
  readonly file: SourceFile;
  readonly from: string;
  readonly specifier: Node & { readonly text: string };
  readonly names: readonly string[];
}

/** One module declaration of the inventory, and the name node it declares. */
interface Declared {
  readonly id: string;
  readonly name: Node & { readonly text: string };
}

/**
 * The references the imports of one project's own files make to the module declarations
 * they name, each at the import's specifier.
 */
export function moduleDeclarationReferences<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  root: string,
  testFiles: ReadonlySet<string>,
): readonly Reference[] {
  const imports: Import[] = [];
  const declared: Declared[] = [];
  for (const file of project.ownSourceFiles()) {
    const fileId = held.declarations.get(nodeKey(file, file));
    if (fileId === undefined) {
      continue;
    }
    const visit = (node: Node, from: string): void => {
      const own = held.declarations.get(nodeKey(file, node));
      if (isModuleDeclaration(node) && literalText(node.name) && own !== undefined) {
        declared.push({ id: own, name: node.name });
      }
      const specifier = specifierOf(node);
      if (specifier !== undefined) {
        imports.push({ file, from, specifier, names: namesImported(node) });
      }
      node.forEachChild((child) => {
        visit(child, own ?? from);
      });
    };
    file.forEachChild((child) => {
      visit(child, fileId);
    });
  }
  if (declared.length === 0 || imports.length === 0) {
    return [];
  }

  const asked = [...declared.map((one) => one.name), ...imports.map((one) => one.specifier)];
  const answers = project.symbolsAt(asked.map((node) => project.handle(node)));
  const moduleOf = (at: number): number | undefined => {
    const symbol = answers[at];
    return symbol === undefined || symbol === UNANSWERED ? undefined : symbol.id;
  };

  const named = namedBy(held);
  const found: Reference[] = [];
  imports.forEach((one, index) => {
    const resolved = moduleOf(declared.length + index);
    const position = renderPosition(one.file, root, one.specifier.getStart());
    const read = (to: string, resolution: Reference["resolution"]): void => {
      found.push({
        from: one.from,
        to,
        position,
        use: "read",
        resolution,
        test: testFiles.has(position.path),
      });
    };
    const same = new Set(
      declared
        .filter((_, at) => resolved !== undefined && resolved === moduleOf(at))
        .map((declaration) => declaration.id),
    );
    for (const id of same) {
      read(id, "batch");
    }
    for (const declaration of named(one.specifier.text, one.names)) {
      if (!same.has(declaration.id)) {
        for (const to of [declaration.id, ...declaration.members]) {
          read(to, "syntax");
        }
      }
    }
  });
  return found;
}
