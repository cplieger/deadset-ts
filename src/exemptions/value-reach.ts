/**
 * The classes of the target a value of one type carries, and the members of the other
 * object types the target writes that it carries, as a serializer walking the value meets
 * them; whether the type is concrete as `references-ts.41` reads it; and, by a second walk
 * over every type the type names, every class a value of it can be. `stored` gives the
 * values a type erases.
 */

import {
  ModifierFlags,
  isAsExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isSatisfiesExpression,
  isSpreadAssignment,
  isTypeAssertion,
  type Node,
} from "@typescript/native/ast";
import {
  ObjectFlags,
  SignatureKind,
  SymbolFlags,
  TypeFlags,
  type NodeHandle,
  type ObjectType,
  type Symbol as TSSymbol,
  type Type,
} from "@typescript/native/sync";
import { classNames, typesAt } from "../class-members.ts";
import type { Inventory } from "../inventory.ts";
import { isAnswered, must } from "../query.ts";
import type { ProjectView } from "../session.ts";

/**
 * The object types whose members the walk reads whatever declares them. A reverse-mapped
 * type has no symbol: it is the shape the checker infers from an argument the target
 * writes against a homomorphic mapped type.
 */
const WRITTEN = ObjectFlags.ObjectLiteral | ObjectFlags.Mapped | ObjectFlags.ReverseMapped;

/** The symbols of an anonymous object type the target writes as a type. */
const LITERAL_SYMBOLS = SymbolFlags.TypeLiteral | SymbolFlags.ObjectLiteral;

/**
 * How many instantiations of one generic type one walk reads at most. A generic type that
 * instantiates itself afresh at each level has no end, and a walk cut here is not `concrete`.
 */
const INSTANTIATIONS = 32;

/**
 * How many types one walk reads at most. The checker instantiates some types afresh at each
 * step without a reference to count, such as a recursive conditional type's parts or a
 * generic signature's parameters, so only a bound ends the walk. A walk cut here names every
 * class of the target, so the cut retains.
 */
const WALK_BUDGET = 4096;

/** What a value of one type carries that the target declares. */
export interface Reached {
  /** The identifiers of the target's classes the value holds, each with its subclasses. */
  readonly classes: ReadonlySet<string>;
  /**
   * The members of the interfaces and object types the target writes, other than its
   * classes: each data member, and each method or getter named `toJSON` or `toString`.
   */
  readonly members: readonly TSSymbol[];
  /**
   * Every class of the target a value of the type can be: those among every type the type
   * names, each with its subclasses, and every class of the target where a walk was cut.
   */
  readonly named: ReadonlySet<string>;
  /**
   * Whether the type says which members its value has: a primitive or a literal, an object
   * literal's own type with no spread, or a non-generic, non-abstract class of the target
   * whose subclasses are not generic, with what each holds concrete in turn. Any other type
   * is not: `any`, `unknown`, `object`, `{}`, an interface or a type literal, a type
   * parameter, a generic instance, a signature, and a type whose walk was cut.
   */
  readonly concrete: boolean;
  /** The type parameters the type names, a class's `this` type and a signature's own aside. */
  readonly parameters: readonly Type[];
}

/** The type parameters one type is written from. */
interface WrittenOver {
  /** Each type parameter met, a class's `this` type aside. */
  readonly parameters: readonly Type[];
  /** Whether a mapped type was met: the checker infers through one a copy that names no class. */
  readonly mapped: boolean;
  /** Whether the walk ended before its bounds. */
  readonly complete: boolean;
}

/** What each type's values carry, each type's parts asked of the checker once. */
export interface ValueReach {
  /**
   * What a value of one type carries. Each read takes `bound`, the type parameters a call
   * instantiates where the value is that call's result, whose bindings the call's own type
   * already says, so the walk reads nothing of them.
   */
  reachedFrom(type: Type, bound?: readonly number[]): Reached;
  /** What a value whose class is exactly its type's carries, as a `new` expression's is. */
  exactly(type: Type, bound?: readonly number[]): Reached;
  /** What the values a value of one type holds carry: its members', elements' and stored values'. */
  heldBy(type: Type, bound?: readonly number[]): Reached;
  /** What an instance of one class of the target carries, read as its polymorphic `this` type. */
  instanceOf(id: string): Reached;
  /** The type parameters one type names, its type arguments and call signatures included. */
  writtenOver(type: Type): WrittenOver;
  /** The declarations of the `toJSON` an instance of one class of the target carries, its own or inherited. */
  serializedBy(id: string): readonly NodeHandle[];
  /** Every class of the target. */
  readonly every: ReadonlySet<string>;
}

/** The method a serializer calls on a value that carries one, wherever the value goes. */
export const SERIALIZED_CONVERSION = "toJSON";

/** The two conversion methods a serializer or a formatter resolves on a value's own shape. */
export const CONVERSION_NAMES: ReadonlySet<string> = new Set([SERIALIZED_CONVERSION, "toString"]);

/** The types that keep nothing of a value they are given, or that a decode gives a value. */
export const ERASED = TypeFlags.Any | TypeFlags.Unknown;

/**
 * The members that can answer a conversion: a serializer reads the name with `[[Get]]`
 * and calls what it answers, so a getter answers it as a method does:
 * https://tc39.es/ecma262/#sec-serializejsonproperty (step 2).
 */
export const CONVERSION_MEMBERS = SymbolFlags.Method | SymbolFlags.GetAccessor;

/**
 * The types each value is checked against by the `satisfies` expressions and type assertions
 * it is written as, through parentheses, and the innermost operand's own type where there is
 * one. A `satisfies` expression's static type is its operand's, so an object literal it
 * checks carries its own members and not the target's, though the literal's properties
 * write the target's; an assertion to `unknown` or `any` hides the operand's type.
 */
export function checkedTypes<Brand>(
  project: ProjectView<Brand>,
  values: readonly Node[],
): readonly (readonly Type[])[] {
  const nodes = values.map((value) => {
    const found: Node[] = [];
    let at = value;
    while (
      isParenthesizedExpression(at) ||
      isSatisfiesExpression(at) ||
      isAsExpression(at) ||
      isTypeAssertion(at)
    ) {
      if (!isParenthesizedExpression(at)) {
        found.push(at.type);
      }
      at = at.expression;
    }
    return found.length === 0 ? found : [...found, at];
  });
  const types = typesAt(project, nodes.flat());
  let next = 0;
  return nodes.map((one) => {
    const part = types.slice(next, next + one.length);
    next += one.length;
    return part.filter((type): type is Type => type !== undefined);
  });
}

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
 * How one walk reads a type: `members` the types its value holds, collecting classes and
 * members; `naming` every type it names, collecting classes; `over` every type it names,
 * ending at a `this` type.
 */
type Mode = "members" | "naming" | "over";

/**
 * The walk over one project's types, against the classes of `held`, the same project's
 * inventory. Where `subclasses`, a class the walk meets brings every class of the target
 * that extends it, since a value of the class's type can be an instance of any of them.
 */
export function valueReach<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  stored: (type: Type) => readonly Type[] = () => [],
  subclasses = true,
): ValueReach {
  const queries = project.queries;
  const names = [...classNames(project, held)];
  const declared = typesAt(
    project,
    names.map(([, node]) => node),
  );
  const classOfTarget = new Map<number, string>();
  const typeOfClass = new Map<string, Type>();
  names.forEach(([id], index) => {
    const type = declared[index];
    if (type !== undefined) {
      classOfTarget.set(type.id, id);
      typeOfClass.set(id, type);
    }
  });
  const every: ReadonlySet<string> = new Set(typeOfClass.keys());
  const abstractNodes = new Map(names.map(([id, node]) => [id, node.parent]));
  const arrays = arrayTargets(project);
  const own = project.ownPaths();
  const children = new Map<number, readonly Type[]>();
  const named = new Map<
    number,
    { readonly types: readonly Type[]; readonly own: number[]; readonly unanswered: boolean }
  >();
  const written = new Map<number, boolean>();
  const concrete = new Map<number, boolean>();
  const concreteExactly = new Map<number, boolean>();
  const holds = new Map<number, readonly Type[]>();
  const unanswered = new Set<number>();
  const targets = new Map<number, Type>();
  const generic = new Map<number, ReadonlyMap<string, number | undefined>>();
  const reached = new Map<string, Reached>();
  const holding = new Map<string, Reached>();
  const exact = new Map<string, Reached>();
  let extending: ReadonlyMap<string, readonly string[]> | undefined;

  /** The generic target of a type reference, and the type itself otherwise. */
  const targetOf = (type: ObjectType): Type => {
    if ((type.objectFlags & ObjectFlags.Reference) === 0) {
      return type;
    }
    let known = targets.get(type.id);
    if (known === undefined) {
      known = must(queries.targetOf(type));
      targets.set(type.id, known);
    }
    return known;
  };

  const classOf = (type: Type): string | undefined => {
    if (!type.isObjectType()) {
      return undefined;
    }
    return classOfTarget.get(type.id) ?? classOfTarget.get(targetOf(type).id);
  };

  /** The classes of the target that extend one, at any depth. */
  const subclassesOf = (id: string): readonly string[] => {
    if (extending === undefined) {
      const found = new Map<string, string[]>();
      for (const [child, type] of typeOfClass) {
        for (const base of must(queries.baseTypes(type))) {
          const parent = classOf(base);
          if (parent !== undefined) {
            found.set(parent, [...(found.get(parent) ?? []), child]);
          }
        }
      }
      extending = found;
    }
    const all = new Set<string>();
    const pending = [...(extending.get(id) ?? [])];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (!all.has(next)) {
        all.add(next);
        pending.push(...(extending.get(next) ?? []));
      }
    }
    return [...all];
  };

  /**
   * What the program stores in a value of one type; an instance of a generic class of the
   * target also holds what the class's own initializers and `this` store over its type
   * parameters.
   */
  const storedIn = (type: Type): readonly Type[] => {
    const own_ = stored(type);
    if (!type.isObjectType() || classOf(type) === undefined) {
      return own_;
    }
    const target = targetOf(type);
    return target.id === type.id ? own_ : [...own_, ...stored(target)];
  };

  /** Whether the target writes the object type, so its members are what the value holds. */
  const isWritten = (type: ObjectType): boolean => {
    let known = written.get(type.id);
    if (known === undefined) {
      known = writes(type);
      written.set(type.id, known);
    }
    return known;
  };
  const writes = (type: ObjectType): boolean => {
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
    // A class the inventory holds is read as a class before this, so an own class
    // here is one it does not hold, such as a class declared in a function.
    return (
      (symbol.flags & (SymbolFlags.Interface | SymbolFlags.Class)) !== 0 &&
      symbol.declarations.every((handle) => own.has(handle.path))
    );
  };

  const dataMembers = (type: Type): readonly TSSymbol[] =>
    must(queries.propertiesOf(type)).filter(
      (property) => (property.flags & SymbolFlags.Property) !== 0,
    );

  /**
   * The types a value of one object type holds, read once per type: its data members', the
   * getters' of a type other than a class of the target (a class's sit on its prototype, which
   * a serializer does not read: https://tc39.es/ecma262/#sec-enumerableownproperties), its
   * index signatures', and each result of its `toJSON`, which a serializer emits in its place
   * (https://tc39.es/ecma262/#sec-serializejsonproperty, step 2).
   */
  const memberTypes = (type: Type): readonly Type[] => {
    const known = holds.get(type.id);
    if (known !== undefined) {
      return known;
    }
    const getters = classOf(type) === undefined ? SymbolFlags.GetAccessor : 0;
    const properties = must(queries.propertiesOf(type));
    const members = properties.filter(
      (property) => (property.flags & (SymbolFlags.Property | getters)) !== 0,
    );
    const conversions = properties.filter((property) => property.name === SERIALIZED_CONVERSION);
    const results = queries
      .typesOfSymbols(conversions)
      .map(must)
      .flatMap((conversion) => {
        if (conversion === undefined) {
          return [];
        }
        const asked = queries.signaturesOf(conversion, SignatureKind.Call);
        if (!isAnswered(asked)) {
          unanswered.add(type.id);
          return [];
        }
        return asked.flatMap((signature) => must(queries.returnTypeOf(signature)) ?? []);
      });
    const found = [
      ...queries
        .typesOfSymbols(members)
        .map(must)
        .filter((held): held is Type => held !== undefined),
      ...must(queries.indexInfosOf(type)).map((info) => info.valueType),
      ...results,
    ];
    holds.set(type.id, found);
    return found;
  };

  const isList = (type: ObjectType): boolean => {
    const target = targetOf(type);
    return (
      type.isTypeReference() &&
      (arrays.has(target.id) ||
        (target.isObjectType() && (target.objectFlags & ObjectFlags.Tuple) !== 0))
    );
  };

  /** Whether the walk reads one type's members because the target writes the type, not as a class. */
  const writtenObject = (type: Type): boolean =>
    type.isObjectType() && classOf(type) === undefined && !isList(type) && isWritten(type);

  /** Whether one type is generic, so the walk also reads the types it is written from. */
  const opens = (type: Type): boolean =>
    (type.flags & TypeFlags.InstantiableNonPrimitive) !== 0 ||
    type.isIntersectionType() ||
    (type.isObjectType() &&
      (type.objectFlags & (ObjectFlags.Mapped | ObjectFlags.ReverseMapped)) !== 0);

  /**
   * Whether an object literal's own type comes from a literal with a spread. The checker
   * flags a spread type `ContainsSpread`, but gives a literal of spreads that add no
   * member, such as one of an `object`, a plain literal type.
   */
  const spreads = (type: Type): boolean =>
    (must(queries.symbolOfType(type))?.declarations ?? []).some((handle) => {
      const node = project.declarationAt(handle)?.node;
      return (
        node !== undefined &&
        isObjectLiteralExpression(node) &&
        node.properties.some((property) => isSpreadAssignment(property))
      );
    });

  /** Whether one class of the target is declared abstract, so its values are its subclasses'. */
  const isAbstract = (id: string): boolean => {
    const node = abstractNodes.get(id);
    return (
      (((node as { readonly modifierFlags?: number } | undefined)?.modifierFlags ?? 0) &
        ModifierFlags.Abstract) !==
      0
    );
  };

  /**
   * Whether one type is concrete as `references-ts.41` reads it, {@link Reached.concrete};
   * where `exact`, the type's own class's subclasses are not asked. A type met again on the
   * path counts as concrete there, so a yes is kept only where the first type's is.
   */
  const isConcrete = (start: Type, exact = false): boolean => {
    const cache = exact ? concreteExactly : concrete;
    const known = cache.get(start.id);
    if (known !== undefined) {
      return known;
    }
    const path = new Set<number>();
    const proven = new Set<number>();
    const holdsConcrete = (type: Type): boolean => {
      const held = [...memberTypes(type), ...storedIn(type)];
      return !unanswered.has(type.id) && held.every((one) => check(one, false));
    };
    // The root of an exact check is never on the path, so a later meeting reads it in full.
    const check = (type: Type, root: boolean): boolean => {
      if (!root) {
        const answered = concrete.get(type.id);
        if (answered !== undefined) {
          return answered;
        }
        if (path.has(type.id) || proven.has(type.id)) {
          return true;
        }
        path.add(type.id);
      }
      let answer: boolean;
      if ((type.flags & (TypeFlags.Primitive | TypeFlags.Never)) !== 0) {
        answer = true;
      } else if (type.isUnionType()) {
        answer = must(queries.constituents(type)).every((one) => check(one, false));
      } else if (type.isObjectType()) {
        const owner = classOf(type);
        const literal =
          owner === undefined &&
          (type.objectFlags & ObjectFlags.ObjectLiteral) !== 0 &&
          (type.objectFlags & ObjectFlags.ContainsSpread) === 0 &&
          !spreads(type);
        const plain =
          owner !== undefined &&
          !isAbstract(owner) &&
          must(queries.typeArguments(type)).length === 0;
        // An abstract subclass is read for its members alone, its values being its subclasses'.
        const extended =
          !plain || root || !subclasses
            ? true
            : subclassesOf(owner).every((id) => {
                const sub = typeOfClass.get(id);
                return (
                  sub !== undefined &&
                  must(queries.typeArguments(sub)).length === 0 &&
                  holdsConcrete(sub)
                );
              });
        answer = (literal || plain) && extended && holdsConcrete(type);
      } else {
        answer = false;
      }
      if (!root) {
        path.delete(type.id);
        if (!answer) {
          concrete.set(type.id, false);
        } else {
          proven.add(type.id);
        }
      }
      return answer;
    };
    const answer = check(start, exact);
    if (answer) {
      for (const id of proven) {
        concrete.set(id, true);
      }
    }
    cache.set(start.id, answer);
    return answer;
  };

  /**
   * The types an instance of another program's generic type holds of its type arguments:
   * its index signatures', and those of the data members whose type the instantiation
   * changes, which its generic declaration writes over a type parameter of its own. The
   * checker gives a member written over none the declaration's own type, as it does a
   * member a project's declaration merges in, which a value of the type need not have.
   */
  const argumentMembers = (type: ObjectType): readonly Type[] => {
    const target = targetOf(type);
    let declaredTypes = generic.get(target.id);
    if (declaredTypes === undefined) {
      const properties = dataMembers(target);
      const types = queries.typesOfSymbols(properties).map(must);
      declaredTypes = new Map(properties.map((property, at) => [property.name, types[at]?.id]));
      generic.set(target.id, declaredTypes);
    }
    const known = declaredTypes;
    const properties = dataMembers(type).filter((property) => known.has(property.name));
    const types = queries.typesOfSymbols(properties).map(must);
    return [
      ...types.filter(
        (one, at): one is Type =>
          one !== undefined && one.id !== known.get(properties[at]?.name ?? ""),
      ),
      ...must(queries.indexInfosOf(type)).map((info) => info.valueType),
    ];
  };

  /** The data members and conversion members of one written object type. */
  const carried = (type: Type): readonly TSSymbol[] =>
    must(queries.propertiesOf(type)).filter(
      (property) =>
        (property.flags & SymbolFlags.Property) !== 0 ||
        ((property.flags & CONVERSION_MEMBERS) !== 0 && CONVERSION_NAMES.has(property.name)),
    );

  /**
   * The types a value of one type holds, read once per type, and at a generic type its
   * parts and alias arguments.
   */
  const childrenOf = (type: Type): readonly Type[] => {
    const known = children.get(type.id);
    if (known !== undefined) {
      return known;
    }
    const found: Type[] = [];
    if (type.isUnionType() || type.isIntersectionType()) {
      found.push(...must(queries.constituents(type)));
    } else if (type.isTypeParameter() && type.isThisType === true) {
      // A value of a class's polymorphic `this` type is an instance of the class.
      const constraint = must(queries.constraintOf(type));
      found.push(...(constraint === undefined ? [] : [constraint]));
    } else if (type.isObjectType()) {
      if (classOf(type) !== undefined || (!isList(type) && isWritten(type))) {
        found.push(...memberTypes(type));
      } else if (isList(type)) {
        found.push(...must(queries.typeArguments(type)));
      } else if (type.isTypeReference()) {
        found.push(...argumentMembers(type));
      }
    }
    if (opens(type) && !(type.isTypeParameter() && type.isThisType === true)) {
      found.push(...must(queries.partsOf(type)), ...must(queries.aliasArgumentsOf(type)));
    }
    found.push(...storedIn(type));
    children.set(type.id, found);
    return found;
  };

  /**
   * The types an object type names besides what its value holds, read once per type: its
   * type arguments, the parameters and results of its call signatures, and, of an object
   * type the target writes, the types of the methods it declares itself; with the type
   * parameters those signatures declare, which name nothing of the value. A constructor's
   * instances are not its value, so its construct signatures name nothing.
   */
  const namedBy = (
    type: ObjectType,
  ): { readonly types: readonly Type[]; readonly own: number[]; readonly unanswered: boolean } => {
    let known = named.get(type.id);
    if (known === undefined) {
      // A type whose signatures the checker cannot answer names what it cannot say, so
      // the walk that meets it is cut.
      const asked = queries.signaturesOf(type, SignatureKind.Call);
      const signatures = isAnswered(asked) ? asked : [];
      const methods = writtenObject(type)
        ? must(queries.propertiesOf(type)).filter(
            (property) =>
              (property.flags & SymbolFlags.Method) !== 0 &&
              property.declarations.every((handle) => own.has(handle.path)),
          )
        : [];
      known = {
        types: [
          ...must(queries.typeArguments(type)),
          ...signatures.flatMap((signature) => [
            ...signature.parameters.map((_parameter, at) =>
              must(queries.typeAtPosition(signature, at)),
            ),
            ...[must(queries.returnTypeOf(signature))].filter((one) => one !== undefined),
          ]),
          ...queries
            .typesOfSymbols(methods)
            .map(must)
            .filter((one): one is Type => one !== undefined),
        ],
        own: signatures.flatMap((signature) => [...(signature.typeParameters ?? [])]),
        unanswered: !isAnswered(asked),
      };
      named.set(type.id, known);
    }
    return known;
  };

  /**
   * One walk from `start`, read as `mode` says; where `exact`, a start type brings no
   * subclass, and a type parameter of `bound` is read no further.
   */
  const walk = (
    start: readonly Type[],
    mode: Mode,
    exact = false,
    bound: readonly number[] = [],
  ) => {
    const classes = new Set<string>();
    const found: TSSymbol[] = [];
    const parameters = new Map<number, Type>();
    const declaredHere = new Set<number>(bound);
    const instances = new Map<number, number>();
    let mapped = false;
    let complete = true;
    const seen = new Set<number>();
    // The classes met only as an exact start, whose subclasses a later meeting brings.
    const exactOnly = new Set<number>();
    const pending = [...start];
    const extend = (owner: string): void => {
      for (const id of subclassesOf(owner)) {
        classes.add(id);
        const type = typeOfClass.get(id);
        if (type !== undefined) {
          pending.push(type);
        }
      }
    };
    // The loop reads each type pushed while it runs, breadth first.
    for (let at = 0; at < pending.length; at += 1) {
      const next = pending[at];
      if (next === undefined) {
        continue;
      }
      const root = exact && at < start.length;
      if (seen.has(next.id)) {
        if (!root && exactOnly.delete(next.id) && mode !== "over") {
          const owner = classOf(next);
          if (owner !== undefined && subclasses) {
            extend(owner);
          }
        }
        continue;
      }
      if (seen.size >= WALK_BUDGET) {
        complete = false;
        break;
      }
      seen.add(next.id);
      if (next.isTypeParameter() && declaredHere.has(next.id)) {
        continue;
      }
      if (next.isObjectType() && (next.objectFlags & ObjectFlags.Reference) !== 0) {
        const target = targetOf(next).id;
        const count = (instances.get(target) ?? 0) + 1;
        instances.set(target, count);
        if (count > INSTANTIATIONS) {
          complete = false;
          continue;
        }
      }
      const owner = classOf(next);
      if (owner !== undefined && mode !== "over") {
        classes.add(owner);
        if (root) {
          exactOnly.add(next.id);
        } else if (subclasses) {
          extend(owner);
        }
      } else if (mode === "members" && writtenObject(next)) {
        found.push(...carried(next));
      }
      if (opens(next)) {
        if (next.isTypeParameter() && next.isThisType !== true) {
          parameters.set(next.id, next);
        }
        mapped ||= next.isObjectType() && (next.objectFlags & ObjectFlags.Mapped) !== 0;
      }
      // A result typed `this` is the receiver, whose own type arguments say nothing of
      // what the call hands back, so what a type is written over ends there.
      if (mode === "over" && next.isTypeParameter() && next.isThisType === true) {
        continue;
      }
      pending.push(...childrenOf(next));
      complete &&= !unanswered.has(next.id);
      if (mode !== "members" && next.isObjectType()) {
        const { types, own: local, unanswered } = namedBy(next);
        complete &&= !unanswered;
        for (const id of local) {
          declaredHere.add(id);
        }
        pending.push(...types);
      }
    }
    return { classes, found, parameters, mapped, complete };
  };

  const over = (start: readonly Type[], exact: boolean, bound: readonly number[]): Reached => {
    const held = walk(start, "members", exact, bound);
    const naming = walk(start, "naming", exact, bound);
    const complete = held.complete && naming.complete;
    return {
      classes: held.classes,
      members: held.found,
      named: complete ? naming.classes : every,
      concrete: complete && start.every((one) => isConcrete(one, exact)),
      parameters: [...naming.parameters.values()],
    };
  };
  const keyOf = (type: Type, bound: readonly number[]): string =>
    `${String(type.id)}:${bound.join(",")}`;
  const reachedFrom = (type: Type, bound: readonly number[] = []): Reached => {
    const key = keyOf(type, bound);
    let known = reached.get(key);
    if (known === undefined) {
      known = over([type], false, bound);
      reached.set(key, known);
    }
    return known;
  };
  const exactly = (type: Type, bound: readonly number[] = []): Reached => {
    const key = keyOf(type, bound);
    let known = exact.get(key);
    if (known === undefined) {
      known = over([type], true, bound);
      exact.set(key, known);
    }
    return known;
  };
  const heldBy = (type: Type, bound: readonly number[] = []): Reached => {
    const key = keyOf(type, bound);
    let known = holding.get(key);
    if (known === undefined) {
      const owner = classOf(type);
      const types = bound.includes(type.id)
        ? []
        : [
            type,
            ...(owner === undefined || !subclasses ? [] : subclassesOf(owner)).flatMap(
              (id) => typeOfClass.get(id) ?? [],
            ),
          ];
      const read = over(types.flatMap(childrenOf), false, bound);
      known = types.some((one) => unanswered.has(one.id))
        ? { ...read, named: every, concrete: false }
        : read;
      holding.set(key, known);
    }
    return known;
  };

  return {
    reachedFrom,
    exactly,
    heldBy,
    instanceOf: (id) => {
      const type = typeOfClass.get(id);
      const known = type === undefined ? undefined : reachedFrom(type);
      return {
        classes: known?.classes ?? new Set([id]),
        members: known?.members ?? [],
        named: known?.named ?? new Set([id]),
        concrete: false,
        parameters: known?.parameters ?? [],
      };
    },
    writtenOver: (type) => {
      const walked = walk([type], "over");
      return {
        parameters: [...walked.parameters.values()],
        mapped: walked.mapped,
        complete: walked.complete,
      };
    },
    serializedBy: (id) => {
      const type = typeOfClass.get(id);
      const conversion =
        type === undefined
          ? undefined
          : must(queries.propertiesOf(type)).find(
              (property) => property.name === SERIALIZED_CONVERSION,
            );
      return conversion?.declarations ?? [];
    },
    every,
  };
}
