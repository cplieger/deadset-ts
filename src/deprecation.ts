/**
 * Which declarations of one project carry the deprecation marker, the documentation tag
 * the TypeScript tools recognize, as the checker reports a symbol's tags: gathered from
 * every declaration of the symbol, so overloads, an accessor pair and a merged
 * declaration share them. A declaration list's documentation covers every name it
 * declares, and the checker attaches it to the first name alone, so the later names read
 * the list's own tags from the tree.
 */

import { isVariableStatement, SyntaxKind, type Node } from "@typescript/native/unstable/ast";
import { nodeKey, type Inventory } from "./inventory.ts";
import { isAnswered, UNANSWERED } from "./query.ts";
import type { Handle, ProjectView } from "./session.ts";

/** The tag the TypeScript tools recognize as marking a declaration deprecated. */
const DEPRECATED_TAG = "deprecated";

/** Whether one node's own documentation carries the deprecation tag. */
function documentedDeprecated(node: Node): boolean {
  const docs = (node as { readonly jsDoc?: readonly Node[] }).jsDoc ?? [];
  return docs.some((doc) =>
    ((doc as { readonly tags?: readonly Node[] }).tags ?? []).some(
      (tag) => tag.kind === SyntaxKind.JSDocDeprecatedTag,
    ),
  );
}

/** The node a declaration's symbol is resolved at: its name, or itself where it has none. */
function nameNode(node: Node): Node {
  return (node as { readonly name?: Node }).name ?? node;
}

/** Which declarations of one project carry the deprecation marker. */
export interface Deprecation {
  /** Every declaration that carries it, in the inventory's order. */
  readonly deprecated: readonly string[];
  /**
   * Every declaration whose symbol or tags the checker left unanswered where the
   * project's files hold the tag, in the inventory's order: whether it carries the
   * marker is unknown.
   */
  readonly unanswered: readonly string[];
}

/**
 * The declarations of one project that carry the deprecation marker.
 *
 * The checker is asked only for a symbol with a declaration in a file whose tree holds
 * the tag, so a project whose files hold none costs no round trip, and one that does
 * costs one batch per file and one for the tags of the symbols that could carry it.
 */
export function deprecatedDeclarations<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
): Deprecation {
  const marked = new Set<string>();
  const unknown = new Set<string>();
  const markedPaths = new Set<string>();
  const declared: { readonly id: string; readonly handle: Handle<Brand> }[][] = [];

  for (const file of project.ownSourceFiles()) {
    const named: { readonly id: string; readonly handle: Handle<Brand> }[] = [];
    const visit = (node: Node): void => {
      if (documentedDeprecated(node)) {
        markedPaths.add(file.path);
        if (isVariableStatement(node)) {
          for (const declaration of node.declarationList.declarations) {
            const id = held.declarations.get(nodeKey(file, declaration));
            if (id !== undefined) {
              marked.add(id);
            }
          }
        }
      }
      const id = held.declarations.get(nodeKey(file, node));
      if (id !== undefined && node !== file) {
        named.push({ id, handle: project.handle(nameNode(node)) });
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
    declared.push(named);
  }

  if (markedPaths.size > 0) {
    const pairs = declared.flatMap((named) => {
      const symbols = project.symbolsAt(named.map((one) => one.handle));
      return named.flatMap((one, at) => {
        const symbol = symbols[at];
        if (symbol === UNANSWERED) {
          unknown.add(one.id);
        }
        return typeof symbol === "object" &&
          symbol.declarations.some((declaration) => markedPaths.has(declaration.path))
          ? [{ id: one.id, symbol }]
          : [];
      });
    });
    const distinct = [...new Map(pairs.map((one) => [one.symbol.id, one.symbol])).values()];
    const tags = project.queries.jsDocTags(distinct);
    const unread = new Set(
      distinct.filter((_, at) => tags[at] === UNANSWERED).map((one) => one.id),
    );
    const carries = new Set(
      distinct.flatMap((symbol, at) => {
        const read = tags[at];
        return read !== undefined &&
          isAnswered(read) &&
          read.some((tag) => tag.name === DEPRECATED_TAG)
          ? [symbol.id]
          : [];
      }),
    );
    for (const one of pairs) {
      if (carries.has(one.symbol.id)) {
        marked.add(one.id);
      }
      if (unread.has(one.symbol.id)) {
        unknown.add(one.id);
      }
    }
  }

  const inOrder = (ids: ReadonlySet<string>): readonly string[] =>
    held.symbols.filter((symbol) => ids.has(symbol.id)).map((symbol) => symbol.id);
  return { deprecated: inOrder(marked), unanswered: inOrder(unknown) };
}
