/**
 * The calls and decorators of one project that the configured classes read: what each
 * call invokes, a call through a method of `Function.prototype` included, and which of the
 * target's classes a call passes or a decorator is attached to. A class is passed by each
 * value an argument can carry ({@link carriedValues}), named directly or through
 * variables, and a decorator written as a call is a call.
 */

import {
  isArrayLiteralExpression,
  isArrowFunction,
  isBindingElement,
  isCallExpression,
  isDecorator,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isVariableDeclaration,
  type CallExpression,
  type Decorator,
  type Expression,
  type Node,
  type ParameterDeclaration,
} from "@typescript/native/ast";
import {
  ObjectFlags,
  SymbolFlags,
  type Symbol as TSSymbol,
  type Type,
} from "@typescript/native/sync";
import { resolvedTargets, type AliasChains } from "../alias-chain.ts";
import { carriedValues, nameOf, type CarriedValue } from "../index/values.ts";
import type { Inventory } from "../inventory.ts";
import { must } from "../query.ts";
import type { ProjectView } from "../session.ts";
import { parenthesesRemoved, unwrapped } from "../unwrap.ts";
import type { ProjectSites } from "./sites.ts";

/** One class of the target a call passes or a decorator is attached to, and where. */
interface ClassUse {
  /** The inventory's identifier of the class. */
  readonly id: string;
  readonly site: Node;
}

/** The callee one decorator names: its expression, or the callee of the call it writes. */
export function decoratorCallee(decorator: Decorator): Node | undefined {
  const expression = decorator.expression;
  return nameOf(isCallExpression(expression) ? expression.expression : expression);
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

/** The methods of `Function.prototype` that invoke a function with arguments of their own. */
const FUNCTION_METHODS: ReadonlySet<string> = new Set(["call", "apply", "bind"]);

/** The interfaces of the standard library that declare those methods for a function value. */
const FUNCTION_INTERFACES: ReadonlySet<string> = new Set([
  "Function",
  "CallableFunction",
  "NewableFunction",
]);

/**
 * One call as the function it invokes sees it: the expression naming that function,
 * and the argument each of its parameters binds, in order.
 */
export interface Invocation {
  readonly callee: Expression;
  readonly arguments: readonly Expression[];
  /** Whether the call reaches the callee through a method of `Function.prototype`. */
  readonly indirect: boolean;
  /** Whether the last argument is a list the parameters bind the elements of, as `apply` takes. */
  readonly listed: boolean;
}

/** A call through a method of `Function.prototype`: the method's name and the invocation. */
interface MethodForm {
  readonly method: Node;
  readonly invocation: Invocation;
}

/**
 * The invocation a call writes through a method of `Function.prototype`, read from
 * the syntax alone: `f.call(self, a)`, `f.apply(self, [a])`, `f.bind(self, a)`, which
 * passes `a` though nothing calls the bound function there, because the bound function
 * carries `a` to wherever it is called and that call is not followed, and
 * `f.bind(self, a)(b)`, which passes `b` after it. An `apply` argument
 * that is no array literal is the value of the first parameter, whose elements it
 * carries. Whether the method is the prototype's is resolution's to say.
 */
function throughMethod(call: CallExpression): MethodForm | undefined {
  const expression = parenthesesRemoved(call.expression);
  if (isPropertyAccessExpression(expression) && FUNCTION_METHODS.has(expression.name.text)) {
    const [, ...rest] = call.arguments;
    let passed: readonly Expression[] = rest;
    let listed = false;
    if (expression.name.text === "apply") {
      const list = rest[0] === undefined ? undefined : parenthesesRemoved(rest[0]);
      listed = list !== undefined && !isArrayLiteralExpression(list);
      passed = list === undefined ? [] : isArrayLiteralExpression(list) ? list.elements : [list];
    }
    return {
      method: expression.name,
      invocation: { callee: expression.expression, arguments: passed, indirect: true, listed },
    };
  }
  if (isCallExpression(expression)) {
    const bound = parenthesesRemoved(expression.expression);
    if (isPropertyAccessExpression(bound) && bound.name.text === "bind") {
      return {
        method: bound.name,
        invocation: {
          callee: bound.expression,
          arguments: [...expression.arguments.slice(1), ...call.arguments],
          indirect: true,
          listed: false,
        },
      };
    }
  }
  return undefined;
}

/** What each call of one project invokes. */
export interface Invocations {
  /** The function one call invokes and the arguments its parameters bind. */
  readonly of: (call: CallExpression) => Invocation;
  /** The declaration the invoked function's name resolves to, every alias followed. */
  readonly callee: (call: CallExpression) => TSSymbol | undefined;
}

/**
 * What each of a project's calls invokes. A call through `call`, `apply` or `bind`
 * invokes the function the method is read from only where the method is the standard
 * library's: the program's own `call` and `Reflect.apply` pass nothing on.
 */
export function invocations<Brand>(
  project: ProjectView<Brand>,
  calls: readonly CallExpression[],
): Invocations {
  const forms = new Map<CallExpression, MethodForm>();
  for (const call of calls) {
    const form = throughMethod(call);
    if (form !== undefined) {
      forms.set(call, form);
    }
  }
  const callees = resolvedTargets(project, [
    ...calls.flatMap((call) => nameOf(call.expression) ?? []),
    ...[...forms.values()].flatMap((form) => {
      const name = nameOf(form.invocation.callee);
      return name === undefined ? [form.method] : [form.method, name];
    }),
  ]);
  const standard = (method: TSSymbol): boolean =>
    method.declarations.some(
      (handle) => project.program.getSourceFileMetadata(handle.path)?.isDefaultLibrary === true,
    ) && FUNCTION_INTERFACES.has(must(project.queries.parentOf(method))?.name ?? "");
  const of = (call: CallExpression): Invocation => {
    const form = forms.get(call);
    const method = form === undefined ? undefined : callees.get(form.method);
    return form !== undefined && method !== undefined && standard(method)
      ? form.invocation
      : { callee: call.expression, arguments: call.arguments, indirect: false, listed: false };
  };
  return {
    of,
    callee: (call) => {
      const name = nameOf(of(call).callee);
      return name === undefined ? undefined : callees.get(name);
    },
  };
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
 * What one carried value holds: the declaration its name resolves to, and the classes and
 * functions the checker's type at it holds ({@link constructedAt}). `known` holds names
 * already resolved in a batch.
 */
function heldBy<Brand>(
  project: ProjectView<Brand>,
  value: CarriedValue,
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

/** The classes of the target each call passes, by the call, as {@link classesCarried} reads its invocation's arguments. */
export function classesPassed<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  chains: AliasChains,
  sites: Pick<ProjectSites, "calls" | "invocations">,
  calls: readonly CallExpression[],
): ReadonlyMap<CallExpression, readonly ClassUse[]> {
  const carried = classesCarried(
    project,
    held,
    chains,
    sites,
    calls.map((call) => sites.invocations.of(call).arguments),
  );
  return new Map(calls.map((call, at) => [call, carried[at] ?? []]));
}

/**
 * The classes of the target each group of written values carries: each class a value
 * can carry holds as a constructor, as the checker types it. A name whose type erases
 * the class is followed through what its declaration binds ({@link boundTo}) and, for a
 * parameter, through what each call of its function passes at its place, so a class
 * handed to a wrapper is passed. A class is used at each value that carries it. A class
 * of another program is carried by nothing.
 */
export function classesCarried<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  chains: AliasChains,
  sites: Pick<ProjectSites, "calls" | "invocations">,
  groups: readonly (readonly Expression[])[],
): readonly (readonly ClassUse[])[] {
  const { invocations: invoked } = sites;
  const passed = groups.map((written) => written.flatMap(carriedValues));
  const targets = resolvedTargets(
    project,
    passed.flat().flatMap((value) => (value.shorthand ? [] : (value.name ?? []))),
  );
  const classes = new Set(
    held.symbols.filter((symbol) => symbol.kind === "class").map((symbol) => symbol.id),
  );
  let calling: CallsOf | undefined;
  const callsOfFunction = (symbol: TSSymbol): readonly CallExpression[] => {
    calling ??= callsByDeclaration(
      project,
      sites.calls.map((one) => one.call),
      invoked,
    );
    return symbol.declarations.flatMap((handle) => calling?.get(keyOf(handle)) ?? []);
  };
  const classesOf = (value: CarriedValue, seen: Set<number>): readonly string[] => {
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
      carriedValues(written).flatMap((value) => classesOf(value, seen));
    return symbol.declarations.flatMap((handle) => {
      const node = project.declarationAt(handle)?.node;
      if (node === undefined) {
        return [];
      }
      if (isParameterDeclaration(node)) {
        return argumentsAt(project, node, callsOfFunction, invoked).flatMap(through);
      }
      const bound = boundTo(project, node);
      return [
        ...(bound.written === undefined ? [] : through(bound.written)),
        ...bound.symbols.flatMap((next) => reached(next, seen)),
      ];
    });
  };
  return passed.map((values) => {
    const uses = new Map<string, ClassUse>();
    for (const value of values) {
      for (const id of classesOf(value, new Set())) {
        uses.set(`${id}\u0000${String(value.site.pos)}`, { id, site: value.site });
      }
    }
    return [...uses.values()];
  });
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
 * Every call of the project by the declarations its invoked function can be: the function
 * or the method it names, or else each function the checker's type at it holds, wherever
 * that value came from. A name is also followed through what its binding copies
 * ({@link boundTo}), which is how a call reaches a function an annotation erases.
 * Only the target's own declarations are keys, as only its own functions are asked for.
 */
function callsByDeclaration<Brand>(
  project: ProjectView<Brand>,
  calls: readonly CallExpression[],
  invoked: Invocations,
): CallsOf {
  const own = project.ownPaths();
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
          ...(bound.written === undefined ? [] : carriedValues(bound.written)).flatMap((value) => {
            const { named: next, typed } = heldBy(project, value);
            return [...typed, ...(next === undefined ? [] : [next])];
          }),
        ];
        return [keyOf(handle), ...copied.flatMap((next) => keysOf(next, seen))];
      });
    named.set(symbol.id, keys);
    return keys;
  };
  const declared = (call: CallExpression): boolean =>
    ((invoked.callee(call)?.flags ?? 0) & (SymbolFlags.Function | SymbolFlags.Method)) !== 0;
  const typed = calls.filter((call) => !declared(call));
  const types = new Map(
    project.queries
      .typesAt(typed.map((call) => unwrapped(invoked.of(call).callee)))
      .map((type, index) => [typed[index], must(type)]),
  );
  const found = new Map<string, CallExpression[]>();
  for (const call of calls) {
    const callee = invoked.callee(call);
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
 * every argument from there on for a rest parameter, as the call's invocation binds them.
 * The function is the one the checker's type at its own declaration names, so a function
 * with no name of its own is called too. A `this` parameter takes no place, and an
 * argument at or after a spread argument passes at every place the spread's length can
 * move it to.
 */
function argumentsAt<Brand>(
  project: ProjectView<Brand>,
  parameter: ParameterDeclaration,
  callsOfFunction: (symbol: TSSymbol) => readonly CallExpression[],
  invoked: Invocations,
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
    return invoked.of(call).arguments.flatMap((argument, index) => {
      const spread = isSpreadElement(argument);
      const earliest = index - spreads;
      spreads += spread ? 1 : 0;
      const open = spread || earliest < index;
      const lands = open ? rest || earliest <= place : rest ? index >= place : index === place;
      return lands ? [spread ? argument.expression : argument] : [];
    });
  });
}
