/**
 * The values the program stores in a property, an index signature, an array element or a
 * variable, each walked at its own static type and each type it is checked against, since
 * a serializer emits the value a slot holds. Containers are the checker's types, so two of
 * one type share their stores, and a class's instances share what its initializers, `this`
 * and `Object.assign` store. A store into an erased property of a type the program does
 * not declare hands the value to the code that declares it.
 */

import {
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isConstructorDeclaration,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
  ModifierFlags,
  SyntaxKind,
  type CallExpression,
  type Expression,
  type Identifier,
  type Node,
  type PropertyAccessExpression,
} from "@typescript/native/ast";
import { SymbolFlags, type Type } from "@typescript/native/sync";
import { modifiersOf } from "../inventory.ts";
import { must } from "../query.ts";
import type { ProjectView } from "../session.ts";
import { checkedTypes, ERASED } from "./value-reach.ts";
import { parenthesesRemoved } from "../unwrap.ts";

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
  /**
   * The expression whose type is the container, the literal whose contextual type is, or
   * the name of the class whose instances are.
   */
  readonly container: Expression;
  readonly contextual: boolean;
  readonly name: string | undefined;
  /** The `Object` an `Object.assign` copying the value names, which must be the standard library's. */
  readonly copiedBy?: Node;
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

/**
 * Whether a variable declaration's type can differ from what is stored in it: it carries an
 * annotation, or it has neither an annotation nor an initializer, so its type evolves.
 */
function declaresSlot(node: Node): boolean {
  const held = node as { readonly type?: Node; readonly initializer?: Node };
  return held.type !== undefined || held.initializer === undefined;
}

/**
 * The name of the class whose instance a `this` is, where it is one of a named class's
 * instance members; an arrow function's `this` is its enclosing one's.
 */
function classOfThis(node: Node): Identifier | undefined {
  for (let at = node.parent; !isSourceFile(at); at = at.parent) {
    if (
      isMethodDeclaration(at) ||
      isConstructorDeclaration(at) ||
      isGetAccessorDeclaration(at) ||
      isSetAccessorDeclaration(at) ||
      isPropertyDeclaration(at)
    ) {
      const owner = at.parent;
      return (isClassDeclaration(owner) || isClassExpression(owner)) &&
        (modifiersOf(at) & ModifierFlags.Static) === 0
        ? owner.name
        : undefined;
    }
    if (
      isFunctionDeclaration(at) ||
      isFunctionExpression(at) ||
      isClassStaticBlockDeclaration(at)
    ) {
      return undefined;
    }
  }
  return undefined;
}

/** The container a store into `target` names: its class for a `this` of one, else itself. */
function storedInto(target: Expression): Expression {
  const at = parenthesesRemoved(target);
  return (at.kind === SyntaxKind.ThisKeyword ? classOfThis(at) : undefined) ?? target;
}

/** Whether a node calls `Object.assign`, which copies each source's own members into its target. */
function isObjectAssign(node: Node): node is CallExpression & {
  readonly expression: PropertyAccessExpression;
} {
  return (
    isCallExpression(node) &&
    isPropertyAccessExpression(node.expression) &&
    isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Object" &&
    node.expression.name.text === "assign"
  );
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
  const target = parenthesesRemoved(pattern);
  const source = from.path.length === 0 ? parenthesesRemoved(from.value) : from.value;
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
  const candidates: Store[] = [];
  const assigns: Node[] = [];
  const assigned: (Stored & { readonly target: Node })[] = [];
  const slotVariables: Node[] = [];
  for (const file of project.ownSourceFiles()) {
    const visit = (node: Node): void => {
      if (isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
            const { name } = property;
            candidates.push({
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
            candidates.push({
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
            candidates.push({
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
            candidates.push({
              container: storedInto(target.expression),
              contextual: false,
              name: target.name.text,
              value,
              path,
            });
          } else if (isElementAccessExpression(target)) {
            candidates.push({
              container: storedInto(target.expression),
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
        isPropertyDeclaration(node) &&
        node.initializer !== undefined &&
        (isIdentifier(node.name) || isStringLiteral(node.name)) &&
        (isClassDeclaration(node.parent) || isClassExpression(node.parent)) &&
        node.parent.name !== undefined &&
        (modifiersOf(node) & ModifierFlags.Static) === 0
      ) {
        candidates.push({
          container: node.parent.name,
          contextual: false,
          name: node.name.text,
          value: node.initializer,
          path: [],
        });
      } else if (isObjectAssign(node)) {
        const [target, ...sources] = node.arguments;
        assigns.push(node.expression.expression);
        const container = target === undefined ? undefined : storedInto(target);
        for (const source of sources) {
          if (container !== undefined && !isSpreadElement(source)) {
            candidates.push({
              container,
              contextual: false,
              name: undefined,
              value: source,
              path: [],
              copiedBy: node.expression.expression,
            });
          }
        }
      } else if (
        isCallExpression(node) &&
        isPropertyAccessExpression(node.expression) &&
        ELEMENT_STORES.has(node.expression.name.text)
      ) {
        for (const argument of node.arguments) {
          candidates.push({
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

  const standard = new Set(
    queries
      .symbolsAt(assigns)
      .map(must)
      .flatMap((symbol, at) =>
        symbol !== undefined &&
        symbol.declarations.length > 0 &&
        symbol.declarations.every((handle) => !own.has(handle.path))
          ? [assigns[at]]
          : [],
      ),
  );
  const stores = candidates.filter(
    (one) => one.copiedBy === undefined || standard.has(one.copiedBy),
  );
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
  /** The types of what each stored value puts in its slot: its own and those it is checked against. */
  const storedTypes = (stored: readonly Stored[]): readonly (readonly Type[])[] => {
    const checked = checkedTypes(
      project,
      stored.map((one) => one.value),
    );
    return queries
      .typesAt(stored.map((one) => one.value))
      .map((type, at) =>
        [must(type), ...(checked[at] ?? [])].flatMap(
          (one) => partOf(one, stored[at]?.path ?? []) ?? [],
        ),
      );
  };
  const valueTypes = storedTypes(stores);
  const inside = new Map<number, Type[]>();
  const outside: OutsideStore[] = [];
  stores.forEach((store, at) => {
    const container = containerOf.get(store);
    const values = valueTypes[at] ?? [];
    if (container === undefined) {
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
        outside.push(...values.map((type) => ({ value: store.value, type, property: name })));
      } else {
        inside.set(part.id, [...(inside.get(part.id) ?? []), ...values]);
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
  const assignedTypes = storedTypes(assigned);
  const byVariable = new Map<Node, Type[]>();
  assigned.forEach((_one, at) => {
    const declaration = declarationOf(symbols[at]);
    const types = assignedTypes[at] ?? [];
    if (declaration !== undefined && slots.has(declaration) && types.length > 0) {
      byVariable.set(declaration, [...(byVariable.get(declaration) ?? []), ...types]);
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
