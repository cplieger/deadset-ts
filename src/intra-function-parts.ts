/**
 * The parts of the declarations one project's own files hold, read while the project's
 * view is open: each parameter and whether its function reads it, each result and the
 * call sites that use or discard it, each statement control flow cannot reach, each
 * write to a local that no read reaches, and each case an earlier case covers.
 */

import {
  isArrowFunction,
  isAwaitExpression,
  isBigIntLiteral,
  isBinaryExpression,
  isBindingElement,
  isBlock,
  isBreakStatement,
  isCallExpression,
  isCaseClause,
  isCatchClause,
  isClassDeclaration,
  isClassStaticBlockDeclaration,
  isClassExpression,
  isConditionalExpression,
  isConstructorDeclaration,
  isContinueStatement,
  isDecorator,
  isDefaultClause,
  isDoStatement,
  isEnumDeclaration,
  isExportDeclaration,
  isExportAssignment,
  isExportSpecifier,
  isExpressionStatement,
  isExpressionWithTypeArguments,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionLikeDeclaration,
  isGetAccessorDeclaration,
  isHeritageClause,
  isIdentifier,
  isIfStatement,
  isInterfaceDeclaration,
  isImportClause,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportSpecifier,
  isLabeledStatement,
  isMethodDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isNamedExports,
  isNamespaceImport,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isParameterDeclaration,
  isPrefixUnaryExpression,
  isPrivateIdentifier,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isPropertySignatureDeclaration,
  isQualifiedName,
  isReturnStatement,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isStringLiteral,
  isSwitchStatement,
  isThrowStatement,
  isTryStatement,
  isTypeAliasDeclaration,
  isTypePredicateNode,
  isTypeReferenceNode,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  isVoidExpression,
  isWhileStatement,
  isWithStatement,
  NodeFlags,
  SyntaxKind,
  type AccessorDeclaration,
  type ArrowFunction,
  type BinaryExpression,
  type BindingName,
  type Block,
  type CallExpression,
  type CatchClause,
  type ConstructorDeclaration,
  type ExportSpecifier,
  type ExpressionStatement,
  type ForInStatement,
  type ForOfStatement,
  type FunctionExpression,
  type FunctionLikeDeclaration,
  type Identifier,
  type Node,
  type ParameterDeclaration,
  type SourceFile,
  type Statement,
  type VariableDeclarationList,
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
import type { FindingPosition } from "./finding.ts";
import {
  exportsLocally,
  implicitReads,
  importBindings,
  type JsxOptions,
} from "./import-bindings.ts";
import { isParameterProperty, nodeKey, type Inventory } from "./inventory.ts";
import { positionKey, renderPosition } from "./position.ts";
import { publishedAPI } from "./roots/published-reach.ts";
import { sourceFilesOf } from "./source-files.ts";
import { importRef } from "./ref.ts";
import { isAnswered, UNANSWERED, type Answer } from "./query.ts";
import type { Reference } from "./references.ts";
import type { ProjectView } from "./session.ts";
import { signatureOf, type SignatureNode } from "./signatures.ts";
import { spellsNoBinding } from "./spelled-names.ts";
import { parenthesesRemoved } from "./unwrap.ts";

/** The subject kind of each part this module reads. */
export type PartKind = "parameter" | "result" | "statement" | "store" | "case";

/** One part of one declaration that a project found doing nothing. */
export interface PartFact {
  /** The inventory's identifier of the declaration that holds the part. */
  readonly declaration: string;
  readonly kind: PartKind;
  /** The part's display name: an identifier, or the text of a case. */
  readonly name: string;
  readonly position: FindingPosition;
  /** Where the part is a parameter's name, what a function used as a value decides it by. */
  readonly parameter?: ParameterPlace;
  /** Where the part is a result, whether its type has a `then` member, as a promise does. */
  readonly thenable?: boolean;
}

/**
 * What a call does with its value: uses it, discards it as a statement of its own or the
 * operand of `void`, or awaits it as a statement, which sequences on a thenable value and
 * discards any other.
 */
type CallUse = "used" | "discarded" | "awaited";

/** What decides a parameter of a function used as a value: a caller may pass it more arguments. */
interface ParameterPlace {
  /** Whether a parameter after this one, which is no binding-pattern name, is read. */
  readonly beforeARead: boolean;
  /** Whether the function's `length` counts the parameter: none at or before it has a default or is a rest. */
  readonly counted: boolean;
  /** Whether no declaration of the inventory declares the function, which is then a value. */
  readonly inValue: boolean;
  /**
   * Where the parameter carries an annotation and the compiler gives its function a
   * contextual type: whether a type parameter of the callee reads the parameter's type,
   * so the annotation may steer the call's inference.
   */
  readonly annotated?: "steers" | "free";
  /**
   * Whether the name is one an object binding pattern of a parameter binds, and the
   * compiler gives its function a contextual type: the code handing the argument may act on
   * the pattern's read of the property, which the program does not show.
   */
  readonly contextualPattern?: true;
  /** Whether the compiler checks the parameter's file, so its unused-parameter rule may report it. */
  readonly checked: boolean;
}

/** What one declaration's signature answers to beside its body. */
interface SignatureFact {
  readonly declaration: string;
  /** Whether the body is empty or does nothing but throw. */
  readonly stub: boolean;
  /** Whether a class hierarchy fixes the signature, or a decorator a constructor's. */
  readonly fixed: boolean;
  /** Whether the signature is a constructor's, which its class's identifier stands for. */
  readonly constructor: boolean;
}

/** One name an import declaration binds, and whether its file reads it. */
interface ImportFact {
  readonly ref: string;
  readonly name: string;
  readonly position: FindingPosition;
  readonly used: boolean;
}

/** What one project answers about the parts of its declarations. */
export interface ProjectParts {
  readonly parts: readonly PartFact[];
  readonly imports: readonly ImportFact[];
  readonly signatures: readonly SignatureFact[];
  /** Each name written as the callee of a call, by position, and what the call does with its value. */
  readonly calls: ReadonlyMap<string, CallUse>;
  /** Each name an import or an export specifier writes, by position, which uses no value. */
  readonly specifiers: ReadonlySet<string>;
  /** Each name of {@link constructionNames}, by position, which uses no constructor as a value. */
  readonly constructions: ReadonlySet<string>;
  /** The rendered path of each file the project compiles, whose parts it judges. */
  readonly files: ReadonlySet<string>;
  /** The declarations whose result the project judged, holding a call that discards it. */
  readonly results: ReadonlySet<string>;
  /** What an outside importer of any of the project's files can name, read where a result part needs it. */
  readonly published: ReadonlySet<string>;
}

/** The result types that carry no value, as the checker spells them. */
const NO_VALUE: ReadonlySet<string> = new Set([
  "void",
  "undefined",
  "never",
  "Promise<void>",
  "Promise<undefined>",
  "Promise<never>",
]);

/** The rendered position of one node, from its first token to its last line. */
function spanOf(file: SourceFile, root: string, node: Node): FindingPosition {
  const start = renderPosition(file, root, node.getStart());
  const endLine = file.getLineAndCharacterOfPosition(node.end).line + 1;
  return { ...start, endLine };
}

/** The node the parentheses around one expression sit in. */
function outerParent(node: Node): Node {
  return isParenthesizedExpression(node.parent) ? outerParent(node.parent) : node.parent;
}

/** The name a call is made through: the identifier, or the member a property access names. */
function calleeName(call: CallExpression): Identifier | undefined {
  const callee = parenthesesRemoved(call.expression);
  if (isIdentifier(callee)) {
    return callee;
  }
  return isPropertyAccessExpression(callee) && isIdentifier(callee.name) ? callee.name : undefined;
}

/** What a call does with its value. */
function callUse(call: CallExpression): CallUse {
  const parent = outerParent(call);
  if (isExpressionStatement(parent) || isVoidExpression(parent)) {
    return "discarded";
  }
  return isAwaitExpression(parent) && isExpressionStatement(outerParent(parent))
    ? "awaited"
    : "used";
}

/** What a namespace declaration holds at run time: nothing, only const enums, or values. */
const HOLDS_NOTHING = 0;
const HOLDS_CONST_ENUMS = 1;
const HOLDS_VALUES = 2;
type InstanceState = typeof HOLDS_NOTHING | typeof HOLDS_CONST_ENUMS | typeof HOLDS_VALUES;

/**
 * The instance state of one declaration, as the compiler's binder computes it
 * (`getModuleInstanceState`) from the declaration's own body. A name an export clause
 * re-exports takes the state of the local declarations it names. A node met again while it
 * is still being decided holds nothing, as in the binder.
 */
function instanceState(node: Node, visited = new Map<Node, InstanceState>()): InstanceState {
  const known = visited.get(node);
  if (known !== undefined || visited.has(node)) {
    return known ?? HOLDS_NOTHING;
  }
  visited.set(node, HOLDS_NOTHING);
  const highest = (nodes: readonly Node[], of: (one: Node) => InstanceState): InstanceState => {
    let state: InstanceState = HOLDS_NOTHING;
    for (const one of nodes) {
      state = Math.max(state, of(one)) as InstanceState;
      if (state === HOLDS_VALUES) {
        break;
      }
    }
    return state;
  };
  let state: InstanceState = HOLDS_VALUES;
  if (isModuleDeclaration(node)) {
    state = node.body === undefined ? HOLDS_VALUES : instanceState(node.body, visited);
  } else if (isModuleBlock(node)) {
    state = highest(node.statements, (one) => instanceState(one, visited));
  } else if (isInterfaceDeclaration(node) || isTypeAliasDeclaration(node)) {
    state = HOLDS_NOTHING;
  } else if (isEnumDeclaration(node) && hasModifier(node, SyntaxKind.ConstKeyword)) {
    state = HOLDS_CONST_ENUMS;
  } else if (
    (isImportDeclaration(node) || isImportEqualsDeclaration(node)) &&
    !hasModifier(node, SyntaxKind.ExportKeyword)
  ) {
    state = HOLDS_NOTHING;
  } else if (
    isExportDeclaration(node) &&
    node.moduleSpecifier === undefined &&
    node.exportClause !== undefined &&
    isNamedExports(node.exportClause)
  ) {
    state = highest(node.exportClause.elements, (one) =>
      reexportedState(one as ExportSpecifier, visited),
    );
  }
  visited.set(node, state);
  return state;
}

/** The instance state of the local declarations one export specifier names, the nearest scope's. */
function reexportedState(
  specifier: ExportSpecifier,
  visited: Map<Node, InstanceState>,
): InstanceState {
  const name = specifier.propertyName ?? specifier.name;
  if (!isIdentifier(name)) {
    return HOLDS_VALUES;
  }
  const names = (statement: Node): boolean => {
    if (isVariableStatement(statement)) {
      return statement.declarationList.declarations.some(names);
    }
    const declared = (statement as { readonly name?: Node }).name;
    return declared !== undefined && isIdentifier(declared) && declared.text === name.text;
  };
  for (let at: Node = specifier.parent; ; at = at.parent) {
    if (isBlock(at) || isModuleBlock(at) || isSourceFile(at)) {
      let found: InstanceState | undefined;
      for (const statement of at.statements.filter(names)) {
        if (isImportEqualsDeclaration(statement)) {
          return HOLDS_VALUES;
        }
        found = Math.max(
          found ?? HOLDS_NOTHING,
          instanceState(statement, visited),
        ) as InstanceState;
        if (found === HOLDS_VALUES) {
          return found;
        }
      }
      if (found !== undefined) {
        return found;
      }
    }
    if (isSourceFile(at)) {
      return HOLDS_VALUES;
    }
  }
}

/**
 * Whether the compiler counts one statement as code that runs (`isPotentiallyExecutableNode`):
 * any statement but a block or an empty one, a `var` only where it initializes a name, and a
 * class, an enum or a namespace.
 */
function executable(node: Node): boolean {
  if (isVariableStatement(node)) {
    const list = node.declarationList;
    return (
      (list.flags & NodeFlags.BlockScoped) !== 0 ||
      list.declarations.some((one) => one.initializer !== undefined)
    );
  }
  return (
    (node.kind >= SyntaxKind.FirstStatement && node.kind <= SyntaxKind.LastStatement) ||
    isClassDeclaration(node) ||
    isEnumDeclaration(node) ||
    isModuleDeclaration(node)
  );
}

/**
 * Whether an unreached statement is a finding, by the checker's exclusions
 * (`isSourceElementUnreachable`): a const enum only while const enums are preserved, and a
 * namespace only where its own declaration holds a value, or preserved const enums.
 */
function reportable(statement: Statement, constEnumsPreserved: boolean): boolean {
  if (isEnumDeclaration(statement)) {
    return constEnumsPreserved || !hasModifier(statement, SyntaxKind.ConstKeyword);
  }
  if (!isModuleDeclaration(statement)) {
    return true;
  }
  const state = instanceState(statement);
  return state === HOLDS_VALUES || (constEnumsPreserved && state === HOLDS_CONST_ENUMS);
}

/**
 * The bodies one statement runs as part of its own flow, as the binder does
 * (`isImmediatelyInvoked`): a non-async, non-generator function expression or arrow that the
 * statement's whole expression calls, or each static block of a class declaration, in order.
 * Every other function-like body starts a flow of its own.
 */
function runsInline(statement: Node): readonly Block[] {
  if (isClassDeclaration(statement)) {
    return statement.members.filter(isClassStaticBlockDeclaration).map((one) => one.body);
  }
  const call = isExpressionStatement(statement)
    ? parenthesesRemoved(statement.expression)
    : undefined;
  const callee =
    call !== undefined && isCallExpression(call) ? parenthesesRemoved(call.expression) : undefined;
  return callee !== undefined &&
    (isFunctionExpression(callee) || isArrowFunction(callee)) &&
    isBlock(callee.body) &&
    !hasModifier(callee, SyntaxKind.AsyncKeyword) &&
    (callee as { readonly asteriskToken?: Node }).asteriskToken === undefined
    ? [callee.body]
    : [];
}

/** Whether a callee is a dotted name (`isDottedName`), whose call statement the binder's flow records. */
function dottedName(node: Node): boolean {
  if (isPropertyAccessExpression(node) || isParenthesizedExpression(node)) {
    return dottedName(node.expression);
  }
  return (
    isIdentifier(node) ||
    node.kind === SyntaxKind.ThisKeyword ||
    node.kind === SyntaxKind.SuperKeyword ||
    node.kind === SyntaxKind.MetaProperty
  );
}

/** Whether an argument is the checker's constant `false` (`isFalseExpression`). */
function falseExpression(node: Node): boolean {
  const bare = parenthesesRemoved(node);
  if (bare.kind === SyntaxKind.FalseKeyword) {
    return true;
  }
  if (!isBinaryExpression(bare)) {
    return false;
  }
  const operator = bare.operatorToken.kind;
  return operator === SyntaxKind.AmpersandAmpersandToken
    ? falseExpression(bare.left) || falseExpression(bare.right)
    : operator === SyntaxKind.BarBarToken &&
        falseExpression(bare.left) &&
        falseExpression(bare.right);
}

/** Whether a node is a member of a class body (`IsClassElement`). */
function classElement(node: Node): boolean {
  return CLASS_ELEMENTS.has(node.kind);
}

const CLASS_ELEMENTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.Constructor,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.IndexSignature,
  SyntaxKind.ClassStaticBlockDeclaration,
  SyntaxKind.SemicolonClassElement,
]);

const THIS_CONTAINERS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ModuleDeclaration,
  SyntaxKind.ClassStaticBlockDeclaration,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.PropertySignature,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.MethodSignature,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.CallSignature,
  SyntaxKind.ConstructSignature,
  SyntaxKind.IndexSignature,
  SyntaxKind.EnumDeclaration,
  SyntaxKind.SourceFile,
]);

/** The node that binds a `this`, arrows passed through (`GetThisContainer`). */
function thisContainer(node: Node): Node | undefined {
  let at = node.parent as Node | undefined;
  while (at !== undefined) {
    if (THIS_CONTAINERS.has(at.kind)) {
      return at;
    }
    if (at.kind === SyntaxKind.ComputedPropertyName) {
      at = at.parent.parent;
    } else if (at.kind === SyntaxKind.Decorator) {
      if (at.parent.kind === SyntaxKind.Parameter && classElement(at.parent.parent)) {
        at = at.parent.parent;
      } else if (classElement(at.parent)) {
        at = at.parent;
      }
    }
    at = at.parent;
  }
  return undefined;
}

/** A signature's type predicate, as the checker reads it. */
interface Predicate {
  readonly asserts: boolean;
  /** Whether it names a type (`asserts value is T`), not the bare `asserts value`. */
  readonly typed: boolean;
  /** The parameter it names, counted without a `this` parameter, or -1. */
  readonly index: number;
}

/** A predicate this port cannot read, whose signature then ends no call. */
const UNKNOWN = Symbol("unknown");

/**
 * The call statements of a project's files that never return, by the checker's rule ported from
 * the pinned typescript-go (microsoft/TypeScript 042e0fb, tsc/internal/checker/flow.go): the call
 * arm of isReachableFlowNodeWorker (2554), getEffectsSignature (2059), getTypeOfDottedName (2134),
 * getExplicitTypeOfSymbol (2167), hasTypePredicateOrNeverReturnType (2223), getExplicitThisType
 * (2227); relater.go getTypePredicateOfSignature (2052). What the API hides or leaves unanswered
 * (a mapped member's origin, a union signature's predicate) ends nothing.
 */
function neverReturning<Brand>(
  project: ProjectView<Brand>,
  files: readonly SourceFile[],
): ReadonlySet<Node> {
  const { queries } = project;
  const statements: (ExpressionStatement & { readonly expression: CallExpression })[] = [];
  const visit = (node: Node): void => {
    if (
      isExpressionStatement(node) &&
      isCallExpression(node.expression) &&
      node.expression.expression.kind !== SyntaxKind.SuperKeyword &&
      dottedName(node.expression.expression)
    ) {
      statements.push(node as ExpressionStatement & { readonly expression: CallExpression });
    }
    node.forEachChild(visit);
  };
  files.forEach(visit);
  const known = <T>(answer: Answer<T | undefined> | undefined): T | undefined =>
    answer === undefined || !isAnswered(answer) ? undefined : answer;
  const nodeOf = (handle: NodeHandle | undefined): Node | undefined =>
    handle === undefined ? undefined : project.declarationAt(handle)?.node;
  const symbolAt = (node: Node): TSSymbol | undefined =>
    known(project.symbolsAt([project.handle(node)])[0]);
  const never = (type: Type | undefined): boolean =>
    type !== undefined && (type.flags & TypeFlags.Never) !== 0;

  // resolvingExplicitTypeOfSymbol (flow.go:2169): the for-of arm recurses through the iterated
  // name, so loops whose iterables name each other's variables would recurse forever. A call
  // through such a variable still reaches this walk where narrowing types it `never`. A symbol
  // met again on the walk has no explicit type, so its call ends nothing.
  const resolving = new Set<number>();
  const explicitTypeOf = (given: TSSymbol): Type | undefined => {
    // IsNonLocalAlias: an alias with no meaning of its own, or one an assignment declares.
    const aliased =
      (given.flags & SymbolFlags.Alias) !== 0 &&
      ((given.flags & (SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace)) === 0 ||
        (given.flags & SymbolFlags.Assignment) !== 0);
    const symbol = aliased ? known(queries.aliased(given)) : given;
    if (symbol === undefined || resolving.has(symbol.id)) {
      return undefined;
    }
    resolving.add(symbol.id);
    try {
      if (
        (symbol.flags &
          (SymbolFlags.Function |
            SymbolFlags.Method |
            SymbolFlags.Class |
            SymbolFlags.ValueModule)) !==
        0
      ) {
        return known(queries.typeOfSymbol(symbol));
      }
      if ((symbol.flags & (SymbolFlags.Variable | SymbolFlags.Property)) === 0) {
        return undefined;
      }
      // A mapped member declares no value of its own, and the API does not expose its origin.
      const declaration = nodeOf(symbol.valueDeclaration);
      if (declaration === undefined) {
        return undefined;
      }
      if (explicitlyTyped(declaration)) {
        return known(queries.typeOfSymbol(symbol));
      }
      if (isVariableDeclaration(declaration) && isForOfStatement(declaration.parent.parent)) {
        const { expression } = declaration.parent.parent;
        const iterated = dottedTypeOf(expression);
        const held = iterated === undefined ? undefined : known(queries.typeAt(expression));
        // The variable's own type iterates the expression's type there, which is the checker's
        // iteration of the dotted name's type where the two are one type.
        return held !== undefined && held.id === iterated?.id
          ? known(queries.typeOfSymbol(symbol))
          : undefined;
      }
      return undefined;
    } finally {
      resolving.delete(symbol.id);
    }
  };

  const propertyOf = (type: Type, name: Node): TSSymbol | undefined => {
    const properties = known(queries.propertiesOf(type));
    if (properties === undefined) {
      return undefined;
    }
    if (isIdentifier(name)) {
      return properties.find((one) => one.name === name.text);
    }
    if (!isPrivateIdentifier(name)) {
      return undefined;
    }
    // getTypeOfDottedName (flow.go:2149) keys a private name by the receiver type's own symbol,
    // so only that class's member answers, and a type with no symbol has none. The lexical
    // member's key is that key exactly where its class is the receiver type's symbol.
    const owner = known(queries.symbolOfType(type));
    const declared = owner === undefined ? undefined : symbolAt(name);
    if (owner === undefined || declared === undefined) {
      return undefined;
    }
    return known(queries.parentOf(declared))?.id === owner.id
      ? properties.find((one) => one.name === declared.name)
      : undefined;
  };

  // getSignatureFromDeclaration's `this` parameter (checker.go:20510, 20529): the container's
  // own or, for an accessor without one, its pair's, which getAccessorThisParameter takes only
  // from a getter with one parameter or a setter with two.
  const thisParameterOf = (
    container: FunctionLikeDeclaration,
  ): ParameterDeclaration | undefined => {
    const [own] = container.parameters;
    if (own !== undefined && symbolName(own) === "this") {
      return own;
    }
    const getter = isGetAccessorDeclaration(container);
    if (!getter && !isSetAccessorDeclaration(container)) {
      return undefined;
    }
    const other = getter ? isSetAccessorDeclaration : isGetAccessorDeclaration;
    const pair = symbolAt(container.name)
      ?.declarations.map(nodeOf)
      .find((one): one is AccessorDeclaration => one !== undefined && other(one));
    const first = pair?.parameters[0];
    return first !== undefined &&
      pair?.parameters.length === (getter ? 2 : 1) &&
      symbolName(first) === "this"
      ? first
      : undefined;
  };

  const explicitThisTypeOf = (node: Node): Type | undefined => {
    const container = thisContainer(node);
    if (container === undefined) {
      return undefined;
    }
    if (isFunctionLikeDeclaration(container)) {
      const signature = known(queries.signatureOf(container));
      if (signature === undefined) {
        return undefined;
      }
      if (signature.thisParameter !== undefined) {
        const declaration = thisParameterOf(container);
        const parameter = declaration === undefined ? undefined : symbolAt(declaration.name);
        return parameter === undefined ? undefined : explicitTypeOf(parameter);
      }
    }
    const owner = container.parent as Node | undefined;
    const name =
      owner !== undefined && (isClassDeclaration(owner) || isClassExpression(owner))
        ? owner.name
        : undefined;
    const symbol = name === undefined ? undefined : symbolAt(name);
    if (symbol === undefined) {
      return undefined;
    }
    return isClassStaticBlockDeclaration(container) ||
      (classElement(container) && hasModifier(container, SyntaxKind.StaticKeyword))
      ? known(queries.typeOfSymbol(symbol))
      : known(queries.declaredTypeOf(symbol));
  };

  const dottedTypeOf = (node: Node): Type | undefined => {
    if ((node.flags & NodeFlags.InWithStatement) !== 0) {
      return undefined;
    }
    if (isIdentifier(node)) {
      // A name's value meaning finds a module member's export symbol, which is
      // getExportSymbolOfValueSymbolIfExported over its resolved symbol.
      const symbol = symbolAt(node);
      return symbol === undefined ? undefined : explicitTypeOf(symbol);
    }
    if (node.kind === SyntaxKind.ThisKeyword) {
      return explicitThisTypeOf(node);
    }
    if (node.kind === SyntaxKind.SuperKeyword) {
      return known(queries.typeAt(node));
    }
    if (isPropertyAccessExpression(node)) {
      const type = dottedTypeOf(node.expression);
      const property = type === undefined ? undefined : propertyOf(type, node.name);
      return property === undefined ? undefined : explicitTypeOf(property);
    }
    return isParenthesizedExpression(node) ? dottedTypeOf(node.expression) : undefined;
  };

  const predicateOf = (
    signature: Signature,
    declaration: Node,
  ): Predicate | undefined | typeof UNKNOWN => {
    const declared = known(queries.signatureOf(declaration));
    let at: Signature | undefined = signature;
    for (let step = 0; at !== undefined && at.id !== declared?.id; step++) {
      at = step < SIGNATURE_TARGET_DEPTH ? known(queries.genericOf(at)) : undefined;
    }
    // A union's signature carries its first member's declaration and its own predicate.
    if (at === undefined) {
      return UNKNOWN;
    }
    const type = (declaration as { readonly type?: Node }).type;
    if (type === undefined || !isTypePredicateNode(type)) {
      return undefined;
    }
    const name = type.parameterName;
    const parameters = (declaration as { readonly parameters?: readonly Node[] }).parameters ?? [];
    const named = parameters.filter((one, index) => !(index === 0 && symbolName(one) === "this"));
    return {
      asserts: type.assertsModifier !== undefined,
      typed: type.type !== undefined,
      index:
        name.kind === SyntaxKind.ThisType
          ? -1
          : named.findIndex((one) => isIdentifier(name) && symbolName(one) === name.text),
    };
  };

  // getReturnTypeFromAnnotation (checker.go:20705). A constructor's result is its instance type,
  // which is not never, and a declaration with no type node writes no never result: a JavaScript
  // type tag's signature is declared by the tag's own function type, which carries the annotation.
  const annotatedNever = (declaration: Node): boolean => {
    if ((declaration as { readonly type?: Node }).type === undefined) {
      return false;
    }
    const declared = known(queries.signatureOf(declaration));
    return declared !== undefined && never(known(queries.returnTypeOf(declared)));
  };

  // Whether a signature has a predicate or writes `never` as its result, where the API tells.
  const marked = (signature: Signature): boolean => {
    const declaration = nodeOf(signature.declaration);
    if (declaration === undefined) {
      return false;
    }
    const predicate = predicateOf(signature, declaration);
    return predicate !== UNKNOWN && (predicate !== undefined || annotatedNever(declaration));
  };

  const effectsOf = (call: CallExpression): Signature | undefined => {
    const type = dottedTypeOf(call.expression);
    const signatures =
      type === undefined ? undefined : known(queries.signaturesOf(type, SignatureKind.Call));
    if (signatures === undefined) {
      return undefined;
    }
    const [only] = signatures;
    const chosen =
      signatures.length === 1 && only !== undefined && (only.typeParameters?.length ?? 0) === 0
        ? only
        : signatures.some(marked)
          ? known(queries.resolvedSignature(call))
          : undefined;
    return chosen !== undefined && marked(chosen) ? chosen : undefined;
  };

  // The effects signature's result is the call's own type, so a call typed neither `never` nor
  // `void` with a false argument cannot end, and is never asked about.
  const types =
    statements.length === 0 ? [] : queries.typesAt(statements.map((one) => one.expression));
  const ends = new Set<Node>();
  statements.forEach((statement, at) => {
    const type = known(types[at]);
    const call = statement.expression;
    if (
      type === undefined ||
      (!never(type) &&
        ((type.flags & TypeFlags.Void) === 0 || !call.arguments.some(falseExpression)))
    ) {
      return;
    }
    const effects = effectsOf(call);
    const declaration = effects === undefined ? undefined : nodeOf(effects.declaration);
    if (effects === undefined || declaration === undefined) {
      return;
    }
    // The checker ends a bare `asserts value` call whose argument there is false.
    const predicate = predicateOf(effects, declaration);
    const asserted =
      predicate !== UNKNOWN && predicate?.asserts === true && !predicate.typed
        ? call.arguments[predicate.index]
        : undefined;
    if (
      (asserted !== undefined && falseExpression(asserted)) ||
      never(known(queries.returnTypeOf(effects)))
    ) {
      ends.add(statement);
    }
  });
  return ends;
}

/** Whether a declaration writes its own type (`isDeclarationWithExplicitTypeAnnotation`, flow.go:2209). */
function explicitlyTyped(declaration: Node): boolean {
  if (
    isVariableDeclaration(declaration) ||
    isPropertyDeclaration(declaration) ||
    isPropertySignatureDeclaration(declaration) ||
    isParameterDeclaration(declaration)
  ) {
    return declaration.type !== undefined;
  }
  // An expando property is typed by the function it is assigned, where that writes its result.
  return (
    isBinaryExpression(declaration) &&
    (isFunctionExpression(declaration.right) || isArrowFunction(declaration.right)) &&
    declaration.right.type !== undefined
  );
}

/** The name a declaration's symbol carries, for an identifier-named one. */
function symbolName(declaration: Node): string | undefined {
  const name = (declaration as { readonly name?: Node }).name;
  return name !== undefined && isIdentifier(name) ? name.text : undefined;
}

/** How many instantiations deep a signature's generic is followed to its declaration's own. */
const SIGNATURE_TARGET_DEPTH = 8;

/**
 * The statements of one file the compiler counts as code that runs and that no path from the
 * start of their own flow reaches: the file's, a namespace body's, or a function-like body's
 * that does not run inline. The walk is `flowWalk`'s with each statement a target of its own,
 * and a construct it does not follow leaves every statement inside it reached.
 */
function unreachedOf(file: SourceFile, ends: ReadonlySet<Node>): ReadonlySet<Node> {
  const flows: { readonly statements: readonly Statement[]; readonly members: Statement[] }[] = [];
  const inline = new Set<Node>();
  const collect = (node: Node, members: Statement[]): void => {
    for (const body of runsInline(node)) {
      inline.add(body);
    }
    node.forEachChild((child) => {
      const own = isModuleBlock(child)
        ? child.statements
        : isBlock(child) &&
            !inline.has(child) &&
            (isFunctionLikeDeclaration(node) || isClassStaticBlockDeclaration(node))
          ? child.statements
          : undefined;
      if (own !== undefined) {
        const inner: Statement[] = [];
        flows.push({ statements: own, members: inner });
        collect(child, inner);
        return;
      }
      if (executable(child)) {
        members.push(child as Statement);
      }
      collect(child, members);
    });
  };
  const top: Statement[] = [];
  flows.push({ statements: file.statements, members: top });
  collect(file, top);
  const unreached = new Set<Node>();
  for (const { statements, members } of flows) {
    // Members are in source order, so those inside one node are one run of bits.
    const first = (pos: number): number => {
      let low = 0;
      for (let high = members.length; low < high;) {
        const middle = (low + high) >> 1;
        if ((members[middle]?.pos ?? pos) < pos) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
      return low;
    };
    const inside = (node: Node | undefined): Reached => {
      if (node === undefined) {
        return NOTHING;
      }
      let low = first(node.pos);
      const high = first(node.end);
      while (low < high && (members[low]?.end ?? 0) > node.end) {
        low += 1;
      }
      return low >= high ? NOTHING : ((1n << BigInt(high - low)) - 1n) << BigInt(low);
    };
    const indexes = new Map(members.map((one, at) => [one, at]));
    const walk = flowWalk({
      inside,
      at: (statement) => {
        const index = indexes.get(statement);
        return index === undefined ? NOTHING : 1n << BigInt(index);
      },
      writes: [],
      ends,
    });
    const reached = walk.sequence(statements, NOTHING, {
      exit: NOTHING,
      raise: NOTHING,
      escape: NOTHING,
      labels: new Map(),
    });
    const digits = reached.toString(2);
    members.forEach((member, at) => {
      if (digits[digits.length - 1 - at] !== "1") {
        unreached.add(member);
      }
    });
  }
  return unreached;
}

/** The value a case expression is a literal of, as a key two equal literals share, or none. */
function caseKey(expression: Node): string | undefined {
  const node = parenthesesRemoved(expression);
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
    return `s:${node.text}`;
  }
  if (isNumericLiteral(node)) {
    return `n:${String(Number(node.text))}`;
  }
  if (isBigIntLiteral(node)) {
    return `b:${BigInt(node.text.slice(0, -1)).toString()}`;
  }
  if (
    isPrefixUnaryExpression(node) &&
    node.operator === SyntaxKind.MinusToken &&
    isNumericLiteral(node.operand)
  ) {
    return `n:${String(-Number(node.operand.text))}`;
  }
  if (
    node.kind === SyntaxKind.TrueKeyword ||
    node.kind === SyntaxKind.FalseKeyword ||
    node.kind === SyntaxKind.NullKeyword
  ) {
    return `k:${String(node.kind)}`;
  }
  return undefined;
}

/** Every identifier below one node whose text one of the names spells as a reference. */
function identifiersNaming(node: Node, names: ReadonlySet<string>): Identifier[] {
  const found: Identifier[] = [];
  const visit = (at: Node): void => {
    if (isIdentifier(at)) {
      if (names.has(at.text) && !spellsNoBinding(at)) {
        found.push(at);
      }
      return;
    }
    at.forEachChild(visit);
  };
  visit(node);
  return found;
}

/** Whether one node is below another, or is it. */
function within(node: Node, container: Node): boolean {
  return node.pos >= container.pos && node.end <= container.end;
}

/** Whether a node is written inside a function nested in `outer`, which may run at any time. */
function inNestedFunction(node: Node, outer: Node): boolean {
  for (let at = node.parent; at !== outer; at = at.parent) {
    if (
      isArrowFunction(at) ||
      at.kind === SyntaxKind.FunctionExpression ||
      isFunctionDeclaration(at) ||
      isMethodDeclaration(at) ||
      isClassDeclaration(at) ||
      isClassExpression(at) ||
      at.kind === SyntaxKind.GetAccessor ||
      at.kind === SyntaxKind.SetAccessor ||
      at.kind === SyntaxKind.Constructor
    ) {
      return true;
    }
  }
  return false;
}

/** The nearest function around one node whose `arguments` object it names: an arrow has none. */
function ownArgumentsOf(node: Node): Node | undefined {
  for (let at = node.parent; !isSourceFile(at); at = at.parent) {
    if (isFunctionLikeDeclaration(at) && !isArrowFunction(at)) {
      return at;
    }
  }
  return undefined;
}

/** Whether a body is a stub: it holds no statement, or nothing but `throw` statements. */
function isStub(signature: SignatureNode): boolean {
  const body = signature.body;
  return body !== undefined && isBlock(body) && body.statements.every(isThrowStatement);
}

/** Whether a function's body or signature returns a value: an expression body, or `return` with one. */
function returnsAValue(signature: SignatureNode): boolean {
  const body = signature.body;
  if (body === undefined) {
    return false;
  }
  if (!isBlock(body)) {
    return true;
  }
  let found = false;
  const visit = (node: Node): void => {
    if (found || inNestedFunction(node, signature)) {
      return;
    }
    if (isReturnStatement(node) && node.expression !== undefined) {
      found = true;
      return;
    }
    node.forEachChild(visit);
  };
  body.forEachChild(visit);
  return found;
}

/** Whether one node is written with a modifier of one kind. */
function hasModifier(node: Node, kind: SyntaxKind): boolean {
  return ((node as { readonly modifiers?: readonly Node[] }).modifiers ?? []).some(
    (modifier) => modifier.kind === kind,
  );
}

/** The types the project's `extends` and `implements` clauses name. */
interface Heritage {
  /** The symbol each clause resolves to, an import alias followed to what it names. */
  readonly ids: ReadonlySet<number>;
  /** Every name a clause spells, read where the checker leaves a class's own symbol unanswered. */
  readonly names: ReadonlySet<string>;
  /**
   * The names of the clauses the checker left unanswered, which may name any class. A clause
   * it resolved to nothing names no class of the program.
   */
  readonly unanswered: ReadonlySet<string>;
}

/** How many alias links a heritage name is followed through, one per re-export. */
const ALIAS_DEPTH = 16;

/** The last identifier of one heritage type: a class's clause holds expressions, an interface's may hold type references. */
function heritageName(type: Node): Identifier | undefined {
  if (isTypeReferenceNode(type)) {
    const named = isQualifiedName(type.typeName) ? type.typeName.right : type.typeName;
    return isIdentifier(named) ? named : undefined;
  }
  return isExpressionWithTypeArguments(type) ? spelledName(type.expression) : undefined;
}

/** What every heritage clause of the project's files names, asked of the checker in one batch. */
function heritageOf<Brand>(project: ProjectView<Brand>, files: readonly SourceFile[]): Heritage {
  const named: Identifier[] = [];
  const visit = (node: Node): void => {
    if (isHeritageClause(node)) {
      named.push(...node.types.flatMap((type) => heritageName(type) ?? []));
    }
    node.forEachChild(visit);
  };
  for (const file of files) {
    file.forEachChild(visit);
  }
  const ids = new Set<number>();
  const unanswered = new Set<string>();
  project.symbolsAt(named.map((name) => project.handle(name))).forEach((answer, at) => {
    let symbol: Answer<TSSymbol | undefined> = answer;
    for (
      let step = 0;
      step < ALIAS_DEPTH && symbol !== undefined && symbol !== UNANSWERED;
      step++
    ) {
      const next = project.aliasStepOf(symbol);
      if (next === undefined) {
        break;
      }
      symbol = next;
    }
    if (symbol === UNANSWERED) {
      unanswered.add(named[at]?.text ?? "");
    } else if (symbol !== undefined) {
      ids.add(symbol.id);
    }
  });
  return { ids, names: new Set(named.map((name) => name.text)), unanswered };
}

/** The names a class is known by: its own, and the variable a class expression initializes. */
function classNames(owner: Node): readonly Identifier[] {
  const own = (owner as { readonly name?: Node }).name;
  const holder = isClassExpression(owner) ? outerParent(owner) : undefined;
  const held = holder !== undefined && isVariableDeclaration(holder) ? holder.name : undefined;
  return [own, held].filter((name): name is Identifier => name !== undefined && isIdentifier(name));
}

/**
 * Whether a class hierarchy fixes one method's signature: its class extends or implements
 * another type, is abstract, or is a type a clause of the project extends or implements,
 * or the method is marked `override`.
 */
function hierarchyFixes(
  declared: Node,
  heritage: Heritage,
  ids: ReadonlyMap<Node, Answer<number>>,
): boolean {
  if (!isMethodDeclaration(declared)) {
    return false;
  }
  const owner = declared.parent;
  if (!isClassDeclaration(owner) && !isClassExpression(owner)) {
    return false;
  }
  if (
    hasModifier(declared, SyntaxKind.OverrideKeyword) ||
    hasModifier(owner, SyntaxKind.AbstractKeyword) ||
    (owner.heritageClauses ?? []).length > 0
  ) {
    return true;
  }
  return classNames(owner).some((name) => {
    const id = ids.get(name);
    return id === undefined || id === UNANSWERED
      ? heritage.names.has(name.text)
      : heritage.ids.has(id) || heritage.unanswered.has(name.text);
  });
}

/** Whether a decorator on a constructor's class or on one of its parameters fixes its signature. */
function decoratorFixes(constructor: ConstructorDeclaration): boolean {
  const owner = constructor.parent;
  return (
    ((owner as { readonly modifiers?: readonly Node[] }).modifiers ?? []).some(isDecorator) ||
    constructor.parameters.some((parameter) =>
      ((parameter as { readonly modifiers?: readonly Node[] }).modifiers ?? []).some(isDecorator),
    )
  );
}

/** The name an expression spells a class by: an identifier, or the member a property access names. */
function spelledName(expression: Node): Identifier | undefined {
  const node = parenthesesRemoved(expression);
  if (isIdentifier(node)) {
    return node;
  }
  return isPropertyAccessExpression(node) && isIdentifier(node.name) ? node.name : undefined;
}

/**
 * The names one node writes that use a class without using its constructor as a value:
 * the class a `new` expression calls, the class an `extends` or `implements` clause
 * names, and the name a type reference spells.
 */
function constructionNames(node: Node): readonly Identifier[] {
  if (isNewExpression(node)) {
    return [spelledName(node.expression) ?? []].flat();
  }
  if (
    isHeritageClause(node) &&
    (isClassDeclaration(node.parent) || isClassExpression(node.parent))
  ) {
    return node.types.flatMap((type) =>
      isTypeReferenceNode(type) ? [] : (spelledName(type.expression) ?? []),
    );
  }
  if (isTypeReferenceNode(node)) {
    const named = isQualifiedName(node.typeName) ? node.typeName.right : node.typeName;
    return isIdentifier(named) ? [named] : [];
  }
  return [];
}

/** One declaration of the inventory that declares a function, and that function. */
interface Declared {
  readonly id: string;
  readonly node: Node;
  readonly signature: SignatureNode;
}

/**
 * The symbol identifier each of a batch of identifiers resolves to, where the batch
 * resolves it, and {@link UNANSWERED} where the checker did not answer.
 */
function resolvedIds<Brand>(
  project: ProjectView<Brand>,
  nodes: readonly Identifier[],
): ReadonlyMap<Node, Answer<number>> {
  const ids = new Map<Node, Answer<number>>();
  project.symbolsAt(nodes.map((node) => project.handle(node))).forEach((symbol, index) => {
    const node = nodes[index];
    if (node !== undefined && symbol !== undefined) {
      ids.set(node, symbol === UNANSWERED ? UNANSWERED : symbol.id);
    }
  });
  return ids;
}

/**
 * Whether one identifier reads the binding a name node declares: it resolves to the
 * same symbol, or the checker resolves it to nothing or does not answer for either
 * name, which is read as a use rather than risk a finding; a shorthand property reads
 * the binding of its own name.
 */
function readsBinding(
  use: Identifier,
  declared: Identifier,
  ids: ReadonlyMap<Node, Answer<number>>,
): boolean {
  if (isShorthandPropertyAssignment(use.parent)) {
    return true;
  }
  const at = ids.get(use);
  const own = ids.get(declared);
  return at === undefined || at === UNANSWERED || own === UNANSWERED || at === own;
}

/** A function written as a value that no inventory declaration declares, and what holds it. */
interface ValueFunction {
  readonly holder: string;
  readonly signature: SignatureNode;
}

/** One name a parameter binds, whole or through a binding pattern. */
interface ParameterName {
  readonly name: Identifier;
  /** The parameter's index in its list. */
  readonly at: number;
  readonly pattern: boolean;
  /**
   * Whether the name is never reported: it is spelled declared unread, or it stands beside a
   * rest element of its object pattern, whose removal changes what the rest holds.
   */
  readonly exempt: boolean;
}

/** Whether a name is spelled with a leading underscore, which declares it unread. */
function declaredUnread(name: Identifier): boolean {
  return name.text.startsWith("_");
}

/** A file's leading comments, where the compiler reads its `@ts-check` and `@ts-nocheck` pragmas. */
const LEADING_COMMENTS = /^(?:#![^\n]*)?(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/u;

/** A comment of the leading comments, a line comment's text after its slashes captured. */
const LEADING_COMMENT = /\/\*[\s\S]*?\*\/|\/\/\/?([^\n]*)/gu;

/**
 * Whether a file's leading comments hold one pragma: as the compiler reads it, a line
 * comment that starts with the pragma's name, in any case, followed by nothing or a space.
 */
function hasPragma(leading: string, pragma: RegExp): boolean {
  return [...leading.matchAll(LEADING_COMMENT)].some(
    ([, text]) => text !== undefined && pragma.test(text),
  );
}

/**
 * Whether the compiler checks a file, so its rules report what they find there: a
 * JavaScript file only under `checkJs` or a `@ts-check` pragma, and no file with a
 * `@ts-nocheck` pragma.
 */
function checkedByTheCompiler(file: SourceFile, checkJs: boolean): boolean {
  const leading = LEADING_COMMENTS.exec(file.text)?.[0] ?? "";
  if (hasPragma(leading, /^\s*@ts-nocheck(?:\s|$)/iu)) {
    return false;
  }
  return (
    !/\.[cm]?jsx?$/u.test(file.fileName) || checkJs || hasPragma(leading, /^\s*@ts-check(?:\s|$)/iu)
  );
}

/** Whether one child of a node is a statement it runs in no statement list: a branch or a body. */
function inStatementPosition(node: Node, child: Node): boolean {
  if (isIfStatement(node)) {
    return child === node.thenStatement || child === node.elseStatement;
  }
  // The body of a `do`, a label, a `for…of`, a `for…in` or a `with` runs whenever its
  // statement does, so only these can start an unreachable run of their own.
  return (isWhileStatement(node) || isForStatement(node)) && child === node.statement;
}

/** What one file's walk collects before the batch that resolves its names. */
interface FileWalk {
  readonly declared: Declared[];
  readonly values: ValueFunction[];
  readonly catches: {
    readonly clause: CatchClause;
    readonly name: Identifier;
    readonly holder: string;
  }[];
  readonly blocks: Block[];
  /** The loops whose `let` or `const` variables each iteration writes. */
  readonly loops: { readonly loop: ForOfStatement | ForInStatement; readonly holder: string }[];
  readonly unreachable: { readonly statement: Statement; readonly holder: string }[];
  readonly cases: { readonly clause: Node; readonly text: string; readonly holder: string }[];
}

/**
 * The parts of one project's own declarations. `references` are the project's own
 * references, which say which declarations a discarded call reaches, so the checker is
 * asked for a result's type only where a call discards it.
 */
export function projectParts<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  references: readonly Reference[],
  targetRoot: string,
): ProjectParts {
  const files = project.ownSourceFiles();
  const heritage = heritageOf(project, files);
  const parts: PartFact[] = [];
  const signatures: SignatureFact[] = [];
  const calls = new Map<string, CallUse>();
  const specifiers = new Set<string>();
  const constructions = new Set<string>();
  const sites: { readonly file: SourceFile; readonly declared: Declared }[] = [];
  const contextual: ContextualParameter[] = [];
  const imports: ImportFact[] = [];
  const refs = new Map(held.symbols.map((symbol) => [symbol.id, symbol.ref]));
  const options = project.program.getCompilerOptions();
  const jsx = options as JsxOptions;
  // The compiler's `shouldPreserveConstEnums`, whose isolated modules include `verbatimModuleSyntax`.
  const constEnumsPreserved =
    options.preserveConstEnums === true ||
    options.isolatedModules === true ||
    options.verbatimModuleSyntax === true;
  const ends = neverReturning(project, files);
  const judged = new Set<string>();

  for (const file of files) {
    judged.add(renderPosition(file, targetRoot, 0).path);
    const checked = checkedByTheCompiler(file, options.checkJs === true);
    // A parameter property's own parts stay with the parameter when its member goes.
    const declarationAt = (node: Node): string | undefined =>
      isParameterProperty(node) ? undefined : held.declarations.get(nodeKey(file, node));
    // A part no declaration holds belongs to the file, which is judged while the file is live.
    const fileId = held.declarations.get(nodeKey(file, file));
    const holderOf = (node: Node): string | undefined => {
      for (let at = node.parent; at.kind !== SyntaxKind.SourceFile; at = at.parent) {
        const id = declarationAt(at);
        if (id !== undefined) {
          return id;
        }
      }
      return fileId;
    };
    const walk: FileWalk = {
      declared: [],
      values: [],
      catches: [],
      blocks: [],
      loops: [],
      unreachable: [],
      cases: [],
    };
    const covered = new Set<Node>();
    const position = (node: Node): string =>
      positionKey(renderPosition(file, targetRoot, node.getStart()));

    // Code inside a run of unreachable statements is still walked for its calls and
    // specifiers, and reports no part of its own: the run's first statement is the one
    // finding, as the compiler reports one diagnostic per run.
    const unreached = unreachedOf(file, ends);
    const unreachable = (statement: Statement): boolean =>
      unreached.has(statement) && reportable(statement, constEnumsPreserved);
    let silenced = 0;
    const statementsOf = (statements: readonly Statement[]): void => {
      let inRun = false;
      for (const statement of statements) {
        const unreached = unreachable(statement);
        const holder = unreached && !inRun && silenced === 0 ? holderOf(statement) : undefined;
        if (holder !== undefined) {
          walk.unreachable.push({ statement, holder });
        }
        inRun = unreached;
        silenced += unreached ? 1 : 0;
        visit(statement);
        silenced -= unreached ? 1 : 0;
      }
    };
    const visit = (node: Node): void => {
      const id = declarationAt(node);
      const signature = id === undefined ? undefined : signatureOf(node);
      if (id !== undefined && signature !== undefined) {
        walk.declared.push({ id, node, signature });
        covered.add(signature);
      }
      // A constructor is no declaration, so the class it belongs to holds its parts.
      const constructs =
        isConstructorDeclaration(node) && node.body !== undefined
          ? declarationAt(node.parent)
          : undefined;
      if (constructs !== undefined && isConstructorDeclaration(node)) {
        walk.declared.push({ id: constructs, node, signature: node });
        covered.add(node);
      }
      for (const name of constructionNames(node)) {
        constructions.add(position(name));
      }
      const value = covered.has(node) ? undefined : valueSignature(node);
      const valueHolder = id ?? holderOf(node);
      if (value !== undefined && valueHolder !== undefined && !isStub(value)) {
        walk.values.push({ holder: valueHolder, signature: value });
      }
      if (isCatchClause(node) && node.variableDeclaration !== undefined) {
        const name = node.variableDeclaration.name;
        const holder = holderOf(node);
        if (isIdentifier(name) && holder !== undefined && silenced === 0) {
          walk.catches.push({ clause: node, name, holder });
        }
      }
      if (isCallExpression(node)) {
        const name = calleeName(node);
        if (name !== undefined) {
          calls.set(position(name), callUse(node));
        }
      }
      if (isImportSpecifier(node) || isExportSpecifier(node)) {
        for (const name of [node.propertyName, node.name]) {
          if (name !== undefined) {
            specifiers.add(position(name));
          }
        }
      }
      if ((isImportClause(node) || isNamespaceImport(node)) && node.name !== undefined) {
        specifiers.add(position(node.name));
      }
      if (isExportAssignment(node) && isIdentifier(parenthesesRemoved(node.expression))) {
        specifiers.add(position(parenthesesRemoved(node.expression)));
      }
      if (isSwitchStatement(node)) {
        const holder = holderOf(node);
        const seen = new Set<string>();
        for (const clause of node.caseBlock.clauses) {
          if (!isCaseClause(clause)) {
            continue;
          }
          const key = caseKey(clause.expression);
          if (key !== undefined && seen.has(key) && holder !== undefined && silenced === 0) {
            walk.cases.push({ clause, text: clause.expression.getText(), holder });
          }
          if (key !== undefined) {
            seen.add(key);
          }
        }
      }
      // A block whose first statement no flow reaches is never entered: the compiler
      // reports the run from inside it, and its locals hold no store of their own.
      if (
        isBlock(node) &&
        silenced === 0 &&
        (node.statements[0] === undefined || !unreachable(node.statements[0])) &&
        holderOf(node) !== undefined
      ) {
        walk.blocks.push(node);
      }
      const loopHolder =
        (isForOfStatement(node) || isForInStatement(node)) && silenced === 0
          ? holderOf(node)
          : undefined;
      if (
        loopHolder !== undefined &&
        (isForOfStatement(node) || isForInStatement(node)) &&
        isVariableDeclarationList(node.initializer) &&
        (node.initializer.flags & (NodeFlags.Let | NodeFlags.Const)) !== 0
      ) {
        walk.loops.push({ loop: node, holder: loopHolder });
      }
      if (isBlock(node) || isCaseClause(node) || isDefaultClause(node) || isModuleBlock(node)) {
        statementsOf(node.statements);
        return;
      }
      // A statement that is a branch or a body of another, in no list, is a run of its own.
      node.forEachChild((child) => {
        if (inStatementPosition(node, child)) {
          statementsOf([child as Statement]);
        } else {
          visit(child);
        }
      });
    };
    statementsOf(file.statements);

    // One batch per file resolves every name a parameter or a local is read through.
    const asked: Identifier[] = [];
    const readers = new Map<SignatureNode, { names: ParameterName[]; uses: Identifier[] }>();
    for (const signature of [
      ...walk.declared.map((one) => one.signature),
      ...walk.values.map((one) => one.signature),
    ]) {
      const names = parameterNames(signature);
      const declaredNames = new Set<Node>(names.map((one) => one.name));
      const spelled = new Set(names.map((one) => one.name.text));
      const uses = identifiersNaming(signature, spelled).filter((use) => !declaredNames.has(use));
      readers.set(signature, { names, uses });
      asked.push(...names.map((one) => one.name), ...uses);
    }
    const caught = walk.catches.map(({ clause, name }) =>
      identifiersNaming(clause.block, new Set([name.text])),
    );
    walk.catches.forEach(({ name }, at) => {
      asked.push(name, ...(caught[at] ?? []));
    });
    const stores = walk.blocks.map((block) => localsOf(block));
    for (const store of stores) {
      asked.push(...store.flatMap((local) => [local.name, ...local.uses]));
    }
    const loopVariables = walk.loops.map(({ loop, holder }) => {
      const list = loop.initializer as VariableDeclarationList;
      // A loop must bind a name, so one spelled declared unread is no subject.
      const names = list.declarations
        .flatMap((declaration) => boundNames(declaration.name))
        .filter((name) => !declaredUnread(name));
      const uses = identifiersNaming(loop.statement, new Set(names.map((one) => one.text)));
      asked.push(...names, ...uses);
      return { names, uses, holder };
    });
    const measured = lengthReads(file);
    const measuredNames = new Set(measured.map((one) => one.text));
    const named = walk.declared.flatMap(({ node }) => {
      const name = (node as { readonly name?: Node }).name;
      return name !== undefined && isIdentifier(name) && measuredNames.has(name.text) ? [name] : [];
    });
    asked.push(...measured, ...named);
    const owners = walk.declared.flatMap(({ node }) =>
      isMethodDeclaration(node) ? classNames(node.parent) : [],
    );
    asked.push(...owners);
    const bindings = fileId === undefined ? [] : importBindings(file);
    const bound = new Set<Node>(bindings);
    const bindingUses =
      bindings.length === 0
        ? []
        : identifiersNaming(file, new Set(bindings.map((one) => one.text))).filter(
            (use) => !bound.has(use),
          );
    asked.push(...bindings, ...bindingUses);
    const ids = resolvedIds(project, [...new Set(asked)]);
    const implicit = bindings.length === 0 ? new Set<string>() : implicitReads(file, jsx);
    for (const binding of bindings) {
      const fileRef = fileId === undefined ? undefined : refs.get(fileId);
      if (fileId === undefined || fileRef === undefined) {
        continue;
      }
      imports.push({
        ref: importRef(fileRef, binding.text),
        name: binding.text,
        position: spanOf(file, targetRoot, binding),
        used:
          implicit.has(binding.text) ||
          bindingUses.some(
            (use) =>
              use.text === binding.text && (exportsLocally(use) || readsBinding(use, binding, ids)),
          ),
      });
    }

    for (const one of walk.declared) {
      const constructor = isConstructorDeclaration(one.node);
      if (!constructor) {
        sites.push({ file, declared: one });
      }
      signatures.push({
        declaration: one.id,
        stub: isStub(one.signature),
        fixed: constructor ? decoratorFixes(one.node) : hierarchyFixes(one.node, heritage, ids),
        constructor,
      });
      const reader = readers.get(one.signature);
      if (reader !== undefined && !lengthRead(one.node, measured, ids)) {
        const found = parameterParts(file, targetRoot, one.id, one.signature, reader, ids, {
          inValue: false,
          checked,
        });
        parts.push(...found.parts);
        contextual.push(...found.contextual);
      }
    }
    for (const one of walk.values) {
      const reader = readers.get(one.signature);
      if (reader !== undefined) {
        const found = parameterParts(file, targetRoot, one.holder, one.signature, reader, ids, {
          inValue: true,
          checked,
        });
        parts.push(...found.parts);
        contextual.push(...found.contextual);
      }
    }
    const part = (declaration: string, kind: PartKind, name: string, node: Node): PartFact => ({
      declaration,
      kind,
      name,
      position: spanOf(file, targetRoot, node),
    });
    walk.catches.forEach(({ name, holder }, at) => {
      if (!(caught[at] ?? []).some((use) => readsBinding(use, name, ids))) {
        parts.push(part(holder, "store", name.text, name));
      }
    });
    for (const { names, uses, holder } of loopVariables) {
      for (const name of names) {
        if (!uses.some((use) => use.text === name.text && readsBinding(use, name, ids))) {
          parts.push(part(holder, "store", name.text, name));
        }
      }
    }
    walk.blocks.forEach((block, at) => {
      const holder = holderOf(block);
      if (holder !== undefined) {
        for (const { local, target } of deadStores(block, stores[at] ?? [], ids, ends)) {
          parts.push(part(holder, "store", local.name.text, target));
        }
      }
    });
    for (const { statement, holder } of walk.unreachable) {
      parts.push(part(holder, "statement", "statement", statement));
    }
    for (const { clause, text, holder } of walk.cases) {
      parts.push(part(holder, "case", text, clause));
    }
  }

  const results = resultParts(project, targetRoot, sites, references, calls);
  return {
    // Only a result reads whether outside callers can reach its declaration.
    published: results.parts.length === 0 ? new Set() : importable(project, held, targetRoot),
    parts: [...withContextualRead(project, parts, contextual), ...results.parts],
    imports,
    signatures,
    calls,
    specifiers,
    constructions,
    files: judged,
    results: results.judged,
  };
}

/** Every identifier of one file whose `length` a property access reads. */
function lengthReads(file: SourceFile): readonly Identifier[] {
  const found: Identifier[] = [];
  const visit = (node: Node): void => {
    if (isPropertyAccessExpression(node) && node.name.text === "length") {
      const read = parenthesesRemoved(node.expression);
      if (isIdentifier(read)) {
        found.push(read);
      }
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return found;
}

/**
 * Whether the program reads the `length` of one declared function through its own binding,
 * which counts its parameters, so none can go. A read the checker leaves unanswered counts.
 */
function lengthRead(
  declared: Node,
  measured: readonly Identifier[],
  ids: ReadonlyMap<Node, Answer<number>>,
): boolean {
  const name = (declared as { readonly name?: Node }).name;
  if (name === undefined || !isIdentifier(name)) {
    return false;
  }
  const own = ids.get(name);
  return measured.some((read) => {
    if (read.text !== name.text) {
      return false;
    }
    const at = ids.get(read);
    return (
      at === undefined || at === UNANSWERED || own === undefined || own === UNANSWERED || at === own
    );
  });
}

/**
 * Every declaration an outside importer of any of the project's own files can name, as the
 * published-API reach states it with each file published, and each one it guessed.
 */
function importable<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  targetRoot: string,
): ReadonlySet<string> {
  const files = sourceFilesOf(project, targetRoot);
  const exported = new Map<string, string[]>();
  for (const symbol of held.symbols) {
    if (symbol.exported) {
      exported.set(symbol.parent, [...(exported.get(symbol.parent) ?? []), symbol.id]);
    }
  }
  const own = [...files.byName.values()];
  const exportsOf = new Map(
    own.map((file) => [
      file.fileName,
      exported.get(held.declarations.get(nodeKey(file, file)) ?? "") ?? [],
    ]),
  );
  const api = publishedAPI(project, own, exportsOf, held, files.byPath, []);
  return new Set([...api.ids, ...api.guessed]);
}

/**
 * A function written in place that no declaration declares: an arrow, a function
 * expression, a nested function declaration, or a method of an object literal.
 */
function valueSignature(node: Node): SignatureNode | undefined {
  if (isArrowFunction(node) || isFunctionExpression(node)) {
    return node;
  }
  if (isFunctionDeclaration(node)) {
    return node.body === undefined ? undefined : node;
  }
  return isMethodDeclaration(node) &&
    node.body !== undefined &&
    isObjectLiteralExpression(node.parent)
    ? node
    : undefined;
}

/**
 * Every name one function's parameters bind, a binding pattern's names one by one. A
 * `this` parameter receives no argument, a decorated one is read by its decorator, and a
 * parameter property is read by the write to its member, so none binds a subject. A name
 * spelled with a leading underscore is declared unread, so it is listed for its reads and
 * reported never.
 */
function parameterNames(signature: SignatureNode): ParameterName[] {
  const found: ParameterName[] = [];
  const patternNames = (pattern: Exclude<BindingName, Identifier>, at: number): void => {
    const rest =
      isObjectBindingPattern(pattern) &&
      pattern.elements.some((element) => element.dotDotDotToken !== undefined);
    for (const element of pattern.elements) {
      if (!isBindingElement(element) || element.name === undefined) {
        continue;
      }
      if (isIdentifier(element.name)) {
        const exempt =
          (rest && element.dotDotDotToken === undefined) || declaredUnread(element.name);
        found.push({ name: element.name, at, pattern: true, exempt });
      } else {
        patternNames(element.name, at);
      }
    }
  };
  signature.parameters.forEach((parameter, at) => {
    const name = parameter.name;
    if (
      ((parameter as { readonly modifiers?: readonly Node[] }).modifiers ?? []).some(isDecorator) ||
      isParameterProperty(parameter)
    ) {
      return;
    }
    if (isIdentifier(name)) {
      if (name.text !== "this") {
        found.push({ name, at, pattern: false, exempt: declaredUnread(name) });
      }
      return;
    }
    patternNames(name, at);
  });
  return found;
}

/** An unread name of a parameter that a contextual type of its function expression keeps. */
interface ContextualParameter {
  readonly part: PartFact;
  readonly signature: ArrowFunction | FunctionExpression;
  /** The parameter's index in its list. */
  readonly at: number;
  /** Whether the parameter is an object binding pattern, rather than an annotated name. */
  readonly pattern: boolean;
}

/** How deep a type is searched for a type parameter: a callback of a callback is two levels. */
const TYPE_PARAMETER_DEPTH = 3;

/** Whether one type is or holds a type parameter, through constituents, type arguments and signatures. */
function namesTypeParameter<Brand>(project: ProjectView<Brand>, type: Type, depth = 0): boolean {
  if (type.isTypeParameter()) {
    return true;
  }
  if (depth >= TYPE_PARAMETER_DEPTH) {
    return false;
  }
  const { queries } = project;
  const parts = type.isUnionType() || type.isIntersectionType() ? queries.constituents(type) : [];
  const args = queries.typeArguments(type);
  const signatures = queries.signaturesOf(type, SignatureKind.Call);
  if (!isAnswered(parts) || !isAnswered(args) || !isAnswered(signatures)) {
    return true;
  }
  const inner = [
    ...parts,
    ...args,
    ...signatures.flatMap((signature) =>
      signature.parameters.map((_parameter, at) => queries.typeAtPosition(signature, at)),
    ),
  ];
  return inner.some((one) => !isAnswered(one) || namesTypeParameter(project, one, depth + 1));
}

/**
 * Whether the call a function expression is written in may read the annotation of its
 * parameter at `at`: the callee is generic, and its parameter type at the function's place
 * reads a type parameter there. A function written inside an object literal a generic
 * call is passed is read so too, and a question the checker leaves unanswered reads it.
 */
function calleeSteers<Brand>(
  project: ProjectView<Brand>,
  signature: ArrowFunction | FunctionExpression,
  at: number,
): boolean {
  const { queries } = project;
  let value: Node = signature;
  while (isParenthesizedExpression(value.parent)) {
    value = value.parent;
  }
  let nested = false;
  while (
    (isPropertyAssignment(value.parent) && isObjectLiteralExpression(value.parent.parent)) ||
    isObjectLiteralExpression(value.parent)
  ) {
    value = isObjectLiteralExpression(value.parent) ? value.parent : value.parent.parent;
    nested = true;
  }
  const call = value.parent;
  if (!isCallExpression(call) && !isNewExpression(call)) {
    return false;
  }
  const argument = (call.arguments ?? []).findIndex((one) => one === value);
  const resolved = argument < 0 ? undefined : queries.resolvedSignature(call);
  const generic =
    resolved === undefined || !isAnswered(resolved) ? resolved : queries.genericOf(resolved);
  if (argument < 0 || generic === undefined) {
    return false;
  }
  if (!isAnswered(generic) || nested) {
    return true;
  }
  const position = queries.typeAtPosition(generic, argument);
  if (!isAnswered(position) || position.isTypeParameter()) {
    return true;
  }
  const parts =
    position.isUnionType() || position.isIntersectionType()
      ? queries.constituents(position)
      : [position];
  if (!isAnswered(parts)) {
    return true;
  }
  return parts.some((part) => {
    if (part.isTypeParameter()) {
      return true;
    }
    const calls = queries.signaturesOf(part, SignatureKind.Call);
    if (!isAnswered(calls)) {
      return true;
    }
    return calls.some((one) => {
      const type = at < one.parameters.length ? queries.typeAtPosition(one, at) : undefined;
      return type !== undefined && (!isAnswered(type) || namesTypeParameter(project, type));
    });
  });
}

/**
 * The parts with each name of `contextual` judged where the compiler gives its function a
 * contextual type: a name an object pattern binds is marked as one, and an annotated
 * parameter with whether the call's inference may read its annotation. A question the
 * checker leaves unanswered keeps the name read, so its part is dropped.
 */
function withContextualRead<Brand>(
  project: ProjectView<Brand>,
  parts: readonly PartFact[],
  contextual: readonly ContextualParameter[],
): readonly PartFact[] {
  if (contextual.length === 0) {
    return parts;
  }
  const signatures = [...new Set(contextual.map((one) => one.signature))];
  const answers = project.queries.contextualTypes(signatures);
  const typedBy = new Map(signatures.map((signature, at) => [signature, answers[at]]));
  const judged = new Map<PartFact, PartFact | undefined>();
  for (const one of contextual) {
    const answer = typedBy.get(one.signature);
    if (answer === undefined) {
      continue;
    }
    const place = one.part.parameter;
    judged.set(
      one.part,
      answer === UNANSWERED || place === undefined
        ? undefined
        : one.pattern
          ? { ...one.part, parameter: { ...place, contextualPattern: true } }
          : {
              ...one.part,
              parameter: {
                ...place,
                annotated: calleeSteers(project, one.signature, one.at) ? "steers" : "free",
              },
            },
    );
  }
  return parts.flatMap((part) => (judged.has(part) ? (judged.get(part) ?? []) : [part]));
}

/**
 * Each name one function's parameters bind that the function never reads, and those of
 * them a contextual type of a function expression may keep: the names of a parameter that
 * carries a type annotation or is an object binding pattern. A binding pattern counts as
 * read where its function reads any name it binds.
 */
function parameterParts(
  file: SourceFile,
  root: string,
  declaration: string,
  signature: SignatureNode,
  reader: { readonly names: readonly ParameterName[]; readonly uses: readonly Identifier[] },
  ids: ReadonlyMap<Node, Answer<number>>,
  place: Pick<ParameterPlace, "inValue" | "checked">,
): { readonly parts: PartFact[]; readonly contextual: ContextualParameter[] } {
  // A function that reads its `arguments` reads every parameter by position. A nested
  // function other than an arrow has an `arguments` object of its own.
  const readsArguments =
    !isArrowFunction(signature) &&
    identifiersNaming(signature, new Set(["arguments"])).some(
      (use) => ownArgumentsOf(use) === signature,
    );
  const read = reader.names.map(
    ({ name }) =>
      readsArguments ||
      reader.uses.some((use) => use.text === name.text && readsBinding(use, name, ids)),
  );
  const lastRead = Math.max(-1, ...reader.names.filter((_, at) => read[at]).map((one) => one.at));
  const found: PartFact[] = [];
  const contextual: ContextualParameter[] = [];
  const expression =
    isArrowFunction(signature) || isFunctionExpression(signature) ? signature : undefined;
  const length = signature.parameters.findIndex(
    (one) => one.initializer !== undefined || one.dotDotDotToken !== undefined,
  );
  reader.names.forEach(({ name, at, pattern, exempt }, index) => {
    if (exempt || read[index] === true) {
      return;
    }
    const part: PartFact = {
      declaration,
      kind: "parameter",
      name: name.text,
      position: spanOf(file, root, name),
      parameter: {
        beforeARead: !pattern && at < lastRead,
        counted: length < 0 || at < length,
        ...place,
      },
    };
    found.push(part);
    const parameter = signature.parameters[at];
    if (
      expression !== undefined &&
      parameter !== undefined &&
      (parameter.type !== undefined || isObjectBindingPattern(parameter.name))
    ) {
      contextual.push({
        part,
        signature: expression,
        at,
        pattern: isObjectBindingPattern(parameter.name),
      });
    }
  });
  return { parts: found, contextual };
}

/** One local a block declares by name, and every identifier of the block that spells it. */
interface Local {
  readonly name: Identifier;
  readonly statement: number;
  readonly initialized: boolean;
  readonly uses: readonly Identifier[];
  /** A `var` of a nested block, whose function scope outlives the block's end. */
  readonly outlives: boolean;
  /** A function declaration, written at the start of the block whatever its place. */
  readonly hoisted: boolean;
}

/**
 * The names one declaration binds that a write of its initializer stores each on its own:
 * the declared name, or each element name of a binding pattern at any depth. A name with a
 * default is left out, because removing it skips the default's evaluation, and so is a name
 * beside a rest element of its object pattern, whose removal changes what the rest holds.
 */
function boundNames(name: BindingName): readonly Identifier[] {
  if (isIdentifier(name)) {
    return [name];
  }
  const rest =
    isObjectBindingPattern(name) &&
    name.elements.some((element) => element.dotDotDotToken !== undefined);
  return name.elements.flatMap((element) => {
    if (!isBindingElement(element) || element.name === undefined) {
      return [];
    }
    if (element.initializer !== undefined || (rest && element.dotDotDotToken === undefined)) {
      return [];
    }
    return boundNames(element.name);
  });
}

/** The function whose scope a `var` of one block belongs to, or none at a module's top level. */
function functionOf(block: Block): FunctionLikeDeclaration | undefined {
  for (let at: Node = block.parent; ; at = at.parent) {
    if (isFunctionLikeDeclaration(at)) {
      return at;
    }
    if (isSourceFile(at)) {
      return undefined;
    }
  }
}

/**
 * The locals one block declares with `let`, `const`, `var` or a function declaration
 * inside a function, each with the names of the block that spell it. A `var` of a nested
 * block is one where no nested function of its function names it, since the function scope
 * holds it past the block's end.
 */
function localsOf(block: Block): readonly Local[] {
  const declared: {
    name: Identifier;
    statement: number;
    initialized: boolean;
    outlives: boolean;
    hoisted: boolean;
  }[] = [];
  const scope = functionOf(block);
  const outlives = scope?.body !== block;
  block.statements.forEach((statement, at) => {
    if (isFunctionDeclaration(statement)) {
      if (scope !== undefined && statement.name !== undefined && statement.body !== undefined) {
        declared.push({
          name: statement.name,
          statement: at,
          initialized: true,
          outlives: false,
          hoisted: true,
        });
      }
      return;
    }
    if (!isVariableStatement(statement)) {
      return;
    }
    const list = statement.declarationList;
    const blockScoped = (list.flags & (NodeFlags.Let | NodeFlags.Const)) !== 0;
    if ((!blockScoped && scope === undefined) || (list.flags & NodeFlags.Using) !== 0) {
      return;
    }
    for (const declaration of list.declarations) {
      // A write to a local typed `never` is the compiler's exhaustiveness check, which
      // fails to compile once a case goes unhandled.
      if (declaration.type?.kind === SyntaxKind.NeverKeyword) {
        continue;
      }
      for (const name of boundNames(declaration.name)) {
        if (
          !blockScoped &&
          outlives &&
          identifiersNaming(scope?.body ?? block, new Set([name.text])).some((use) =>
            inNestedFunction(use, scope ?? block),
          )
        ) {
          continue;
        }
        declared.push({
          name,
          statement: at,
          initialized: declaration.initializer !== undefined,
          outlives: !blockScoped && outlives,
          hoisted: false,
        });
      }
    }
  });
  if (declared.length === 0) {
    return [];
  }
  const spelled = identifiersNaming(block, new Set(declared.map((one) => one.name.text)));
  return declared.map((one) => ({
    ...one,
    uses: spelled.filter((use) => use !== one.name && use.text === one.name.text),
  }));
}

/** Whether one name is the whole target of a plain assignment, which writes it and reads nothing. */
function isPlainWrite(use: Identifier): boolean {
  const parent = outerParent(use);
  return (
    isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    parenthesesRemoved(parent.left) === use
  );
}

/**
 * What a path from one point reaches, one bit per target: for a judged local, the one bit
 * is a read before the next write; for a flow's statements, each statement has its own.
 */
type Reached = bigint;

const NOTHING: Reached = 0n;
const READ: Reached = 1n;

/** What a path reaches from where each jump out of the statement being walked lands. */
interface Targets {
  readonly exit: Reached;
  /** Where a `throw` lands, which any statement inside a `try` may also reach. */
  readonly raise: Reached;
  /** Where a jump with no target inside the walked statements lands. */
  readonly escape: Reached;
  readonly breaks?: Reached;
  readonly continues?: Reached;
  readonly labels: ReadonlyMap<string, { readonly breaks: Reached; readonly continues?: Reached }>;
}

/** What one walk of `flowWalk` asks about the statements it walks. */
interface Judged {
  /** The targets inside one node, which a path entering it reaches where the walk does not follow it. */
  readonly inside: (node: Node | undefined) => Reached;
  /** The target one statement is, where the walk asks which statements a path reaches. */
  readonly at: (statement: Statement) => Reached;
  /** The identifiers of the judged local, whose plain writes the walk records. */
  readonly writes: readonly Identifier[];
  /** The call statements that never return. */
  readonly ends: ReadonlySet<Node>;
}

/** Whether a block sits inside a `try` whose `catch` or `finally` runs after the block is left. */
function handledOutside(block: Block, scope: Node | undefined): boolean {
  for (let at: Node = block.parent; at !== scope && !isSourceFile(at); at = at.parent) {
    if (
      isTryStatement(at) &&
      (at.finallyBlock !== undefined ||
        (at.catchClause !== undefined && within(block, at.tryBlock)))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * What evaluating one expression may do: go each way as a condition, give `null` or
 * `undefined` (which goes `no`), and run code that may throw.
 */
interface Evaluation {
  readonly yes: boolean;
  readonly no: boolean;
  readonly nullish: boolean;
  readonly throws: boolean;
}

const UNEVALUATED: Evaluation = { yes: false, no: false, nullish: false, throws: false };

/** The literals whose evaluation runs no code. */
const LITERALS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.RegularExpressionLiteral,
]);

/**
 * One walk over an expression with JavaScript's short-circuit. It folds only the values the
 * binder folds (`bindCondition`): an absent part, and a bare `true` or `false` that is the
 * whole condition, an operand of `&&` or `||` or a `?:` condition, seen through `(` and `!`
 * only to a logical operator. The binder sends a falsy left operand of `??` to the right;
 * JavaScript and this walk end the `??` there.
 */
function evaluationOf(node: Node | undefined): Evaluation {
  if (node === undefined) {
    return { yes: true, no: false, nullish: false, throws: false };
  }
  const core = logicalCore(node);
  if (core === undefined) {
    const leaf = negationsRemoved(node);
    const literal = LITERALS.has(leaf.kind);
    const folded =
      (leaf.kind === SyntaxKind.TrueKeyword || leaf.kind === SyntaxKind.FalseKeyword) &&
      leaf === node &&
      !(
        isBinaryExpression(node.parent) &&
        node.parent.operatorToken.kind === SyntaxKind.QuestionQuestionToken
      );
    // The binder judges a `?:` whole, so it goes either way; a branch runs where its condition may go its way.
    const test = isConditionalExpression(leaf) ? evaluationOf(leaf.condition) : undefined;
    const branches =
      test !== undefined && isConditionalExpression(leaf)
        ? [...(test.yes ? [leaf.whenTrue] : []), ...(test.no ? [leaf.whenFalse] : [])].map(
            (branch) => evaluationOf(branch),
          )
        : undefined;
    return {
      yes: !folded || leaf.kind === SyntaxKind.TrueKeyword,
      no: !folded || leaf.kind === SyntaxKind.FalseKeyword,
      nullish:
        leaf === parenthesesRemoved(node) &&
        (branches?.some((one) => one.nullish) ??
          (!literal || leaf.kind === SyntaxKind.NullKeyword)),
      throws:
        test === undefined ? !literal : test.throws || (branches ?? []).some((one) => one.throws),
    };
  }
  if (isParenthesizedExpression(node)) {
    return evaluationOf(node.expression);
  }
  if (isPrefixUnaryExpression(node)) {
    const inner = evaluationOf(node.operand);
    return { yes: inner.no, no: inner.yes, nullish: false, throws: inner.throws };
  }
  const left = evaluationOf(core.left);
  const operator = core.operatorToken.kind;
  const runs =
    operator === SyntaxKind.AmpersandAmpersandToken
      ? left.yes
      : operator === SyntaxKind.BarBarToken
        ? left.no
        : left.nullish;
  const right = runs ? evaluationOf(core.right) : UNEVALUATED;
  return {
    yes: (operator !== SyntaxKind.AmpersandAmpersandToken && left.yes) || right.yes,
    no: (operator !== SyntaxKind.BarBarToken && left.no) || right.no,
    nullish: (operator === SyntaxKind.AmpersandAmpersandToken && left.nullish) || right.nullish,
    throws: left.throws || right.throws,
  };
}

/** One expression below any parentheses and `!` around it. */
function negationsRemoved(node: Node): Node {
  let at = node;
  while (
    isParenthesizedExpression(at) ||
    (isPrefixUnaryExpression(at) && at.operator === SyntaxKind.ExclamationToken)
  ) {
    at = isParenthesizedExpression(at) ? at.expression : at.operand;
  }
  return at;
}

/** The `&&`, `||` or `??` an expression is below any parentheses and `!`, if it is one. */
function logicalCore(node: Node): BinaryExpression | undefined {
  const core = negationsRemoved(node);
  return isBinaryExpression(core) &&
    [
      SyntaxKind.AmpersandAmpersandToken,
      SyntaxKind.BarBarToken,
      SyntaxKind.QuestionQuestionToken,
    ].includes(core.operatorToken.kind)
    ? core
    : undefined;
}

/**
 * One backward transfer over statements, which dead stores and unreachable statements share:
 * what a path from each statement's start reaches, given what one from its end reaches and
 * where its jumps land. A write is a plain assignment of the judged local that an expression
 * statement or a `for` head evaluates, or the bare name a `for…of` or `for…in` assigns; `live`
 * holds what a path from each write reaches. A node the walk does not follow reaches every
 * target inside it.
 */
function flowWalk(judged: Judged): {
  readonly sequence: (statements: readonly Statement[], after: Reached, to: Targets) => Reached;
  readonly record: (target: Identifier, after: Reached) => void;
  readonly live: ReadonlyMap<Identifier, Reached>;
} {
  const { inside: reads, writes, ends } = judged;
  const live = new Map<Identifier, Reached>();
  const record = (target: Identifier, after: Reached): void => {
    live.set(target, (live.get(target) ?? NOTHING) | after);
  };
  const fixpoint = (step: (head: Reached) => Reached): Reached => {
    let head = NOTHING;
    for (let next = step(head); next !== head; next = step(head)) {
      head = next;
    }
    return head;
  };
  const sequence = (statements: readonly Statement[], after: Reached, to: Targets): Reached =>
    statements.reduceRight((out, statement) => flow(statement, out, to), after);
  // A body run inline is a function's or a static block's: only `return` and a throw leave it,
  // so it starts with no break, continue or label target.
  const ran = (body: Block, after: Reached, exit: Reached, raise: Reached): Reached =>
    sequence(body.statements, after, { exit, raise, escape: NOTHING, labels: new Map() });
  // Every label of a chain such as `a: b: while` names the loop, so each one continues it.
  const looped = (
    to: Targets,
    after: Reached,
    head: Reached,
    chain: readonly string[],
  ): Targets => ({
    ...to,
    breaks: after,
    continues: head,
    labels: new Map([
      ...to.labels,
      ...chain.map((label) => [label, { breaks: after, continues: head }] as const),
    ]),
  });
  const when = (condition: boolean, reached: Reached): Reached => (condition ? reached : NOTHING);
  // Code that may throw reaches `raise`, where a throw lands, before it writes anything.
  const thrown = (node: Node | undefined, raise: Reached): Reached =>
    when(evaluationOf(node).throws, raise);
  // A comma's operands run in turn, so a throw in the right one follows the left one's write.
  // A store to the local, whose declaration has run, throws only where its value does.
  const evaluated = (node: Node | undefined, after: Reached, raise: Reached): Reached => {
    const expression = node === undefined ? undefined : parenthesesRemoved(node);
    if (
      expression !== undefined &&
      isBinaryExpression(expression) &&
      expression.operatorToken.kind === SyntaxKind.CommaToken
    ) {
      return evaluated(expression.left, evaluated(expression.right, after, raise), raise);
    }
    const target =
      expression !== undefined &&
      isBinaryExpression(expression) &&
      expression.operatorToken.kind === SyntaxKind.EqualsToken
        ? parenthesesRemoved(expression.left)
        : undefined;
    if (
      expression === undefined ||
      !isBinaryExpression(expression) ||
      target === undefined ||
      !isIdentifier(target) ||
      !writes.includes(target)
    ) {
      return reads(expression) | after | thrown(expression, raise);
    }
    record(target, after);
    return reads(expression.right) | thrown(expression.right, raise);
  };
  // A statement may throw where it starts, before it writes anything, but entering a block
  // runs nothing. A part a statement runs again, or after a write of its own, gets its own
  // throw edge.
  const flow = (
    node: Statement,
    after: Reached,
    to: Targets,
    chain: readonly string[] = [],
  ): Reached => judged.at(node) | transfer(node, after, to, chain) | when(!isBlock(node), to.raise);
  const transfer = (
    node: Statement,
    after: Reached,
    to: Targets,
    chain: readonly string[],
  ): Reached => {
    if (isBlock(node)) {
      return sequence(node.statements, after, to);
    }
    if (isExpressionStatement(node)) {
      const [body] = runsInline(node);
      const call = parenthesesRemoved(node.expression);
      if (body !== undefined && isCallExpression(call)) {
        // The arguments run first, then the body, whose `return` ends the call.
        return call.arguments.reduce(
          (out, argument) => out | reads(argument),
          ran(body, after, after, to.raise),
        );
      }
      return evaluated(node.expression, ends.has(node) ? NOTHING : after, to.raise);
    }
    if (isClassDeclaration(node)) {
      return runsInline(node).reduceRight((out, body) => ran(body, out, NOTHING, to.raise), after);
    }
    if (isIfStatement(node)) {
      const then = flow(node.thenStatement, after, to);
      const otherwise =
        node.elseStatement === undefined ? after : flow(node.elseStatement, after, to);
      const way = evaluationOf(node.expression);
      return reads(node.expression) | when(way.yes, then) | when(way.no, otherwise);
    }
    if (isLabeledStatement(node)) {
      const labels = new Map([...to.labels, [node.label.text, { breaks: after }]]);
      return flow(node.statement, after, { ...to, labels }, [...chain, node.label.text]);
    }
    if (isWithStatement(node)) {
      return reads(node.expression) | flow(node.statement, after, to);
    }
    if (isWhileStatement(node) || isDoStatement(node)) {
      const way = evaluationOf(node.expression);
      const test = fixpoint((head) => {
        const body = flow(node.statement, head, looped(to, after, head, chain));
        return (
          reads(node.expression) |
          when(way.no, after) |
          when(way.yes, body) |
          thrown(node.expression, to.raise)
        );
      });
      return isDoStatement(node)
        ? flow(node.statement, test, looped(to, after, test, chain))
        : test;
    }
    if (isForStatement(node)) {
      const way = evaluationOf(node.condition);
      const head = fixpoint((at) => {
        const next = evaluated(node.incrementor, at, to.raise);
        const body = flow(node.statement, next, looped(to, after, next, chain));
        return (
          reads(node.condition) |
          when(way.no, after) |
          when(way.yes, body) |
          thrown(node.condition, to.raise)
        );
      });
      return node.initializer !== undefined && isVariableDeclarationList(node.initializer)
        ? reads(node.initializer) | head
        : evaluated(node.initializer, head, to.raise);
    }
    if (isForOfStatement(node) || isForInStatement(node)) {
      const target = parenthesesRemoved(node.initializer);
      const assigned = isIdentifier(target) && writes.includes(target) ? target : undefined;
      // The iterator runs on each pass through the head and may throw.
      const head = fixpoint((at) => {
        const body = flow(node.statement, at, looped(to, after, at, chain));
        if (assigned === undefined) {
          return reads(node.initializer) | after | body | to.raise;
        }
        record(assigned, body);
        return after | to.raise;
      });
      return reads(node.expression) | head;
    }
    if (isSwitchStatement(node)) {
      const inside: Targets = { ...to, breaks: after };
      let next = after;
      let entered = NOTHING;
      for (const clause of node.caseBlock.clauses.toReversed()) {
        next = sequence(clause.statements, next, inside);
        entered |= next | (isCaseClause(clause) ? reads(clause.expression) : NOTHING);
      }
      const total = node.caseBlock.clauses.some(isDefaultClause);
      return reads(node.expression) | entered | when(!total, after);
    }
    if (isBreakStatement(node) || isContinueStatement(node)) {
      const named = node.label === undefined ? undefined : to.labels.get(node.label.text);
      const target = isBreakStatement(node)
        ? node.label === undefined
          ? to.breaks
          : named?.breaks
        : node.label === undefined
          ? to.continues
          : named?.continues;
      return target ?? to.escape;
    }
    if (isReturnStatement(node)) {
      return reads(node.expression) | to.exit;
    }
    if (isThrowStatement(node)) {
      return reads(node.expression) | to.raise;
    }
    if (isTryStatement(node)) {
      const final = node.finallyBlock;
      // The finally block's entry depends only on what a path from where it continues
      // reaches, so it is computed at most once for each answer.
      const entries = new Map<Reached, Reached>();
      const through = (reached: Reached): Reached => {
        if (final === undefined) {
          return reached;
        }
        const known = entries.get(reached) ?? sequence(final.statements, reached, to);
        entries.set(reached, known);
        return known;
      };
      const map = (one: { readonly breaks: Reached; readonly continues?: Reached }) => ({
        breaks: through(one.breaks),
        ...(one.continues === undefined ? {} : { continues: through(one.continues) }),
      });
      const outer: Targets = {
        exit: through(to.exit),
        raise: through(to.raise),
        escape: through(to.escape),
        ...(to.breaks === undefined ? {} : { breaks: through(to.breaks) }),
        ...(to.continues === undefined ? {} : { continues: through(to.continues) }),
        labels: new Map([...to.labels].map(([name, one]) => [name, map(one)])),
      };
      const normal = through(after);
      const handler =
        node.catchClause === undefined
          ? undefined
          : sequence(node.catchClause.block.statements, normal, outer);
      // The binder's catch or finally sees the state before the try (`bindTryStatement`),
      // so it is reached from the entry even where the block runs nothing.
      const raise = handler ?? outer.raise;
      return sequence(node.tryBlock.statements, normal, { ...outer, raise }) | raise;
    }
    return reads(node) | after;
  };
  return { sequence, record, live };
}

/**
 * The writes to one local of its block that no read reaches, by `flowWalk` from the
 * statement that declares it: a write is dead where no path from it reads the local before
 * the next write or the end of its scope, and any node the walk does not follow that names
 * the local reads it.
 */
function deadWrites(
  block: Block,
  local: Local,
  uses: readonly Identifier[],
  escape: boolean,
  ends: ReadonlySet<Node>,
): readonly Identifier[] {
  const reads = (node: Node | undefined): Reached =>
    node !== undefined && uses.some((use) => within(use, node)) ? READ : NOTHING;
  const walk = flowWalk({ inside: reads, at: () => NOTHING, writes: uses, ends });
  const statements = block.statements;
  const declaration = statements[local.statement];
  const outlives = local.outlives ? READ : NOTHING;
  const after = walk.sequence(statements.slice(local.statement + 1), outlives, {
    exit: escape ? READ : NOTHING,
    raise: escape ? READ : NOTHING,
    escape: outlives,
    labels: new Map(),
  });
  // The rest of the declaring statement runs after the write: a later declarator may read the local.
  if (local.initialized && declaration !== undefined && reads(declaration) === NOTHING) {
    walk.record(local.name, after);
  }
  return [...walk.live]
    .filter(([, read]) => read === NOTHING)
    .map(([target]) => target)
    .toSorted((a, b) => a.pos - b.pos);
}

/**
 * The writes to the locals of one block that no read reaches. A local a nested function
 * reads is no subject, since the function may run at any time, and every write to a local
 * nothing reads is dead, a nested function's included.
 */
function deadStores(
  block: Block,
  locals: readonly Local[],
  ids: ReadonlyMap<Node, Answer<number>>,
  ends: ReadonlySet<Node>,
): readonly { readonly local: Local; readonly target: Identifier }[] {
  const found: { local: Local; target: Identifier }[] = [];
  const scope = functionOf(block);
  for (const local of locals) {
    const own = local.hoisted ? block.statements[local.statement] : undefined;
    // A function's reads of itself keep it no more than its absence would.
    const uses = local.uses.filter(
      (use) => readsBinding(use, local.name, ids) && (own === undefined || !within(use, own)),
    );
    if (!local.outlives && uses.every(isPlainWrite)) {
      // A declaration with no initializer writes `undefined`, the one store left to name.
      const writes = [...(local.initialized ? [local.name] : []), ...uses];
      const targets = writes.length === 0 ? [local.name] : writes;
      found.push(...targets.map((target) => ({ local, target })));
      continue;
    }
    // A read anywhere in the block reads a function declaration, which is written first.
    if (local.hoisted || uses.some((use) => inNestedFunction(use, block))) {
      continue;
    }
    const escape = local.outlives && handledOutside(block, scope);
    found.push(
      ...deadWrites(block, local, uses, escape, ends).map((target) => ({ local, target })),
    );
  }
  return found;
}

/**
 * The result of each function a discarded call reaches, where its type carries a value:
 * whether it is used is the call sites' to say, which the run decides over every project.
 * `judged` holds every function whose result type the project was asked about.
 */
function resultParts<Brand>(
  project: ProjectView<Brand>,
  root: string,
  sites: readonly { readonly file: SourceFile; readonly declared: Declared }[],
  references: readonly Reference[],
  calls: ReadonlyMap<string, CallUse>,
): { readonly parts: readonly PartFact[]; readonly judged: ReadonlySet<string> } {
  const discardedAt = new Set(
    references
      .filter((one) => (calls.get(positionKey(one.position)) ?? "used") !== "used")
      .map((one) => one.to),
  );
  const found: PartFact[] = [];
  const judged = new Set<string>();
  for (const { file, declared } of sites) {
    const { signature, node, id } = declared;
    const generator = (signature as { readonly asteriskToken?: Node }).asteriskToken !== undefined;
    if (!discardedAt.has(id) || generator || !returnsAValue(signature)) {
      continue;
    }
    judged.add(id);
    // A question the checker leaves unanswered withholds the finding.
    const typed = project.queries.signatureOf(signature);
    if (typed === undefined || !isAnswered(typed)) {
      continue;
    }
    const result = project.queries.returnTypeOf(typed);
    if (result === undefined || !isAnswered(result)) {
      continue;
    }
    const spelled = project.queries.typeToString(result);
    if (!isAnswered(spelled) || NO_VALUE.has(spelled)) {
      continue;
    }
    const at = signature.type ?? (node as { readonly name?: Node }).name ?? node;
    const valued = project.queries.nonNullable(result);
    const members = isAnswered(valued) ? project.queries.propertiesOf(valued) : UNANSWERED;
    found.push({
      declaration: id,
      kind: "result",
      name: "result",
      position: spanOf(file, root, at),
      thenable: !isAnswered(members) || members.some((member) => member.name === "then"),
    });
  }
  return { parts: found, judged };
}

/** What the run answers about the parts of its declarations, over every project. */
export interface IntraFunctionFacts {
  /** Every part of the run, each once, that every project judging it found doing nothing. */
  readonly parts: readonly PartFact[];
  /** Every import binding of the run, each once, read where any project found it read. */
  readonly imports: readonly ImportFact[];
  /** The declarations an outside importer of the run's files can name. */
  readonly published: ReadonlySet<string>;
  /** The declarations whose signature is free to change. */
  readonly free: ReadonlySet<string>;
  /** The declarations whose signature is free but for a use as a value. */
  readonly freeButValued: ReadonlySet<string>;
  /**
   * The declarations every reference of which is a call in the loaded program that
   * discards the call's value, with at least one such call.
   */
  readonly discardedEverywhere: ReadonlySet<string>;
}

/**
 * The parts of a run's projects merged (matrix.6): a part stands only where every project
 * that judges it finds it, a project judging the parts of each file it compiles and the
 * result of each function it asked the checker about. A signature is free when no
 * exemption record names it, its body is no stub, no class hierarchy fixes it, and every
 * reference is a call or a specifier: any other uses the function as a value, and a
 * consumer's reference has a form this run does not read.
 */
export function intraFunctionFacts(
  projects: readonly ProjectParts[],
  references: readonly Reference[],
  exempted: ReadonlySet<string>,
): IntraFunctionFacts {
  const found = new Map<string, { readonly part: PartFact; readonly by: Set<ProjectParts> }>();
  for (const project of projects) {
    for (const part of project.parts) {
      const key = `${part.kind}\u0000${positionKey(part.position)}`;
      const known = found.get(key) ?? { part, by: new Set<ProjectParts>() };
      known.by.add(project);
      found.set(key, known);
    }
  }
  const judges = (project: ProjectParts, part: PartFact): boolean =>
    part.kind === "result"
      ? project.results.has(part.declaration)
      : project.files.has(part.position.path);
  const parts = [...found.values()]
    .filter(({ part, by }) => projects.every((one) => by.has(one) || !judges(one, part)))
    .map(({ part }) => part);
  const imports = new Map<string, ImportFact>();
  for (const binding of projects.flatMap((one) => one.imports)) {
    const key = positionKey(binding.position);
    const known = imports.get(key);
    imports.set(
      key,
      known === undefined ? binding : { ...known, used: known.used || binding.used },
    );
  }
  const calls = new Map<string, CallUse>();
  const specifiers = new Set<string>();
  for (const one of projects) {
    for (const [at, value] of one.calls) {
      calls.set(at, value);
    }
    for (const at of [...one.specifiers, ...one.constructions]) {
      specifiers.add(at);
    }
  }
  const valued = new Set<string>();
  const called = new Map<string, boolean>();
  const awaited = new Set<string>();
  for (const reference of references) {
    if (reference.use === "decorator" || reference.use === "evaluation") {
      continue;
    }
    const at = positionKey(reference.position);
    const call = reference.consumer === undefined ? calls.get(at) : undefined;
    if (call !== undefined) {
      called.set(reference.to, (called.get(reference.to) ?? true) && call !== "used");
      if (call === "awaited") {
        awaited.add(reference.to);
      }
    } else if (reference.consumer !== undefined || !specifiers.has(at)) {
      valued.add(reference.to);
    }
  }
  const signatures = projects.flatMap((one) => one.signatures);
  const fixed = new Set(
    signatures.filter((one) => one.stub || one.fixed).map((one) => one.declaration),
  );
  const free = new Set(
    signatures
      .map((one) => one.declaration)
      .filter((id) => !fixed.has(id) && !exempted.has(id) && !valued.has(id)),
  );
  // A class used as a value fixes its constructor's whole signature, whatever reads follow.
  const constructors = new Set(
    signatures.filter((one) => one.constructor).map((one) => one.declaration),
  );
  const freeButValued = new Set(
    signatures
      .map((one) => one.declaration)
      .filter(
        (id) => !fixed.has(id) && !exempted.has(id) && valued.has(id) && !constructors.has(id),
      ),
  );
  // Awaiting a thenable result sequences on it, so a call that awaits one uses it.
  const sequenced = new Set(
    parts
      .filter((part) => part.thenable === true && awaited.has(part.declaration))
      .map((part) => part.declaration),
  );
  const discardedEverywhere = new Set(
    [...called]
      .filter(([id, all]) => all && !valued.has(id) && !sequenced.has(id))
      .map(([id]) => id),
  );
  return {
    parts,
    imports: [...imports.values()],
    published: new Set(projects.flatMap((one) => [...one.published])),
    free,
    freeButValued,
    discardedEverywhere,
  };
}
