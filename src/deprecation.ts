/**
 * Which declarations of one project carry the deprecation marker, the documentation tag
 * the TypeScript tools recognize, as the checker reports a symbol's tags: gathered from
 * every declaration of the symbol, so overloads, an accessor pair and a merged
 * declaration share them. A declaration list's documentation covers every name it
 * declares, and the checker attaches it to the first name alone, so the later names read
 * the list's own tags from the tree.
 */

import { isVariableStatement, SyntaxKind, type Node } from "@typescript/native/unstable/ast";
import type { Symbol as TSSymbol } from "@typescript/native/unstable/sync";
import { nodeKey, type Inventory } from "./inventory.ts";
import { DEFAULT_BATCH_CAP } from "./references.ts";
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

/**
 * The identifiers of every declaration of one project that carries the deprecation
 * marker, in the inventory's order.
 *
 * The checker is asked only for a symbol with a declaration in a file whose tree holds
 * the tag, so a project whose files hold none costs no round trip, and one that does
 * costs one batch per file and one request per symbol that could carry the tag.
 */
export function deprecatedDeclarations<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
): readonly string[] {
  const marked = new Set<string>();
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
    const asked = new Map<number, boolean>();
    const carriesTag = (symbol: TSSymbol): boolean => {
      const known = asked.get(symbol.id);
      if (known !== undefined) {
        return known;
      }
      const carries =
        symbol.declarations.some((declaration) => markedPaths.has(declaration.path)) &&
        symbol.getJsDocTags(project.checker).some((tag) => tag.name === DEPRECATED_TAG);
      asked.set(symbol.id, carries);
      return carries;
    };
    for (const named of declared) {
      for (let start = 0; start < named.length; start += DEFAULT_BATCH_CAP) {
        const batch = named.slice(start, start + DEFAULT_BATCH_CAP);
        project.symbolsAt(batch.map((one) => one.handle)).forEach((symbol, at) => {
          const one = batch[at];
          if (symbol !== undefined && one !== undefined && carriesTag(symbol)) {
            marked.add(one.id);
          }
        });
      }
    }
  }

  return held.symbols.filter((symbol) => marked.has(symbol.id)).map((symbol) => symbol.id);
}
