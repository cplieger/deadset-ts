/**
 * The serialization-contract class: the data members and `toJSON` of every type a value's
 * static type reaches, where the value reaches `JSON.stringify` or a call `ts.serializers`
 * names, and `toString` too where it reaches an erased parameter of a function outside the
 * analysis, or an erased property of a type the program does not declare. A function of
 * the project handing such a parameter to a destination is one, to a fixpoint, and a
 * function invoked through `call`, `apply` or `bind` is the callee.
 */

import {
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isSpreadElement,
  isStringLiteral,
  isTypeLiteralNode,
  isVariableDeclaration,
  ModifierFlags,
  NodeFlags,
  SyntaxKind,
  type CallExpression,
  type Expression,
  type Node,
  type ParameterDeclaration,
} from "@typescript/native/ast";
import {
  SignatureKind,
  SymbolFlags,
  TypeFlags,
  type NodeHandle,
  type Signature,
  type Symbol as TSSymbol,
  type Type,
} from "@typescript/native/sync";
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
import { must } from "./query.ts";
import type { ProjectView } from "./session.ts";
import { erasedStores, type ErasedStores } from "./erased-stores.ts";
import { checkedTypes, CONVERSION_MEMBERS, valueReach, type Reached } from "./value-reach.ts";

/** The serializer every run reads, whatever the configuration names. */
const JSON_STRINGIFY: DeclarationEntry = { shape: "global", global: "JSON.stringify" };

/** The methods a serializer and a formatter resolve by name on a value that left the analysis. */
const CONVERSIONS: ReadonlySet<string> = new Set(["toJSON", "toString"]);

/** The method a serializer calls on a value that carries one, wherever the value goes. */
const SERIALIZED_CONVERSION = "toJSON";

/** The parameter types that keep nothing of the value they are given. */
const ERASED = TypeFlags.Any | TypeFlags.Unknown;

/** How deep a callee's result is searched for a type parameter: `Promise<Box<T>>` is two levels. */
const MENTION_DEPTH = 3;

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
interface Invocation {
  readonly callee: Expression;
  readonly arguments: readonly Expression[];
  /** Whether the call reaches the callee through a method of `Function.prototype`. */
  readonly indirect: boolean;
}

/** A call through a method of `Function.prototype`: the method's name and the invocation. */
interface MethodForm {
  readonly method: Node;
  readonly invocation: Invocation;
}

function unparenthesized(expression: Expression): Expression {
  return isParenthesizedExpression(expression)
    ? unparenthesized(expression.expression)
    : expression;
}

/**
 * The invocation a call writes through a method of `Function.prototype`, read from
 * the syntax alone: `f.call(self, a)`, `f.apply(self, [a])`, `f.bind(self, a)`, which
 * binds `a`, and `f.bind(self, a)(b)`, which passes `b` after it. An `apply` argument
 * that is no array literal is the value of the first parameter, whose elements it
 * carries. Whether the method is the prototype's is resolution's to say.
 */
function throughMethod(call: CallExpression): MethodForm | undefined {
  const expression = unparenthesized(call.expression);
  if (isPropertyAccessExpression(expression) && FUNCTION_METHODS.has(expression.name.text)) {
    const [, ...rest] = call.arguments;
    let passed: readonly Expression[] = rest;
    if (expression.name.text === "apply") {
      const list = rest[0] === undefined ? undefined : unparenthesized(rest[0]);
      passed = list === undefined ? [] : isArrayLiteralExpression(list) ? list.elements : [list];
    }
    return {
      method: expression.name,
      invocation: { callee: expression.expression, arguments: passed, indirect: true },
    };
  }
  if (isCallExpression(expression)) {
    const bound = unparenthesized(expression.expression);
    if (isPropertyAccessExpression(bound) && bound.name.text === "bind") {
      return {
        method: bound.name,
        invocation: {
          callee: bound.expression,
          arguments: [...expression.arguments.slice(1), ...call.arguments],
          indirect: true,
        },
      };
    }
  }
  return undefined;
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
    const [element] = must(project.queries.typeArguments(type));
    return element !== undefined && (element.flags & ERASED) !== 0;
  });
  const bySymbol = new Map<number, Parameter>();
  project
    .symbolsAt(erased.map((parameter) => project.handle(parameter.name)))
    .map(must)
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
  invocationOf: (call: CallExpression) => Invocation,
): readonly Forwarded[] {
  const spellings = new Set([...erased.values()].map((parameter) => parameter.name.getText()));
  const candidates = sites.flatMap((site) =>
    invocationOf(site.call).arguments.flatMap((argument, index) =>
      valuesPassed(argument)
        .filter((value) => spellings.has(value.name.getText()))
        .map((value) => ({ site, argument: index, value })),
    ),
  );
  const plain = candidates.filter((one) => !one.value.shorthand);
  const resolved = project.symbolsAt(plain.map((one) => project.handle(one.value.name))).map(must);
  const symbolOf = new Map(plain.map((one, index) => [one, resolved[index]]));
  return candidates.flatMap((one) => {
    const symbol = one.value.shorthand
      ? must(project.shorthandValueAt(project.handle(one.value.name)))
      : symbolOf.get(one);
    const parameter = symbol === undefined ? undefined : erased.get(symbol.id);
    return parameter === undefined ? [] : [{ parameter, site: one.site, argument: one.argument }];
  });
}

/**
 * The symbols of the interfaces and object types code of the analysis implements: those a
 * class's `implements` and `extends` clauses name, those an object literal is typed as by
 * a variable or property annotation or a `satisfies` or `as` expression, and every type
 * each of those extends. Read at the first call, which asks the checker.
 */
function implementedOwners<Brand>(
  project: ProjectView<Brand>,
  inAnalysis: (path: string) => boolean,
): () => ReadonlySet<number> {
  let owners: Set<number> | undefined;
  return () => {
    if (owners !== undefined) {
      return owners;
    }
    const found = new Set<number>();
    const queries = project.queries;
    const own = project.ownPaths();
    const files = [
      ...project.ownSourceFiles(),
      ...project.program
        .getSourceFileNames()
        .filter((name) => !own.has(name) && inAnalysis(name))
        .flatMap((name) => project.program.getSourceFile(name) ?? []),
    ];
    const naming: Node[] = [];
    const visit = (node: Node): void => {
      if (isClassDeclaration(node) || isClassExpression(node)) {
        naming.push(...(node.heritageClauses ?? []).flatMap((clause) => [...clause.types]));
      } else if (
        (isVariableDeclaration(node) || isPropertyDeclaration(node)) &&
        node.type !== undefined &&
        node.initializer !== undefined &&
        isObjectLiteralExpression(evaluated(node.initializer))
      ) {
        naming.push(node.type);
      } else if (
        (isSatisfiesExpression(node) || isAsExpression(node)) &&
        isObjectLiteralExpression(evaluated(node.expression))
      ) {
        naming.push(node.type);
      }
      node.forEachChild(visit);
    };
    for (const file of files) {
      file.forEachChild(visit);
    }
    const pending = typesAt(project, naming).filter((type) => type !== undefined);
    const seen = new Set<number>();
    for (let type = pending.pop(); type !== undefined; type = pending.pop()) {
      for (const part of must(queries.constituents(type))) {
        const target = must(queries.targetOf(part));
        if (!seen.has(target.id)) {
          seen.add(target.id);
          const symbol = must(queries.symbolOfType(target));
          if (symbol !== undefined) {
            found.add(symbol.id);
          }
          pending.push(...must(queries.baseTypes(target)));
        }
      }
    }
    owners = found;
    return owners;
  };
}

/** The destination of each call's arguments, with the project's forwarding functions settled. */
interface Destinations {
  /** The function one call invokes and the arguments its parameters bind. */
  invocation(call: CallExpression): Invocation;
  /** The destination one argument of one call is, if it is one. */
  at(call: CallExpression, argument: number): Destination | undefined;
  /** Whether a call can be a destination at any argument, read without a round trip. */
  mayReceive(call: CallExpression): boolean;
}

/**
 * The destinations of one project's calls. A call is one at every argument where its
 * callee is a serializer an entry names; at the arguments its resolved signature types
 * `unknown` or `any` where its callee is declared outside the analysis or only ambiently
 * with no implementation in it; and, where its callee is a function of the project, at each
 * parameter the function hands on to a destination, holding back the widest of what those
 * destinations hold back, which is settled by widening until no parameter moves.
 */
function destinations<Brand>(
  input: DetectorInput<Brand>,
  chains: AliasChains,
  walked: Walked,
): Destinations {
  const { project, held } = input;
  const queries = project.queries;
  const own = project.ownPaths();
  const named = resolveEntries(project, held, [JSON_STRINGIFY, ...input.ts.serializers]).filter(
    namesADeclaration,
  );
  const forms = new Map<CallExpression, MethodForm>();
  for (const site of walked.sites) {
    const form = throughMethod(site.call);
    if (form !== undefined) {
      forms.set(site.call, form);
    }
  }
  const callees = resolvedTargets(project, [
    ...walked.sites.flatMap((site) => calleeName(site.call.expression) ?? []),
    ...[...forms.values()].flatMap((form) => {
      const name = calleeName(form.invocation.callee);
      return name === undefined ? [form.method] : [form.method, name];
    }),
  ]);
  const erased = erasedParameters(project, walked.parameters);
  const byFunction = new Map<string, Parameter[]>();
  for (const parameter of erased.values()) {
    byFunction.set(parameter.fn, [...(byFunction.get(parameter.fn) ?? []), parameter]);
  }
  const inAnalysis = (path: string): boolean =>
    own.has(path) || input.consumers.some((root) => path === root || path.startsWith(`${root}/`));
  const implemented = implementedOwners(project, inAnalysis);
  /**
   * Whether every one of `declarations`, all of the callee's by default, is outside the
   * analysis or ambient. An ambient declaration has no body, so the code that runs is
   * outside the analysis, unless it is a member of an interface or an object type a class
   * or a typed object literal of the analysis implements; `settled` false skips that
   * question, which asks the checker.
   */
  const outside = (
    target: TSSymbol,
    settled: boolean,
    declarations: readonly NodeHandle[] = target.declarations,
  ): boolean =>
    declarations.length > 0 &&
    declarations.every((handle) => {
      if (!inAnalysis(handle.path)) {
        return true;
      }
      const node = project.declarationAt(handle)?.node;
      if (node === undefined || (node.flags & NodeFlags.Ambient) === 0) {
        return false;
      }
      if (!settled || !(isInterfaceDeclaration(node.parent) || isTypeLiteralNode(node.parent))) {
        return true;
      }
      const owner = must(queries.parentOf(target));
      return owner === undefined || !implemented().has(owner.id);
    });
  /**
   * Whether some one declaration of a callee is outside the analysis or ambient, without
   * asking the checker. A project's declaration merged into a library's symbol leaves the
   * library's beside it, so a call can still resolve to the library's.
   */
  const mayBeOutside = (target: TSSymbol): boolean =>
    target.declarations.some((handle) => outside(target, false, [handle]));
  const invocation = (call: CallExpression): Invocation => {
    const form = forms.get(call);
    const method = form === undefined ? undefined : callees.get(form.method);
    // Only the standard library's function methods pass their arguments on: the
    // program's own `call` and `Reflect.apply` invoke nothing here.
    if (
      form !== undefined &&
      method !== undefined &&
      mayBeOutside(method) &&
      FUNCTION_INTERFACES.has(must(project.queries.parentOf(method))?.name ?? "")
    ) {
      return form.invocation;
    }
    return { callee: call.expression, arguments: call.arguments, indirect: false };
  };
  const calleeOf = (call: CallExpression): TSSymbol | undefined => {
    const name = calleeName(invocation(call).callee);
    return name === undefined ? undefined : callees.get(name);
  };
  const signatures = new Map<CallExpression, Signature | undefined>();
  const resolvedOf = (call: CallExpression): Signature | undefined => {
    if (!signatures.has(call)) {
      signatures.set(call, must(queries.resolvedSignature(call)));
    }
    return signatures.get(call);
  };
  /**
   * The declarations of a callee that the declaration of a direct call's resolved
   * signature lies in, or all of them where it lies in none: a declaration merged into
   * the callee's symbol that the call does not resolve to does not decide where it runs.
   */
  const calledDeclarations = (call: CallExpression, target: TSSymbol): readonly NodeHandle[] => {
    const declaration = invocation(call).indirect ? undefined : resolvedOf(call)?.declaration;
    const signature =
      declaration === undefined ? undefined : project.declarationAt(declaration)?.node;
    if (declaration === undefined || signature === undefined) {
      return target.declarations;
    }
    const containing = target.declarations.filter((handle) => {
      const node =
        handle.path === declaration.path ? project.declarationAt(handle)?.node : undefined;
      return node !== undefined && node.pos <= signature.pos && signature.end <= node.end;
    });
    return containing.length === 0 ? target.declarations : containing;
  };
  /** Whether a type names a type parameter, through constituents, type arguments and call signatures. */
  const mentions = (type: Type, parameter: Type, depth: number): boolean => {
    // A conditional type an alias names, `Awaited<T>` among them, carries its arguments
    // only on the alias the client's type object reports.
    const aliased = (type as { readonly aliasTypeArguments?: readonly number[] })
      .aliasTypeArguments;
    if (type.id === parameter.id || aliased?.includes(parameter.id) === true) {
      return true;
    }
    if (depth >= MENTION_DEPTH) {
      return false;
    }
    const inner = [
      ...(type.isUnionType() || type.isIntersectionType() ? must(queries.constituents(type)) : []),
      ...must(queries.typeArguments(type)),
      ...must(queries.signaturesOf(type, SignatureKind.Call)).flatMap((signature) => [
        ...signature.parameters.map((_parameter, at) =>
          must(queries.typeAtPosition(signature, at)),
        ),
        ...[must(queries.returnTypeOf(signature))].filter((one) => one !== undefined),
      ]),
    ];
    return inner.some((one) => mentions(one, parameter, depth + 1));
  };
  const erasedArguments = new Map<CallExpression, ReadonlySet<number>>();
  const erasedAt = (call: CallExpression, argument: number): boolean => {
    let indexes = erasedArguments.get(call);
    if (indexes === undefined) {
      const invoked = invocation(call);
      // Through a method of the prototype the resolved signature is the method's, so
      // the parameters are read off the callee's own signatures, any one erasing.
      const type = invoked.indirect ? must(queries.typeAt(invoked.callee)) : undefined;
      const signatures = invoked.indirect
        ? type === undefined
          ? []
          : must(queries.signaturesOf(type, SignatureKind.Call))
        : [resolvedOf(call)].filter((one) => one !== undefined);
      // A type parameter of the callee that nothing constrains and its result does not name
      // keeps nothing of the value either: the instantiated signature names the value's own
      // type there instead, and a result that names it hands the value back.
      const generic = invoked.indirect ? undefined : resolvedOf(call);
      const declared = generic === undefined ? undefined : must(queries.genericOf(generic));
      const unconstrained = (index: number): boolean => {
        const parameter =
          declared === undefined ? undefined : must(queries.parameterType(declared, index));
        const parts =
          parameter === undefined
            ? []
            : parameter.isUnionType()
              ? must(queries.constituents(parameter))
              : [parameter];
        const result = declared === undefined ? undefined : must(queries.returnTypeOf(declared));
        return parts.some((part) => {
          if (!part.isTypeParameter() || (result !== undefined && mentions(result, part, 0))) {
            return false;
          }
          const constraint = must(queries.constraintOf(part));
          return constraint === undefined || (constraint.flags & ERASED) !== 0;
        });
      };
      indexes = new Set(
        invoked.arguments.flatMap((_unused, index) =>
          unconstrained(index) ||
          signatures.some((signature) => {
            const parameter = must(queries.parameterType(signature, index));
            return parameter !== undefined && (parameter.flags & ERASED) !== 0;
          })
            ? [index]
            : [],
        ),
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
    if (outside(target, true, calledDeclarations(call, target))) {
      return erasedAt(call, argument)
        ? {
            reach: "conversions",
            callee: invocation(call).callee.getText().replace(/\s+/gu, ""),
          }
        : undefined;
    }
    for (const fn of chains.declarationsOf(target)) {
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

  const forwarded = handedOn(project, walked.sites, erased, invocation);
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
    if (named.some((one) => names(one, target, chains)) || mayBeOutside(target)) {
      return true;
    }
    return chains
      .declarationsOf(target)
      .some((fn) => (byFunction.get(fn) ?? []).some((parameter) => forwards.has(keyOf(parameter))));
  };
  return { invocation, at, mayReceive };
}

/** One value that carries classes and object types of the target into a destination. */
interface Flow {
  readonly site: Node;
  readonly classes: ReadonlySet<string>;
  /** The members of the interfaces and object types the value carries. */
  readonly members: readonly TSSymbol[];
  readonly to: Destination;
  /** What a retention names the destination by. */
  readonly detail: string;
}

/** What two reaches carry together. */
function joined(a: Reached, b: Reached): Reached {
  return { classes: new Set([...a.classes, ...b.classes]), members: [...a.members, ...b.members] };
}

/** Each argument of a call that can receive one whose value carries a class of the target. */
function flowsOf<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  sites: readonly Site[],
  to: Destinations,
  stores: ErasedStores,
): readonly Flow[] {
  const reach = valueReach(project, held, stores.inside);
  const arguments_ = sites.flatMap((site) =>
    to.mayReceive(site.call)
      ? to.invocation(site.call).arguments.flatMap((argument, index) => {
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
  const checked = checkedTypes(
    project,
    arguments_.map((one) => one.value),
  );
  const passed = arguments_.flatMap((one, index) => {
    const type = typeOf.get(one.value);
    let reached: Reached = { classes: new Set<string>(), members: [] };
    if (one.value.kind === SyntaxKind.ThisKeyword) {
      reached = {
        classes: new Set(one.site.self === undefined ? [] : [one.site.self]),
        members: [],
      };
    } else if (type !== undefined) {
      reached = reach.reachedFrom(type);
    }
    for (const stored of [...(checked[index] ?? []), ...(stores.ofVariable(one.value) ?? [])]) {
      reached = joined(reached, reach.reachedFrom(stored));
    }
    const carries = reached.classes.size > 0 || reached.members.length > 0;
    const destination = carries ? to.at(one.site.call, one.argument) : undefined;
    return destination === undefined
      ? []
      : [
          {
            site: one.value,
            classes: reached.classes,
            members: reached.members,
            to: destination,
            detail: `passed to ${destination.callee}`,
          },
        ];
  });
  const left = stores.outside.flatMap((store) => {
    const reached = reach.reachedFrom(store.type);
    return reached.classes.size === 0 && reached.members.length === 0
      ? []
      : [
          {
            site: store.value,
            classes: reached.classes,
            members: reached.members,
            to: { reach: "conversions" as const, callee: store.property },
            detail: `stored in the property ${store.property} of a type the program does not declare`,
          },
        ];
  });
  return [...passed, ...left];
}

/**
 * The serialization-contract detector: each data member and `toJSON` of each class,
 * interface and object type a value that reaches a destination carries, and `toString`
 * as well where the destination is outside the analysis, recorded at the argument with
 * the callee named.
 */
export function serializationContract<Brand>(input: DetectorInput<Brand>): readonly Evidence[] {
  const { project, held, targetRoot } = input;
  const walked = walkProject(project, held);
  const chains = aliasChains(project, held);
  const flows = flowsOf(
    project,
    held,
    walked.sites,
    destinations(input, chains, walked),
    erasedStores(project),
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
  // A destination holds back a data member and `toJSON`, and `toString` as well where
  // the value left the analysis.
  const holdsBack = (flags: SymbolFlags, name: string, to: Destination): boolean =>
    (flags & SymbolFlags.Property) !== 0 ||
    ((flags & CONVERSION_MEMBERS) !== 0 &&
      (name === SERIALIZED_CONVERSION || (to.reach === "conversions" && CONVERSIONS.has(name))));
  const found: Evidence[] = [];
  for (const flow of flows) {
    const site = renderPosition(flow.site.getSourceFile(), targetRoot, flow.site.getStart());
    const { detail } = flow;
    for (const member of [...flow.classes].flatMap((id) => members.get(id) ?? [])) {
      const symbol = byId.get(member.id);
      const name = symbol === undefined ? "" : (memberComponent(symbol, byId) ?? "");
      if (holdsBack(member.flags, name, flow.to)) {
        found.push({ id: member.id, detail, site });
      }
    }
    for (const member of flow.members) {
      if (holdsBack(member.flags, member.name, flow.to)) {
        for (const id of chains.declarationsOf(member)) {
          found.push({ id, detail, site });
        }
      }
    }
  }
  return found;
}
