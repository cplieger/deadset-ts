/**
 * The overrides of the target's class members. A call through the base class, `this`
 * in the base's own body or a value typed as the base, names the base's member and
 * runs the override of whichever subclass the value is, so the base member's
 * declaration references every override as a use of it.
 */

import {
  isClassDeclaration,
  isClassExpression,
  isExpressionWithTypeArguments,
  isPropertyAccessExpression,
  isQualifiedName,
  SyntaxKind,
  type HeritageClauseElement,
  type Node,
} from "@typescript/native/unstable/ast";
import type { AliasChains } from "./alias-chain.ts";
import { memberComponent } from "./class-members.ts";
import { nodeKey, type Inventory, type InventorySymbol } from "./inventory.ts";
import { UNANSWERED } from "./query.ts";
import type { Reference } from "./references.ts";
import type { ProjectView } from "./session.ts";

/** The member kinds a subclass overrides. */
const OVERRIDABLE: ReadonlySet<string> = new Set(["method", "class-member"]);

/** The node naming the class one `extends` entry names. */
function nameOf(entry: HeritageClauseElement): Node {
  if (isExpressionWithTypeArguments(entry)) {
    return isPropertyAccessExpression(entry.expression) ? entry.expression.name : entry.expression;
  }
  return isQualifiedName(entry.typeName) ? entry.typeName.right : entry.typeName;
}

/** Each class of the target whose `extends` clause names a class, with the name node. */
function extending<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
): readonly { readonly id: string; readonly base: Node }[] {
  const found: { id: string; base: Node }[] = [];
  for (const file of project.ownSourceFiles()) {
    const visit = (node: Node): void => {
      if (isClassDeclaration(node) || isClassExpression(node)) {
        const id = held.declarations.get(nodeKey(file, node));
        const clause = node.heritageClauses?.find((one) => one.token === SyntaxKind.ExtendsKeyword);
        const base = clause?.types[0];
        if (id !== undefined && base !== undefined) {
          found.push({ id, base: nameOf(base) });
        }
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
  }
  return found;
}

/**
 * The references each base class member makes to its overrides, for the classes of one
 * project that extend another class of the target. A member a nearer base already
 * overrides is reached through that override. A private member is not overridden.
 * Each reference is placed at the override and made by its file.
 */
export function overrideReferences<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  chains: AliasChains,
  testFiles: ReadonlySet<string>,
): readonly Reference[] {
  const classes = extending(project, held);
  if (classes.length === 0) {
    return [];
  }
  const byId = new Map(held.symbols.map((symbol) => [symbol.id, symbol]));
  const members = new Map<string, Map<string, InventorySymbol>>();
  for (const symbol of held.symbols) {
    const component = memberComponent(symbol, byId);
    if (
      component === undefined ||
      !OVERRIDABLE.has(symbol.kind) ||
      symbol.visibility === "private" ||
      symbol.visibility === "private-name"
    ) {
      continue;
    }
    const own = members.get(symbol.parent) ?? new Map<string, InventorySymbol>();
    own.set(component, symbol);
    members.set(symbol.parent, own);
  }
  const bases = new Map<string, readonly string[]>();
  const symbols = project.symbolsAt(classes.map((one) => project.handle(one.base)));
  classes.forEach(({ id }, index) => {
    const symbol = symbols[index];
    if (symbol !== undefined && symbol !== UNANSWERED) {
      bases.set(
        id,
        chains
          .chainOf(symbol)
          .map((target) => target.id)
          .filter((target) => byId.get(target)?.kind === "class" && target !== id),
      );
    }
  });

  /** The nearest member of one component the class or a class it extends declares. */
  const declaredAbove = (classId: string, component: string, seen: Set<string>): string[] => {
    if (seen.has(classId)) {
      return [];
    }
    seen.add(classId);
    const own = members.get(classId)?.get(component);
    if (own !== undefined) {
      return [own.id];
    }
    return (bases.get(classId) ?? []).flatMap((base) => declaredAbove(base, component, seen));
  };

  const found: Reference[] = [];
  for (const [classId, baseIds] of bases) {
    for (const [component, member] of members.get(classId) ?? []) {
      const seen = new Set([classId]);
      for (const base of baseIds.flatMap((one) => declaredAbove(one, component, seen))) {
        found.push({
          from: base,
          to: member.id,
          position: member.position,
          use: "read",
          resolution: "override",
          test: testFiles.has(member.position.path),
        });
      }
    }
  }
  return found;
}
