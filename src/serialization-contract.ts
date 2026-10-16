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
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
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
  ModifierFlags,
  NodeFlags,
  SyntaxKind,
  type CallExpression,
  type Expression,
  type Node,
  type ParameterDeclaration,
  type SourceFile,
  type SpreadAssignment,
} from "@typescript/native/ast";
import { parenthesesRemoved } from "./unwrap.ts";
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
import { renderPosition, type Position } from "./position.ts";
import { must, Unanswerable } from "./query.ts";
import type { ProjectView } from "./session.ts";
import { erasedStores, type ErasedStores } from "./erased-stores.ts";
import { checkedTypes, CONVERSION_MEMBERS, valueReach, type Reached } from "./value-reach.ts";

/** The serializer every run reads, whatever the configuration names. */
const JSON_STRINGIFY: DeclarationEntry = { global: "JSON.stringify" };

/** The methods a serializer and a formatter resolve by name on a value that left the analysis. */
const CONVERSIONS: ReadonlySet<string> = new Set(["toJSON", "toString"]);

/** The method a serializer calls on a value that carries one, wherever the value goes. */
const SERIALIZED_CONVERSION = "toJSON";

/** The parameter types that keep nothing of the value they are given. */
const ERASED = TypeFlags.Any | TypeFlags.Unknown;

/** The standard library's promise types, whose value is their one type argument. */
const PROMISES: ReadonlySet<string> = new Set(["Promise", "PromiseLike"]);

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

/**
 * The invocation a call writes through a method of `Function.prototype`, read from
 * the syntax alone: `f.call(self, a)`, `f.apply(self, [a])`, `f.bind(self, a)`, which
 * binds `a`, and `f.bind(self, a)(b)`, which passes `b` after it. An `apply` argument
 * that is no array literal is the value of the first parameter, whose elements it
 * carries. Whether the method is the prototype's is resolution's to say.
 */
function throughMethod(call: CallExpression): MethodForm | undefined {
  const expression = parenthesesRemoved(call.expression);
  if (isPropertyAccessExpression(expression) && FUNCTION_METHODS.has(expression.name.text)) {
    const [, ...rest] = call.arguments;
    let passed: readonly Expression[] = rest;
    if (expression.name.text === "apply") {
      const list = rest[0] === undefined ? undefined : parenthesesRemoved(rest[0]);
      passed = list === undefined ? [] : isArrayLiteralExpression(list) ? list.elements : [list];
    }
    return {
      method: expression.name,
      invocation: { callee: expression.expression, arguments: passed, indirect: true },
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
  /** The class properties whose declaration writes an initializer, by identifier. */
  readonly initialized: ReadonlySet<string>;
}

/**
 * Every call of the project's own files with the class `this` stands for there, and
 * every identifier-named parameter of every function, method and function-valued
 * variable the project declares, at the position of the argument it binds.
 */
function walkProject<Brand>(project: ProjectView<Brand>, held: Inventory): Walked {
  const sites: Site[] = [];
  const parameters: Parameter[] = [];
  const initialized = new Set<string>();
  for (const file of project.ownSourceFiles()) {
    const visit = (node: Node, self: string | undefined): void => {
      let inner = self;
      if (isPropertyDeclaration(node) && node.initializer !== undefined) {
        const id = held.declarations.get(nodeKey(file, node));
        if (id !== undefined) {
          initialized.add(id);
        }
      }
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
  return { sites, parameters, initialized };
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
 * reads it, and a rest parameter whose elements keep none, each by its symbol.
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
      return keepsNoName(project, type);
    }
    const [element] = must(project.queries.typeArguments(type));
    return element !== undefined && keepsNoName(project, element);
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
  erased: ReadonlyMap<number, Parameter>,
): readonly Parameter[] {
  const asked: {
    readonly node: Node;
    readonly parameter: Parameter;
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
      for (const value of read.map(evaluated)) {
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
 * parameter the function enumerates or hands on to a destination, holding back the widest
 * of what those hold back, settled by widening until no parameter moves.
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

  for (const parameter of enumeratedParameters(project, erased)) {
    forwards.set(keyOf(parameter), "properties");
  }
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
  const generic = typeParameterFlows(
    project,
    reach,
    sites,
    arguments_.flatMap((one) => {
      const type = typeOf.get(one.value);
      const parameters = type === undefined ? [] : typeParametersOf(project, type, 0);
      const destination = parameters.length === 0 ? undefined : to.at(one.site.call, one.argument);
      return destination === undefined
        ? []
        : parameters.map((parameter) => ({ parameter, to: destination }));
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

/** The type parameters one type names, through constituents and type arguments. */
function typeParametersOf<Brand>(project: ProjectView<Brand>, type: Type, depth: number): Type[] {
  if (type.isTypeParameter()) {
    return [type];
  }
  if (depth >= MENTION_DEPTH) {
    return [];
  }
  const { queries } = project;
  return [
    ...(type.isUnionType() || type.isIntersectionType() ? must(queries.constituents(type)) : []),
    ...must(queries.typeArguments(type)),
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

/**
 * The flows a type parameter of a function of the project carries where a value its type
 * names reaches a destination: each call of the function passes its type argument there,
 * written or inferred from the arguments, and a type argument that is a type parameter
 * of the calling function is followed on to that function's calls, to a fixpoint.
 */
function typeParameterFlows<Brand>(
  project: ProjectView<Brand>,
  reach: ReturnType<typeof valueReach>,
  sites: readonly Site[],
  pending: { readonly parameter: Type; readonly to: Destination }[],
): readonly Flow[] {
  const { queries } = project;
  const byName = new Map<string, Site[]>();
  for (const site of sites) {
    const name = calleeName(site.call.expression)?.getText();
    if (name !== undefined) {
      byName.set(name, [...(byName.get(name) ?? []), site]);
    }
  }
  const found: Flow[] = [];
  const seen = new Set<number>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { parameter, to } = next;
    if (seen.has(parameter.id)) {
      continue;
    }
    seen.add(parameter.id);
    const symbol = must(queries.symbolOfType(parameter));
    const [handle] = symbol?.declarations ?? [];
    const declaration = handle === undefined ? undefined : project.declarationAt(handle)?.node;
    const fn = declaration?.parent;
    const index =
      fn === undefined || !isFunctionLikeDeclaration(fn)
        ? -1
        : (fn.typeParameters ?? []).findIndex((one) => one === declaration);
    const name =
      fn === undefined
        ? undefined
        : isMethodDeclaration(fn) && isIdentifier(fn.name)
          ? fn.name.text
          : nestedName(fn);
    if (symbol === undefined || fn === undefined || index < 0 || name === undefined) {
      continue;
    }
    for (const site of byName.get(name) ?? []) {
      const resolved = must(queries.resolvedSignature(site.call));
      const declared = resolved === undefined ? undefined : must(queries.genericOf(resolved));
      const called =
        declared?.declaration === undefined
          ? undefined
          : project.declarationAt(declared.declaration)?.node;
      if (resolved === undefined || declared === undefined || called !== fn) {
        continue;
      }
      const written = site.call.typeArguments?.[index];
      const given =
        written === undefined
          ? site.call.arguments.flatMap((_argument, at) => {
              const from = must(queries.parameterType(declared, at));
              const into = must(queries.parameterType(resolved, at));
              return from === undefined || into === undefined
                ? []
                : bound(project, from, into, parameter, 0);
            })
          : typesAt(project, [written]).filter((type) => type !== undefined);
      for (const type of given) {
        const reached = reach.reachedFrom(type);
        if (reached.classes.size > 0 || reached.members.length > 0) {
          found.push({
            site: site.call,
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
  // The receiver reads only what the program wrote, so a data member holds while written.
  const evidence = (id: string, flags: SymbolFlags, detail: string, site: Position): Evidence =>
    (flags & SymbolFlags.Property) !== 0 && !walked.initialized.has(id)
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
 * A generic declared outside the analysis, or only ambiently, fills the type that a type
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
        (node === undefined || (node.flags & NodeFlags.Ambient) === 0))
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
  const read = readTypes(project, untyped);
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
    const untyped = type !== undefined && (type.flags & (TypeFlags.Any | TypeFlags.Unknown)) !== 0;
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
