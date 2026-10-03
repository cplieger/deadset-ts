/**
 * The members a value of one of the target's classes carries, as the checker answers
 * for the class's type, so a member a base class declares is a member of every class
 * that extends it and a member a subclass overrides is the subclass's own.
 */

import { isClassDeclaration, isClassExpression, type Node } from "@typescript/native/unstable/ast";
import type { Symbol as TSSymbol, SymbolFlags, Type } from "@typescript/native/unstable/sync";
import { nodeKey, type Inventory, type InventorySymbol } from "./inventory.ts";
import { must } from "./query.ts";
import type { ProjectView } from "./session.ts";

/** One member of a class's value that the target declares. */
export interface ClassMember {
  /** The inventory's identifier of the declaration. */
  readonly id: string;
  /** The declaring node, whose syntax says whether it is a property, an accessor or a method. */
  readonly node: Node;
  /** The member's symbol flags, as the checker reads it on this class. */
  readonly flags: SymbolFlags;
}

/** Which side of a class a reading asks for: its instances, or the class itself. */
export type ClassSide = "instance" | "static";

/** The name node of each class declaration of the target, by the class's identifier. */
export function classNames<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
): ReadonlyMap<string, Node> {
  const names = new Map<string, Node>();
  for (const file of project.ownSourceFiles()) {
    const visit = (node: Node): void => {
      if ((isClassDeclaration(node) || isClassExpression(node)) && node.name !== undefined) {
        const id = held.declarations.get(nodeKey(file, node));
        if (id !== undefined) {
          names.set(id, node.name);
        }
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
  }
  return names;
}

/**
 * The types of a batch of nodes, for a pass that cannot go on past a type the checker
 * did not answer: it stops there, as {@link must} stops.
 */
export function typesAt<Brand>(
  project: ProjectView<Brand>,
  nodes: readonly Node[],
): (Type | undefined)[] {
  return project.queries.typesAt(nodes).map(must);
}

/**
 * The type one side of each class is: the instance type at the class's name, or the
 * type of the class's own symbol, which is its constructor's.
 */
function sideTypes<Brand>(
  project: ProjectView<Brand>,
  nodes: readonly Node[],
  side: ClassSide,
): (Type | undefined)[] {
  if (side === "instance") {
    return typesAt(project, nodes);
  }
  const symbols = project.symbolsAt(nodes.map((node) => project.handle(node))).map(must);
  const present = symbols.filter((symbol): symbol is TSSymbol => symbol !== undefined);
  const types = project.queries.typesOfSymbols(present).map(must);
  let next = 0;
  return symbols.map((symbol) => (symbol === undefined ? undefined : types[next++]));
}

/**
 * The members one side of each class carries that the target declares, by the class.
 * A member declared in a file outside the project's own, and the `prototype` a class
 * carries on its static side, are not declarations of the target and are left out.
 */
export function classMembers<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  classIds: ReadonlySet<string>,
  side: ClassSide,
): ReadonlyMap<string, readonly ClassMember[]> {
  const named = [...classNames(project, held)].filter(([id]) => classIds.has(id));
  const own = project.ownPaths();
  const types = sideTypes(
    project,
    named.map(([, node]) => node),
    side,
  );
  const members = new Map<string, readonly ClassMember[]>();
  named.forEach(([id], index) => {
    const type = types[index];
    if (type === undefined) {
      return;
    }
    const found: ClassMember[] = [];
    for (const property of must(project.queries.propertiesOf(type))) {
      for (const handle of property.declarations) {
        if (!own.has(handle.path)) {
          continue;
        }
        const node = project.declarationAt(handle)?.node;
        const declared =
          node === undefined
            ? undefined
            : held.declarations.get(nodeKey(node.getSourceFile(), node));
        if (node !== undefined && declared !== undefined) {
          found.push({ id: declared, node, flags: property.flags });
        }
      }
    }
    members.set(id, found);
  });
  return members;
}

/**
 * The last component of one member's stable reference, `:static` included, which is
 * how a configuration names a member; undefined for a declaration that is no member.
 */
export function memberComponent(
  symbol: InventorySymbol,
  byId: ReadonlyMap<string, InventorySymbol>,
): string | undefined {
  const parent = byId.get(symbol.parent);
  if (parent === undefined || !symbol.ref.startsWith(`${parent.ref}.`)) {
    return undefined;
  }
  return symbol.ref.slice(parent.ref.length + 1);
}
