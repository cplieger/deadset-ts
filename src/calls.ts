/**
 * The calls and decorators of one project that the configured classes read: what each
 * callee resolves to, and which of the target's classes a call passes or a decorator
 * is attached to. A class is passed as an argument, or as an element of an array
 * literal or a property value of an object literal written as one, at any depth, and a
 * decorator written as a call is a call.
 */

import {
  isArrayLiteralExpression,
  isCallExpression,
  isClassDeclaration,
  isDecorator,
  isIdentifier,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadElement,
  type CallExpression,
  type Decorator,
  type Expression,
  type Node,
} from "@typescript/native/unstable/ast";
import { SymbolFlags, type Symbol as TSSymbol } from "@typescript/native/unstable/sync";
import type { AliasChains } from "./alias-chain.ts";
import { nodeKey, type Inventory } from "./inventory.ts";
import { must } from "./query.ts";
import type { ProjectView } from "./session.ts";

/** One value written where a call passes it, and the node its declaration is resolved from. */
interface PassedValue {
  /** Where the value is written, which is where a record of it sits. */
  readonly site: Node;
  /** The name the value is resolved through, or the shorthand assignment that holds it. */
  readonly name: Node;
  readonly shorthand: boolean;
}

/** One class of the target a call passes or a decorator is attached to, and where. */
interface ClassUse {
  /** The inventory's identifier of the class. */
  readonly id: string;
  readonly site: Node;
}

/** The name node a callee or a decorator expression resolves through, where it has one. */
export function calleeName(expression: Expression): Node | undefined {
  if (isParenthesizedExpression(expression)) {
    return calleeName(expression.expression);
  }
  if (isPropertyAccessExpression(expression)) {
    return expression.name;
  }
  return isIdentifier(expression) ? expression : undefined;
}

/** The callee one decorator names: its expression, or the callee of the call it writes. */
export function decoratorCallee(decorator: Decorator): Node | undefined {
  const expression = decorator.expression;
  return calleeName(isCallExpression(expression) ? expression.expression : expression);
}

/** How one decorator is spelled in a record: its expression, without a call's arguments. */
export function spelledDecorator(decorator: Decorator): string {
  const expression = decorator.expression;
  const named = isCallExpression(expression) ? expression.expression : expression;
  return `@${named.getText().replace(/\s+/gu, "")}`;
}

/** The decorators written on one declaration. */
export function decoratorsOf(node: Node): readonly Decorator[] {
  return ((node as { readonly modifiers?: readonly Node[] }).modifiers ?? []).filter(isDecorator);
}

/**
 * What each of a batch of nodes resolves to, every alias followed to the declaration
 * it stands for. A node the checker resolves to nothing, and an alias that resolves
 * to nothing, are absent from the answer. Each alias is followed once. A question the
 * checker does not answer stops the pass, as {@link must} stops.
 */
export function resolvedTargets<Brand>(
  project: ProjectView<Brand>,
  nodes: readonly Node[],
): ReadonlyMap<Node, TSSymbol> {
  const followed = new Map<number, TSSymbol | undefined>();
  const targets = new Map<Node, TSSymbol>();
  project
    .symbolsAt(nodes.map((node) => project.handle(node)))
    .map(must)
    .forEach((symbol, index) => {
      const node = nodes[index];
      if (symbol === undefined || node === undefined) {
        return;
      }
      let target: TSSymbol | undefined = symbol;
      if ((symbol.flags & SymbolFlags.Alias) !== 0) {
        if (!followed.has(symbol.id)) {
          const aliased = must(project.queries.aliased(symbol));
          followed.set(symbol.id, aliased.declarations.length === 0 ? undefined : aliased);
        }
        target = followed.get(symbol.id);
      }
      if (target !== undefined) {
        targets.set(node, target);
      }
    });
  return targets;
}

/** The values one expression passes: itself, or what an array or object literal holds. */
function passedIn(expression: Expression, found: PassedValue[]): void {
  if (isParenthesizedExpression(expression)) {
    passedIn(expression.expression, found);
    return;
  }
  if (isArrayLiteralExpression(expression)) {
    for (const element of expression.elements) {
      passedIn(isSpreadElement(element) ? element.expression : element, found);
    }
    return;
  }
  if (isObjectLiteralExpression(expression)) {
    for (const property of expression.properties) {
      if (isPropertyAssignment(property)) {
        passedIn(property.initializer, found);
      } else if (isShorthandPropertyAssignment(property)) {
        found.push({ site: property.name, name: property, shorthand: true });
      }
    }
    return;
  }
  const name = calleeName(expression);
  if (name !== undefined) {
    found.push({ site: expression, name, shorthand: false });
  }
}

/** The values one argument passes, a spread argument's included. */
export function valuesPassed(argument: Expression): readonly PassedValue[] {
  const found: PassedValue[] = [];
  passedIn(isSpreadElement(argument) ? argument.expression : argument, found);
  return found;
}

/**
 * The classes of the target each call passes, by the call. A value that names no
 * class of the target, a class of another program included, passes nothing here.
 */
export function classesPassed<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  chains: AliasChains,
  calls: readonly CallExpression[],
): ReadonlyMap<CallExpression, readonly ClassUse[]> {
  const passed = new Map(
    calls.map((call) => [call, call.arguments.flatMap((argument) => valuesPassed(argument))]),
  );
  const all = [...passed.values()].flat();
  const targets = resolvedTargets(
    project,
    all.filter((value) => !value.shorthand).map((value) => value.name),
  );
  const classes = new Set(
    held.symbols.filter((symbol) => symbol.kind === "class").map((symbol) => symbol.id),
  );
  const classesOf = (value: PassedValue): readonly string[] => {
    const symbol = value.shorthand
      ? must(project.shorthandValueAt(project.handle(value.name)))
      : targets.get(value.name);
    return symbol === undefined
      ? []
      : chains.declarationsOf(symbol).filter((id) => classes.has(id));
  };
  return new Map(
    [...passed].map(([call, values]) => [
      call,
      values.flatMap((value) => classesOf(value).map((id) => ({ id, site: value.site }))),
    ]),
  );
}

/** One class declaration of the target and the decorators written on it. */
interface DecoratedClass {
  readonly id: string;
  readonly decorators: readonly Decorator[];
}

/** Every class declaration of the target that carries a decorator. */
export function decoratedClasses<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
): readonly DecoratedClass[] {
  const found: DecoratedClass[] = [];
  for (const file of project.ownSourceFiles()) {
    const visit = (node: Node): void => {
      if (isClassDeclaration(node)) {
        const id = held.declarations.get(nodeKey(file, node));
        const decorators = decoratorsOf(node);
        if (id !== undefined && decorators.length > 0) {
          found.push({ id, decorators });
        }
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
  }
  return found;
}

/** Every call expression of the project's own files, decorators written as calls included. */
export function callsOf<Brand>(project: ProjectView<Brand>): readonly CallExpression[] {
  const found: CallExpression[] = [];
  for (const file of project.ownSourceFiles()) {
    const visit = (node: Node): void => {
      if (isCallExpression(node)) {
        found.push(node);
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
  }
  return found;
}
