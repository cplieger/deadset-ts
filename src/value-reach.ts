/**
 * The classes of the target a value of one type carries, and the members of the other
 * object types the target writes that it carries, as a serializer walking the value
 * reaches them: through union and intersection constituents, array and tuple elements,
 * and the data members and index signatures of the target's classes and of the
 * interfaces and object types the target writes. The walk stops at `any`, `unknown`, a
 * type parameter, a function and an interface or class of another program, so an
 * instance held only there is missed.
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
import { must } from "./query.ts";
import type { ProjectView } from "./session.ts";

/** The object types whose members the walk reads whatever declares them. */
const WRITTEN = ObjectFlags.ObjectLiteral | ObjectFlags.Mapped;

/** The symbols of an anonymous object type the target writes as a type. */
const LITERAL_SYMBOLS = SymbolFlags.TypeLiteral | SymbolFlags.ObjectLiteral;

/** What a value of one type carries that the target declares. */
export interface Reached {
  /** The identifiers of the target's classes. */
  readonly classes: ReadonlySet<string>;
  /**
   * The members of the interfaces and object types the target writes, other than its
   * classes: each data member, and each method named `toJSON` or `toString`.
   */
  readonly members: readonly TSSymbol[];
}

/** What each type's values carry, each type asked of the checker once. */
export interface ValueReach {
  reachedFrom(type: Type): Reached;
}

/** The two conversion methods a serializer or a formatter resolves on a value's own shape. */
const CONVERSION_NAMES: ReadonlySet<string> = new Set(["toJSON", "toString"]);

/** The global array types, whose element type is what an array value carries. */
function arrayTargets<Brand>(project: ProjectView<Brand>): ReadonlySet<number> {
  const queries = project.queries;
  return new Set(
    ["Array", "ReadonlyArray"].flatMap((name) => {
      const symbol = must(queries.resolveName(name, SymbolFlags.Type, undefined, false));
      return symbol === undefined ? [] : [must(queries.declaredTypeOf(symbol)).id];
    }),
  );
}

/**
 * The walk over one project's types, against the classes of `held`, the same
 * project's inventory.
 */
export function valueReach<Brand>(project: ProjectView<Brand>, held: Inventory): ValueReach {
  const queries = project.queries;
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
  const own = project.ownPaths();
  const children = new Map<number, readonly Type[]>();

  /** The generic target of a type reference, and the type itself otherwise. */
  const targetOf = (type: ObjectType): Type =>
    (type.objectFlags & ObjectFlags.Reference) !== 0 ? must(queries.targetOf(type)) : type;

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
    const symbol: TSSymbol | undefined = must(queries.symbolOfType(type));
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
    const properties = must(queries.propertiesOf(type)).filter(
      (property) => (property.flags & SymbolFlags.Property) !== 0,
    );
    const types = queries.typesOfSymbols(properties).map(must);
    return [
      ...types.filter((held): held is Type => held !== undefined),
      ...must(queries.indexInfosOf(type)).map((info) => info.valueType),
    ];
  };

  /** Whether the walk reads one type's members because the target writes the type, not as a class. */
  const writtenObject = (type: Type): boolean => {
    if (!type.isObjectType() || classOf(type) !== undefined) {
      return false;
    }
    const target = targetOf(type);
    const isList =
      type.isTypeReference() &&
      (arrays.has(target.id) ||
        (target.isObjectType() && (target.objectFlags & ObjectFlags.Tuple) !== 0));
    return !isList && isWritten(type);
  };

  /** The data members and conversion methods of one written object type. */
  const carried = (type: Type): readonly TSSymbol[] =>
    must(queries.propertiesOf(type)).filter(
      (property) =>
        (property.flags & SymbolFlags.Property) !== 0 ||
        ((property.flags & SymbolFlags.Method) !== 0 && CONVERSION_NAMES.has(property.name)),
    );

  /** The types a value of one type holds, read once per type. */
  const childrenOf = (type: Type): readonly Type[] => {
    const known = children.get(type.id);
    if (known !== undefined) {
      return known;
    }
    let found: readonly Type[] = [];
    if (type.isUnionType() || type.isIntersectionType()) {
      found = must(queries.constituents(type));
    } else if (type.isObjectType()) {
      const target = targetOf(type);
      const isList =
        type.isTypeReference() &&
        (arrays.has(target.id) ||
          (target.isObjectType() && (target.objectFlags & ObjectFlags.Tuple) !== 0));
      if (classOf(type) !== undefined || (!isList && isWritten(type))) {
        found = memberTypes(type);
      } else if (isList && type.isTypeReference()) {
        found = must(queries.typeArguments(type));
      }
    }
    children.set(type.id, found);
    return found;
  };

  return {
    reachedFrom: (type) => {
      const classes = new Set<string>();
      const members: TSSymbol[] = [];
      const seen = new Set<number>();
      const pending: Type[] = [type];
      for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        if (seen.has(next.id)) {
          continue;
        }
        seen.add(next.id);
        const owner = classOf(next);
        if (owner !== undefined) {
          classes.add(owner);
        } else if (writtenObject(next)) {
          members.push(...carried(next));
        }
        pending.push(...childrenOf(next));
      }
      return { classes, members };
    },
  };
}
