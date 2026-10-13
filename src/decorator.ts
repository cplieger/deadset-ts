/**
 * The decorator class: a member a decorator expression is attached to, and every member
 * of a class one is attached to but the member a parameter property declares, is held
 * back, because the decorator may reach the member by its name. The rule is read from
 * the tree alone. The decorator's own use of what it decorates is the reference pass's
 * `decorator` reference; this class records only that the declaration is held back,
 * static members of a decorated class included.
 */

import type { Node } from "@typescript/native/ast";
import { decoratorsOf, spelledDecorator } from "./calls.ts";
import type { DetectorInput, Evidence } from "./exempt.ts";
import {
  isParameterProperty,
  nodeKey,
  type InventorySymbol,
  type SymbolKind,
} from "./inventory.ts";
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

  const decorated: {
    readonly symbol: InventorySymbol;
    readonly detail: string;
    readonly site: Evidence["site"];
  }[] = [];
  // A decorated class's container passes each constructor argument, which keeps the
  // parameter, not the member a parameter property stores it in.
  const parameterMembers = new Set<string>();
  for (const file of project.ownSourceFiles()) {
    const visit = (node: Node): void => {
      const id = held.declarations.get(nodeKey(file, node));
      const symbol = id === undefined ? undefined : byId.get(id);
      if (id !== undefined && isParameterProperty(node)) {
        parameterMembers.add(id);
      }
      // A parameter property's decorator is attached to its parameter, and to no member.
      if (symbol !== undefined && DECORATED.has(symbol.kind) && !isParameterProperty(node)) {
        for (const attached of decoratorsOf(node)) {
          decorated.push({
            symbol,
            detail: `decorated by ${spelledDecorator(attached)}`,
            site: renderPosition(file, targetRoot, attached.getStart()),
          });
        }
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
  }
  return decorated.flatMap(({ symbol, detail, site }) =>
    (symbol.kind === "class"
      ? (membersOf.get(symbol.id) ?? []).filter((member) => !parameterMembers.has(member.id))
      : [symbol]
    ).map((member) => ({ id: member.id, detail, site })),
  );
}
