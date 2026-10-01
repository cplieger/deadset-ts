/**
 * The classes of the target a value of one type carries, as a serializer walking the
 * value reaches them: through union and intersection constituents, array and tuple
 * elements, and the data members of the target's classes and of object types the
 * target writes. The walk stops at `any`, `unknown`, a type parameter, a function and
 * an interface or class of another program, so an instance held only there is missed.
 */

import {
  ObjectFlags,
  SymbolFlags,
  type ObjectType,
  type Symbol as TSSymbol,
  type Type,
} from "@typescript/native/unstable/sync";
import { classNames, typesAt } from "./class-members.ts";
import type { Inventory } from "./inventory.ts";
import type { ProjectView } from "./session.ts";

/** The object types whose members the walk reads whatever declares them. */
const WRITTEN = ObjectFlags.ObjectLiteral | ObjectFlags.Mapped;

/** The symbols of an anonymous object type the target writes as a type. */
const LITERAL_SYMBOLS = SymbolFlags.TypeLiteral | SymbolFlags.ObjectLiteral;

/** The classes a type's values carry, each asked of the checker once. */
export interface ValueReach {
  /** The identifiers of the target's classes a value of `type` carries. */
  classesOf(type: Type): ReadonlySet<string>;
}

/** The global array types, whose element type is what an array value carries. */
function arrayTargets<Brand>(project: ProjectView<Brand>): ReadonlySet<number> {
  const checker = project.checker;
  return new Set(
    ["Array", "ReadonlyArray"].flatMap((name) => {
      const symbol = checker.resolveName(name, SymbolFlags.Type, undefined, false);
      return symbol === undefined ? [] : [checker.getDeclaredTypeOfSymbol(symbol).id];
    }),
  );
}

/**
 * The walk over one project's types, against the classes of `held`, the same
 * project's inventory.
 */
export function valueReach<Brand>(project: ProjectView<Brand>, held: Inventory): ValueReach {
  const checker = project.checker;
  const names = [...classNames(project, held)];
  const declared = typesAt(
    project,
    names.map(([, node]) => node),
  );
  const classOfTarget = new Map<number, string>();
  names.forEach(([id], index) => {
    const type = declared[index];
    if (type !== undefined) {
      classOfTarget.set(type.id, id);
    }
  });
  const arrays = arrayTargets(project);
  const own = new Set(project.ownSourceFiles().map((file) => file.fileName));
  const children = new Map<number, readonly Type[]>();

  /** The generic target of a type reference, and the type itself otherwise. */
  const targetOf = (type: ObjectType): Type =>
    (type.objectFlags & ObjectFlags.Reference) !== 0 && type.isTypeReference()
      ? type.getTarget()
      : type;

  const classOf = (type: Type): string | undefined => {
    if (!type.isObjectType()) {
      return undefined;
    }
    return classOfTarget.get(type.id) ?? classOfTarget.get(targetOf(type).id);
  };

  /** Whether the target writes the object type, so its members are what the value holds. */
  const isWritten = (type: ObjectType): boolean => {
    if ((type.objectFlags & WRITTEN) !== 0) {
      return true;
    }
    const symbol: TSSymbol | undefined = type.getSymbol();
    if (symbol === undefined) {
      return false;
    }
    if ((type.objectFlags & ObjectFlags.Anonymous) !== 0) {
      return (symbol.flags & LITERAL_SYMBOLS) !== 0;
    }
    return (
      (symbol.flags & SymbolFlags.Interface) !== 0 &&
      symbol.declarations.every((handle) => own.has(handle.path))
    );
  };

  /** The types a value of one object type holds in its data members. */
  const memberTypes = (type: Type): readonly Type[] => {
    const properties = checker
      .getPropertiesOfType(type)
      .filter((property) => (property.flags & SymbolFlags.Property) !== 0);
    const types = properties.length === 0 ? [] : checker.getTypeOfSymbol(properties);
    return [
      ...types.filter((held): held is Type => held !== undefined),
      ...checker.getIndexInfosOfType(type).map((info) => info.valueType),
    ];
  };

  /** The types a value of one type holds, read once per type. */
  const childrenOf = (type: Type): readonly Type[] => {
    const known = children.get(type.id);
    if (known !== undefined) {
      return known;
    }
    let found: readonly Type[] = [];
    if (type.isUnionType() || type.isIntersectionType()) {
      found = type.getTypes();
    } else if (type.isObjectType()) {
      const target = targetOf(type);
      const isList =
        type.isTypeReference() &&
        (arrays.has(target.id) ||
          (target.isObjectType() && (target.objectFlags & ObjectFlags.Tuple) !== 0));
      if (classOf(type) !== undefined || (!isList && isWritten(type))) {
        found = memberTypes(type);
      } else if (isList && type.isTypeReference()) {
        found = checker.getTypeArguments(type);
      }
    }
    children.set(type.id, found);
    return found;
  };

  return {
    classesOf: (type) => {
      const found = new Set<string>();
      const seen = new Set<number>();
      const pending: Type[] = [type];
      for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        if (seen.has(next.id)) {
          continue;
        }
        seen.add(next.id);
        const owner = classOf(next);
        if (owner !== undefined) {
          found.add(owner);
        }
        pending.push(...childrenOf(next));
      }
      return found;
    },
  };
}
