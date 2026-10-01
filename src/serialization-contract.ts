/**
 * The serialization-contract class: the properties of a class whose values reach
 * `JSON.stringify` or a call `ts.serializers` names, and those and `toJSON` and
 * `toString` where a value is passed to an `unknown` or `any` parameter of a function
 * outside the analysis. A function of the project handing such a parameter of its own
 * to a destination is one, holding back what that destination does, to a fixpoint.
 */

import {
  isArrowFunction,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isSetAccessorDeclaration,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
  ModifierFlags,
  SyntaxKind,
  type CallExpression,
  type Expression,
  type Node,
  type ParameterDeclaration,
} from "@typescript/native/unstable/ast";
import {
  SymbolFlags,
  TypeFlags,
  type Symbol as TSSymbol,
  type Type,
} from "@typescript/native/unstable/sync";
import { aliasChains, type AliasChains } from "./alias-chain.ts";
import { calleeName, resolvedTargets, valuesPassed } from "./calls.ts";
import { classMembers, memberComponent, typesAt } from "./class-members.ts";
import type { DeclarationEntry } from "./config.ts";
import {
  names,
  namesADeclaration,
  resolveEntries,
  spelledEntry,
} from "./configured-declarations.ts";
import type { DetectorInput, Evidence } from "./exempt.ts";
import { nodeKey, type Inventory } from "./inventory.ts";
import { renderPosition } from "./position.ts";
import type { ProjectView } from "./session.ts";
import { valueReach } from "./value-reach.ts";

/** The serializer every run reads, whatever the configuration names. */
const JSON_STRINGIFY: DeclarationEntry = { shape: "global", global: "JSON.stringify" };

/** The methods a serializer and a formatter resolve by name on a value that left the analysis. */
const CONVERSIONS: ReadonlySet<string> = new Set(["toJSON", "toString"]);

/** The parameter types that keep nothing of the value they are given. */
const ERASED = TypeFlags.Any | TypeFlags.Unknown;

/**
 * What a destination holds back of a class: its properties, or its properties and its
 * two conversion methods. The second holds back everything the first does.
 */
type Reach = "properties" | "conversions";

/** One call of the project's own files, and the class `this` is a value of where it is written. */
interface Site {
  readonly call: CallExpression;
  readonly self: string | undefined;
}

/** One parameter of a function of the project that may hand on what it is given. */
interface Parameter {
  /** The inventory's identifier of the function's declaration. */
  readonly fn: string;
  readonly index: number;
  readonly rest: boolean;
  readonly name: Node;
}

/** One place a function hands a parameter of its own to the argument of a call. */
interface Forwarded {
  readonly parameter: Parameter;
  readonly site: Site;
  readonly argument: number;
}

/** A destination at one argument: what it holds back, and the callee a record names. */
interface Destination {
  readonly reach: Reach;
  readonly callee: string;
}

/** The wider of two reaches, where either may be absent. */
function wider(a: Reach | undefined, b: Reach | undefined): Reach | undefined {
  return a === "conversions" || b === "conversions" ? "conversions" : (a ?? b);
}

/** Whether one node declares a static member, whose `this` is the class itself. */
function isStatic(node: Node): boolean {
  const flags = (node as { readonly modifierFlags?: number }).modifierFlags ?? 0;
  return (flags & ModifierFlags.Static) !== 0;
}

/** Whether one node opens a body whose `this` is not an instance of the enclosing class. */
function resetsThis(node: Node): boolean {
  return (
    isFunctionDeclaration(node) ||
    isFunctionExpression(node) ||
    isClassStaticBlockDeclaration(node) ||
    isStatic(node) ||
    ((isMethodDeclaration(node) ||
      isGetAccessorDeclaration(node) ||
      isSetAccessorDeclaration(node)) &&
      isObjectLiteralExpression(node.parent))
  );
}

/** The parameters and declaring node of one function-like declaration of the project. */
function functionOf(
  node: Node,
): { readonly declared: Node; readonly parameters: readonly ParameterDeclaration[] } | undefined {
  if (
    isFunctionDeclaration(node) ||
    (isMethodDeclaration(node) && !isObjectLiteralExpression(node.parent))
  ) {
    return { declared: node, parameters: node.parameters };
  }
  if (
    isVariableDeclaration(node) &&
    node.initializer !== undefined &&
    (isArrowFunction(node.initializer) || isFunctionExpression(node.initializer))
  ) {
    return { declared: node, parameters: node.initializer.parameters };
  }
  return undefined;
}

/** Whether one parameter is a `this` parameter, which types `this` and binds no argument. */
function isThisParameter(parameter: ParameterDeclaration): boolean {
  return isIdentifier(parameter.name) && parameter.name.text === "this";
}

/** Whether an argument is written in a form that holds no class instance, which saves a type. */
function holdsNoInstance(argument: Expression): boolean {
  return (
    isArrowFunction(argument) ||
    isFunctionExpression(argument) ||
    isStringLiteral(argument) ||
    isNumericLiteral(argument) ||
    isNoSubstitutionTemplateLiteral(argument) ||
    argument.kind === SyntaxKind.TemplateExpression
  );
}

/** The expression an argument evaluates, through parentheses and a spread. */
function evaluated(argument: Expression): Expression {
  const value = isSpreadElement(argument) ? argument.expression : argument;
  return isParenthesizedExpression(value) ? evaluated(value.expression) : value;
}

/** What one walk of the project's own files found: its calls and its functions' parameters. */
interface Walked {
  readonly sites: readonly Site[];
  readonly parameters: readonly Parameter[];
}

/**
 * Every call of the project's own files with the class `this` stands for there, and
 * every identifier-named parameter of every function, method and function-valued
 * variable the project declares, at the position of the argument it binds.
 */
function walkProject<Brand>(project: ProjectView<Brand>, held: Inventory): Walked {
  const sites: Site[] = [];
  const parameters: Parameter[] = [];
  for (const file of project.ownSourceFiles()) {
    const visit = (node: Node, self: string | undefined): void => {
      let inner = self;
      if (isClassDeclaration(node) || isClassExpression(node)) {
        inner = held.declarations.get(nodeKey(file, node));
      } else if (resetsThis(node)) {
        inner = undefined;
      }
      if (node.kind === SyntaxKind.CallExpression) {
        sites.push({ call: node as CallExpression, self });
      }
      const fn = functionOf(node);
      const id = fn === undefined ? undefined : held.declarations.get(nodeKey(file, fn.declared));
      if (fn !== undefined && id !== undefined) {
        fn.parameters
          .filter((parameter) => !isThisParameter(parameter))
          .forEach((parameter, index) => {
            if (isIdentifier(parameter.name)) {
              parameters.push({
                fn: id,
                index,
                rest: parameter.dotDotDotToken !== undefined,
                name: parameter.name,
              });
            }
          });
      }
      node.forEachChild((child) => {
        visit(child, inner);
      });
    };
    file.forEachChild((child) => {
      visit(child, undefined);
    });
  }
  return { sites, parameters };
}

/**
 * The parameters that keep nothing of the value they are given: one typed `unknown` or
 * `any`, and a rest parameter whose elements are, each by its symbol.
 */
function erasedParameters<Brand>(
  project: ProjectView<Brand>,
  parameters: readonly Parameter[],
): ReadonlyMap<number, Parameter> {
  const types = typesAt(
    project,
    parameters.map((parameter) => parameter.name),
  );
  const erased = parameters.filter((parameter, index) => {
    const type = types[index];
    if (type === undefined) {
      return false;
    }
    if (!parameter.rest) {
      return (type.flags & ERASED) !== 0;
    }
    const [element] = type.isTypeReference() ? project.checker.getTypeArguments(type) : [];
    return element !== undefined && (element.flags & ERASED) !== 0;
  });
  const bySymbol = new Map<number, Parameter>();
  project
    .symbolsAt(erased.map((parameter) => project.handle(parameter.name)))
    .forEach((symbol, index) => {
      const parameter = erased[index];
      if (symbol !== undefined && parameter !== undefined) {
        bySymbol.set(symbol.id, parameter);
      }
    });
  return bySymbol;
}

/** Each place a call's argument passes one of the erased parameters it can see. */
function handedOn<Brand>(
  project: ProjectView<Brand>,
  sites: readonly Site[],
  erased: ReadonlyMap<number, Parameter>,
): readonly Forwarded[] {
  const spellings = new Set([...erased.values()].map((parameter) => parameter.name.getText()));
  const candidates = sites.flatMap((site) =>
    site.call.arguments.flatMap((argument, index) =>
      valuesPassed(argument)
        .filter((value) => spellings.has(value.name.getText()))
        .map((value) => ({ site, argument: index, value })),
    ),
  );
  const plain = candidates.filter((one) => !one.value.shorthand);
  const resolved = project.symbolsAt(plain.map((one) => project.handle(one.value.name)));
  const symbolOf = new Map(plain.map((one, index) => [one, resolved[index]]));
  return candidates.flatMap((one) => {
    const symbol = one.value.shorthand
      ? project.shorthandValueAt(project.handle(one.value.name))
      : symbolOf.get(one);
    const parameter = symbol === undefined ? undefined : erased.get(symbol.id);
    return parameter === undefined ? [] : [{ parameter, site: one.site, argument: one.argument }];
  });
}

/** The destination of each call's arguments, with the project's forwarding functions settled. */
interface Destinations {
  /** The destination one argument of one call is, if it is one. */
  at(call: CallExpression, argument: number): Destination | undefined;
  /** Whether a call can be a destination at any argument, read without a round trip. */
  mayReceive(call: CallExpression): boolean;
}

/**
 * The destinations of one project's calls. A call is one at every argument where its
 * callee is a serializer an entry names; at the arguments its resolved signature types
 * `unknown` or `any` where its callee is declared outside the analysis; and, where its
 * callee is a function of the project, at each parameter the function hands on to a
 * destination, holding back the widest of what those destinations hold back, which is
 * settled by widening until no parameter moves.
 */
function destinations<Brand>(
  input: DetectorInput<Brand>,
  chains: AliasChains,
  walked: Walked,
): Destinations {
  const { project, held } = input;
  const checker = project.checker;
  const own = new Set(project.ownSourceFiles().map((file) => file.fileName));
  const named = resolveEntries(project, held, [JSON_STRINGIFY, ...input.ts.serializers]).filter(
    namesADeclaration,
  );
  const callees = resolvedTargets(
    project,
    walked.sites.flatMap((site) => calleeName(site.call.expression) ?? []),
  );
  const calleeOf = (call: CallExpression): TSSymbol | undefined => {
    const name = calleeName(call.expression);
    return name === undefined ? undefined : callees.get(name);
  };
  const erased = erasedParameters(project, walked.parameters);
  const byFunction = new Map<string, Parameter[]>();
  for (const parameter of erased.values()) {
    byFunction.set(parameter.fn, [...(byFunction.get(parameter.fn) ?? []), parameter]);
  }
  const outside = (target: TSSymbol): boolean =>
    target.declarations.length > 0 &&
    target.declarations.every(
      (handle) =>
        !own.has(handle.path) &&
        !input.consumers.some((root) => handle.path === root || handle.path.startsWith(`${root}/`)),
    );
  const erasedArguments = new Map<CallExpression, ReadonlySet<number>>();
  const erasedAt = (call: CallExpression, argument: number): boolean => {
    let indexes = erasedArguments.get(call);
    if (indexes === undefined) {
      const signature = checker.getResolvedSignature(call);
      indexes = new Set(
        call.arguments.flatMap((_unused, index) => {
          const type =
            signature === undefined ? undefined : checker.getParameterType(signature, index);
          return type !== undefined && (type.flags & ERASED) !== 0 ? [index] : [];
        }),
      );
      erasedArguments.set(call, indexes);
    }
    return indexes.has(argument);
  };

  const forwards = new Map<string, Reach>();
  const keyOf = (parameter: Parameter): string => `${parameter.fn}\u0000${String(parameter.index)}`;
  const at = (call: CallExpression, argument: number): Destination | undefined => {
    const target = calleeOf(call);
    if (target === undefined) {
      return undefined;
    }
    const entry = named.find((one) => names(one, target, chains));
    if (entry !== undefined) {
      return { reach: "properties", callee: spelledEntry(entry.entry, held) };
    }
    const declared = chains.declarationsOf(target);
    if (declared.length === 0) {
      return outside(target) && erasedAt(call, argument)
        ? { reach: "conversions", callee: call.expression.getText().replace(/\s+/gu, "") }
        : undefined;
    }
    for (const fn of declared) {
      const parameter = (byFunction.get(fn) ?? []).find(
        (one) => one.index === argument || (one.rest && one.index <= argument),
      );
      const reach = parameter === undefined ? undefined : forwards.get(keyOf(parameter));
      if (reach !== undefined) {
        return { reach, callee: held.symbols.find((symbol) => symbol.id === fn)?.name ?? fn };
      }
    }
    return undefined;
  };

  const forwarded = handedOn(project, walked.sites, erased);
  for (let moved = true; moved;) {
    moved = false;
    for (const one of forwarded) {
      const key = keyOf(one.parameter);
      const before = forwards.get(key);
      const after = wider(before, at(one.site.call, one.argument)?.reach);
      if (after !== undefined && after !== before) {
        forwards.set(key, after);
        moved = true;
      }
    }
  }

  const mayReceive = (call: CallExpression): boolean => {
    const target = calleeOf(call);
    if (target === undefined) {
      return false;
    }
    const declared = chains.declarationsOf(target);
    if (named.some((one) => names(one, target, chains))) {
      return true;
    }
    if (declared.length === 0) {
      return outside(target);
    }
    return declared.some((fn) =>
      (byFunction.get(fn) ?? []).some((parameter) => forwards.has(keyOf(parameter))),
    );
  };
  return { at, mayReceive };
}

/** One argument whose value carries classes of the target into a destination. */
interface Flow {
  readonly site: Node;
  readonly classes: ReadonlySet<string>;
  readonly to: Destination;
}

/** Each argument of a call that can receive one whose value carries a class of the target. */
function flowsOf<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  sites: readonly Site[],
  to: Destinations,
): readonly Flow[] {
  const reach = valueReach(project, held);
  const arguments_ = sites.flatMap((site) =>
    to.mayReceive(site.call)
      ? site.call.arguments.flatMap((argument, index) => {
          const value = evaluated(argument);
          return holdsNoInstance(value) ? [] : [{ site, argument: index, value }];
        })
      : [],
  );
  const asked = arguments_.filter((one) => one.value.kind !== SyntaxKind.ThisKeyword);
  const types = typesAt(
    project,
    asked.map((one) => one.value),
  );
  const typeOf = new Map<Expression, Type | undefined>(
    asked.map((one, index) => [one.value, types[index]]),
  );
  return arguments_.flatMap((one) => {
    const type = typeOf.get(one.value);
    let classes: ReadonlySet<string> = new Set<string>();
    if (one.value.kind === SyntaxKind.ThisKeyword) {
      classes = new Set(one.site.self === undefined ? [] : [one.site.self]);
    } else if (type !== undefined) {
      classes = reach.classesOf(type);
    }
    const destination = classes.size === 0 ? undefined : to.at(one.site.call, one.argument);
    return destination === undefined ? [] : [{ site: one.value, classes, to: destination }];
  });
}

/**
 * The serialization-contract detector: each property of each class whose values reach
 * a destination, and the two conversion methods where the destination is outside the
 * analysis, recorded at the argument with the callee named.
 */
export function serializationContract<Brand>(input: DetectorInput<Brand>): readonly Evidence[] {
  const { project, held, targetRoot } = input;
  const walked = walkProject(project, held);
  const flows = flowsOf(
    project,
    held,
    walked.sites,
    destinations(input, aliasChains(project, held), walked),
  );
  if (flows.length === 0) {
    return [];
  }
  const members = classMembers(
    project,
    held,
    new Set(flows.flatMap((flow) => [...flow.classes])),
    "instance",
  );
  const byId = new Map(held.symbols.map((symbol) => [symbol.id, symbol]));
  const found: Evidence[] = [];
  for (const flow of flows) {
    const site = renderPosition(flow.site.getSourceFile(), targetRoot, flow.site.getStart());
    const detail = `passed to ${flow.to.callee}`;
    for (const member of [...flow.classes].flatMap((id) => members.get(id) ?? [])) {
      const symbol = byId.get(member.id);
      const isProperty = (member.flags & SymbolFlags.Property) !== 0;
      const converts =
        flow.to.reach === "conversions" &&
        (member.flags & SymbolFlags.Method) !== 0 &&
        symbol !== undefined &&
        CONVERSIONS.has(memberComponent(symbol, byId) ?? "");
      if (isProperty || converts) {
        found.push({ id: member.id, detail, site });
      }
    }
  }
  return found;
}
