/**
 * The decorator class: a member a decorator expression is attached to, and every member
 * of a class one is attached to but the member a parameter property declares, is held
 * back, because the decorator may reach the member by its name. The rule is read from
 * the tree alone. The decorator's own use of what it decorates is the reference pass's
 * `decorator` reference; this class records only that the declaration is held back,
 * static members of a decorated class included.
 */

import { decoratorsOf, spelledDecorator } from "./calls.ts";
import type { DetectorInput, Evidence } from "./lifecycle.ts";
import { isParameterProperty, type InventorySymbol, type SymbolKind } from "../inventory.ts";
import { renderPosition } from "../position.ts";

/** The kinds of declaration a decorator is attached to and holds back. */
const DECORATED: ReadonlySet<SymbolKind> = new Set(["class", "method", "class-member"]);

/**
 * The decorator detector: each decorated member, and each member of a decorated
 * class, recorded at the decorator.
 */
export function decorator<Brand>(input: DetectorInput<Brand>): readonly Evidence[] {
  const { held, sites, targetRoot } = input;
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
  // A decorated class's container passes each constructor argument, which keeps the
  // parameter, not the member a parameter property stores it in. A parameter property's
  // decorator is attached to its parameter, and to no member.
  return sites.decorated.flatMap(({ id, node }) => {
    const symbol = byId.get(id);
    if (symbol === undefined || !DECORATED.has(symbol.kind) || isParameterProperty(node)) {
      return [];
    }
    const members =
      symbol.kind === "class"
        ? (membersOf.get(symbol.id) ?? []).filter(
            (member) => !sites.parameterProperties.has(member.id),
          )
        : [symbol];
    return decoratorsOf(node).flatMap((attached) => {
      const detail = `decorated by ${spelledDecorator(attached)}`;
      const site = renderPosition(node.getSourceFile(), targetRoot, attached.getStart());
      return members.map((member) => ({ id: member.id, detail, site }));
    });
  });
}
