/**
 * The overrides of the target's class members. A call through the base class runs the
 * override of whichever subclass the value is, so the base member references every
 * override. A member, static or not, overriding one of a class declared outside the target
 * at any depth of its `extends` chain, a library's interface-and-variable class such as
 * `Error` included, is used by outside code holding the value, so its own class references it.
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
  type SourceFile,
} from "@typescript/native/ast";
import { memberComponent } from "./class-members.ts";
import { nodeKey, type InventorySymbol } from "./inventory.ts";
import { SymbolFlags, type Symbol as TSSymbol, type Type } from "@typescript/native/sync";
import { UNANSWERED } from "./query.ts";
import { nameComponent } from "./ref.ts";
import type { Read, ReadRule } from "./references/read-rule.ts";
import type { ProjectView } from "./session.ts";

const CLASS_DECLARATIONS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ClassDeclaration,
  SyntaxKind.ClassExpression,
]);

/** The member kinds a subclass overrides. */
const OVERRIDABLE: ReadonlySet<string> = new Set(["method", "class-member"]);

/** The node naming the class one `extends` entry names. */
function nameOf(entry: HeritageClauseElement): Node {
  if (isExpressionWithTypeArguments(entry)) {
    return isPropertyAccessExpression(entry.expression) ? entry.expression.name : entry.expression;
  }
  return isQualifiedName(entry.typeName) ? entry.typeName.right : entry.typeName;
}

/** One class whose `extends` clause names a class, with the name node and its file. */
interface Extending {
  readonly node: Node;
  readonly file: SourceFile;
  readonly base: Node;
}

/**
 * The reads each base class member makes of its overrides, for the classes of the target that
 * extend another class of the target, and each class makes of its members that override a
 * member of a class declared outside the target. A member a nearer base already overrides is
 * reached through that override. A private member is not overridden. Each read is placed at
 * the override. A class whose base the checker leaves unanswered holds every member it could
 * override.
 */
export const overrides: ReadRule = {
  start() {
    const extending: Extending[] = [];
    return {
      visit(node, { file }) {
        if (isClassDeclaration(node) || isClassExpression(node)) {
          const clause = node.heritageClauses?.find(
            (one) => one.token === SyntaxKind.ExtendsKeyword,
          );
          const base = clause?.types[0];
          if (base !== undefined) {
            extending.push({ node, file, base: nameOf(base) });
          }
        }
      },
      reads({ project, held, chains }) {
        const found: Read[] = [];
        const classes = extending.flatMap((one) => {
          const id = held.declarations.get(nodeKey(one.file, one.node));
          return id === undefined ? [] : [{ ...one, id }];
        });
        if (classes.length === 0) {
          return found;
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
        const fileOf = new Map(classes.map((one) => [one.id, one.file]));
        const own = project.ownPaths();
        const unanswered = new Set<string>();
        const symbols = project.symbolsAt(classes.map((one) => project.handle(one.base)));
        classes.forEach(({ id }, index) => {
          const symbol = symbols[index];
          if (symbol === UNANSWERED) {
            unanswered.add(id);
            return;
          }
          if (symbol === undefined) {
            return;
          }
          const inTarget = chains
            .chainOf(symbol)
            .map((target) => target.id)
            .filter((target) => byId.get(target)?.kind === "class" && target !== id);
          bases.set(id, inTarget);
          const declared =
            (symbol.flags & SymbolFlags.Alias) === 0 ? symbol : project.queries.aliased(symbol);
          if (declared === UNANSWERED) {
            unanswered.add(id);
            return;
          }
          if (
            inTarget.length === 0 &&
            (((declared.flags & SymbolFlags.Class) !== 0 &&
              // The target's augmentation of an outside class merges an interface into it,
              // so only a class declaration says where the class is.
              declared.declarations.some(
                (handle) => CLASS_DECLARATIONS.has(handle.kind) && !own.has(handle.path),
              )) ||
              ((declared.flags & SymbolFlags.Interface) !== 0 &&
                declared.declarations.some(
                  (handle) =>
                    handle.kind === SyntaxKind.VariableDeclaration && !own.has(handle.path),
                )))
          ) {
            outsideBases.set(id, declared);
          }
        });

        /** The nearest member of one component the class or a class it extends declares. */
        const declaredAbove = (classId: string, component: string, seen: Set<string>): string[] => {
          if (seen.has(classId)) {
            return [];
          }
          seen.add(classId);
          const member = members.get(classId)?.get(component);
          if (member !== undefined) {
            return [member.id];
          }
          return (bases.get(classId) ?? []).flatMap((base) => declaredAbove(base, component, seen));
        };

        const read = (classId: string, from: string, member: InventorySymbol): void => {
          const file = fileOf.get(classId);
          if (file !== undefined) {
            found.push({
              kind: "named",
              from,
              to: member.id,
              file,
              at: member.position,
              use: "read",
              via: "override",
            });
          }
        };
        const outside = outsideMemberNames(project, bases, outsideBases);
        for (const classId of [...unanswered, ...outside.unanswered]) {
          const ids = [...(members.get(classId)?.values() ?? [])].map((member) => member.id);
          found.push({ kind: "held", from: classId, ids });
        }
        for (const [classId, names] of outside.names) {
          for (const [component, member] of members.get(classId) ?? []) {
            if (names.has(component)) {
              read(classId, classId, member);
            }
          }
        }
        for (const [classId, baseIds] of bases) {
          for (const [component, member] of members.get(classId) ?? []) {
            const seen = new Set([classId]);
            for (const base of baseIds.flatMap((one) => declaredAbove(one, component, seen))) {
              read(classId, base, member);
            }
          }
        }
        return found;
      },
    };
  },
};

/**
 * Per class of the target with a class declared outside the target in its `extends`
 * chain, the member components that outside class's instances and constructor carry, a
 * static one spelled as a static member's component is.
 */
function outsideMemberNames<Brand>(
  project: ProjectView<Brand>,
  bases: ReadonlyMap<string, readonly string[]>,
  outsideBases: ReadonlyMap<string, TSSymbol>,
): {
  readonly names: ReadonlyMap<string, ReadonlySet<string>>;
  readonly unanswered: readonly string[];
} {
  const direct = new Map<string, ReadonlySet<string>>();
  const unanswered: string[] = [];
  const error = errorType(project);
  for (const [classId, base] of outsideBases) {
    const instance = project.queries.declaredTypeOf(base);
    const statics = project.queries.typeOfSymbol(base);
    if (
      instance === UNANSWERED ||
      statics === UNANSWERED ||
      project.queries.propertiesOf(instance) === UNANSWERED ||
      (statics !== undefined && project.queries.propertiesOf(statics) === UNANSWERED)
    ) {
      unanswered.push(classId);
    }
    const components = [
      ...namesOf(project, instance === UNANSWERED ? undefined : instance).map(nameComponent),
      ...(instance !== UNANSWERED && reaches(project, instance, error) ? ["toString"] : []),
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
  return { names, unanswered };
}

/** The global `Error` instance type's identifier, where the program's library declares one. */
function errorType<Brand>(project: ProjectView<Brand>): number | undefined {
  const symbol = project.queries.resolveName("Error", SymbolFlags.Type, undefined, false);
  if (symbol === UNANSWERED || symbol === undefined) {
    return undefined;
  }
  const type = project.queries.declaredTypeOf(symbol);
  return type === UNANSWERED ? undefined : type.id;
}

/**
 * Whether one type is the `Error` instance type or extends it at any depth: the runtime
 * prints an error through its `toString`, a member the library's `Error` interface omits.
 */
function reaches<Brand>(
  project: ProjectView<Brand>,
  type: Type,
  target: number | undefined,
): boolean {
  const seen = new Set<number>();
  const pending = [type];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (next.id === target) {
      return true;
    }
    if (!seen.has(next.id)) {
      seen.add(next.id);
      const bases = project.queries.baseTypes(next);
      pending.push(...(bases === UNANSWERED ? [] : bases));
    }
  }
  return false;
}

/** The names of a type's properties; none where the type or its properties are unanswered. */
function namesOf<Brand>(project: ProjectView<Brand>, type: Type | undefined): readonly string[] {
  const properties = type === undefined ? UNANSWERED : project.queries.propertiesOf(type);
  return properties === UNANSWERED ? [] : properties.map((property) => property.name);
}
