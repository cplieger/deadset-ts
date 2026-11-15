/**
 * What one use of a namespace value, a module's namespace object or a `namespace` declaration
 * (references-ts.3 to .6), reads, by its place in the tree; the checker says which names resolve
 * to one (`AliasChains.namespaceOf`). `ns.name`, a literal index and a variable's object pattern
 * of names read one member; a re-export passes the value on; a namespace binding
 * ({@link boundValue}) and a discarded value read nothing; every other use reads it whole.
 */

import {
  isArrowFunction,
  isAsExpression,
  isAwaitExpression,
  isCallExpression,
  isElementAccessExpression,
  isExportAssignment,
  isExportDeclaration,
  isExportSpecifier,
  isExpressionStatement,
  isIdentifier,
  isImportClause,
  isImportEqualsDeclaration,
  isImportSpecifier,
  isModuleBlock,
  isNamespaceExport,
  isNamespaceImport,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isParameterDeclaration,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isQualifiedName,
  isSatisfiesExpression,
  isSourceFile,
  isStringLiteral,
  isTypeAssertion,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  isVoidExpression,
  isWithStatement,
  NodeFlags,
  SyntaxKind,
  type ArrowFunction,
  type ImportEqualsDeclaration,
  type Node,
  type ObjectBindingPattern,
  type ParameterDeclaration,
  type SourceFile,
} from "@typescript/native/ast";
import type { PropertyRead } from "./destructuring.ts";

/** What one use of a namespace value reads beyond the names the checker resolves. */
export interface Judgement {
  /** A re-export or an exported alias passes the value on (references-ts.4). */
  readonly passes: boolean;
  /** Where the use reads every export (`references-ts.5`), each node a place it does. */
  readonly whole: readonly Node[];
  /** The literal index of a value with no name, an `import()`'s, which reads the export it names. */
  readonly indexed?: Node;
  /**
   * A variable's or a `then` parameter's object pattern of names under a declared type, which the
   * checker types from the annotation rather than this value: each name reads the member so named
   * from the value.
   */
  readonly pattern?: ObjectBindingPattern;
  /**
   * The name a declaration binds the value to, where it may be a namespace binding: the reader
   * asks the checker, and reads nothing where it is one, or passes the value on where the binding
   * is `held` at a module's or a namespace's top level, which an analysis outside may enter.
   */
  readonly binds?: { readonly name: Node; readonly held: boolean };
}

export const NONE: Judgement = { passes: false, whole: [] };
export const PASSES: Judgement = { passes: true, whole: [] };

/**
 * Whether one import or re-export declaration is written type-only, so it binds no value
 * and no namespace object: the compiler's own answer, its type-only alias declaration, is
 * not on the API it serves.
 */
export function declaredTypeOnly(node: Node): boolean {
  const clauseTypeOnly = (clause: Node): boolean =>
    isImportClause(clause) && clause.phaseModifier === SyntaxKind.TypeKeyword;
  if (isImportSpecifier(node) || isExportSpecifier(node)) {
    const declaration = node.parent.parent;
    return (
      node.isTypeOnly ||
      clauseTypeOnly(declaration) ||
      (isExportDeclaration(declaration) && declaration.isTypeOnly)
    );
  }
  if (isImportClause(node) || isNamespaceImport(node)) {
    return clauseTypeOnly(isImportClause(node) ? node : node.parent);
  }
  if (isNamespaceExport(node)) {
    return isExportDeclaration(node.parent) && node.parent.isTypeOnly;
  }
  return isImportEqualsDeclaration(node) && node.isTypeOnly;
}

function isLiteralText(node: Node): boolean {
  return isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node);
}

/** The outermost expression one node is, through the parentheses written around it. */
function parenthesized(node: Node): Node {
  let at = node;
  while (isParenthesizedExpression(at.parent)) {
    at = at.parent;
  }
  return at;
}

/** The expression one node holds inside the parentheses written around it. */
function unwrapped(node: Node): Node {
  let at = node;
  while (isParenthesizedExpression(at)) {
    at = at.expression;
  }
  return at;
}

/** Whether one import-equals declaration is written `export import`. */
function exportsAlias(declaration: ImportEqualsDeclaration): boolean {
  return (declaration.modifiers ?? []).some((one) => one.kind === SyntaxKind.ExportKeyword);
}

/** Whether one variable declaration is a statement of a module's or a namespace's top level. */
function heldAtTop(declaration: Node): boolean {
  const statement = declaration.parent.parent;
  return (
    isVariableStatement(statement) &&
    (isSourceFile(statement.parent) || isModuleBlock(statement.parent))
  );
}

/** The literal specifier of the dynamic `import()` whose `then` callback ({@link thenCallback}) one function is. */
function thenImported(callback: Node): Node | undefined {
  const then = parenthesized(callback).parent;
  const access = isCallExpression(then) ? then.expression : undefined;
  const call =
    access !== undefined && isPropertyAccessExpression(access)
      ? unwrapped(access.expression)
      : undefined;
  return call !== undefined &&
    isLiteralImport(call) &&
    isCallExpression(call) &&
    thenCallback(call) === callback
    ? call.arguments[0]
    : undefined;
}

const withFiles = new WeakMap<SourceFile, boolean>();

/**
 * Whether one file holds a `with` statement anywhere, which reads names the checker does not
 * resolve (ECMA-262 14.11): such a file binds no namespace object ({@link boundValue}). Read once
 * per file.
 */
function holdsWith(file: SourceFile): boolean {
  let holds = withFiles.get(file);
  if (holds === undefined) {
    holds = descendants(file).some((node) => isWithStatement(node));
    withFiles.set(file, holds);
  }
  return holds;
}

/** Every node below one node, by a plain recursive `forEachChild` that skips no child. */
export function descendants(root: Node): readonly Node[] {
  const found: Node[] = [];
  const visit = (node: Node): void => {
    found.push(node);
    node.forEachChild(visit);
  };
  root.forEachChild(visit);
  return found;
}

/**
 * The `eval` identifier one call calls directly, with no `?.`, which reads bindings in scope by
 * names the checker does not resolve (ECMA-262 PerformEval): its callee through parentheses and
 * the type assertions the compiler erases (`as`, `satisfies`, `!`, `<T>`), so `(eval)(x)` is one
 * and `(0, eval)(x)` is not. Whether it is the global `eval` is `AliasChains.undeclared`'s answer.
 * A `with` body needs no case: every question inside one is unanswered (`queriesOf`), and a file
 * that holds one binds no namespace object ({@link holdsWith}).
 */
export function directEval(node: Node): Node | undefined {
  if (!isCallExpression(node) || node.questionDotToken !== undefined) {
    return undefined;
  }
  let callee: Node = node.expression;
  while (
    isParenthesizedExpression(callee) ||
    isAsExpression(callee) ||
    isSatisfiesExpression(callee) ||
    isNonNullExpression(callee) ||
    isTypeAssertion(callee)
  ) {
    callee = callee.expression;
  }
  return isIdentifier(callee) && callee.text === "eval" ? callee : undefined;
}

/** What one declaration binds where it may bind a namespace object ({@link boundValue}). */
interface BoundValue {
  /** The node whose symbol names the value: the import's specifier for an import. */
  readonly node: Node;
  /** Whether a module's or a namespace's top level holds the binding. */
  readonly held: boolean;
}

/**
 * What one declaration binds, where it may bind a namespace object as `import * as` does
 * (references-ts.4): a `const` written with a name and initialized with a name, a member access,
 * a literal index or an awaited literal `import()`, or an arrow `then` callback's parameter
 * ({@link thenParameter}) written as a name, each with no type of its own (a TypeScript annotation,
 * or a JSDoc type the compiler reads as one), in a file that holds no `with` statement. The
 * checker decides the rest (`AliasChains.namespaceOf`).
 */
export function boundValue(declaration: Node): BoundValue | undefined {
  if (isVariableDeclaration(declaration)) {
    const list = declaration.parent;
    const value =
      declaration.initializer === undefined ? undefined : unwrapped(declaration.initializer);
    if (
      value === undefined ||
      declaration.type !== undefined ||
      !isIdentifier(declaration.name) ||
      !isVariableDeclarationList(list) ||
      (list.flags & NodeFlags.Const) === 0 ||
      (list.flags & (NodeFlags.Let | NodeFlags.Using)) !== 0
    ) {
      return undefined;
    }
    const awaited = isAwaitExpression(value) ? unwrapped(value.expression) : undefined;
    const node =
      awaited !== undefined && isLiteralImport(awaited) && isCallExpression(awaited)
        ? awaited.arguments[0]
        : nameOf(value);
    return node === undefined || holdsWith(declaration.getSourceFile())
      ? undefined
      : { node, held: heldAtTop(declaration) };
  }
  if (
    !isParameterDeclaration(declaration) ||
    !isIdentifier(declaration.name) ||
    declaration.type !== undefined ||
    declaration.initializer !== undefined ||
    declaration.dotDotDotToken !== undefined
  ) {
    return undefined;
  }
  const callback = declaration.parent;
  if (!isArrowFunction(callback) || thenParameter(callback) !== declaration) {
    return undefined;
  }
  const specifier = thenImported(callback);
  return specifier === undefined || holdsWith(declaration.getSourceFile())
    ? undefined
    : { node: specifier, held: false };
}

/** Whether one call is a dynamic `import()` whose argument is literal text. */
function isLiteralImport(node: Node): boolean {
  if (!isCallExpression(node) || node.expression.kind !== SyntaxKind.ImportKeyword) {
    return false;
  }
  const [argument] = node.arguments;
  return argument !== undefined && isLiteralText(argument);
}

/** The name node one expression that may be a namespace value is read at, where it has one. */
function nameOf(expression: Node): Node | undefined {
  if (isIdentifier(expression)) {
    return expression;
  }
  if (isPropertyAccessExpression(expression)) {
    return expression.name;
  }
  return isElementAccessExpression(expression) && isLiteralText(expression.argumentExpression)
    ? expression.argumentExpression
    : undefined;
}

/**
 * The literal index of one element access, with the name of the value it indexes, where that
 * value has one: the literal reads an export where the checker says the value is a namespace
 * value. An `import()`'s value has no name, so {@link judged} gives its literal index.
 */
export function indexedThrough(
  node: Node,
): { readonly node: Node; readonly through: Node } | undefined {
  if (!isElementAccessExpression(node) || !isLiteralText(node.argumentExpression)) {
    return undefined;
  }
  const through = nameOf(unwrapped(node.expression));
  return through === undefined ? undefined : { node: node.argumentExpression, through };
}

/**
 * The expression one name node of a use stands for: the member access or qualified name it
 * names, the element access a literal index indexes, or the name itself.
 */
export function valueAt(name: Node): Node {
  const parent = name.parent;
  if (
    (isPropertyAccessExpression(parent) && parent.name === name) ||
    (isQualifiedName(parent) && parent.right === name) ||
    (isElementAccessExpression(parent) && parent.argumentExpression === name)
  ) {
    return parent;
  }
  return name;
}

/** The element access one value is the object of, where it is one. */
export function indexedBy(value: Node): Node | undefined {
  const at = parenthesized(value);
  return isElementAccessExpression(at.parent) && at.parent.expression === at
    ? at.parent
    : undefined;
}

/**
 * Whether one object pattern names members alone: each element an identifier binding under an
 * identifier, string or numeric property name, with no default and no rest (references-ts.4).
 */
function namesAlone(pattern: ObjectBindingPattern): boolean {
  return pattern.elements.every((element) => {
    const key = element.propertyName ?? element.name;
    return (
      element.dotDotDotToken === undefined &&
      element.initializer === undefined &&
      element.name !== undefined &&
      isIdentifier(element.name) &&
      key !== undefined &&
      (isIdentifier(key) || isStringLiteral(key) || isNumericLiteral(key))
    );
  });
}

/**
 * What one use of a namespace value reads, by the place `value`, the expression one name node
 * stands for ({@link valueAt}), is written in: a member access, a literal index and a variable's
 * object pattern of names alone read only the member named; a `const` may bind the value
 * ({@link Judgement.binds}); an expression statement, `void` and an `import x =` that is not
 * exported read nothing, each read of the alias judged where it is read; a re-export and an
 * exported alias pass the value on; every other place, a holder among them, reads it whole.
 */
export function judged(value: Node): Judgement {
  const at = parenthesized(value);
  const parent = at.parent;
  if (isImportEqualsDeclaration(parent) && parent.moduleReference === at) {
    return exportsAlias(parent) ? PASSES : NONE;
  }
  if (isExportAssignment(parent) && parent.expression === at) {
    return PASSES;
  }
  if (isExpressionStatement(parent) || isVoidExpression(parent)) {
    return NONE;
  }
  if (
    (isPropertyAccessExpression(parent) && parent.expression === at) ||
    (isQualifiedName(parent) && parent.left === at)
  ) {
    return NONE;
  }
  if (
    isElementAccessExpression(parent) &&
    parent.expression === at &&
    isLiteralText(parent.argumentExpression)
  ) {
    // A literal index of a value with a name is the literal's own site (`indexedThrough`).
    return nameOf(unwrapped(at)) === undefined
      ? { ...NONE, indexed: parent.argumentExpression }
      : NONE;
  }
  if (
    isVariableDeclaration(parent) &&
    parent.initializer === at &&
    isObjectBindingPattern(parent.name) &&
    namesAlone(parent.name)
  ) {
    return parent.type === undefined ? NONE : { ...NONE, pattern: parent.name };
  }
  if (isVariableDeclaration(parent) && parent.initializer === at && isIdentifier(parent.name)) {
    return { passes: false, whole: [at], binds: { name: parent.name, held: heldAtTop(parent) } };
  }
  return { passes: false, whole: [at] };
}

/**
 * What a property an object pattern destructures reads, where the checker resolves the property
 * to a namespace value: the property's value whole.
 */
export function judgedProperty(read: PropertyRead): Judgement {
  return { passes: false, whole: [read.key] };
}

/** One dynamic `import()` of literal text, and what its value, the call or its `await`, is put to. */
export interface ImportedUse {
  readonly at: Node;
  readonly specifier: Node;
  readonly judgement: Judgement;
}

/**
 * The arrow callback a `then` on one dynamic `import()` call passes the namespace object to. A
 * function expression is none: code it calls may read its `arguments` object through its function
 * object (`caller`, `arguments`), by routes the checker does not resolve, where an arrow has no
 * `arguments` object and its function object's `caller` and `arguments` throw (ECMA-262 10.2.4,
 * 15.3), so its call holds the value.
 */
function thenCallback(call: Node): ArrowFunction | undefined {
  const access = parenthesized(call).parent;
  const then = access.parent;
  if (
    !isPropertyAccessExpression(access) ||
    access.name.text !== "then" ||
    !isCallExpression(then) ||
    then.expression !== access
  ) {
    return undefined;
  }
  const [argument] = then.arguments;
  const callback = argument === undefined ? undefined : unwrapped(argument);
  return callback !== undefined && isArrowFunction(callback) ? callback : undefined;
}

/**
 * The parameter a `then` callback ({@link thenCallback}) is given the namespace object in, its
 * first. One named `this`, which an arrow may not have (TS2730), is none.
 */
function thenParameter(callback: ArrowFunction): ParameterDeclaration | undefined {
  const [first] = callback.parameters;
  return first !== undefined && isIdentifier(first.name) && first.name.text === "this"
    ? undefined
    : first;
}

/**
 * What one dynamic `import()` call's value is put to: its `await` is judged as any namespace
 * value is; a `then` callback ({@link thenCallback}) reads nothing where it has no parameter, may
 * bind the value where its parameter is a name ({@link boundValue}), and reads only the names of
 * an object pattern of names alone (references-ts.4), by name from the value where the pattern
 * has a type of its own; any other use holds it, which reads it whole.
 */
function importJudged(call: Node): Judgement {
  const at = parenthesized(call);
  const parent = at.parent;
  if (isExpressionStatement(parent) || isVoidExpression(parent)) {
    return NONE;
  }
  if (isAwaitExpression(parent)) {
    return judged(parent);
  }
  const callback = thenCallback(call);
  if (callback?.parameters.length === 0) {
    return NONE;
  }
  const first = callback === undefined ? undefined : thenParameter(callback);
  if (
    first !== undefined &&
    first.initializer === undefined &&
    first.dotDotDotToken === undefined
  ) {
    if (isIdentifier(first.name)) {
      return { passes: false, whole: [call], binds: { name: first.name, held: false } };
    }
    if (isObjectBindingPattern(first.name) && namesAlone(first.name)) {
      return first.type === undefined ? NONE : { ...NONE, pattern: first.name };
    }
  }
  return { passes: false, whole: [call] };
}

/** The dynamic imports one file makes of literal text, each judged where its value is put. */
export function dynamicImports(file: SourceFile): readonly ImportedUse[] {
  const imports: ImportedUse[] = [];
  const visit = (node: Node): void => {
    if (isLiteralImport(node) && isCallExpression(node)) {
      const [specifier] = node.arguments;
      if (specifier !== undefined) {
        const awaited = parenthesized(node).parent;
        imports.push({
          at: isAwaitExpression(awaited) ? awaited : node,
          specifier,
          judgement: importJudged(node),
        });
      }
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return imports;
}
