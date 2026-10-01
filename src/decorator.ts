/**
 * The decorator class: a member a decorator expression is attached to, and every
 * member of a class a decorator expression is attached to, is held back, because the
 * decorator receives the member or the class when the class is defined and may reach
 * the member by its name.
 *
 * The rule is read from the tree alone: a decorator is attached where it is written.
 * The use the decorator itself makes of what it decorates is the reference pass's,
 * which records it as a `decorator` reference; this class records only that the
 * declaration is held back, and the member set of a decorated class is every member
 * the inventory holds for the class, static members included.
 */

import type { Node } from "@typescript/native/unstable/ast";
import { decoratorsOf, spelledDecorator } from "./calls.ts";
import type { DetectorInput, Evidence } from "./exempt.ts";
import { nodeKey, type InventorySymbol, type SymbolKind } from "./inventory.ts";
import { renderPosition } from "./position.ts";

/** The kinds of declaration a decorator is attached to and holds back. */
const DECORATED: ReadonlySet<SymbolKind> = new Set(["class", "method", "class-member"]);

/**
 * The decorator detector: each decorated member, and each member of a decorated
 * class, recorded at the decorator.
 */
export function decorator<Brand>(input: DetectorInput<Brand>): readonly Evidence[] {
  const { project, held, targetRoot } = input;
  const byId = new Map(held.symbols.map((symbol) => [symbol.id, symbol]));
  const membersOf = new Map<string, InventorySymbol[]>();
  for (const symbol of held.symbols) {
    if (symbol.kind === "method" || symbol.kind === "class-member") {
      const members = membersOf.get(symbol.parent);
      if (members === undefined) {
        membersOf.set(symbol.parent, [symbol]);
      } else {
        members.push(symbol);
      }
    }
  }

  const found: Evidence[] = [];
  for (const file of project.ownSourceFiles()) {
    const visit = (node: Node): void => {
      const id = held.declarations.get(nodeKey(file, node));
      const symbol = id === undefined ? undefined : byId.get(id);
      if (symbol !== undefined && DECORATED.has(symbol.kind)) {
        for (const attached of decoratorsOf(node)) {
          const detail = `decorated by ${spelledDecorator(attached)}`;
          const site = renderPosition(file, targetRoot, attached.getStart());
          const reached = symbol.kind === "class" ? (membersOf.get(symbol.id) ?? []) : [symbol];
          for (const member of reached) {
            found.push({ id: member.id, detail, site });
          }
        }
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
  }
  return found;
}
