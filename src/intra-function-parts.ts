/**
 * The parts of the declarations one project's own files hold, read while the project's
 * view is open: each parameter and whether its function reads it, each result and the
 * call sites that use or discard it, each statement control flow cannot reach, each
 * write to a local that no read reaches, and each case an earlier case covers.
 */

import { CODE } from "./contract/contract.generated.ts";
import {
  isArrowFunction,
  isAwaitExpression,
  isBigIntLiteral,
  isBinaryExpression,
  isBlock,
  isBreakStatement,
  isBindingElement,
  isCallExpression,
  isCaseClause,
  isCatchClause,
  isClassDeclaration,
  isClassExpression,
  isConstructorDeclaration,
  isContinueStatement,
  isDecorator,
  isDefaultClause,
  isEmptyStatement,
  isExportAssignment,
  isExportSpecifier,
  isExpressionStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isForInStatement,
  isForOfStatement,
  isFunctionLikeDeclaration,
  isHeritageClause,
  isIdentifier,
  isIfStatement,
  isImportClause,
  isImportSpecifier,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isModuleDeclaration,
  isNamespaceImport,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPrefixUnaryExpression,
  isPropertyAssignment,
  isPropertyAccessExpression,
  isQualifiedName,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isSourceFile,
  isStringLiteral,
  isSwitchStatement,
  isThrowStatement,
  isTypeAliasDeclaration,
  isTypeReferenceNode,
  isVariableDeclarationList,
  isVariableStatement,
  isVoidExpression,
  NodeFlags,
  SyntaxKind,
  type ArrowFunction,
  type BindingName,
  type Block,
  type CallExpression,
  type CatchClause,
  type ConstructorDeclaration,
  type ForInStatement,
  type ForOfStatement,
  type FunctionLikeDeclaration,
  type FunctionExpression,
  type Identifier,
  type Node,
  type SourceFile,
  type Statement,
  type VariableDeclarationList,
} from "@typescript/native/ast";
import { SignatureKind, type Type } from "@typescript/native/sync";
import type { FindingPosition } from "./finding.ts";
import {
  exportsLocally,
  implicitReads,
  importBindings,
  type JsxOptions,
} from "./import-bindings.ts";
import { isParameterProperty, nodeKey, type Inventory } from "./inventory.ts";
import { positionKey, renderPosition } from "./position.ts";
import { importRef } from "./ref.ts";
import { isAnswered, UNANSWERED, type Answer } from "./query.ts";
import type { Reference } from "./references.ts";
import type { ProjectView } from "./session.ts";
import { signatureOf, type SignatureNode } from "./signatures.ts";
import { spellsNoBinding } from "./spelled-names.ts";
import { parenthesesRemoved } from "./unwrap.ts";

/** The subject kind of each part this module reads. */
type PartKind = "parameter" | "result" | "statement" | "store" | "case";

/** One part of one declaration, and whether this project found it in use. */
export interface PartFact {
  readonly code: string;
  /** The inventory's identifier of the declaration that holds the part. */
  readonly declaration: string;
  readonly kind: PartKind;
  /** The part's display name: an identifier, or the text of a case. */
  readonly name: string;
  readonly position: FindingPosition;
  /** What a finding about the part says, before the rules that report it too. */
  readonly message: string;
  /** Whether the project found the part in use, which takes it out of the answer. */
  readonly used: boolean;
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

/** Whether one statement leaves its statement list on every path: the rest of the list never runs. */
function abrupt(statement: Statement): boolean {
  if (
    isReturnStatement(statement) ||
    isThrowStatement(statement) ||
    isBreakStatement(statement) ||
    isContinueStatement(statement)
  ) {
    return true;
  }
  if (isBlock(statement)) {
    return statement.statements.some(abrupt);
  }
  if (isIfStatement(statement)) {
    return (
      statement.elseStatement !== undefined &&
      abrupt(statement.thenStatement) &&
      abrupt(statement.elseStatement)
    );
  }
  return false;
}

/**
 * Whether an unreachable statement is no subject: a declaration the language hoists or
 * that emits nothing, an empty statement, and a `var` that initializes nothing.
 */
function unreachableExempt(statement: Statement): boolean {
  if (
    isFunctionDeclaration(statement) ||
    isInterfaceDeclaration(statement) ||
    isTypeAliasDeclaration(statement) ||
    isModuleDeclaration(statement) ||
    isEmptyStatement(statement)
  ) {
    return true;
  }
  if (isVariableStatement(statement)) {
    const list = statement.declarationList;
    return (
      (list.flags & (NodeFlags.Let | NodeFlags.Const | NodeFlags.Using)) === 0 &&
      list.declarations.every((one) => one.initializer === undefined)
    );
  }
  return false;
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

/** Every class name an `extends` clause of the project names, by its last identifier. */
function extendedNames(files: readonly SourceFile[]): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: Node): void => {
    if (isHeritageClause(node) && node.token === SyntaxKind.ExtendsKeyword) {
      for (const type of node.types) {
        // A class's clause holds expressions; an interface's holds type references.
        let named: Node;
        if (isTypeReferenceNode(type)) {
          named = isQualifiedName(type.typeName) ? type.typeName.right : type.typeName;
        } else {
          const expression = parenthesesRemoved(type.expression);
          named = isPropertyAccessExpression(expression) ? expression.name : expression;
        }
        if (isIdentifier(named)) {
          names.add(named.text);
        }
      }
    }
    node.forEachChild(visit);
  };
  for (const file of files) {
    file.forEachChild(visit);
  }
  return names;
}

/**
 * Whether a class hierarchy fixes one method's signature: its class extends or implements
 * another type, is abstract or is extended itself, or the method is marked `override`.
 */
function hierarchyFixes(declared: Node, extended: ReadonlySet<string>): boolean {
  if (!isMethodDeclaration(declared)) {
    return false;
  }
  const owner = declared.parent;
  if (!isClassDeclaration(owner) && !isClassExpression(owner)) {
    return false;
  }
  if (
    hasModifier(declared, SyntaxKind.OverrideKeyword) ||
    hasModifier(owner, SyntaxKind.AbstractKeyword)
  ) {
    return true;
  }
  if ((owner.heritageClauses ?? []).length > 0) {
    return true;
  }
  return owner.name !== undefined && extended.has(owner.name.text);
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
  const extended = extendedNames(files);
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

  for (const file of files) {
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

    // Code below an unreachable statement is still walked for its calls and specifiers,
    // and reports no part of its own: the unreachable statement is the one finding.
    let silenced = 0;
    const statementsOf = (statements: readonly Statement[]): void => {
      let reachable = true;
      let reported = false;
      for (const statement of statements) {
        if (reachable) {
          visit(statement);
          reachable = !abrupt(statement);
          continue;
        }
        const holder = holderOf(statement);
        if (silenced === 0 && !reported && !unreachableExempt(statement) && holder !== undefined) {
          walk.unreachable.push({ statement, holder });
          reported = true;
        }
        silenced += 1;
        visit(statement);
        silenced -= 1;
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
      if (isBlock(node) && silenced === 0 && holderOf(node) !== undefined) {
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
      if (isBlock(node) || isCaseClause(node) || isDefaultClause(node)) {
        statementsOf(node.statements);
        return;
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);

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
        fixed: constructor ? decoratorFixes(one.node) : hierarchyFixes(one.node, extended),
        constructor,
      });
      const reader = readers.get(one.signature);
      if (reader !== undefined) {
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
    walk.catches.forEach(({ name, holder }, at) => {
      parts.push({
        code: CODE.deadStore,
        declaration: holder,
        kind: "store",
        name: name.text,
        position: spanOf(file, targetRoot, name),
        message: `value written to ${name.text} is never read`,
        used: (caught[at] ?? []).some((use) => readsBinding(use, name, ids)),
      });
    });
    for (const { names, uses, holder } of loopVariables) {
      for (const name of names) {
        parts.push({
          code: CODE.deadStore,
          declaration: holder,
          kind: "store",
          name: name.text,
          position: spanOf(file, targetRoot, name),
          message: `value written to ${name.text} is never read`,
          used: uses.some((use) => use.text === name.text && readsBinding(use, name, ids)),
        });
      }
    }
    walk.blocks.forEach((block, at) => {
      const holder = holderOf(block);
      if (holder !== undefined) {
        parts.push(...deadStores(file, targetRoot, block, holder, stores[at] ?? [], ids));
      }
    });
    for (const { statement, holder } of walk.unreachable) {
      parts.push({
        code: CODE.unreachableStatement,
        declaration: holder,
        kind: "statement",
        name: "statement",
        position: spanOf(file, targetRoot, statement),
        message: "statement is unreachable",
        used: false,
      });
    }
    for (const { clause, text, holder } of walk.cases) {
      parts.push({
        code: CODE.unreachableCase,
        declaration: holder,
        kind: "case",
        name: text,
        position: spanOf(file, targetRoot, clause),
        message: `case ${text} is covered by an earlier case of the same switch`,
        used: false,
      });
    }
  }

  parts.push(...resultParts(project, targetRoot, sites, references, calls));
  return {
    parts: withContextualRead(project, parts, contextual),
    imports,
    signatures,
    calls,
    specifiers,
    constructions,
  };
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
 * checker leaves unanswered keeps the name read.
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
  const judged = new Map<PartFact, PartFact>();
  for (const one of contextual) {
    const answer = typedBy.get(one.signature);
    if (answer === undefined) {
      continue;
    }
    const place = one.part.parameter;
    judged.set(
      one.part,
      answer === UNANSWERED || place === undefined
        ? { ...one.part, used: true }
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
  return parts.map((part) => judged.get(part) ?? part);
}

/**
 * Each name one function's parameters bind and whether the function reads it, and the
 * unread names a contextual type of a function expression may keep: those of a parameter
 * that carries a type annotation or is an object binding pattern. A binding pattern counts
 * as read where its function reads any name it binds.
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
  reader.names.forEach(({ name, at, pattern, exempt }, index) => {
    if (exempt) {
      return;
    }
    const part: PartFact = {
      code: CODE.unusedParameter,
      declaration,
      kind: "parameter",
      name: name.text,
      position: spanOf(file, root, name),
      message: `parameter ${name.text} is never read in the body`,
      used: read[index] === true,
      parameter: { beforeARead: !pattern && at < lastRead, ...place },
    };
    found.push(part);
    const parameter = signature.parameters[at];
    if (
      expression !== undefined &&
      !part.used &&
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
 * The writes to the locals of one block that no read reaches. A write is a declaration's
 * initializer or a plain assignment written as a statement of the block; it is dead when
 * the block's later statements read the local nowhere before the next such write or the
 * block's end. A statement writing it inside a nested construct ends the search with the
 * write kept. A local a nested function reads is no subject, since the function may run at
 * any time, and every write to a local nothing reads is dead, a nested function's included.
 */
function deadStores(
  file: SourceFile,
  root: string,
  block: Block,
  holder: string,
  locals: readonly Local[],
  ids: ReadonlyMap<Node, Answer<number>>,
): PartFact[] {
  const found: PartFact[] = [];
  const deadAt = (local: Local, target: Identifier): PartFact => ({
    code: CODE.deadStore,
    declaration: holder,
    kind: "store",
    name: local.name.text,
    position: spanOf(file, root, target),
    message: `value written to ${local.name.text} is never read`,
    used: false,
  });
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
      found.push(...targets.map((target) => deadAt(local, target)));
      continue;
    }
    // A read anywhere in the block reads a function declaration, which is written first.
    if (local.hoisted) {
      continue;
    }
    if (uses.some((use) => inNestedFunction(use, block))) {
      continue;
    }
    const statements = block.statements;
    const usesIn = (statement: Node): Identifier[] => uses.filter((use) => within(use, statement));
    /** The plain assignment to the local a statement of the block is, where it is one. */
    const writeOf = (statement: Statement): { target: Identifier; value: Node } | undefined => {
      if (!isExpressionStatement(statement)) {
        return undefined;
      }
      const expression = parenthesesRemoved(statement.expression);
      if (
        !isBinaryExpression(expression) ||
        expression.operatorToken.kind !== SyntaxKind.EqualsToken
      ) {
        return undefined;
      }
      const target = parenthesesRemoved(expression.left);
      return isIdentifier(target) && uses.includes(target)
        ? { target, value: expression.right }
        : undefined;
    };
    const writes: { at: number; target: Identifier }[] = [];
    if (local.initialized) {
      writes.push({ at: local.statement, target: local.name });
    }
    statements.forEach((statement, at) => {
      const write = writeOf(statement);
      if (write !== undefined && at > local.statement) {
        writes.push({ at, target: write.target });
      }
    });
    for (const write of writes) {
      // The rest of the write's own statement runs after it: a later declarator may read the local.
      const own = statements[write.at];
      const sameStatement = own !== undefined && write.target === local.name ? usesIn(own) : [];
      if (sameStatement.length > 0) {
        continue;
      }
      let dead = !local.outlives;
      for (let at = write.at + 1; at < statements.length; at += 1) {
        const statement = statements[at];
        if (statement === undefined) {
          break;
        }
        const next = writeOf(statement);
        if (next !== undefined) {
          dead = usesIn(next.value).length === 0;
          break;
        }
        const named = usesIn(statement);
        if (named.length > 0) {
          dead = false;
          break;
        }
      }
      if (dead) {
        found.push(deadAt(local, write.target));
      }
    }
  }
  return found;
}

/**
 * The result of each function a discarded call reaches, where its type carries a value:
 * whether it is used is the call sites' to say, which the run decides over every project.
 */
function resultParts<Brand>(
  project: ProjectView<Brand>,
  root: string,
  sites: readonly { readonly file: SourceFile; readonly declared: Declared }[],
  references: readonly Reference[],
  calls: ReadonlyMap<string, CallUse>,
): PartFact[] {
  const discardedAt = new Set(
    references
      .filter((one) => (calls.get(positionKey(one.position)) ?? "used") !== "used")
      .map((one) => one.to),
  );
  const found: PartFact[] = [];
  for (const { file, declared } of sites) {
    const { signature, node, id } = declared;
    const generator = (signature as { readonly asteriskToken?: Node }).asteriskToken !== undefined;
    if (!discardedAt.has(id) || generator || !returnsAValue(signature)) {
      continue;
    }
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
      code: CODE.unusedResult,
      declaration: id,
      kind: "result",
      name: "result",
      position: spanOf(file, root, at),
      message: "result is discarded at every call site",
      used: false,
      thenable: !isAnswered(members) || members.some((member) => member.name === "then"),
    });
  }
  return found;
}

/** What the run answers about the parts of its declarations, over every project. */
export interface IntraFunctionFacts {
  /** Every part of the run, each once, in use where any project found it in use. */
  readonly parts: readonly PartFact[];
  /** Every import binding of the run, each once, read where any project found it read. */
  readonly imports: readonly ImportFact[];
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
 * The parts of a run's projects merged: a part two projects hold is one part, in use
 * where either found it in use. A signature is free when no exemption record names its
 * declaration, its body is no stub, no class hierarchy fixes it, and every reference to
 * the declaration is a call or a specifier: any other reference uses the function as a
 * value, whose type then fixes the signature, and a reference a consumer makes is one
 * whose form this run does not read.
 */
export function intraFunctionFacts(
  projects: readonly ProjectParts[],
  references: readonly Reference[],
  exempted: ReadonlySet<string>,
): IntraFunctionFacts {
  const parts = new Map<string, PartFact>();
  for (const part of projects.flatMap((one) => one.parts)) {
    const key = `${part.code}\u0000${positionKey(part.position)}`;
    const known = parts.get(key);
    parts.set(key, known === undefined ? part : { ...known, used: known.used || part.used });
  }
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
    [...parts.values()]
      .filter((part) => part.thenable === true && awaited.has(part.declaration))
      .map((part) => part.declaration),
  );
  const discardedEverywhere = new Set(
    [...called]
      .filter(([id, all]) => all && !valued.has(id) && !sequenced.has(id))
      .map(([id]) => id),
  );
  return {
    parts: [...parts.values()],
    imports: [...imports.values()],
    free,
    freeButValued,
    discardedEverywhere,
  };
}
