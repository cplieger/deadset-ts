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
  isAwaitExpression,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isElementAccessExpression,
  isExportAssignment,
  isExportSpecifier,
  isExpressionStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isForOfStatement,
  isFunctionLikeDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isImportSpecifier,
  isInferTypeNode,
  isInterfaceDeclaration,
  isMappedTypeNode,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isNewExpression,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParameterDeclaration,
  isParenthesizedExpression,
  isForInStatement,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isPropertySignatureDeclaration,
  isReturnStatement,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTypeAssertion,
  isTypeLiteralNode,
  isTypeQueryNode,
  isVariableDeclaration,
  NodeFlags,
  SyntaxKind,
  type CallExpression,
  type Expression,
  type NewExpression,
  type Node,
  type ParameterDeclaration,
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
import { carriedValues, nameOf, valuesOf } from "../index/values.ts";
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
  SERIALIZED_CONVERSION,
  valueReach,
  type Reached,
  type ValueReach,
} from "./value-reach.ts";

/** The serializer every run reads, whatever the configuration names. */
const JSON_STRINGIFY: DeclarationEntry = { global: "JSON.stringify" };

/**
 * How many steps a hand-back reads into a result; a type parameter named deeper is not
 * handed back, so the place keeps nothing and the value is held back.
 */
const MENTION_DEPTH = 3;

/** The standard library's promise types, whose value is their one type argument. */
const PROMISES: ReadonlySet<string> = new Set(["Promise", "PromiseLike"]);

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

/** Whether every constituent of each type is a primitive, which no code hands an instance back as. */
function primitive<Brand>(project: ProjectView<Brand>, types: readonly Type[]): boolean {
  return (
    types.length > 0 &&
    types.every((type) =>
      must(project.queries.constituents(type)).every(
        (part) => (part.flags & (TypeFlags.Primitive | TypeFlags.Never)) !== 0,
      ),
    )
  );
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
  /** Whether a call or `new` expression runs code outside the analysis, whose result says nothing of its arguments. */
  outside(node: CallExpression | NewExpression): boolean;
}

/**
 * The destinations of one project's calls. A call is one at every argument where its
 * callee is a serializer an entry names; at the arguments its resolved signature types
 * `unknown` or `any` where its callee is declared outside the analysis or only ambiently
 * with no implementation in it; and, where its callee is a function of the project, at each
 * parameter the function enumerates or hands on to a destination, holding back the widest
 * of what those hold back, settled by widening until no parameter moves.
 */
function destinations<Brand>(
  input: DetectorInput<Brand>,
  chains: AliasChains,
  reach: ValueReach,
): Destinations {
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
  /**
   * Whether a type names a type parameter as itself, an alias argument, a constituent, a
   * type argument or a call signature's parameter or result, within `MENTION_DEPTH`
   * steps. The members of an object type are not read: a result that holds the value in
   * one, such as an HTTP client's `Promise<{ data: T }>`, need not hand back the value.
   */
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
    const inner_ = [
      ...(type.isUnionType() || type.isIntersectionType() ? must(queries.constituents(type)) : []),
      ...must(queries.typeArguments(type)),
      ...must(queries.signaturesOf(type, SignatureKind.Call)).flatMap((signature) => [
        ...signature.parameters.map((_parameter, at) =>
          must(queries.typeAtPosition(signature, at)),
        ),
        ...[must(queries.returnTypeOf(signature))].filter((one) => one !== undefined),
      ]),
    ];
    return inner_.some((one) => mentions(one, parameter, depth + 1));
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
      // A place keeps nothing of the value where it, or a type parameter it is written over,
      // has an erased or absent base constraint, unless the result names each such type
      // parameter as `mentions` reads it, so the instantiated result hands it back. Through a
      // mapped type the checker infers a copy without the class's non-public members, so a
      // place that meets one hands nothing back, and a walk cut short keeps nothing.
      const erasedConstraint = (generic: Type): boolean => {
        const constraint = must(queries.baseConstraintOf(generic));
        return constraint === undefined || (constraint.flags & ERASED) !== 0;
      };
      const handsBack = (parameters: readonly Type[], result: Type | undefined): boolean =>
        result !== undefined && parameters.every((parameter) => mentions(result, parameter, 0));
      const keepsNothing = (part: Type, result: Type | undefined): boolean => {
        const over = reach.writtenOver(part);
        if (!over.complete) {
          return true;
        }
        const whole = (part.flags & TypeFlags.Instantiable) !== 0 && erasedConstraint(part);
        const erased = whole ? over.parameters : over.parameters.filter(erasedConstraint);
        if (!whole && erased.length === 0) {
          return false;
        }
        return over.mapped || !handsBack(erased, result);
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
        if (rest?.isTypeParameter() === true && handsBack([rest], result)) {
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
  const outsideOf = (node: CallExpression | NewExpression): boolean => {
    if (isCallExpression(node)) {
      const target = calleeOf(node);
      return target !== undefined && outside(target, true, calledDeclarations(node, target));
    }
    const name = nameOf(node.expression);
    let [symbol] = name === undefined ? [] : project.symbolsAt([project.handle(name)]).map(must);
    if (symbol !== undefined && (symbol.flags & SymbolFlags.Alias) !== 0) {
      symbol = must(queries.aliased(symbol));
    }
    return symbol !== undefined && outside(symbol, true);
  };
  return { invocation, bindings, at, mayReceive, outside: outsideOf };
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

/** What a type that names nothing of the target carries. */
const NOTHING: Reached = {
  classes: new Set(),
  members: [],
  named: new Set(),
  concrete: true,
  parameters: [],
};

/** What two reaches carry together. */
function joined(a: Reached, b: Reached): Reached {
  return {
    classes: new Set([...a.classes, ...b.classes]),
    members: [...a.members, ...b.members],
    named: new Set([...a.named, ...b.named]),
    concrete: a.concrete && b.concrete,
    parameters: [...a.parameters, ...b.parameters],
  };
}

/** Whether a reach holds back anything of the target. */
function carries(reached: Reached): boolean {
  return reached.classes.size > 0 || reached.members.length > 0;
}

/** A flow whose value's type is not concrete, which gathers what flows into the value. */
interface Gathered extends Flow {
  readonly classes: Set<string>;
  readonly members: TSSymbol[];
}

/**
 * One value whose own type is read for what flows into a gathered flow: the value's own
 * classes, or, where `inside`, those of the values it holds, which a member read from it
 * can be.
 */
interface Inflow {
  readonly into: Gathered;
  readonly value: Expression;
  readonly inside: boolean;
}

/** A type parameter a value at a destination is written over, and the site of that value. */
interface Pending {
  readonly parameter: Type;
  readonly to: Destination;
  readonly site: Node;
}

/** The expression a value is, through parentheses, `!`, `await`, assertions and `satisfies`. */
function inner(value: Expression): Expression {
  let at = value;
  while (
    isParenthesizedExpression(at) ||
    isNonNullExpression(at) ||
    isAwaitExpression(at) ||
    isAsExpression(at) ||
    isSatisfiesExpression(at) ||
    isTypeAssertion(at)
  ) {
    at = at.expression;
  }
  return at;
}

/** The value of an argument, a spread's operand for a spread. */
function spreadless(argument: Expression): Expression {
  return isSpreadElement(argument) ? argument.expression : argument;
}

/** The expressions one function's body returns, its nested functions' aside. */
function returnsOf(fn: Node): readonly Expression[] {
  if (isArrowFunction(fn) && fn.body.kind !== SyntaxKind.Block) {
    return [fn.body];
  }
  const found: Expression[] = [];
  const visit = (node: Node): void => {
    if (isReturnStatement(node) && node.expression !== undefined) {
      found.push(node.expression);
    }
    if (!isFunctionNode(node)) {
      node.forEachChild(visit);
    }
  };
  if (isFunctionLikeDeclaration(fn)) {
    fn.body?.forEachChild(visit);
  }
  return found;
}

/** The name a method or a property declares, by which an interface or a base class dispatches to it. */
function memberName(node: Node): string | undefined {
  const name =
    isMethodDeclaration(node) ||
    isMethodSignatureDeclaration(node) ||
    isPropertySignatureDeclaration(node) ||
    isPropertyDeclaration(node) ||
    isPropertyAssignment(node)
      ? node.name
      : undefined;
  return name !== undefined && isIdentifier(name) ? name.text : undefined;
}

/** The `this` parameter one function declares, if it declares one. */
function thisParameterOf(fn: Node): ParameterDeclaration | undefined {
  const [first] = isFunctionLikeDeclaration(fn) ? fn.parameters : [];
  return first !== undefined && isIdentifier(first.name) && first.name.text === "this"
    ? first
    : undefined;
}

/** The node a function is written at, through parentheses and assertions around it. */
function writtenAt(fn: Node): Node {
  let at = fn;
  while (
    isParenthesizedExpression(at.parent) ||
    isAsExpression(at.parent) ||
    isSatisfiesExpression(at.parent)
  ) {
    at = at.parent;
  }
  return at;
}

/** Where one function of the project is read as a value other than a call's callee. */
interface Passed {
  /** The calls it is an argument of, which hand it what they hold. */
  readonly to: readonly (CallExpression | NewExpression)[];
  /** Whether it is read any other way, so the values it is called with cannot be read. */
  readonly loose: boolean;
}

/** The calls that can run each function of the project. */
interface FunctionCalls {
  /**
   * The bindings of the calls that resolve to a function and, for a method or a property,
   * to any member of its name, through which an interface or a base class dispatches.
   */
  of(fn: Node): readonly Binding[];
  passed(fn: Node): Passed;
  /** The value a call passes as `this`: its callee's object, or the first argument `call`, `apply` or `bind` takes. */
  receiver(call: CallExpression | NewExpression): Expression | undefined;
}

/** The methods of `Function.prototype` that call a function with the `this` they are given. */
const RECEIVING: ReadonlySet<string> = new Set(["call", "apply", "bind"]);

/** The calls of one project's functions, read from the bindings of its call sites. */
function functionCalls<Brand>(
  project: ProjectView<Brand>,
  sites: readonly CallSite[],
  to: Destinations,
): FunctionCalls {
  let direct: Map<Node, Binding[]> | undefined;
  let byName: Map<string, Binding[]> | undefined;
  let spelled: Map<string, Node[]> | undefined;
  const passedOf = new Map<Node, Passed>();
  const own = project.ownPaths();
  const index = (): void => {
    direct = new Map();
    byName = new Map();
    for (const one of to.bindings.all(sites.map((site) => site.call))) {
      const handle = (one.declared ?? one.signature).declaration;
      const node = handle === undefined ? undefined : project.declarationAt(handle)?.node;
      if (handle === undefined || node === undefined) {
        continue;
      }
      const atNode = direct.get(node) ?? [];
      atNode.push(one);
      direct.set(node, atNode);
      const name = memberName(node);
      if (name !== undefined && own.has(handle.path)) {
        const atName = byName.get(name) ?? [];
        atName.push(one);
        byName.set(name, atName);
      }
    }
  };
  /** The member a function is written as: itself, or the property its value initializes. */
  const memberOf = (fn: Node): Node => {
    const at = writtenAt(fn);
    return isPropertyAssignment(at.parent) || isPropertyDeclaration(at.parent) ? at.parent : fn;
  };
  /** The name a function is read by: its own, its variable's, or its member's. */
  const nameNode = (fn: Node): Node | undefined => {
    if (isFunctionDeclaration(fn) || isMethodDeclaration(fn)) {
      return fn.name;
    }
    const at = writtenAt(fn).parent;
    return isVariableDeclaration(at) || isPropertyAssignment(at) || isPropertyDeclaration(at)
      ? at.name
      : undefined;
  };
  const role = (
    reference: Node,
  ): "callee" | "ignored" | CallExpression | NewExpression | "loose" => {
    let at = reference;
    if (isPropertyAccessExpression(at.parent) && at.parent.name === at) {
      at = at.parent;
    }
    const parent = at.parent;
    if (isCallExpression(parent) && parent.expression === at) {
      return "callee";
    }
    if (
      isPropertyAccessExpression(parent) &&
      parent.expression === at &&
      RECEIVING.has(parent.name.text)
    ) {
      return "callee";
    }
    if (
      (isBinaryExpression(parent) &&
        parent.left === at &&
        parent.operatorToken.kind === SyntaxKind.EqualsToken) ||
      isExportSpecifier(parent) ||
      isExportAssignment(parent) ||
      isTypeQueryNode(parent) ||
      isImportSpecifier(parent)
    ) {
      return "ignored";
    }
    if (
      (isCallExpression(parent) || isNewExpression(parent)) &&
      (parent.arguments ?? []).some((argument) => argument === at)
    ) {
      return parent;
    }
    return "loose";
  };
  return {
    of: (fn) => {
      if (direct === undefined || byName === undefined) {
        index();
      }
      const name = memberName(memberOf(fn));
      return [
        ...new Set([
          ...(direct?.get(fn) ?? []),
          ...(name === undefined ? [] : (byName?.get(name) ?? [])),
        ]),
      ];
    },
    passed: (fn) => {
      const known = passedOf.get(fn);
      if (known !== undefined) {
        return known;
      }
      const at = writtenAt(fn);
      const found: { to: (CallExpression | NewExpression)[]; loose: boolean } = {
        to: [],
        loose: false,
      };
      if (
        (isArrowFunction(fn) || isFunctionExpression(fn)) &&
        !isVariableDeclaration(at.parent) &&
        !isPropertyAssignment(at.parent) &&
        !isPropertyDeclaration(at.parent)
      ) {
        const where = role(at);
        if (where === "loose") {
          found.loose = true;
        } else if (typeof where !== "string") {
          found.to.push(where);
        }
      }
      const pendingNames: Node[] = [];
      const name = nameNode(fn);
      if (name !== undefined && isIdentifier(name)) {
        pendingNames.push(name);
      }
      const visited = new Set<Node>();
      for (let next = pendingNames.pop(); next !== undefined; next = pendingNames.pop()) {
        if (!isIdentifier(next) || visited.has(next)) {
          continue;
        }
        visited.add(next);
        const self_ = next;
        if (spelled === undefined) {
          const all = new Map<string, Node[]>();
          const visit = (node: Node): void => {
            if (isIdentifier(node)) {
              const spelledAs = all.get(node.text) ?? [];
              spelledAs.push(node);
              all.set(node.text, spelledAs);
            }
            node.forEachChild(visit);
          };
          for (const file of project.ownSourceFiles()) {
            file.forEachChild(visit);
          }
          spelled = all;
        }
        const member =
          self_ === name &&
          memberName(memberOf(fn)) !== undefined &&
          !isVariableDeclaration(at.parent);
        const references = (spelled.get(self_.text) ?? []).filter((one) => one !== self_);
        // A member is read through any object of any type, so every reference of its name counts.
        const read = member
          ? references.filter(
              (one) => isPropertyAccessExpression(one.parent) && one.parent.name === one,
            )
          : (() => {
              const symbols = project
                .symbolsAt([self_, ...references].map((one) => project.handle(one)))
                .map(must);
              const [self] = symbols;
              return references.filter((_one, at) => {
                const symbol = symbols[at + 1];
                return self !== undefined && symbol?.id === self.id;
              });
            })();
        for (const reference of read) {
          const where = role(reference);
          const holder = reference.parent;
          if (
            isVariableDeclaration(holder) &&
            holder.initializer !== undefined &&
            parenthesesRemoved(holder.initializer) === reference
          ) {
            pendingNames.push(holder.name);
          } else if (isImportSpecifier(holder)) {
            pendingNames.push(holder.name);
          } else if (where === "loose") {
            found.loose = true;
          } else if (typeof where !== "string") {
            found.to.push(where);
          }
        }
      }
      passedOf.set(fn, found);
      return found;
    },
    receiver: (call) => {
      if (isNewExpression(call)) {
        return undefined;
      }
      const callee = parenthesesRemoved(call.expression);
      if (isPropertyAccessExpression(callee) && RECEIVING.has(callee.name.text)) {
        return callee.name.text === "bind" ? undefined : call.arguments[0];
      }
      if (isCallExpression(callee)) {
        const bound = parenthesesRemoved(callee.expression);
        if (isPropertyAccessExpression(bound) && bound.name.text === "bind") {
          return callee.arguments[0];
        }
      }
      const object = inner(to.invocation(call).callee);
      return isPropertyAccessExpression(object) || isElementAccessExpression(object)
        ? object.expression
        : undefined;
    },
  };
}

/**
 * The flows of one project's values into destinations: each argument a destination receives,
 * each value stored where a type of another program erases it, and, where the value's type
 * is not concrete (`references-ts.41`), what flows into it and what binds the type
 * parameters it is written over.
 */
function flowsOf<Brand>(
  project: ProjectView<Brand>,
  sites: readonly CallSite[],
  to: Destinations,
  stores: ErasedStores,
  reach: ValueReach,
): readonly Flow[] {
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
  // `this` in a member of a held class is a value of its class; elsewhere the checker types it.
  const ofClass = (one: (typeof arguments_)[number]): boolean =>
    one.value.kind === SyntaxKind.ThisKeyword && one.site.self !== undefined;
  const asked = arguments_.filter((one) => !ofClass(one));
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

  const flows: Flow[] = [];
  const inflows: Inflow[] = [];
  const pending: Pending[] = [];
  /**
   * One value reaching `destination`. Where its type is not concrete, the flow holds back
   * every class the type names, and those of what flows into `value` and of what binds its
   * type parameters as well.
   */
  const place = (
    site: Node,
    reached: Reached,
    destination: Destination,
    detail: string,
    value: Expression | undefined,
  ): void => {
    if (reached.concrete) {
      if (carries(reached)) {
        flows.push({ site, ...reached, to: destination, detail });
      }
      return;
    }
    const into: Gathered = {
      site,
      classes: new Set(reached.named),
      members: [...reached.members],
      to: destination,
      detail,
    };
    flows.push(into);
    pending.push(...reached.parameters.map((parameter) => ({ parameter, to: destination, site })));
    if (value !== undefined) {
      inflows.push({ into, value, inside: false });
    }
  };
  /** Whether a value is the result of code outside the analysis, which its type does not describe. */
  const fromOutside = (value: Expression): boolean => {
    const at = inner(value);
    return (isCallExpression(at) || isNewExpression(at)) && to.outside(at);
  };

  arguments_.forEach((one, index) => {
    const type = typeOf.get(one.value);
    const types = [
      ...(type === undefined ? [] : [type]),
      ...(checked[index] ?? []),
      ...(stores.ofVariable(one.value) ?? []),
    ];
    const outside = fromOutside(one.value) && !primitive(project, types);
    for (const { element, types: parts } of partsOf(one, types)) {
      const self =
        element === undefined && ofClass(one) && one.site.self !== undefined
          ? reach.instanceOf(one.site.self)
          : NOTHING;
      const made = isNewExpression(inner(one.value));
      const read = parts.reduce<Reached>(
        (all, part) => joined(all, made ? reach.exactly(part) : reach.reachedFrom(part)),
        self,
      );
      const reached = outside ? { ...read, concrete: false } : read;
      const destination =
        carries(reached) || !reached.concrete
          ? to.at(one.site.call, one.argument, element)
          : undefined;
      if (destination !== undefined) {
        place(one.value, reached, destination, `passed to ${destination.callee}`, one.value);
      }
    }
  });
  for (const store of stores.outside) {
    const read = reach.reachedFrom(store.type);
    place(
      store.value,
      fromOutside(store.value) && !primitive(project, [store.type])
        ? { ...read, concrete: false }
        : read,
      { reach: "conversions", callee: store.property },
      `stored in the property ${store.property} of a type the program does not declare`,
      store.value,
    );
  }
  const calls = functionCalls(project, sites, to);
  const read = inflowReader(project, reach, to, pending, stores, calls);
  const bind = parameterBinder(project, reach, to, place, stores, calls);
  while (inflows.length > 0 || pending.length > 0) {
    read(inflows.splice(0));
    bind(pending.splice(0));
  }
  return flows;
}

/**
 * Reads, a batch at a time, the values that flow into each gathered flow's value, as
 * `references-ts.41` lists them, each read again where its own type is not concrete, and
 * what the `toJSON` of each class the flow holds returns. An argument a destination of
 * its own receives, holding back as much, is left to that flow.
 */
function inflowReader<Brand>(
  project: ProjectView<Brand>,
  reach: ValueReach,
  to: Destinations,
  pending: Pending[],
  stores: ErasedStores,
  calls: FunctionCalls,
): (batch: readonly Inflow[]) => void {
  const { queries } = project;
  const generic = new Map<ParameterDeclaration, boolean>();
  /**
   * The values the calls of a function pass at one of its parameters, `this` included. A
   * parameter written over a type parameter is read where the binder binds it, and an
   * argument a destination of its own receives, holding back as much as `reach`, is left
   * to that flow.
   */
  const passedAt = (parameter: ParameterDeclaration, reach_: Reach): readonly Expression[] => {
    let named = generic.get(parameter);
    if (named === undefined) {
      const [type] = typesAt(project, [parameter.name]);
      named = type !== undefined && reach.reachedFrom(type).parameters.length > 0;
      generic.set(parameter, named);
    }
    if (named) {
      return [];
    }
    const fn = parameter.parent;
    const self = thisParameterOf(fn);
    const position = (isFunctionLikeDeclaration(fn) ? [...fn.parameters] : []).indexOf(parameter);
    const found: Expression[] = [];
    for (const one of calls.of(fn)) {
      if (parameter === self) {
        const receiver = calls.receiver(one.call);
        found.push(...(receiver === undefined ? [] : [receiver]));
        continue;
      }
      const at = position - (self === undefined ? 0 : 1);
      const args = to.invocation(one.call).arguments;
      for (const placed of one.placed()) {
        const argument = args[placed.argument];
        const own = to.at(one.call, placed.argument)?.reach;
        if (
          argument !== undefined &&
          !placed.uncovered &&
          (placed.place === at || (placed.rest && placed.place <= at)) &&
          (own === undefined || wider(own, reach_) !== own)
        ) {
          found.push(spreadless(argument));
        }
      }
    }
    for (const call of calls.passed(fn).to) {
      const receiver = calls.receiver(call);
      found.push(
        ...(receiver === undefined ? [] : [receiver]),
        ...(call.arguments ?? []).filter((argument) => writtenAt(fn) !== argument).map(spreadless),
      );
    }
    return found;
  };
  /** What one vertex holds back, and the vertices it reads further where its type is not concrete. */
  interface Info {
    readonly named: Set<string>;
    readonly members: TSSymbol[];
    readonly parameters: Type[];
    readonly follow: boolean;
    next: string[] | undefined;
  }
  /** One value read in one mode for the reach of the flow it joins. */
  interface Vertex {
    readonly value: Expression;
    readonly inside: boolean;
    readonly reach: Reach;
    /**
     * The type parameters of the function a call returned the value from, which that
     * call's own type instantiates, so they bind nothing further here.
     */
    readonly bound: readonly number[];
  }
  const infos = new Map<string, Info>();
  const keyOf = (vertex: Vertex): string =>
    `${vertex.value.getSourceFile().fileName}:${String(vertex.value.pos)}:${String(vertex.value.end)}:${String(vertex.inside)}:${vertex.reach}:${vertex.bound.join(",")}`;
  const join = (info: Info, reached: Reached, follow: boolean): void => {
    for (const id of reached.named) {
      info.named.add(id);
    }
    if (follow) {
      info.parameters.push(...reached.parameters);
    } else {
      info.members.push(...reached.members);
    }
  };
  const infoOf = (vertex: Vertex, type: Type | undefined): Info => {
    if (type === undefined) {
      return { named: new Set(), members: [], parameters: [], follow: false, next: undefined };
    }
    const value = inner(vertex.value);
    const own = isNewExpression(value)
      ? reach.exactly(type, vertex.bound)
      : reach.reachedFrom(type, vertex.bound);
    const outside =
      (isCallExpression(value) || isNewExpression(value)) &&
      to.outside(value) &&
      !primitive(project, [type]);
    const follow = !own.concrete || outside;
    const held = vertex.inside ? reach.heldBy(type, vertex.bound) : own;
    const info: Info = {
      named: new Set(held.named),
      members: follow ? [] : [...held.members],
      parameters: follow ? [...own.parameters] : [],
      follow,
      next: undefined,
    };
    return info;
  };
  /** The vertices each of `vertices` reads, its stored types joined into its own info. */
  const successors = (vertices: readonly Vertex[]): readonly (readonly Vertex[])[] => {
    const found = vertices.map((): Vertex[] => []);
    const named: { readonly at: number; readonly value: Node; readonly shorthand: boolean }[] = [];
    vertices.forEach((vertex, at) => {
      const { inside, reach: held } = vertex;
      const push = (one: Expression, deeper = inside, bound = vertex.bound): void => {
        found[at]?.push({ value: one, inside: deeper, reach: held, bound });
      };
      for (const value of valuesOf(vertex.value).map(inner)) {
        if (isCallExpression(value)) {
          const invoked = to.invocation(value);
          const ran = to.bindings.of(value).flatMap((binding) => {
            const declared = binding.declared ?? binding.signature;
            const handle = declared.declaration;
            const fn = handle === undefined ? undefined : project.declarationAt(handle)?.node;
            return fn !== undefined && isFunctionLikeDeclaration(fn) && fn.body !== undefined
              ? [{ fn, own: declared.typeParameters ?? [] }]
              : [];
          });
          const outside = to.outside(value);
          // A function of the project hands back what it returns; code with no body the
          // analysis reads may hand back any value it is given.
          if (outside || ran.length === 0) {
            invoked.arguments.forEach((argument, index) => {
              const own = to.at(value, index)?.reach;
              if (own === undefined || wider(own, held) !== own) {
                push(spreadless(argument));
              }
            });
          }
          for (const { fn, own } of ran) {
            for (const returned of returnsOf(fn)) {
              push(
                returned,
                inside,
                [...new Set([...vertex.bound, ...own])].sort((a, b) => a - b),
              );
            }
          }
          if (outside) {
            const callee = inner(invoked.callee);
            if (
              (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) &&
              callee.expression.kind !== SyntaxKind.ThisKeyword
            ) {
              push(callee.expression);
            }
            for (const argument of invoked.arguments) {
              const fn = inner(argument);
              if (isArrowFunction(fn) || isFunctionExpression(fn)) {
                for (const returned of returnsOf(fn)) {
                  push(returned);
                }
              }
            }
          }
        } else if (isNewExpression(value)) {
          for (const argument of value.arguments ?? []) {
            push(spreadless(argument));
          }
        } else if (isIdentifier(value)) {
          named.push({ at, value, shorthand: false });
        } else if (
          (isPropertyAccessExpression(value) || isElementAccessExpression(value)) &&
          value.expression.kind !== SyntaxKind.ThisKeyword
        ) {
          // What a member reads is held in the object, not the object itself.
          push(value.expression, true);
        } else if (isArrayLiteralExpression(value)) {
          for (const element of value.elements) {
            if (!isOmittedExpression(element)) {
              push(spreadless(element));
            }
          }
        } else if (isObjectLiteralExpression(value)) {
          for (const property of value.properties) {
            if (isPropertyAssignment(property)) {
              push(property.initializer);
            } else if (isShorthandPropertyAssignment(property)) {
              named.push({ at, value: property.name, shorthand: true });
            } else if (isSpreadAssignment(property)) {
              push(property.expression);
            } else if (isGetAccessorDeclaration(property)) {
              for (const returned of returnsOf(property)) {
                push(returned);
              }
            }
          }
        } else if (value.kind === SyntaxKind.ThisKeyword) {
          let fn: Node | undefined = value.parent;
          while (fn !== undefined && (!isFunctionNode(fn) || isArrowFunction(fn))) {
            fn = isSourceFile(fn) ? undefined : fn.parent;
          }
          const self = fn === undefined ? undefined : thisParameterOf(fn);
          for (const passed of self === undefined ? [] : passedAt(self, held)) {
            push(passed);
          }
        }
      }
    });
    const plain = named.filter((one) => !one.shorthand);
    const resolved = project.symbolsAt(plain.map((one) => project.handle(one.value))).map(must);
    const symbolOf = new Map(plain.map((one, at) => [one, resolved[at]]));
    for (const one of named) {
      const vertex = vertices[one.at];
      const info = vertex === undefined ? undefined : infos.get(keyOf(vertex));
      if (vertex === undefined || info === undefined) {
        continue;
      }
      const into = (value: Expression): void => {
        found[one.at]?.push({
          value,
          inside: vertex.inside,
          reach: vertex.reach,
          bound: vertex.bound,
        });
      };
      for (const type of stores.ofVariable(one.value) ?? []) {
        const stored = reach.reachedFrom(type);
        join(info, vertex.inside ? reach.heldBy(type) : stored, !stored.concrete);
      }
      let symbol = one.shorthand
        ? must(project.shorthandValueAt(project.handle(one.value)))
        : symbolOf.get(one);
      if (symbol !== undefined && (symbol.flags & SymbolFlags.Alias) !== 0) {
        symbol = must(queries.aliased(symbol));
      }
      for (const handle of symbol?.declarations ?? []) {
        let node = project.declarationAt(handle)?.node;
        while (node !== undefined && isBindingElement(node)) {
          node = node.parent.parent;
        }
        if (node !== undefined && isVariableDeclaration(node)) {
          const loop = node.parent.parent;
          if (node.initializer !== undefined) {
            into(node.initializer);
          } else if (isForOfStatement(loop) || isForInStatement(loop)) {
            into(loop.expression);
          }
        } else if (node !== undefined && isParameterDeclaration(node)) {
          for (const value of passedAt(node, vertex.reach)) {
            into(value);
          }
        }
      }
    }
    return found;
  };
  /** Reads every vertex `start` reaches into the shared graph, a wave of checker questions at a time. */
  const build = (start: readonly { readonly vertex: Vertex; readonly force: boolean }[]): void => {
    let wave = [...start];
    while (wave.length > 0) {
      const fresh = [...new Map(wave.map((one) => [keyOf(one.vertex), one.vertex])).entries()]
        .filter(([key]) => !infos.has(key))
        .map(([, vertex]) => vertex);
      typesAt(
        project,
        fresh.map((one) => one.value),
      ).forEach((type, at) => {
        const vertex = fresh[at];
        if (vertex !== undefined) {
          infos.set(keyOf(vertex), infoOf(vertex, type));
        }
      });
      const expand = [
        ...new Map(
          wave
            .filter((one) => {
              const info = infos.get(keyOf(one.vertex));
              return info !== undefined && info.next === undefined && (info.follow || one.force);
            })
            .map((one) => [keyOf(one.vertex), one.vertex]),
        ).values(),
      ];
      const next: { vertex: Vertex; force: boolean }[] = [];
      successors(expand).forEach((read, at) => {
        const vertex = expand[at];
        const info = vertex === undefined ? undefined : infos.get(keyOf(vertex));
        if (info === undefined) {
          return;
        }
        const kept = read.filter((one) => !holdsNoInstance(one.value));
        info.next = kept.map(keyOf);
        next.push(
          ...kept
            .filter((one) => !infos.has(keyOf(one)))
            .map((one) => ({ vertex: one, force: false })),
        );
      });
      wave = next;
    }
  };
  const asked = new Set<string>();
  const converted = new Map<Gathered, Set<string>>();
  /** What the `toJSON` of one class of the target returns, which a serializer emits in its place. */
  const returnsByClass = new Map<string, readonly Expression[]>();
  const conversionReturns = (id: string): readonly Expression[] => {
    let known = returnsByClass.get(id);
    if (known === undefined) {
      known = reach.serializedBy(id).flatMap((handle) => {
        const node = project.declarationAt(handle)?.node;
        if (node === undefined) {
          return [];
        }
        const fn =
          isPropertyDeclaration(node) && node.initializer !== undefined
            ? inner(node.initializer)
            : node;
        return returnsOf(fn);
      });
      returnsByClass.set(id, known);
    }
    return known;
  };
  const readBatch = (batch: readonly Inflow[]): readonly Inflow[] => {
    const roots = batch.map((one) => ({
      into: one.into,
      vertex: { value: one.value, inside: one.inside, reach: one.into.to.reach, bound: [] },
    }));
    build(roots.map((one) => ({ vertex: one.vertex, force: true })));
    const more: Inflow[] = [];
    for (const { into, vertex } of roots) {
      const met = new Set<string>();
      const members = new Set(into.members.map((member) => member.id));
      const queue = [keyOf(vertex)];
      for (const key of queue) {
        const info = met.has(key) ? undefined : infos.get(key);
        met.add(key);
        if (info === undefined) {
          continue;
        }
        for (const id of info.named) {
          into.classes.add(id);
        }
        for (const member of info.members) {
          if (!members.has(member.id)) {
            members.add(member.id);
            into.members.push(member);
          }
        }
        for (const parameter of info.parameters) {
          const id = `${String(parameter.id)}\u0000${into.to.reach}`;
          if (!asked.has(id)) {
            asked.add(id);
            pending.push({ parameter, to: into.to, site: into.site });
          }
        }
        queue.push(...(info.next ?? []));
      }
      const done = converted.get(into) ?? new Set<string>();
      converted.set(into, done);
      for (const id of into.classes) {
        if (!done.has(id)) {
          done.add(id);
          for (const value of conversionReturns(id)) {
            more.push({ into, value, inside: false });
          }
        }
      }
    }
    return more;
  };
  // Each round reads the conversions of the classes the last one added.
  return (batch) => {
    let next = readBatch(batch);
    while (next.length > 0) {
      next = readBatch(next);
    }
  };
}

/**
 * Binds, a batch at a time, each type parameter of a function, a method or a class of the
 * project that a value at a destination is written over, as `references-ts.41` reads its
 * bindings: each is placed at the destination through the type parameter, and a type
 * parameter it is written over is bound in turn, to a fixpoint. A type parameter whose
 * bindings cannot be read, of a function read as a value other than a call's argument or
 * of a declaration it does not read, holds back every class of the target.
 */
function parameterBinder<Brand>(
  project: ProjectView<Brand>,
  reach: ValueReach,
  to: Destinations,
  place: (
    site: Node,
    reached: Reached,
    destination: Destination,
    detail: string,
    value: Expression | undefined,
  ) => void,
  stores: ErasedStores,
  calls: FunctionCalls,
): (batch: readonly Pending[]) => void {
  const { queries } = project;
  const seen = new Set<string>();
  const every: Reached = { ...NOTHING, classes: reach.every, named: reach.every };
  let built: readonly { readonly node: Node; readonly type: Type | undefined }[] | undefined;
  const constructed = (): readonly { readonly node: Node; readonly type: Type | undefined }[] => {
    const nodes: Node[] = [];
    const visit = (node: Node): void => {
      if (isNewExpression(node)) {
        nodes.push(node);
      }
      node.forEachChild(visit);
    };
    for (const file of project.ownSourceFiles()) {
      file.forEachChild(visit);
    }
    const types = typesAt(project, nodes);
    return nodes.map((node, at) => ({ node, type: types[at] }));
  };
  /**
   * Whether a declared type at a place names a type parameter, or its walk was cut, so an
   * argument there may bind it; read once per type and type parameter.
   */
  const names = new Map<string, boolean>();
  const namesParameter = (type: Type, parameter: number): boolean => {
    const key = `${String(type.id)}:${String(parameter)}`;
    let known = names.get(key);
    if (known === undefined) {
      const over = reach.writtenOver(type);
      known = !over.complete || over.parameters.some((one) => one.id === parameter);
      names.set(key, known);
    }
    return known;
  };
  /** Each type argument of the class `target` a type of it, or of a class that extends it, writes. */
  const argumentsOf = (type: Type, target: Type, index: number): readonly Type[] => {
    const found: Type[] = [];
    const met = new Set<number>();
    const queue = [...must(queries.constituents(type))];
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      if (met.has(next.id) || !next.isObjectType()) {
        continue;
      }
      met.add(next.id);
      const generic = must(queries.targetOf(next));
      const given = must(queries.typeArguments(next))[index];
      if (generic.id === target.id && given !== undefined) {
        found.push(given);
      } else {
        queue.push(...must(queries.baseTypes(generic)));
      }
    }
    return found;
  };
  return (batch) => {
    for (const { parameter, to: destination, site } of batch) {
      // One binding per type parameter and reach holds back what every destination of that
      // reach would, so the first destination names it.
      const key = `${String(parameter.id)}\u0000${destination.reach}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const symbol = must(queries.symbolOfType(parameter));
      const [handle] = symbol?.declarations ?? [];
      const declaration = handle === undefined ? undefined : project.declarationAt(handle)?.node;
      const owner = declaration?.parent;
      const detail = `passed to ${destination.callee} through the type parameter ${symbol?.name ?? ""}`;
      if (symbol === undefined || owner === undefined) {
        place(site, every, destination, detail, undefined);
        continue;
      }
      // A mapped type's key and an inferred type range over parts of a type the walk reads.
      if (isMappedTypeNode(owner) || isInferTypeNode(owner)) {
        continue;
      }
      const at = (where: Node, type: Type | undefined, value?: Expression): void => {
        if (type !== undefined) {
          place(where, reach.reachedFrom(type), destination, detail, value);
        }
      };
      /** A value bound at a place, its classes all those its type names. */
      const atValue = (where: Node, type: Type, value: Expression | undefined): void => {
        const reached = reach.reachedFrom(type);
        place(where, { ...reached, classes: reached.named }, destination, detail, value);
      };
      const isClass = isClassDeclaration(owner) || isClassExpression(owner);
      const index = (
        isFunctionLikeDeclaration(owner) || isClass ? (owner.typeParameters ?? []) : []
      ).findIndex((one) => one === declaration);
      if (index < 0) {
        place(site, every, destination, detail, undefined);
        continue;
      }
      if (!isClass) {
        const passed = calls.passed(owner);
        if (passed.loose) {
          place(site, every, destination, detail, undefined);
          continue;
        }
        const handed = passed.to.flatMap((call) => {
          const receiver = calls.receiver(call);
          return [
            ...(receiver === undefined ? [] : [receiver]),
            ...(call.arguments ?? [])
              .filter((argument) => writtenAt(owner) !== argument)
              .map(spreadless),
          ].map((value) => ({ call, value }));
        });
        typesAt(
          project,
          handed.map((one) => one.value),
        ).forEach((type, position) => {
          const one = handed[position];
          if (type !== undefined && one !== undefined) {
            atValue(one.call, type, one.value);
          }
        });
      }
      // A call dispatched to a member of the same name binds a type parameter at the same
      // position, or, where that member declares none there, the owner's own places do.
      const binding = isClass
        ? owner.members.flatMap((member) =>
            isFunctionLikeDeclaration(member) ? calls.of(member) : [],
          )
        : calls.of(owner);
      const ownSignature = isClass ? undefined : must(queries.signatureOf(owner));
      const dispatched = (one: Binding): boolean =>
        !isClass && ((one.declared ?? one.signature).typeParameters ?? []).length <= index;
      // A method's written type arguments are its own, never its class's.
      const written = isClass
        ? []
        : binding.flatMap((one) => {
            const node = dispatched(one) ? undefined : one.written?.[index];
            return node === undefined ? [] : [{ call: one.call, node }];
          });
      typesAt(
        project,
        written.map((one) => one.node),
      ).forEach((type, position) => {
        const call = written[position]?.call;
        if (call !== undefined) {
          at(call, type);
        }
      });
      const self = isClass ? undefined : thisParameterOf(owner);
      const [selfType] = self?.type === undefined ? [] : typesAt(project, [self.type]);
      const placedValues = binding.flatMap((one) => {
        const own_ = dispatched(one);
        const declared = own_ ? ownSignature : (one.declared ?? one.signature);
        if (declared === undefined) {
          place(one.call, every, destination, detail, undefined);
          return [];
        }
        // A call dispatched to another declaration binds that declaration's own type
        // parameter at the position this one has.
        const target =
          isClass || own_ ? parameter.id : (declared.typeParameters?.[index] ?? parameter.id);
        const args = to.invocation(one.call).arguments;
        const receiver = calls.receiver(one.call);
        const own =
          selfType === undefined || !namesParameter(selfType, target) || receiver === undefined
            ? []
            : [{ one, given: undefined, value: receiver, declaredAt: [selfType], target }];
        const found = [
          ...own,
          ...one.placed().flatMap((placed) => {
            const types = placed.uncovered
              ? []
              : [
                  must(queries.parameterType(declared, placed.place)),
                  ...(placed.rest ? [restElementOf(project, declared)] : []),
                ].filter((type) => type !== undefined);
            const argument = args[placed.argument];
            if (!types.some((type) => namesParameter(type, target)) || argument === undefined) {
              return [];
            }
            return [
              { one, given: placed.given, value: spreadless(argument), declaredAt: types, target },
            ];
          }),
        ];
        // A dispatched call no place of the owner binds the type parameter at cannot say
        // what binds it.
        if (own_ && found.length === 0) {
          place(one.call, every, destination, detail, undefined);
        }
        return found;
      });
      const valueTypes = typesAt(
        project,
        placedValues.map((one) => one.value),
      );
      placedValues.forEach(({ one, given, value, declaredAt, target }, position) => {
        const type = given ?? valueTypes[position];
        if (type === undefined) {
          return;
        }
        for (const stored of [
          type,
          ...(given === undefined ? (stores.ofVariable(value) ?? []) : []),
        ]) {
          // The classes are those of what the call binds the parameter to, or, where no
          // place names it in a shape the match reads, every class the argument names; the
          // members of the other types the argument carries are held back only for what binds
          // the parameter, since the argument may hold the value in a type never serialized.
          const argument = reach.reachedFrom(stored);
          const bound_ = declaredAt
            .flatMap((declared) => bound(project, declared, stored, target))
            .map((one) => reach.reachedFrom(one));
          const classes = new Set(
            bound_.length === 0
              ? argument.named
              : bound_.flatMap((one) => [...(one.concrete ? one.classes : one.named)]),
          );
          const members = argument.concrete
            ? argument.members
            : bound_.flatMap((one) => one.members);
          place(
            one.call,
            { ...argument, classes, members },
            destination,
            detail,
            given === undefined && stored === type && !holdsNoInstance(value) ? value : undefined,
          );
        }
      });
      if (!isClass || owner.name === undefined) {
        continue;
      }
      const [target] = typesAt(project, [owner.name]);
      const slot =
        target === undefined
          ? -1
          : must(queries.typeArguments(target)).findIndex((one) => one.id === parameter.id);
      if (target === undefined || slot < 0) {
        continue;
      }
      const receivers = binding.flatMap((one) => {
        const callee = inner(to.invocation(one.call).callee);
        return (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) &&
          callee.expression.kind !== SyntaxKind.ThisKeyword &&
          callee.expression.kind !== SyntaxKind.SuperKeyword
          ? [{ call: one.call, receiver: callee.expression }]
          : [];
      });
      typesAt(
        project,
        receivers.map((one) => one.receiver),
      ).forEach((type, position) => {
        const call = receivers[position]?.call;
        if (type !== undefined && call !== undefined) {
          for (const given of argumentsOf(type, target, slot)) {
            at(call, given);
          }
        }
      });
      built ??= constructed();
      for (const { node, type } of built) {
        for (const given of type === undefined ? [] : argumentsOf(type, target, slot)) {
          at(node, given);
        }
      }
    }
  };
}

/**
 * The types an instantiated type puts where a declared type names `parameter`: matched
 * through type arguments, the constituents of an intersection, the parameters and result
 * of a call signature and the properties of an object type, and in a union every
 * constituent the declared union does not itself name.
 */
function bound<Brand>(
  project: ProjectView<Brand>,
  declared: Type,
  instantiated: Type,
  parameter: number,
  seen = new Set<string>(),
): Type[] {
  if (declared.id === parameter) {
    return [instantiated];
  }
  const pair = `${String(declared.id)}:${String(instantiated.id)}`;
  if (seen.has(pair)) {
    return [];
  }
  seen.add(pair);
  const { queries } = project;
  const deeper = (one: Type | undefined, given: Type | undefined): Type[] =>
    one === undefined || given === undefined ? [] : bound(project, one, given, parameter, seen);
  // A place of a rest the parameter types is declared as an indexed access over it, and
  // what the call passes there is one element of the type it binds.
  if (must(queries.indexedAccessOf(declared))?.object.id === parameter) {
    return [instantiated];
  }
  if (declared.isUnionType()) {
    const parts = must(queries.constituents(declared));
    if (parts.some((part) => part.id === parameter)) {
      const kept = new Set(parts.map((part) => part.id));
      const given = instantiated.isUnionType()
        ? must(queries.constituents(instantiated))
        : [instantiated];
      return given.filter((part) => !kept.has(part.id));
    }
  }
  if (declared.isIntersectionType()) {
    return must(queries.constituents(declared)).flatMap((part) => deeper(part, instantiated));
  }
  const declaredArguments = must(queries.typeArguments(declared));
  const givenArguments = must(queries.typeArguments(instantiated));
  const found =
    declaredArguments.length !== givenArguments.length
      ? []
      : declaredArguments.flatMap((one, at) => deeper(one, givenArguments[at]));
  if (!declared.isObjectType() || !instantiated.isObjectType() || declaredArguments.length > 0) {
    return found;
  }
  const [signature] = must(queries.signaturesOf(declared, SignatureKind.Call));
  const [instance] = must(queries.signaturesOf(instantiated, SignatureKind.Call));
  if (signature !== undefined && instance !== undefined) {
    found.push(
      ...deeper(must(queries.returnTypeOf(signature)), must(queries.returnTypeOf(instance))),
      ...signature.parameters.flatMap((_one, at) =>
        at < instance.parameters.length
          ? deeper(
              must(queries.typeAtPosition(signature, at)),
              must(queries.typeAtPosition(instance, at)),
            )
          : [],
      ),
    );
  }
  const properties = must(queries.propertiesOf(declared));
  const types = queries.typesOfSymbols(properties).map(must);
  properties.forEach((property, at) => {
    found.push(...deeper(types[at], must(queries.propertyTypeOf(instantiated, property.name))));
  });
  return found;
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
  const direct = (call: CallExpression, resolved: Signature | undefined): readonly Binding[] => {
    if (resolved === undefined) {
      return [];
    }
    const declared = must(queries.genericOf(resolved));
    const placed = once(() => placesIn(spans(call), layout(resolved)));
    return [{ call, signature: resolved, declared, placed, written: call.typeArguments }];
  };
  const indirect = (call: CallExpression, callee: Type | undefined): readonly Binding[] =>
    (callee === undefined ? [] : must(queries.signaturesOf(callee, SignatureKind.Call))).map(
      (signature) => {
        const placed = once(() => placesIn(spans(call), layout(signature)));
        return { call, signature, declared: signature, placed, written: undefined };
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
 * The serialization-contract detector: each data member and `toJSON` of each class,
 * interface and object type a value that reaches a destination carries, and `toString`
 * as well where the destination is outside the analysis, recorded at the argument with
 * the callee named.
 */
export function serializationContract<Brand>(input: DetectorInput<Brand>): readonly Evidence[] {
  const { project, held, sites, targetRoot } = input;
  const chains = aliasChains(project, held);
  const stores = erasedStores(project);
  const reach = valueReach(project, held, stores.inside);
  const flows = flowsOf(project, sites.calls, destinations(input, chains, reach), stores, reach);
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
  // Two flows at one site, such as two places of one call binding a type parameter, can
  // hold back one member alike, and it is recorded once.
  const found = new Map<string, Evidence>();
  const record = (one: Evidence): void => {
    found.set(`${one.id}\u0000${one.detail}\u0000${JSON.stringify(one.site)}`, one);
  };
  for (const flow of flows) {
    const site = renderPosition(flow.site.getSourceFile(), targetRoot, flow.site.getStart());
    const { detail } = flow;
    for (const member of [...flow.classes].flatMap((id) => members.get(id) ?? [])) {
      const symbol = byId.get(member.id);
      const name = symbol === undefined ? "" : (memberComponent(symbol, byId) ?? "");
      if (holdsBack(member.flags, name, flow.to)) {
        record(evidence(member.id, member.flags, detail, site));
      }
    }
    for (const member of flow.members) {
      if (holdsBack(member.flags, member.name, flow.to)) {
        for (const id of chains.declarationsOf(member)) {
          record(evidence(id, member.flags, detail, site));
        }
      }
    }
  }
  return [...found.values()];
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
 * A generic outside the analysis, only ambient, or reading a value {@link readTypes} finds
 * untyped as its own type parameter, fills what a type parameter no parameter names binds
 * where the awaited result holds it in data members, not only naming it as a store's
 * methods do: no argument hands the value over, so it is filled out of sight and may be
 * read. Where the checker leaves a question unanswered, every data member is `unanswered`.
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
  let reach: ValueReach | undefined;
  const reachOf = (): ValueReach => (reach ??= valueReach(project, held, undefined, false));
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
        return type === undefined
          ? []
          : reachOf()
              .writtenOver(type)
              .parameters.map((parameter) => parameter.id);
      }),
    );
    // A result the walk cannot finish may carry any type parameter, so it fills all it carries.
    const over = reachOf().writtenOver(result);
    const types = over.complete
      ? over.parameters
          .filter((parameter) => generic.includes(parameter.id) && !passed.has(parameter.id))
          .flatMap((parameter) => bound(project, result, given, parameter.id))
      : [awaited(project, given)];
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
  const chains = aliasChains(project, held);
  const members = (type: Type): readonly string[] => {
    const reached = reachOf().reachedFrom(type);
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
function readAs(value: Expression): ReadAs {
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
  // The call taking a callback encloses it, so each step reads further out and ends.
  const call = callTaking(at);
  const outer = call === undefined ? undefined : readAs(call);
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
  for (const seen = new Set<number>(); !seen.has(at.id);) {
    seen.add(at.id);
    const symbol = must(queries.symbolOfType(at));
    const [resolved] = must(queries.typeArguments(at));
    const standard =
      symbol !== undefined &&
      PROMISES.has(symbol.name) &&
      symbol.declarations.every(
        (handle) => project.program.getSourceFileMetadata(handle.path)?.isDefaultLibrary === true,
      );
    if (!standard || resolved === undefined) {
      break;
    }
    at = resolved;
  }
  return at;
}
