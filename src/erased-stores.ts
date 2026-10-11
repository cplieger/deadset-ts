/**
 * The values the program stores in a slot of a container: a property, an index signature,
 * an array element, and a variable. A serializer walking the container emits the value the
 * slot holds, so it walks each stored value at its own static type, a subtype stored where
 * the slot's type names a supertype, `object`, `unknown` or `any` included. A container is
 * identified by the checker's type identity, so two containers of one type share what
 * either stores. A store into an erased property of a type the analyzed program does not
 * declare hands the value to the code that declares the type.
 */

import {
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
  SyntaxKind,
  type Expression,
  type Node,
} from "@typescript/native/ast";
import { SymbolFlags, TypeFlags, type Type } from "@typescript/native/sync";
import { must } from "./query.ts";
import type { ProjectView } from "./session.ts";

/** The types that keep nothing of the value they are given. */
const ERASED = TypeFlags.Any | TypeFlags.Unknown;

/** The array methods whose arguments become elements of the array they are called on. */
const ELEMENT_STORES: ReadonlySet<string> = new Set(["push", "unshift"]);

/** One step into a value: a property's name, or an element's place. */
type Step = string | number;

/**
 * What a store puts in its slot: the value of `value`, or, where a destructuring pattern
 * takes it apart, the part of it `path` names.
 */
interface Stored {
  readonly value: Expression;
  readonly path: readonly Step[];
}

/** One store into a slot of a container: the property it names, or none for an element or an index. */
interface Store extends Stored {
  /** The expression whose type is the container, or the literal whose contextual type is. */
  readonly container: Expression;
  readonly contextual: boolean;
  readonly name: string | undefined;
}

/** A store into an erased property of a type no file of the project declares. */
interface OutsideStore {
  readonly value: Expression;
  readonly type: Type;
  readonly property: string;
}

/** What the program stores where a type erases it. */
export interface ErasedStores {
  /** The static types of the values stored in a slot of a value of one type. */
  readonly inside: (type: Type) => readonly Type[];
  /** The static types stored in the variable one identifier names, if it names one the program stores into. */
  readonly ofVariable: (node: Node) => readonly Type[] | undefined;
  readonly outside: readonly OutsideStore[];
}

/** The name an element access's literal index spells, or none. */
function literalKey(node: Expression): string | undefined {
  return isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node) || isNumericLiteral(node)
    ? node.text
    : undefined;
}

function unwrapped(node: Expression): Expression {
  return isParenthesizedExpression(node) ? unwrapped(node.expression) : node;
}

/**
 * Whether a variable declaration's type can differ from what is stored in it: it carries an
 * annotation, or it has neither an annotation nor an initializer, so its type evolves.
 */
function declaresSlot(node: Node): boolean {
  const held = node as { readonly type?: Node; readonly initializer?: Node };
  return held.type !== undefined || held.initializer === undefined;
}

/** One target a destructuring assignment writes, and what it receives. */
interface Target extends Stored {
  readonly target: Expression;
}

/** The element of an array literal at one place, where no spread before it moves the places. */
function elementAt(source: Expression, at: number): Expression | undefined {
  if (!isArrayLiteralExpression(source)) {
    return undefined;
  }
  const before = source.elements.slice(0, at + 1);
  return before.some((one) => isSpreadElement(one)) ? undefined : source.elements[at];
}

/** The name a property spells, and none for a computed one. */
function propertyName(name: Node): string | undefined {
  return isIdentifier(name) || isStringLiteral(name) || isNumericLiteral(name)
    ? name.text
    : undefined;
}

/** The name one property of an object literal spells and the expression it holds, or none. */
function propertyParts(
  property: Node,
): { readonly name: string; readonly value: Expression } | undefined {
  if (isPropertyAssignment(property)) {
    const name = propertyName(property.name);
    return name === undefined ? undefined : { name, value: property.initializer };
  }
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
    return { name: property.name.text, value: property.name };
  }
  return undefined;
}

/** The value an object literal gives one property, where it gives it by a plain or a shorthand property. */
function propertyAt(source: Expression, name: string): Expression | undefined {
  if (!isObjectLiteralExpression(source)) {
    return undefined;
  }
  for (const property of source.properties) {
    const parts = propertyParts(property);
    if (parts?.name === name) {
      return parts.value;
    }
  }
  return undefined;
}

/**
 * Every target one destructuring pattern writes at any depth, each with the expression
 * whose value it receives: the matching element or property of a literal on the right,
 * else the right side with the path into it. A rest element copies, so it is no target
 * here, and a default value is stored in its target too.
 */
function patternTargets(pattern: Expression, from: Stored, out: Target[]): void {
  const target = unwrapped(pattern);
  const source = from.path.length === 0 ? unwrapped(from.value) : from.value;
  const into = (element: Expression, step: Step, literal: Expression | undefined): void => {
    patternTargets(
      element,
      literal === undefined
        ? { value: from.value, path: [...from.path, step] }
        : { value: literal, path: [] },
      out,
    );
  };
  if (isArrayLiteralExpression(target)) {
    target.elements.forEach((element, at) => {
      if (!isSpreadElement(element) && element.kind !== SyntaxKind.OmittedExpression) {
        into(element, at, from.path.length === 0 ? elementAt(source, at) : undefined);
      }
    });
    return;
  }
  if (isObjectLiteralExpression(target)) {
    for (const property of target.properties) {
      const parts = propertyParts(property);
      if (parts !== undefined) {
        into(
          parts.value,
          parts.name,
          from.path.length === 0 ? propertyAt(source, parts.name) : undefined,
        );
      }
      if (
        parts !== undefined &&
        isShorthandPropertyAssignment(property) &&
        property.objectAssignmentInitializer !== undefined
      ) {
        out.push({ target: parts.value, value: property.objectAssignmentInitializer, path: [] });
      }
    }
    return;
  }
  if (isBinaryExpression(target) && target.operatorToken.kind === SyntaxKind.EqualsToken) {
    patternTargets(target.left, from, out);
    out.push({ target: target.left, value: target.right, path: [] });
    return;
  }
  out.push({ target, ...from });
}

/** Every store one project's own files write, and the stores into variables declared erased. */
export function erasedStores<Brand>(project: ProjectView<Brand>): ErasedStores {
  const queries = project.queries;
  const own = project.ownPaths();
  const stores: Store[] = [];
  const assigned: (Stored & { readonly target: Node })[] = [];
  const slotVariables: Node[] = [];
  for (const file of project.ownSourceFiles()) {
    const visit = (node: Node): void => {
      if (isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
            const { name } = property;
            stores.push({
              container: node,
              contextual: true,
              name: name.text,
              value: name,
              path: [],
            });
          } else if (
            isPropertyAssignment(property) &&
            (isIdentifier(property.name) || isStringLiteral(property.name))
          ) {
            const value = property.initializer;
            stores.push({
              container: node,
              contextual: true,
              name: property.name.text,
              value,
              path: [],
            });
          }
        }
      } else if (isArrayLiteralExpression(node)) {
        for (const element of node.elements) {
          if (!isSpreadElement(element)) {
            stores.push({
              container: node,
              contextual: true,
              name: undefined,
              value: element,
              path: [],
            });
          }
        }
      } else if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) {
        const targets: Target[] = [];
        patternTargets(node.left, { value: node.right, path: [] }, targets);
        for (const { target, value, path } of targets) {
          if (isPropertyAccessExpression(target)) {
            stores.push({
              container: target.expression,
              contextual: false,
              name: target.name.text,
              value,
              path,
            });
          } else if (isElementAccessExpression(target)) {
            stores.push({
              container: target.expression,
              contextual: false,
              name: literalKey(target.argumentExpression),
              value,
              path,
            });
          } else if (isIdentifier(target)) {
            assigned.push({ target, value, path });
          }
        }
      } else if (
        isCallExpression(node) &&
        isPropertyAccessExpression(node.expression) &&
        ELEMENT_STORES.has(node.expression.name.text)
      ) {
        for (const argument of node.arguments) {
          stores.push({
            container: node.expression.expression,
            contextual: false,
            name: undefined,
            value: argument,
            path: [],
          });
        }
      } else if (isVariableDeclaration(node) && declaresSlot(node)) {
        slotVariables.push(node);
        if (node.initializer !== undefined) {
          assigned.push({ target: node, value: node.initializer, path: [] });
        }
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
  }

  const contextual = stores.filter((one) => one.contextual);
  const contexts = queries.contextualTypes(contextual.map((one) => one.container)).map(must);
  const containerOf = new Map<Store, Type | undefined>(
    contextual.map((one, at) => [one, contexts[at]]),
  );
  const typed = stores.filter((one) => !one.contextual);
  queries
    .typesAt(typed.map((one) => one.container))
    .map(must)
    .forEach((type, at) => {
      const one = typed[at];
      if (one !== undefined) {
        containerOf.set(one, type);
      }
    });

  const slotTypes = new Map<string, Type | undefined>();
  /** The type a slot of one object type holds: a property's, else the string index's, else an element's. */
  const slotOf = (type: Type, name: string | undefined): Type | undefined => {
    const key = `${String(type.id)}\u0000${name ?? ""}`;
    if (slotTypes.has(key)) {
      return slotTypes.get(key);
    }
    let found: Type | undefined;
    const property =
      name === undefined
        ? undefined
        : must(queries.propertiesOf(type)).find((one) => one.name === name);
    if (property !== undefined) {
      found =
        (property.flags & SymbolFlags.Property) !== 0
          ? must(queries.typeOfSymbol(property))
          : undefined;
    } else if (type.isTypeReference() && must(queries.isArray(type))) {
      found = must(queries.typeArguments(type))[0];
    } else {
      found = must(queries.indexInfosOf(type))[0]?.valueType;
    }
    slotTypes.set(key, found);
    return found;
  };
  const declaredOutside = (type: Type): boolean => {
    const symbol = must(queries.symbolOfType(type));
    return (
      symbol !== undefined &&
      symbol.declarations.length > 0 &&
      symbol.declarations.every((handle) => !own.has(handle.path))
    );
  };

  /** The type of the part of a stored value its path names, a step at a time. */
  const partOf = (type: Type | undefined, path: readonly Step[]): Type | undefined =>
    path.reduce<Type | undefined>(
      (at, step) => (at === undefined ? undefined : slotOf(at, String(step))),
      type,
    );
  const valueTypes = queries
    .typesAt(stores.map((one) => one.value))
    .map((type, at) => partOf(must(type), stores[at]?.path ?? []));
  const inside = new Map<number, Type[]>();
  const outside: OutsideStore[] = [];
  stores.forEach((store, at) => {
    const container = containerOf.get(store);
    const value = valueTypes[at];
    if (container === undefined || value === undefined) {
      return;
    }
    const parts =
      container.isUnionType() || container.isIntersectionType()
        ? must(queries.constituents(container))
        : [container];
    for (const part of parts) {
      if (!part.isObjectType()) {
        continue;
      }
      const { name } = store;
      const erased = name !== undefined && ((slotOf(part, name)?.flags ?? 0) & ERASED) !== 0;
      if (erased && declaredOutside(part)) {
        outside.push({ value: store.value, type: value, property: name });
      } else {
        inside.set(part.id, [...(inside.get(part.id) ?? []), value]);
      }
    }
  });

  const targets = assigned.map((one) =>
    isVariableDeclaration(one.target) ? one.target.name : one.target,
  );
  const symbols = queries.symbolsAt(targets).map(must);
  const slots = new Set(slotVariables);
  const declarationOf = (symbol: (typeof symbols)[number]): Node | undefined => {
    const handle = symbol?.valueDeclaration ?? symbol?.declarations[0];
    return handle === undefined ? undefined : project.declarationAt(handle)?.node;
  };
  const assignedTypes = queries
    .typesAt(assigned.map((one) => one.value))
    .map((type, at) => partOf(must(type), assigned[at]?.path ?? []));
  const byVariable = new Map<Node, Type[]>();
  assigned.forEach((_one, at) => {
    const declaration = declarationOf(symbols[at]);
    const type = assignedTypes[at];
    if (declaration !== undefined && slots.has(declaration) && type !== undefined) {
      byVariable.set(declaration, [...(byVariable.get(declaration) ?? []), type]);
    }
  });

  return {
    inside: (type) => inside.get(type.id) ?? [],
    ofVariable: (node) => {
      if (byVariable.size === 0 || !isIdentifier(node)) {
        return undefined;
      }
      const [symbol] = queries.symbolsAt([node]).map(must);
      const declaration = declarationOf(symbol);
      return declaration === undefined ? undefined : byVariable.get(declaration);
    },
    outside,
  };
}
