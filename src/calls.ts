/**
 * The calls and decorators of one project that the configured classes read: what each
 * callee resolves to, and which of the target's classes a call passes or a decorator
 * is attached to. A class is passed by each value an argument can be, at any depth inside
 * the array and object literals it writes, named directly or through variables, and a
 * decorator written as a call is a call.
 */

import {
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isClassDeclaration,
  isConditionalExpression,
  isDecorator,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isShorthandPropertyAssignment,
  isOmittedExpression,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclaration,
  type CallExpression,
  type Decorator,
  type Expression,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
} from "@typescript/native/ast";
import {
  ObjectFlags,
  SymbolFlags,
  type Symbol as TSSymbol,
  type Type,
} from "@typescript/native/sync";
import type { AliasChains } from "./alias-chain.ts";
import { nodeKey, type Inventory } from "./inventory.ts";
import { must } from "./query.ts";
import type { ProjectView } from "./session.ts";
import { unwrapped } from "./unwrap.ts";

/** One value written where a call passes it, and the node its declaration is resolved from. */
interface PassedValue {
  /** Where the value is written, which is where a record of it sits. */
  readonly site: Node;
  /** The name the value is resolved through, the shorthand assignment that holds it, or none. */
  readonly name: Node | undefined;
  readonly shorthand: boolean;
}

/** A passed value that names its declaration. */
type NamedValue = PassedValue & { readonly name: Node };

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

/** The declaration a shorthand property's value resolves to, an import followed to what it names. */
function shorthandTarget<Brand>(project: ProjectView<Brand>, node: Node): TSSymbol | undefined {
  const value = must(project.shorthandValueAt(project.handle(node)));
  if (value === undefined || (value.flags & SymbolFlags.Alias) === 0) {
    return value;
  }
  const aliased = must(project.queries.aliased(value));
  return aliased.declarations.length === 0 ? undefined : aliased;
}

/**
 * The values one expression passes: each value it can be ({@link leavesOf}), or what an
 * array or object literal it can be holds, at any depth.
 */
function passedIn(written: Expression, found: PassedValue[]): void {
  for (const expression of leavesOf(written)) {
    if (isArrayLiteralExpression(expression)) {
      for (const element of expression.elements) {
        passedIn(element, found);
      }
    } else if (isObjectLiteralExpression(expression)) {
      for (const property of expression.properties) {
        if (isPropertyAssignment(property)) {
          passedIn(property.initializer, found);
        } else if (isSpreadAssignment(property)) {
          passedIn(property.expression, found);
        } else if (isShorthandPropertyAssignment(property)) {
          found.push({ site: property.name, name: property, shorthand: true });
        }
      }
    } else if (!isOmittedExpression(expression)) {
      found.push({ site: expression, name: calleeName(expression), shorthand: false });
    }
  }
}

/** The operators whose value is one of their operands. */
const CHOOSING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.QuestionQuestionToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.AmpersandAmpersandToken,
]);

/**
 * The expressions one value can be: itself, or each branch of a conditional, each operand
 * of `??`, `||` and `&&` and the last of a comma, inside any wrapper that changes no value.
 * Each is read alone because the checker reduces a union by subtype, so the type at the
 * whole drops a class structurally equal to, or a subtype of, another branch's.
 */
function leavesOf(written: Expression): readonly Expression[] {
  const expression = unwrapped(isSpreadElement(written) ? written.expression : written);
  if (isConditionalExpression(expression)) {
    return [...leavesOf(expression.whenTrue), ...leavesOf(expression.whenFalse)];
  }
  if (isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind;
    if (CHOOSING.has(operator)) {
      return [...leavesOf(expression.left), ...leavesOf(expression.right)];
    }
    if (operator === SyntaxKind.CommaToken) {
      return leavesOf(expression.right);
    }
  }
  return [expression];
}

/** The values one argument passes, a spread argument's included. */
function leavesPassed(argument: Expression): readonly PassedValue[] {
  const found: PassedValue[] = [];
  passedIn(argument, found);
  return found;
}

/** The values one argument passes that name their declaration. */
export function valuesPassed(argument: Expression): readonly NamedValue[] {
  return leavesPassed(argument).filter((value): value is NamedValue => value.name !== undefined);
}

/**
 * What one passed value holds: the declaration its name resolves to, and the classes and
 * functions the checker's type at it holds ({@link constructedAt}). `known` holds names
 * already resolved in a batch.
 */
function heldBy<Brand>(
  project: ProjectView<Brand>,
  value: PassedValue,
  known?: ReadonlyMap<Node, TSSymbol>,
): { readonly named: TSSymbol | undefined; readonly typed: readonly TSSymbol[] } {
  const { name } = value;
  if (name === undefined) {
    return { named: undefined, typed: constructedAt(project, value.site) };
  }
  if (value.shorthand) {
    return { named: shorthandTarget(project, name), typed: [] };
  }
  return {
    named: known?.get(name) ?? resolvedTargets(project, [name]).get(name),
    typed: constructedAt(project, value.site),
  };
}

/**
 * The classes of the target each call passes, by the call: each class a value an argument
 * can be holds as a constructor, as the checker types it. A name whose type erases the
 * class is followed through what its declaration binds ({@link boundTo}) and, for a
 * parameter, through what each call of its function passes at its place, so a class handed
 * to a wrapper is passed. A class is used at each value that passes it. A class of another
 * program passes nothing.
 */
export function classesPassed<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  chains: AliasChains,
  calls: readonly CallExpression[],
): ReadonlyMap<CallExpression, readonly ClassUse[]> {
  const passed = new Map(calls.map((call) => [call, call.arguments.flatMap(leavesPassed)]));
  const targets = resolvedTargets(
    project,
    [...passed.values()].flat().flatMap((value) => (value.shorthand ? [] : (value.name ?? []))),
  );
  const classes = new Set(
    held.symbols.filter((symbol) => symbol.kind === "class").map((symbol) => symbol.id),
  );
  let calling: CallsOf | undefined;
  const callsOfFunction = (symbol: TSSymbol): readonly CallExpression[] => {
    calling ??= callsByDeclaration(project);
    return symbol.declarations.flatMap((handle) => calling?.get(keyOf(handle)) ?? []);
  };
  const classesOf = (value: PassedValue, seen: Set<number>): readonly string[] => {
    const { named, typed } = heldBy(project, value, targets);
    return [
      ...typed.flatMap((symbol) => chains.declarationsOf(symbol).filter((id) => classes.has(id))),
      ...(named === undefined ? [] : reached(named, seen)),
    ];
  };
  const reached = (symbol: TSSymbol, seen: Set<number>): readonly string[] => {
    const ids = chains.declarationsOf(symbol).filter((id) => classes.has(id));
    if (ids.length > 0 || seen.has(symbol.id)) {
      return ids;
    }
    seen.add(symbol.id);
    const through = (written: Expression): readonly string[] =>
      leavesPassed(written).flatMap((value) => classesOf(value, seen));
    return symbol.declarations.flatMap((handle) => {
      const node = project.declarationAt(handle)?.node;
      if (node === undefined) {
        return [];
      }
      if (isParameterDeclaration(node)) {
        return argumentsAt(project, node, callsOfFunction).flatMap(through);
      }
      const bound = boundTo(project, node);
      return [
        ...(bound.written === undefined ? [] : through(bound.written)),
        ...bound.symbols.flatMap((next) => reached(next, seen)),
      ];
    });
  };
  return new Map(
    [...passed].map(([call, values]) => {
      const uses = new Map<string, ClassUse>();
      for (const value of values) {
        for (const id of classesOf(value, new Set())) {
          uses.set(`${id}\u0000${String(value.site.pos)}`, { id, site: value.site });
        }
      }
      return [call, [...uses.values()]];
    }),
  );
}

/**
 * The symbols of the classes and functions the checker's type at one expression holds as
 * values, each member of a union: the static side of a class or a function is an
 * anonymous type its declaration's symbol names, which an instance's type is not.
 */
function constructedAt<Brand>(project: ProjectView<Brand>, written: Node): readonly TSSymbol[] {
  return heldIn(project, must(project.queries.typeAt(unwrapped(written))));
}

/** The classes and functions one type holds as values, as {@link constructedAt} reads them. */
function heldIn<Brand>(project: ProjectView<Brand>, type: Type | undefined): readonly TSSymbol[] {
  const { queries } = project;
  return (type === undefined ? [] : must(queries.constituents(type))).flatMap((part) => {
    if (!part.isObjectType() || (part.objectFlags & ObjectFlags.Anonymous) === 0) {
      return [];
    }
    return must(queries.symbolOfType(part)) ?? [];
  });
}

/** What one declaration binds its name to: the value it writes, or the symbols it copies. */
interface Bound {
  readonly written?: Expression;
  readonly symbols: readonly TSSymbol[];
}

/**
 * What a variable, a property or a destructured binding binds its name to: a variable's
 * or a property's initializer, the value a shorthand property names, or the property of
 * the destructured value a binding element reads.
 */
function boundTo<Brand>(project: ProjectView<Brand>, node: Node): Bound {
  if (isShorthandPropertyAssignment(node)) {
    const value = shorthandTarget(project, node);
    return { symbols: value === undefined ? [] : [value] };
  }
  if (isBindingElement(node)) {
    const key = node.propertyName ?? node.name;
    if (key === undefined || !isIdentifier(key)) {
      return { symbols: [] };
    }
    const source = must(project.queries.typeAt(node.parent));
    const property =
      source === undefined
        ? undefined
        : must(project.queries.propertiesOf(source)).find((one) => one.name === key.text);
    return { symbols: property === undefined ? [] : [property] };
  }
  const written = initializerOf(node);
  return written === undefined ? { symbols: [] } : { written, symbols: [] };
}

/** The value a variable or a property declaration binds its name to, where it writes one. */
function initializerOf(node: Node): Expression | undefined {
  return isVariableDeclaration(node) || isPropertyAssignment(node) || isPropertyDeclaration(node)
    ? node.initializer
    : undefined;
}

/** The project's calls, by each declaration their callee resolves to. */
type CallsOf = ReadonlyMap<string, readonly CallExpression[]>;

/** The key of one declaration a symbol names, the same for each symbol the checker makes of it. */
function keyOf(handle: { readonly path: string; readonly index: number }): string {
  return `${handle.path}#${String(handle.index)}`;
}

/**
 * Every call of the project by the declarations its callee can be: the function or the
 * method it names, or else each function the checker's type at it holds, wherever that
 * value came from. A name is also followed through what its binding copies
 * ({@link boundTo}), which is how a call reaches a function an annotation erases.
 * Only the target's own declarations are keys, as only its own functions are asked for.
 */
function callsByDeclaration<Brand>(project: ProjectView<Brand>): CallsOf {
  const calls = callsOf(project);
  const own = project.ownPaths();
  const callees = resolvedTargets(
    project,
    calls.flatMap((call) => calleeName(call.expression) ?? []),
  );
  const named = new Map<number, readonly string[]>();
  const keysOf = (symbol: TSSymbol, seen: Set<number>): readonly string[] => {
    const known = named.get(symbol.id);
    if (known !== undefined || seen.has(symbol.id)) {
      return known ?? [];
    }
    seen.add(symbol.id);
    const keys = symbol.declarations
      .filter((handle) => own.has(handle.path))
      .flatMap((handle) => {
        const node = project.declarationAt(handle)?.node;
        const bound = node === undefined ? { symbols: [] } : boundTo(project, node);
        const copied = [
          ...bound.symbols,
          ...(bound.written === undefined ? [] : leavesPassed(bound.written)).flatMap((value) => {
            const { named: next, typed } = heldBy(project, value);
            return [...typed, ...(next === undefined ? [] : [next])];
          }),
        ];
        return [keyOf(handle), ...copied.flatMap((next) => keysOf(next, seen))];
      });
    named.set(symbol.id, keys);
    return keys;
  };
  const calleeOf = (call: CallExpression): TSSymbol | undefined => {
    const name = calleeName(call.expression);
    return name === undefined ? undefined : callees.get(name);
  };
  const declared = (call: CallExpression): boolean =>
    ((calleeOf(call)?.flags ?? 0) & (SymbolFlags.Function | SymbolFlags.Method)) !== 0;
  const typed = calls.filter((call) => !declared(call));
  const types = new Map(
    project.queries
      .typesAt(typed.map((call) => unwrapped(call.expression)))
      .map((type, index) => [typed[index], must(type)]),
  );
  const found = new Map<string, CallExpression[]>();
  for (const call of calls) {
    const callee = calleeOf(call);
    const held = [
      ...(callee === undefined ? [] : [callee]),
      ...(types.has(call) ? heldIn(project, types.get(call)) : []),
    ];
    for (const key of new Set(held.flatMap((symbol) => keysOf(symbol, new Set())))) {
      found.set(key, [...(found.get(key) ?? []), call]);
    }
  }
  return found;
}

/**
 * What each call of the function a parameter belongs to passes at the parameter's place,
 * every argument from there on for a rest parameter. The function is the one the checker's
 * type at its own declaration names, so a function with no name of its own is called too.
 * A `this` parameter takes no place, and an argument at or after a spread argument passes
 * at every place the spread's length can move it to.
 */
function argumentsAt<Brand>(
  project: ProjectView<Brand>,
  parameter: ParameterDeclaration,
  callsOfFunction: (symbol: TSSymbol) => readonly CallExpression[],
): readonly Expression[] {
  const owner = parameter.parent;
  if (
    !isFunctionDeclaration(owner) &&
    !isMethodDeclaration(owner) &&
    !isArrowFunction(owner) &&
    !isFunctionExpression(owner)
  ) {
    return [];
  }
  const calls = new Set(constructedAt(project, owner).flatMap(callsOfFunction));
  const [first] = owner.parameters;
  const erased = first !== undefined && isIdentifier(first.name) && first.name.text === "this";
  const place = owner.parameters.indexOf(parameter) - (erased ? 1 : 0);
  const rest = parameter.dotDotDotToken !== undefined;
  return [...calls].flatMap((call) => {
    let spreads = 0;
    return call.arguments.flatMap((argument, index) => {
      const spread = isSpreadElement(argument);
      const earliest = index - spreads;
      spreads += spread ? 1 : 0;
      const open = spread || earliest < index;
      const lands = open ? rest || earliest <= place : rest ? index >= place : index === place;
      return lands ? [spread ? argument.expression : argument] : [];
    });
  });
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
