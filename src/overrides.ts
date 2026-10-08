/**
 * The overrides of the target's class members. A call through the base class names the
 * base's member and runs the override of whichever subclass the value is, so the base
 * member's declaration references every override. A method, an accessor or a property,
 * static or not, overriding a member of a class declared outside the target, at any depth
 * of its `extends` chain, is used by outside code holding the instance or the class
 * through that class, so its own class references it.
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
import { SymbolFlags, type Symbol as TSSymbol, type Type } from "@typescript/native/unstable/sync";
import { UNANSWERED } from "./query.ts";
import { nameComponent } from "./ref.ts";
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
 * project that extend another class of the target, and each class makes to its members
 * that override a member of a class declared outside the target. A member a nearer base
 * already overrides is reached through that override. A private member is not
 * overridden. Each reference is placed at the override and made by its file.
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
  const outsideBases = new Map<string, TSSymbol>();
  const own = project.ownPaths();
  const symbols = project.symbolsAt(classes.map((one) => project.handle(one.base)));
  classes.forEach(({ id }, index) => {
    const symbol = symbols[index];
    if (symbol !== undefined && symbol !== UNANSWERED) {
      const inTarget = chains
        .chainOf(symbol)
        .map((target) => target.id)
        .filter((target) => byId.get(target)?.kind === "class" && target !== id);
      bases.set(id, inTarget);
      const declared =
        (symbol.flags & SymbolFlags.Alias) === 0 ? symbol : project.queries.aliased(symbol);
      if (
        inTarget.length === 0 &&
        declared !== UNANSWERED &&
        (declared.flags & SymbolFlags.Class) !== 0 &&
        declared.declarations.length > 0 &&
        declared.declarations.every((handle) => !own.has(handle.path))
      ) {
        outsideBases.set(id, declared);
      }
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
  const outsideNames = outsideMemberNames(project, bases, outsideBases);
  for (const [classId, names] of outsideNames) {
    for (const [component, member] of members.get(classId) ?? []) {
      if (names.has(component)) {
        found.push({
          from: classId,
          to: member.id,
          position: member.position,
          use: "read",
          resolution: "override",
          test: testFiles.has(member.position.path),
        });
      }
    }
  }
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

/**
 * Per class of the target with a class declared outside the target in its `extends`
 * chain, the member components that outside class's instances and constructor carry, a
 * static one spelled as a static member's component is.
 */
function outsideMemberNames<Brand>(
  project: ProjectView<Brand>,
  bases: ReadonlyMap<string, readonly string[]>,
  outsideBases: ReadonlyMap<string, TSSymbol>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const direct = new Map<string, ReadonlySet<string>>();
  for (const [classId, base] of outsideBases) {
    const instance = project.queries.declaredTypeOf(base);
    const statics = project.queries.typeOfSymbol(base);
    const components = [
      ...namesOf(project, instance === UNANSWERED ? undefined : instance).map(nameComponent),
      ...namesOf(project, statics === UNANSWERED ? undefined : statics).map(
        (name) => `${nameComponent(name)}:static`,
      ),
    ];
    if (components.length > 0) {
      direct.set(classId, new Set(components));
    }
  }
  const names = new Map<string, ReadonlySet<string>>();
  const above = (classId: string, seen: Set<string>): ReadonlySet<string> => {
    if (seen.has(classId)) {
      return new Set();
    }
    seen.add(classId);
    return new Set([
      ...(direct.get(classId) ?? []),
      ...(bases.get(classId) ?? []).flatMap((base) => [...above(base, seen)]),
    ]);
  };
  for (const classId of bases.keys()) {
    const found = above(classId, new Set());
    if (found.size > 0) {
      names.set(classId, found);
    }
  }
  return names;
}

/** The names of a type's properties; none where the type or its properties are unanswered. */
function namesOf<Brand>(project: ProjectView<Brand>, type: Type | undefined): readonly string[] {
  const properties = type === undefined ? UNANSWERED : project.queries.propertiesOf(type);
  return properties === UNANSWERED ? [] : properties.map((property) => property.name);
}
