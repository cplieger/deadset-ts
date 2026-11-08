/**
 * The serialization-contract class: the data members and `toJSON` of every type a value's
 * static type reaches, where the value reaches `JSON.stringify` or a call `ts.serializers`
 * names, and `toString` too where it reaches an erased parameter of a function outside the
 * analysis, or an erased property of a type the program does not declare. A function of
 * the project handing such a parameter to a destination is one, to a fixpoint, and a
 * function invoked through `call`, `apply` or `bind` is the callee.
 */

import {
  isArrowFunction,
  isAsExpression,
  isAwaitExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionLikeDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isForInStatement,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isReturnStatement,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTypeAssertion,
  isTypeLiteralNode,
  isVariableDeclaration,
  NodeFlags,
  SyntaxKind,
  type CallExpression,
  type Expression,
  type Node,
  type SourceFile,
  type SpreadAssignment,
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
import { aliasChains, type AliasChains } from "../alias-chain.ts";
import { carriedValues, valuesOf } from "../index/values.ts";
import { parenthesesRemoved } from "../unwrap.ts";
import {
  fills,
  knownElements,
  layoutOf,
  placesIn,
  spansOf,
  type Layout,
  type Placed,
  type Span,
} from "./argument-places.ts";
import type { Invocation } from "./calls.ts";
import { classMembers, memberComponent, typesAt } from "../class-members.ts";
import type { DeclarationEntry } from "../config.ts";
import {
  names,
  namesADeclaration,
  resolveEntries,
  spelledEntry,
} from "../roots/configured-declarations.ts";
import type { DetectorInput, Evidence } from "./lifecycle.ts";
import type { Inventory } from "../inventory.ts";
import { renderPosition, type Position } from "../position.ts";
import { must, Unanswerable } from "../query.ts";
import type { ProjectView } from "../session.ts";
import { erasedStores, type ErasedStores } from "./erased-stores.ts";
import type { CallSite, ParameterSite, ProjectSites } from "./sites.ts";
import {
  checkedTypes,
  CONVERSION_MEMBERS,
  CONVERSION_NAMES,
  ERASED,
  valueReach,
  type Reached,
} from "./value-reach.ts";

/** The serializer every run reads, whatever the configuration names. */
const JSON_STRINGIFY: DeclarationEntry = { global: "JSON.stringify" };

/** The method a serializer calls on a value that carries one, wherever the value goes. */
const SERIALIZED_CONVERSION = "toJSON";

/** The standard library's promise types, whose value is their one type argument. */
const PROMISES: ReadonlySet<string> = new Set(["Promise", "PromiseLike"]);

/** How deep a callee's result is searched for a type parameter: `Promise<Box<T>>` is two levels. */
const MENTION_DEPTH = 3;

/**
 * What a destination holds back of a class: its properties, or its properties and its
 * two conversion methods. The second holds back everything the first does.
 */
type Reach = "properties" | "conversions";

/** One place a function hands a parameter of its own to the argument of a call. */
interface Forwarded {
  readonly parameter: ParameterSite;
  readonly site: CallSite;
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

/** The calls of `Object` that read every own property of their argument by name. */
const ENUMERATIONS: ReadonlySet<string> = new Set([
  "keys",
  "entries",
  "values",
  "getOwnPropertyNames",
  "assign",
]);

/**
 * Whether a parameter type keeps no member name of the value it is given beyond the
 * properties it names: `unknown`, `any`, or an object type of a string index signature,
 * under which every other member of the value is held.
 */
function keepsNoName<Brand>(project: ProjectView<Brand>, type: Type): boolean {
  if ((type.flags & ERASED) !== 0) {
    return true;
  }
  if ((type.flags & TypeFlags.Object) === 0) {
    return false;
  }
  return must(project.queries.indexInfosOf(type)).some(
    (info) => (info.keyType.flags & TypeFlags.String) !== 0,
  );
}

/**
 * The parameters that keep no member name of the value they are given, as `keepsNoName`
 * reads it, and a rest parameter whose number index holds a type that keeps none, an
 * element of an array, a tuple, an array-like interface or a union or an intersection of
 * them, each by its symbol. A rest a type parameter types is left to its calls' flows.
 */
function erasedParameters<Brand>(
  project: ProjectView<Brand>,
  parameters: readonly ParameterSite[],
): ReadonlyMap<number, ParameterSite> {
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
      return keepsNoName(project, type);
    }
    const element =
      (type.flags & TypeFlags.Instantiable) === 0
        ? must(project.queries.numberIndexOf(type))
        : undefined;
    return (
      element !== undefined &&
      must(project.queries.constituents(element)).some((part) => keepsNoName(project, part))
    );
  });
  const bySymbol = new Map<number, ParameterSite>();
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

/**
 * The type any place of a signature's rest may take, the number index of the rest's type;
 * none where it has no rest or the type no number index.
 */
function restElementOf<Brand>(project: ProjectView<Brand>, signature: Signature): Type | undefined {
  const rest = must(project.queries.restTypeOf(signature));
  return rest === undefined ? undefined : must(project.queries.numberIndexOf(rest));
}

/** Whether one node is a function, whose body runs only where something calls it. */
function isFunctionNode(node: Node): boolean {
  return (
    isFunctionDeclaration(node) ||
    isFunctionExpression(node) ||
    isArrowFunction(node) ||
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node)
  );
}

/** The name a function nested in another is called by: its own, or the variable it initializes. */
function nestedName(fn: Node): string | undefined {
  if (isFunctionDeclaration(fn)) {
    return fn.name?.text;
  }
  let at = fn.parent;
  while (isParenthesizedExpression(at) || isAsExpression(at) || isSatisfiesExpression(at)) {
    at = at.parent;
  }
  return isVariableDeclaration(at) && isIdentifier(at.name) ? at.name.text : undefined;
}

/** The names one function's body writes as identifiers, other than the names its declarations bind. */
function namesWritten(fn: Node): ReadonlySet<string> {
  const found = new Set<string>();
  const visit = (node: Node): void => {
    const declares =
      (isFunctionDeclaration(node.parent) || isVariableDeclaration(node.parent)) &&
      node.parent.name === node;
    if (isIdentifier(node) && !declares) {
      found.add(node.text);
    }
    node.forEachChild(visit);
  };
  fn.forEachChild(visit);
  return found;
}

/**
 * The erased parameters their own function enumerates: one an `Object.keys`, `entries`,
 * `values`, `getOwnPropertyNames` or `assign` call takes, `Object` the standard library's,
 * or a `for…in` statement walks, which reads every property of the value by its name. A
 * nested function is read as the function's own only where its name is written in it, or
 * it has none, a callback or a function called where it is written.
 */
function enumeratedParameters<Brand>(
  project: ProjectView<Brand>,
  erased: ReadonlyMap<number, ParameterSite>,
): readonly ParameterSite[] {
  const asked: {
    readonly node: Node;
    readonly parameter: ParameterSite;
    readonly object: Node | undefined;
  }[] = [];
  for (const parameter of erased.values()) {
    const fn = parameter.name.parent.parent;
    const spelled = parameter.name.getText();
    const written = namesWritten(fn);
    const visit = (node: Node): void => {
      if (isFunctionNode(node)) {
        const name = nestedName(node);
        if (name !== undefined && !written.has(name)) {
          return;
        }
      }
      const read: Expression[] = [];
      let object: Node | undefined;
      if (isCallExpression(node)) {
        const callee = node.expression;
        if (
          isPropertyAccessExpression(callee) &&
          isIdentifier(callee.expression) &&
          callee.expression.text === "Object" &&
          ENUMERATIONS.has(callee.name.text)
        ) {
          object = callee.expression;
          // `Object.assign` reads its sources, every argument after the target.
          read.push(...node.arguments.slice(...(callee.name.text === "assign" ? [1] : [0, 1])));
        }
      } else if (isForInStatement(node)) {
        read.push(node.expression);
      }
      for (const value of read.flatMap(valuesOf)) {
        if (isIdentifier(value) && value.text === spelled) {
          asked.push({ node: value, parameter, object });
        }
      }
      node.forEachChild(visit);
    };
    fn.forEachChild(visit);
  }
  const symbols = project.symbolsAt(asked.map((one) => project.handle(one.node))).map(must);
  const objects = asked.flatMap((one) => (one.object === undefined ? [] : [one.object]));
  const own = project.ownPaths();
  const standard = new Set(
    project
      .symbolsAt(objects.map((node) => project.handle(node)))
      .map(must)
      .flatMap((symbol, at) =>
        symbol?.declarations.every((handle) => !own.has(handle.path)) === true ? [objects[at]] : [],
      ),
  );
  return [
    ...new Set(
      asked.flatMap((one, at) => {
        const symbol = symbols[at];
        return symbol !== undefined &&
          erased.get(symbol.id) === one.parameter &&
          (one.object === undefined || standard.has(one.object))
          ? [one.parameter]
          : [];
      }),
    ),
  ];
}

/** Each place a call's argument passes one of the erased parameters it can see. */
function handedOn<Brand>(
  project: ProjectView<Brand>,
  sites: ProjectSites,
  erased: ReadonlyMap<number, ParameterSite>,
): readonly Forwarded[] {
  const spellings = new Set([...erased.values()].map((parameter) => parameter.name.getText()));
  const candidates = sites.calls.flatMap((site) =>
    sites.invocations
      .of(site.call)
      .arguments.flatMap((argument, index) =>
        carriedValues(argument).flatMap((value) =>
          value.name !== undefined && spellings.has(value.name.getText())
            ? [{ site, argument: index, value: { ...value, name: value.name } }]
            : [],
        ),
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
        isObjectLiteralExpression(parenthesesRemoved(node.initializer))
      ) {
        naming.push(node.type);
      } else if (
        (isSatisfiesExpression(node) || isAsExpression(node)) &&
        isObjectLiteralExpression(parenthesesRemoved(node.expression))
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
  readonly invocation: (call: CallExpression) => Invocation;
  /** The signatures each call binds. */
  readonly bindings: Bindings;
  /**
   * The destination one argument of one call is, if it is one; with `element`, the
   * destination of that element of a spread of known length, at the one place it fills.
   */
  at(call: CallExpression, argument: number, element?: number): Destination | undefined;
  /** Whether a call can be a destination at any argument, read without a round trip. */
  mayReceive(call: CallExpression): boolean;
}

/**
 * The destinations of one project's calls. A call is one at every argument where its
 * callee is a serializer an entry names; at the arguments its resolved signature types
 * `unknown` or `any` where its callee is declared outside the analysis or only ambiently
 * with no implementation in it; and, where its callee is a function of the project, at each
 * parameter the function enumerates or hands on to a destination, holding back the widest
 * of what those hold back, settled by widening until no parameter moves.
 */
function destinations<Brand>(input: DetectorInput<Brand>, chains: AliasChains): Destinations {
  const { project, held, sites } = input;
  const queries = project.queries;
  const own = project.ownPaths();
  const named = resolveEntries(project, held, [JSON_STRINGIFY, ...input.ts.serializers]).filter(
    namesADeclaration,
  );
  const { of: invocation, callee: calleeOf } = sites.invocations;
  const erased = erasedParameters(project, sites.parameters);
  const byFunction = new Map<string, ParameterSite[]>();
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
  const bindings = callBindings(project, invocation);
  /**
   * The declarations of a callee that the declaration of a direct call's resolved
   * signature lies in, or all of them where it lies in none: a declaration merged into
   * the callee's symbol that the call does not resolve to does not decide where it runs.
   */
  const calledDeclarations = (call: CallExpression, target: TSSymbol): readonly NodeHandle[] => {
    const declaration = invocation(call).indirect
      ? undefined
      : bindings.of(call)[0]?.signature.declaration;
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
  const erasedPlaces = new Map<CallExpression, ReadonlySet<string>>();
  /**
   * Whether an argument of a call is erased: where `element` is given, that element of a
   * span of known length at the one place it fills, and otherwise at any place the
   * argument fills, in any signature the call binds. An argument no signature the call
   * binds has a place for says nothing of what it keeps, so it counts as erased.
   */
  const erasedAt = (call: CallExpression, argument: number, element?: number): boolean => {
    let erased = erasedPlaces.get(call);
    if (erased === undefined) {
      // A type parameter or an indexed access over one keeps nothing of the value where its
      // base constraint is erased or absent, unless the result names the type parameter:
      // the instantiated result is then the value's own type, handed back. A mapped type
      // over type parameters keeps nothing where any of theirs is erased, whatever the
      // result names, because the checker infers through it a copy without the class's
      // non-public members, and which keys the mapping keeps is not read.
      const erasedConstraint = (generic: Type): boolean => {
        const constraint = must(queries.baseConstraintOf(generic));
        return constraint === undefined || (constraint.flags & ERASED) !== 0;
      };
      const keepsNothing = (part: Type, result: Type | undefined): boolean => {
        const mapped = must(queries.mappedParametersOf(part));
        if (mapped.length > 0) {
          return mapped.some(erasedConstraint);
        }
        if ((part.flags & TypeFlags.Instantiable) === 0) {
          return false;
        }
        const free = part.isTypeParameter() ? part : must(queries.indexedAccessOf(part))?.object;
        if (free?.isTypeParameter() === true && result !== undefined && mentions(result, free, 0)) {
          return false;
        }
        return erasedConstraint(part);
      };
      // At a rest placement the declaration's type is its rest's element, the number index,
      // which the checker reads through the base constraint of a rest a type parameter
      // types, so an element erased there is one the declaration leaves generic.
      const unconstrained = (declared: Signature | undefined, placed: Placed): boolean => {
        if (declared === undefined) {
          return false;
        }
        const result = must(queries.returnTypeOf(declared));
        if (!placed.rest) {
          const parameter = must(queries.parameterType(declared, placed.place));
          return (parameter === undefined ? [] : must(queries.constituents(parameter))).some(
            (part) => keepsNothing(part, result),
          );
        }
        const rest = must(queries.restTypeOf(declared));
        const element = restElementOf(project, declared);
        if (rest?.isTypeParameter() === true && result !== undefined && mentions(result, rest, 0)) {
          return false;
        }
        return (
          element === undefined ||
          must(queries.constituents(element)).some(
            (part) => (part.flags & ERASED) !== 0 || keepsNothing(part, result),
          )
        );
      };
      const found = new Set<string>();
      const placedAt = new Set<string>();
      const unplaced = new Map<string, number>();
      for (const one of bindings.of(call)) {
        const asked = new Set<string>();
        for (const placed of one.placed()) {
          const { argument: at, element: given, place, uncovered, rest } = placed;
          const key = `${String(at)}:${String(given)}`;
          if (uncovered) {
            unplaced.set(key, at);
            continue;
          }
          placedAt.add(key);
          const where = `${key}:${rest ? "rest" : String(place)}`;
          if (found.has(key) || asked.has(where)) {
            continue;
          }
          asked.add(where);
          // A signature that is its own declaration, as one an indirect call binds, has its
          // rest's element judged as the declaration's alone.
          const own = rest && one.signature === one.declared;
          const parameter = own
            ? undefined
            : rest
              ? restElementOf(project, one.signature)
              : must(queries.parameterType(one.signature, place));
          if (
            (rest && !own && parameter === undefined) ||
            (parameter !== undefined && (parameter.flags & ERASED) !== 0) ||
            unconstrained(one.declared, placed)
          ) {
            found.add(key);
            found.add(String(at));
          }
        }
      }
      for (const [key, at] of unplaced) {
        if (!placedAt.has(key)) {
          found.add(key);
          found.add(String(at));
        }
      }
      erased = found;
      erasedPlaces.set(call, erased);
    }
    const span = bindings.spans(call).find((one) => one.argument === argument);
    return element === undefined || span?.open !== false
      ? erased.has(String(argument))
      : erased.has(`${String(argument)}:${String(element)}`);
  };

  const forwards = new Map<string, Reach>();
  const keyOf = (parameter: ParameterSite): string =>
    `${parameter.fn}\u0000${String(parameter.index)}`;
  const at = (
    call: CallExpression,
    argument: number,
    element?: number,
  ): Destination | undefined => {
    const target = calleeOf(call);
    if (target === undefined) {
      return undefined;
    }
    const entry = named.find((one) => names(one, target, chains));
    if (entry !== undefined) {
      return { reach: "properties", callee: spelledEntry(entry.entry, held) };
    }
    if (outside(target, true, calledDeclarations(call, target))) {
      return erasedAt(call, argument, element)
        ? {
            reach: "conversions",
            callee: invocation(call).callee.getText().replace(/\s+/gu, ""),
          }
        : undefined;
    }
    const spans = bindings.spans(call).filter((span) => span.argument === argument);
    for (const fn of chains.declarationsOf(target)) {
      const reach = (byFunction.get(fn) ?? [])
        .filter((one) => spans.some((span) => fills(span, one.index, one.rest, element)))
        .reduce<Reach | undefined>(
          (widest, one) => wider(widest, forwards.get(keyOf(one))),
          undefined,
        );
      if (reach !== undefined) {
        return { reach, callee: held.symbols.find((symbol) => symbol.id === fn)?.name ?? fn };
      }
    }
    return undefined;
  };

  for (const parameter of enumeratedParameters(project, erased)) {
    forwards.set(keyOf(parameter), "properties");
  }
  const forwarded = handedOn(project, sites, erased);
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
  return { invocation, bindings, at, mayReceive };
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
  sites: readonly CallSite[],
  to: Destinations,
  stores: ErasedStores,
): readonly Flow[] {
  const reach = valueReach(project, held, stores.inside);
  const arguments_ = sites.flatMap((site) =>
    to.mayReceive(site.call)
      ? to
          .invocation(site.call)
          .arguments.flatMap((argument, index) =>
            valuesOf(argument).flatMap((value) =>
              holdsNoInstance(value) ? [] : [{ site, argument: index, value }],
            ),
          )
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
  /**
   * The types one argument's value carries, each with the element of the argument's span
   * it fills. A spread's value is its elements, which a container other than an array does
   * not walk to, so the span's element types join. A spread of known length gives each
   * element at its own place, as does any type read for it that is a tuple of that length,
   * and every other type fills every place the argument does.
   */
  const partsOf = (
    one: (typeof arguments_)[number],
    types: readonly Type[],
  ): readonly { readonly element: number | undefined; readonly types: readonly Type[] }[] => {
    const span = to.bindings.spans(one.site.call).find((at) => at.argument === one.argument);
    const given = span?.spread === true ? span.given.filter((type) => type !== undefined) : [];
    if (span === undefined || !span.spread || span.open) {
      return [{ element: undefined, types: [...types, ...given] }];
    }
    const whole: Type[] = [];
    const elements = span.given.map((type) => (type === undefined ? [] : [type]));
    for (const type of types) {
      const known = knownElements(project, type, elements.length);
      if (known === undefined) {
        whole.push(type);
      } else {
        known.forEach((part, element) => {
          if (part !== undefined) {
            elements[element]?.push(part);
          }
        });
      }
    }
    return [
      { element: undefined, types: whole },
      ...elements.map((parts, element) => ({ element, types: parts })),
    ];
  };
  const passed = arguments_.flatMap((one, index) => {
    const type = typeOf.get(one.value);
    const self: Reached = {
      classes: new Set(
        one.value.kind === SyntaxKind.ThisKeyword && one.site.self !== undefined
          ? [one.site.self]
          : [],
      ),
      members: [],
    };
    const types = [
      ...(type === undefined ? [] : [type]),
      ...(checked[index] ?? []),
      ...(stores.ofVariable(one.value) ?? []),
    ];
    return partsOf(one, types).flatMap(({ element, types: parts }) => {
      const reached = parts.reduce<Reached>(
        (all, part) => joined(all, reach.reachedFrom(part)),
        element === undefined ? self : { classes: new Set<string>(), members: [] },
      );
      const carries = reached.classes.size > 0 || reached.members.length > 0;
      const destination = carries ? to.at(one.site.call, one.argument, element) : undefined;
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
  });
  const generic = typeParameterFlows(
    project,
    reach,
    sites,
    to.bindings,
    arguments_.flatMap((one) => {
      const type = typeOf.get(one.value);
      return partsOf(one, type === undefined ? [] : [type]).flatMap(({ element, types }) => {
        const parameters = types.flatMap((part) => typeParametersOf(project, part, 0));
        const destination =
          parameters.length === 0 ? undefined : to.at(one.site.call, one.argument, element);
        return destination === undefined
          ? []
          : parameters.map((parameter) => ({ parameter, to: destination }));
      });
    }),
  );
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
  return [...passed, ...generic, ...left];
}

/**
 * The type parameters one type names, through constituents, type arguments and the type
 * parameters a mapped type is over. A class's polymorphic `this` type is no parameter a
 * call binds: the reach walks it as its class.
 */
function typeParametersOf<Brand>(project: ProjectView<Brand>, type: Type, depth: number): Type[] {
  if (type.isTypeParameter()) {
    return type.isThisType === true ? [] : [type];
  }
  if (depth >= MENTION_DEPTH) {
    return [];
  }
  const { queries } = project;
  return [
    ...(type.isUnionType() || type.isIntersectionType() ? must(queries.constituents(type)) : []),
    ...must(queries.typeArguments(type)),
    ...must(queries.mappedParametersOf(type)),
  ].flatMap((one) => typeParametersOf(project, one, depth + 1));
}

/**
 * The type parameters one type names, by identifier: through constituents, type arguments,
 * an alias's arguments and the parameters and results of its call signatures, so a callback
 * parameter's result names the parameter its callee's result does.
 */
function namedTypeParameters<Brand>(
  project: ProjectView<Brand>,
  type: Type,
  depth: number,
): readonly number[] {
  const { queries } = project;
  const aliased = (type as { readonly aliasTypeArguments?: readonly number[] }).aliasTypeArguments;
  if (type.isTypeParameter()) {
    return [type.id];
  }
  if (depth >= MENTION_DEPTH) {
    return aliased ?? [];
  }
  return [
    ...(aliased ?? []),
    ...[
      ...(type.isUnionType() || type.isIntersectionType() ? must(queries.constituents(type)) : []),
      ...must(queries.typeArguments(type)),
      ...must(queries.signaturesOf(type, SignatureKind.Call)).flatMap((signature) => [
        ...signature.parameters.flatMap((_parameter, at) => [
          must(queries.typeAtPosition(signature, at)),
        ]),
        ...[must(queries.returnTypeOf(signature))].filter((one) => one !== undefined),
      ]),
    ].flatMap((one) => namedTypeParameters(project, one, depth + 1)),
  ];
}

/**
 * The types an instantiated type puts where a declared type names `parameter`: matched
 * through type arguments, and in a union every constituent the declared union does not
 * itself name.
 */
function bound<Brand>(
  project: ProjectView<Brand>,
  declared: Type,
  instantiated: Type,
  parameter: Type,
  depth: number,
): Type[] {
  if (declared.id === parameter.id) {
    return [instantiated];
  }
  if (depth >= MENTION_DEPTH) {
    return [];
  }
  const { queries } = project;
  // A place of a rest the parameter types is declared as an indexed access over it, and
  // what the call passes there is one element of the type it binds.
  if (must(queries.indexedAccessOf(declared))?.object.id === parameter.id) {
    return [instantiated];
  }
  if (declared.isUnionType()) {
    const parts = must(queries.constituents(declared));
    if (parts.some((part) => part.id === parameter.id)) {
      const kept = new Set(parts.map((part) => part.id));
      const given = instantiated.isUnionType()
        ? must(queries.constituents(instantiated))
        : [instantiated];
      return given.filter((part) => !kept.has(part.id));
    }
  }
  const declaredArguments = must(queries.typeArguments(declared));
  const givenArguments = must(queries.typeArguments(instantiated));
  return declaredArguments.length !== givenArguments.length
    ? []
    : declaredArguments.flatMap((one, at) => {
        const given = givenArguments[at];
        return given === undefined ? [] : bound(project, one, given, parameter, depth + 1);
      });
}

/** A declared type at a place and the type a call puts there. */
interface Placing {
  readonly from: Type;
  readonly into: Type;
}

/**
 * One signature a call binds its arguments to: the one the checker resolves for a direct
 * call, and each call signature of the value the method is read from for one through
 * `call`, `apply` or `bind`, whose resolved signature is the method's.
 */
interface Binding {
  readonly call: CallExpression;
  /** The signature whose parameter types the arguments meet. */
  readonly signature: Signature;
  /** The generic signature the call instantiates: the resolved one's, or the callee's own. */
  readonly declared: Signature | undefined;
  /** The parameter place each argument binds in `signature`. */
  readonly placed: () => readonly Placed[];
  /**
   * The declared and the instantiated type at each place an argument binds, and an open
   * rest's element type.
   */
  readonly places: () => readonly Placing[];
  /** The type arguments the call writes for the declared signature, if it writes them. */
  readonly written: readonly Node[] | undefined;
}

/** The signatures each call binds, each call read once. */
interface Bindings {
  of(call: CallExpression): readonly Binding[];
  /** Those of every call, asked of the checker in batches. */
  all(calls: readonly CallExpression[]): readonly Binding[];
  /** The places each argument of one call fills, read as `argument-places.ts` reads them. */
  spans(call: CallExpression): readonly Span[];
}

/** One value read once, at its first use. */
function once<T>(read: () => T): () => T {
  let held: { readonly value: T } | undefined;
  return () => (held ??= { value: read() }).value;
}

/**
 * The signatures a project's calls bind, and the place each argument binds in each. A
 * direct call binds the signature the checker resolves, its places taking the types the
 * checker instantiates there. Through `call`, `apply` or `bind` a call binds every call
 * signature of the function, a place taking the type of the argument that fills it: the
 * checker instantiates those methods from the arguments, not from the function's own
 * parameters, so no instantiation of them says what the function keeps.
 */
function callBindings<Brand>(
  project: ProjectView<Brand>,
  invocation: (call: CallExpression) => Invocation,
): Bindings {
  const { queries } = project;
  const known = new Map<CallExpression, readonly Binding[]>();
  const passed = new Map<CallExpression, readonly (Type | undefined)[]>();
  const spanned = new Map<CallExpression, readonly Span[]>();
  const layouts = new Map<number, Layout>();
  const valueOf = (argument: Expression): Expression =>
    isSpreadElement(argument) ? argument.expression : argument;
  // An indirect call's places take its arguments' types, and a spread's type says how
  // many places it fills; a direct call with neither reads no argument's type.
  const typed = (call: CallExpression): boolean => {
    const invoked = invocation(call);
    return invoked.indirect || invoked.arguments.some(isSpreadElement);
  };
  const typesPassed = (call: CallExpression): readonly (Type | undefined)[] => {
    let types = passed.get(call);
    if (types === undefined) {
      types = typesAt(project, invocation(call).arguments.map(valueOf));
      passed.set(call, types);
    }
    return types;
  };
  const spans = (call: CallExpression): readonly Span[] => {
    let found = spanned.get(call);
    if (found === undefined) {
      const invoked = invocation(call);
      found = spansOf(
        project,
        invoked.arguments,
        invoked.listed,
        typed(call) ? typesPassed(call) : [],
      );
      spanned.set(call, found);
    }
    return found;
  };
  const layout = (signature: Signature): Layout => {
    let found = layouts.get(signature.id);
    if (found === undefined) {
      found = layoutOf(project, signature);
      layouts.set(signature.id, found);
    }
    return found;
  };
  const distinct = (pairs: readonly Placing[]): readonly Placing[] => [
    ...new Map(
      pairs.map((pair) => [`${String(pair.from.id)}:${String(pair.into.id)}`, pair]),
    ).values(),
  ];
  // The checker infers a type parameter a mapped type is over by reversing the mapping,
  // into a copy that names no class, so at a place declared as one the value passed is
  // what each of its type parameters carries.
  const mappedFrom = (from: Type, value: Type | undefined): readonly Placing[] =>
    value === undefined
      ? []
      : must(queries.constituents(from)).flatMap((part) =>
          must(queries.mappedParametersOf(part)).map((source) => ({ from: source, into: value })),
        );
  const direct = (call: CallExpression, resolved: Signature | undefined): readonly Binding[] => {
    if (resolved === undefined) {
      return [];
    }
    const declared = must(queries.genericOf(resolved));
    const placed = once(() => placesIn(spans(call), layout(resolved)));
    const places = () => {
      if (declared === undefined) {
        return [];
      }
      return distinct(
        placed().flatMap((one) => {
          const from = one.uncovered ? undefined : must(queries.parameterType(declared, one.place));
          if (from === undefined) {
            return [];
          }
          const into = must(queries.parameterType(resolved, one.place));
          const element = one.rest ? restElementOf(project, declared) : undefined;
          const elements = one.rest ? restElementOf(project, resolved) : undefined;
          return [
            ...(into === undefined ? [] : [{ from, into }]),
            ...(element === undefined || elements === undefined
              ? []
              : [{ from: element, into: elements }]),
            ...mappedFrom(from, one.given ?? typesPassed(call)[one.argument]),
          ];
        }),
      );
    };
    return [{ call, signature: resolved, declared, placed, places, written: call.typeArguments }];
  };
  const indirect = (call: CallExpression, callee: Type | undefined): readonly Binding[] =>
    (callee === undefined ? [] : must(queries.signaturesOf(callee, SignatureKind.Call))).map(
      (signature) => {
        const placed = once(() => placesIn(spans(call), layout(signature)));
        return {
          call,
          signature,
          declared: signature,
          placed,
          places: () =>
            distinct(
              placed().flatMap(({ place, given, uncovered, rest }) => {
                const from = uncovered ? undefined : must(queries.parameterType(signature, place));
                const element = rest ? restElementOf(project, signature) : undefined;
                return from === undefined || given === undefined
                  ? []
                  : [
                      { from, into: given },
                      ...(element === undefined ? [] : [{ from: element, into: given }]),
                      ...mappedFrom(from, given),
                    ];
              }),
            ),
          written: undefined,
        };
      },
    );
  const of = (call: CallExpression): readonly Binding[] => {
    let bound = known.get(call);
    if (bound === undefined) {
      const invoked = invocation(call);
      bound = invoked.indirect
        ? indirect(call, must(queries.typeAt(invoked.callee)))
        : direct(call, must(queries.resolvedSignature(call)));
      known.set(call, bound);
    }
    return bound;
  };
  const all = (calls: readonly CallExpression[]): readonly Binding[] => {
    const asked = calls.filter((call) => !known.has(call));
    const plain = asked.filter((call) => !invocation(call).indirect);
    queries
      .resolvedSignatures(plain)
      .map(must)
      .forEach((resolved, at) => {
        const call = plain[at];
        if (call !== undefined) {
          known.set(call, direct(call, resolved));
        }
      });
    const through = asked.filter((call) => invocation(call).indirect);
    const callees = typesAt(
      project,
      through.map((call) => invocation(call).callee),
    );
    const typing = asked.filter((call) => typed(call) && !passed.has(call));
    const values = typesAt(
      project,
      typing.flatMap((call) => invocation(call).arguments.map(valueOf)),
    );
    let offset = 0;
    for (const call of typing) {
      const count = invocation(call).arguments.length;
      passed.set(call, values.slice(offset, offset + count));
      offset += count;
    }
    through.forEach((call, at) => {
      known.set(call, indirect(call, callees[at]));
    });
    return calls.flatMap(of);
  };
  return { of, all, spans };
}

/**
 * The flows a type parameter of a function of the project carries where a value its type
 * names reaches a destination: each call of the function passes its type argument there,
 * written or inferred from the arguments, and a type argument that is a type parameter
 * of the calling function is followed on to that function's calls, to a fixpoint.
 */
function typeParameterFlows<Brand>(
  project: ProjectView<Brand>,
  reach: ReturnType<typeof valueReach>,
  sites: readonly CallSite[],
  bindings: Bindings,
  pending: { readonly parameter: Type; readonly to: Destination }[],
): readonly Flow[] {
  const { queries } = project;
  let calls: ReadonlyMap<Node, readonly Binding[]> | undefined;
  const byDeclaration = (): ReadonlyMap<Node, readonly Binding[]> => {
    const found = new Map<Node, Binding[]>();
    for (const one of bindings.all(sites.map((site) => site.call))) {
      const handle = one.declared?.declaration;
      const node = handle === undefined ? undefined : project.declarationAt(handle)?.node;
      if (node !== undefined) {
        found.set(node, [...(found.get(node) ?? []), one]);
      }
    }
    return found;
  };
  const found: Flow[] = [];
  // One type parameter reaches each of its destinations, each holding back its own.
  const seen = new Set<string>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { parameter, to } = next;
    const key = `${String(parameter.id)}\u0000${to.reach}\u0000${to.callee}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const symbol = must(queries.symbolOfType(parameter));
    const [handle] = symbol?.declarations ?? [];
    const declaration = handle === undefined ? undefined : project.declarationAt(handle)?.node;
    const fn = declaration?.parent;
    if (symbol === undefined || fn === undefined || !isFunctionLikeDeclaration(fn)) {
      continue;
    }
    const index = (fn.typeParameters ?? []).findIndex((one) => one === declaration);
    if (index < 0) {
      continue;
    }
    calls ??= byDeclaration();
    for (const one of calls.get(fn) ?? []) {
      const written = one.written?.[index];
      const given =
        written === undefined
          ? one.places().flatMap(({ from, into }) => bound(project, from, into, parameter, 0))
          : typesAt(project, [written]).filter((type) => type !== undefined);
      for (const type of given) {
        const reached = reach.reachedFrom(type);
        if (reached.classes.size > 0 || reached.members.length > 0) {
          found.push({
            site: one.call,
            classes: reached.classes,
            members: reached.members,
            to,
            detail: `passed to ${to.callee} through the type parameter ${symbol.name}`,
          });
        }
        pending.push(...typeParametersOf(project, type, 0).map((one) => ({ parameter: one, to })));
      }
    }
  }
  return found;
}

/**
 * The serialization-contract detector: each data member and `toJSON` of each class,
 * interface and object type a value that reaches a destination carries, and `toString`
 * as well where the destination is outside the analysis, recorded at the argument with
 * the callee named.
 */
export function serializationContract<Brand>(input: DetectorInput<Brand>): readonly Evidence[] {
  const { project, held, sites, targetRoot } = input;
  const chains = aliasChains(project, held);
  const flows = flowsOf(
    project,
    held,
    sites.calls,
    destinations(input, chains),
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
      (name === SERIALIZED_CONVERSION ||
        (to.reach === "conversions" && CONVERSION_NAMES.has(name))));
  // The receiver reads only what the program wrote, so a data member holds while written.
  const evidence = (id: string, flags: SymbolFlags, detail: string, site: Position): Evidence =>
    (flags & SymbolFlags.Property) !== 0 && !sites.initialized.has(id)
      ? { id, detail, site, whileWritten: true }
      : { id, detail, site };
  const found: Evidence[] = [];
  for (const flow of flows) {
    const site = renderPosition(flow.site.getSourceFile(), targetRoot, flow.site.getStart());
    const { detail } = flow;
    for (const member of [...flow.classes].flatMap((id) => members.get(id) ?? [])) {
      const symbol = byId.get(member.id);
      const name = symbol === undefined ? "" : (memberComponent(symbol, byId) ?? "");
      if (holdsBack(member.flags, name, flow.to)) {
        found.push(evidence(member.id, member.flags, detail, site));
      }
    }
    for (const member of flow.members) {
      if (holdsBack(member.flags, member.name, flow.to)) {
        for (const id of chains.declarationsOf(member)) {
          found.push(evidence(id, member.flags, detail, site));
        }
      }
    }
  }
  return found;
}

/** The data members the decodes and copies of a project's production code fill. */
export interface Decoded {
  /**
   * Those a generic declared outside the analysis fills, which it may read, and those of
   * a value another call or a property types `any` or `unknown`, whose maker it cannot see.
   */
  readonly filled: readonly string[];
  /** Those a `JSON.parse` call of the standard library fills. */
  readonly parsed: readonly string[];
  /** Those a spread or `Object.assign` copies from a value whose type has a member of the name. */
  readonly copied: readonly string[];
  /** Every data member of the project, where the checker left a question unanswered. */
  readonly unanswered: readonly string[];
}

/**
 * The data members the decodes and copies of `files` fill, as {@link Decoded} names them.
 * A generic declared outside the analysis, or only ambiently, or one that reads a value
 * {@link readTypes} finds untyped as its own type parameter, fills the type that a type
 * parameter of its own no parameter names binds, where the awaited result carries that
 * type through its data members rather than only naming it, as a store's methods do: no
 * argument hands the value over, so it fills it where the analysis cannot see, and may
 * read it. Where the checker leaves a question unanswered, every data member is `unanswered`.
 */
export function decodedMembers<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  files: readonly SourceFile[],
  consumers: readonly string[],
): Decoded {
  try {
    return { ...decodedOf(project, held, files, consumers), unanswered: [] };
  } catch (error: unknown) {
    if (!(error instanceof Unanswerable)) {
      throw error;
    }
    return {
      filled: [],
      parsed: [],
      copied: [],
      unanswered: held.symbols
        .filter((symbol) => symbol.kind === "class-member" || symbol.kind === "type-member")
        .map((symbol) => symbol.id),
    };
  }
}

function decodedOf<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  files: readonly SourceFile[],
  consumers: readonly string[],
): Omit<Decoded, "unanswered"> {
  const { queries } = project;
  const own = project.ownPaths();
  const inAnalysis = (path: string): boolean =>
    own.has(path) || consumers.some((root) => path === root || path.startsWith(`${root}/`));
  const calls: CallExpression[] = [];
  const untyped: Expression[] = [];
  const spreads: SpreadAssignment[] = [];
  const noteRead = (node: Expression): void => {
    const at = readAs(node);
    if (at.tops.length > 0 || at.asserted.length > 0) {
      untyped.push(node);
    }
  };
  const visit = (node: Node): void => {
    if (isCallExpression(node)) {
      calls.push(node);
      noteRead(node);
    } else if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
      noteRead(node);
    } else if (isSpreadAssignment(node)) {
      spreads.push(node);
    }
    node.forEachChild(visit);
  };
  for (const file of files) {
    file.forEachChild(visit);
  }
  const read = readTypes(project, untyped);
  // A generic of the analysis that reads an untyped value as its own type parameter is a
  // client of what made the value, and fills what that parameter binds as an outside one does.
  const clients = new Set(read.made.flatMap((type) => (type.isTypeParameter() ? [type.id] : [])));
  const filled: { readonly carried: Type; readonly types: readonly Type[] }[] = [];
  const resolved = queries.resolvedSignatures(calls).map(must);
  for (const signature of resolved) {
    const declared =
      signature?.target === undefined ? undefined : must(queries.genericOf(signature));
    const declaration = declared?.declaration;
    const generic = declared?.typeParameters ?? [];
    if (signature === undefined || declared === undefined || generic.length === 0) {
      continue;
    }
    const node = declaration === undefined ? undefined : project.declarationAt(declaration)?.node;
    if (
      declaration === undefined ||
      (inAnalysis(declaration.path) &&
        (node === undefined || (node.flags & NodeFlags.Ambient) === 0) &&
        !generic.some((id) => clients.has(id)))
    ) {
      continue;
    }
    const result = must(queries.returnTypeOf(declared));
    const given = must(queries.returnTypeOf(signature));
    if (result === undefined || given === undefined) {
      continue;
    }
    const passed = new Set(
      declared.parameters.flatMap((_parameter, at) => {
        const type = must(queries.parameterType(declared, at));
        return type === undefined ? [] : namedTypeParameters(project, type, 0);
      }),
    );
    const types = typeParametersOf(project, result, 0)
      .filter((parameter) => generic.includes(parameter.id) && !passed.has(parameter.id))
      .flatMap((parameter) => bound(project, result, given, parameter, 0));
    if (types.length > 0) {
      filled.push({ carried: awaited(project, given), types });
    }
  }
  const copies = copiedNames(project, spreads, calls);
  if (
    filled.length === 0 &&
    read.parsed.length === 0 &&
    read.made.length === 0 &&
    copies.length === 0
  ) {
    return { filled: [], parsed: [], copied: [] };
  }
  const reach = valueReach(project, held);
  const chains = aliasChains(project, held);
  const members = (type: Type): readonly string[] => {
    const reached = reach.reachedFrom(type);
    const ofClasses = classMembers(project, held, reached.classes, "instance");
    return [
      ...[...reached.classes].flatMap((id) =>
        (ofClasses.get(id) ?? []).flatMap((member) =>
          (member.flags & SymbolFlags.Property) !== 0 ? [member.id] : [],
        ),
      ),
      ...reached.members.flatMap((member) =>
        (member.flags & SymbolFlags.Property) !== 0 ? chains.declarationsOf(member) : [],
      ),
    ];
  };
  return {
    filled: [
      ...new Set([
        ...filled.flatMap(({ carried, types }) => {
          const carries = new Set(members(carried));
          return types.flatMap((type) => members(type).filter((id) => carries.has(id)));
        }),
        ...read.made.flatMap(members),
      ]),
    ],
    parsed: [...new Set(read.parsed.flatMap(members))],
    copied: [
      ...new Set(
        copies.flatMap(({ into, names }) =>
          must(queries.constituents(into)).flatMap((part) =>
            must(queries.propertiesOf(part)).flatMap((property) =>
              (property.flags & SymbolFlags.Property) !== 0 && names.has(property.name)
                ? chains.declarationsOf(property)
                : [],
            ),
          ),
        ),
      ),
    ],
  };
}

/** Where a value is read as a type: the assertions around it, and the positions it is written in. */
interface ReadAs {
  /** The type nodes of the `as` and angle-bracket assertions around the value. */
  readonly asserted: readonly Node[];
  /** The outermost expressions whose contextual types the value is read as. */
  readonly tops: readonly Expression[];
}

/**
 * Where one value is read as a type: each `as` and angle-bracket assertion around it,
 * through parentheses, `await` and `!`, and the outermost expression unless a statement
 * of its own or the object or callee of a further access holds it. A `satisfies` check
 * is stepped through and types nothing, its expression's type being its operand's. A
 * callback's result is read as well where the call taking the callback is, which may
 * hand it on inside its result, as `map` does.
 */
function readAs(value: Expression, depth = 0): ReadAs {
  const asserted: Node[] = [];
  let at: Expression = value;
  for (;;) {
    const parent = at.parent;
    if (isAsExpression(parent) || isTypeAssertion(parent)) {
      asserted.push(parent.type);
    } else if (
      !isParenthesizedExpression(parent) &&
      !isAwaitExpression(parent) &&
      !isNonNullExpression(parent) &&
      !isSatisfiesExpression(parent)
    ) {
      break;
    }
    at = parent;
  }
  const parent = at.parent;
  const unused =
    isExpressionStatement(parent) ||
    ((isPropertyAccessExpression(parent) ||
      isElementAccessExpression(parent) ||
      isCallExpression(parent)) &&
      parent.expression === at);
  const call = depth < MENTION_DEPTH ? callTaking(at) : undefined;
  const outer = call === undefined ? undefined : readAs(call, depth + 1);
  return {
    asserted: [...asserted, ...(outer?.asserted ?? [])],
    tops: [...(unused ? [] : [at]), ...(outer?.tops ?? [])],
  };
}

/** The call one value is returned to as a callback's result, an argument of that call. */
function callTaking(value: Expression): CallExpression | undefined {
  const parent = value.parent;
  let callback: Node | undefined;
  if (isArrowFunction(parent) && parent.body === value) {
    callback = parent;
  } else if (isReturnStatement(parent)) {
    let at: Node = parent.parent;
    while (!isFunctionLikeDeclaration(at) && !isSourceFile(at)) {
      at = at.parent;
    }
    callback = isArrowFunction(at) || isFunctionExpression(at) ? at : undefined;
  }
  let at = callback?.parent;
  while (at !== undefined && isParenthesizedExpression(at)) {
    at = at.parent;
  }
  return at !== undefined && isCallExpression(at) && at.expression !== callback ? at : undefined;
}

/** The global the standard library declares one name of `JSON` or `Object` as. */
function standardGlobal(callee: Expression, global: string, name: string): Node | undefined {
  return isPropertyAccessExpression(callee) &&
    isIdentifier(callee.expression) &&
    callee.expression.text === global &&
    callee.name.text === name
    ? callee.expression
    : undefined;
}

/**
 * The types each value of `values` typed `any` or `unknown` is read as ({@link readAs}):
 * `parsed` for a `JSON.parse` call of the standard library, `made` for any other call or
 * property, whose maker the analysis cannot see. `JSON` must be the standard library's
 * global.
 */
function readTypes<Brand>(
  project: ProjectView<Brand>,
  values: readonly Expression[],
): { readonly parsed: readonly Type[]; readonly made: readonly Type[] } {
  if (values.length === 0) {
    return { parsed: [], made: [] };
  }
  const own = project.ownPaths();
  const parses = values.map((value) =>
    isCallExpression(value) ? standardGlobal(value.expression, "JSON", "parse") : undefined,
  );
  const globals = parses.flatMap((global) => (global === undefined ? [] : [global]));
  const standard = new Set(
    project
      .symbolsAt(globals.map((global) => project.handle(global)))
      .map(must)
      .flatMap((symbol, at) =>
        symbol?.declarations.every((handle) => !own.has(handle.path)) === true ? [globals[at]] : [],
      ),
  );
  // An `await` around the value reads the value it resolves to.
  const valueTypes = typesAt(
    project,
    values.map((value) => (isAwaitExpression(value.parent) ? value.parent : value)),
  );
  const sites = values.flatMap((value, at) => {
    const parse = parses[at];
    const parsed = parse !== undefined && standard.has(parse);
    const type = valueTypes[at];
    const untyped = type !== undefined && (type.flags & ERASED) !== 0;
    return parsed || untyped ? [{ ...readAs(value), parsed }] : [];
  });
  // Each type node and each outermost expression, with whether a `JSON.parse` call is read as it.
  const typed = sites.flatMap((site) =>
    site.asserted.map((node) => ({ node, parsed: site.parsed })),
  );
  const placed = sites.flatMap((site) => site.tops.map((node) => ({ node, parsed: site.parsed })));
  const read = [
    ...typesAt(
      project,
      typed.map((one) => one.node),
    ).map((type, at) => ({ type, parsed: typed[at]?.parsed })),
    ...project.queries
      .contextualTypes(placed.map((one) => one.node))
      .map(must)
      .map((type, at) => ({ type, parsed: placed[at]?.parsed })),
  ];
  const typesWhere = (parsed: boolean): Type[] =>
    read.flatMap((one) => (one.type !== undefined && one.parsed === parsed ? [one.type] : []));
  return { parsed: typesWhere(true), made: typesWhere(false) };
}

/**
 * The copies the spreads and calls of `files` make: for each spread in an object literal,
 * the type the literal is read as, and for each `Object.assign` call of the standard
 * library, its first argument's type, with the member names of the copied values' types.
 */
function copiedNames<Brand>(
  project: ProjectView<Brand>,
  spreads: readonly SpreadAssignment[],
  calls: readonly CallExpression[],
): readonly { readonly into: Type; readonly names: ReadonlySet<string> }[] {
  const own = project.ownPaths();
  const assigns = calls.flatMap((call) => {
    const global = standardGlobal(call.expression, "Object", "assign");
    const [target, ...sources] = call.arguments;
    return global === undefined || target === undefined || sources.length === 0
      ? []
      : [{ global, target, sources: sources.filter((source) => !isSpreadElement(source)) }];
  });
  const standard = project
    .symbolsAt(assigns.map((one) => project.handle(one.global)))
    .map(must)
    .map((symbol) => symbol?.declarations.every((handle) => !own.has(handle.path)) === true);
  const assigned = assigns.filter((_one, at) => standard[at] === true);
  const literals = spreads.flatMap((spread) =>
    isObjectLiteralExpression(spread.parent)
      ? [{ literal: spread.parent, source: spread.expression }]
      : [],
  );
  const contexts = project.queries.contextualTypes(literals.map((one) => one.literal)).map(must);
  const targets = typesAt(
    project,
    assigned.map((one) => one.target),
  );
  const spreadTypes = typesAt(
    project,
    literals.map((one) => one.source),
  );
  const sourceTypes = assigned.map((one) => typesAt(project, one.sources));
  const namesOf = (types: readonly (Type | undefined)[]): ReadonlySet<string> =>
    new Set(
      types.flatMap((type) =>
        type === undefined
          ? []
          : must(project.queries.propertiesOf(type)).map((property) => property.name),
      ),
    );
  const found: { readonly into: Type; readonly names: ReadonlySet<string> }[] = [];
  const add = (into: Type | undefined, names: ReadonlySet<string>): void => {
    if (into !== undefined && names.size > 0) {
      found.push({ into, names });
    }
  };
  contexts.forEach((into, at) => {
    add(into, namesOf([spreadTypes[at]]));
  });
  targets.forEach((into, at) => {
    add(into, namesOf(sourceTypes[at] ?? []));
  });
  return found;
}

/** The value a promise of the standard library resolves to, through nested promises. */
function awaited<Brand>(project: ProjectView<Brand>, type: Type): Type {
  const { queries } = project;
  let at = type;
  for (let depth = 0; depth < MENTION_DEPTH; depth += 1) {
    const symbol = must(queries.symbolOfType(at));
    const [inner] = must(queries.typeArguments(at));
    const standard =
      symbol !== undefined &&
      PROMISES.has(symbol.name) &&
      symbol.declarations.every(
        (handle) => project.program.getSourceFileMetadata(handle.path)?.isDefaultLibrary === true,
      );
    if (!standard || inner === undefined) {
      break;
    }
    at = inner;
  }
  return at;
}
