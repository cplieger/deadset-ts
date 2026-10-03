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
  isBlock,
  isBreakStatement,
  isCallExpression,
  isCaseClause,
  isClassDeclaration,
  isClassExpression,
  isContinueStatement,
  isDecorator,
  isDefaultClause,
  isEmptyStatement,
  isExportAssignment,
  isExportSpecifier,
  isExpressionStatement,
  isFunctionDeclaration,
  isHeritageClause,
  isIdentifier,
  isIfStatement,
  isImportClause,
  isImportSpecifier,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isModuleDeclaration,
  isNamespaceImport,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isParenthesizedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isQualifiedName,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isSwitchStatement,
  isThrowStatement,
  isTypeAliasDeclaration,
  isTypeReferenceNode,
  isVariableStatement,
  isVoidExpression,
  NodeFlags,
  SyntaxKind,
  type Block,
  type CallExpression,
  type Identifier,
  type Node,
  type SourceFile,
  type Statement,
} from "@typescript/native/unstable/ast";
import type { FindingPosition } from "./finding.ts";
import { nodeKey, type Inventory } from "./inventory.ts";
import { positionKey, renderPosition } from "./position.ts";
import { isAnswered, UNANSWERED, type Answer } from "./query.ts";
import type { Reference } from "./references.ts";
import type { ProjectView } from "./session.ts";
import { signatureOf, type SignatureNode } from "./signatures.ts";

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
}

/** What one declaration's signature answers to beside its body. */
interface SignatureFact {
  readonly declaration: string;
  /** Whether the body is empty or does nothing but throw. */
  readonly stub: boolean;
  /** Whether a class hierarchy fixes the signature: the method overrides, or is overridden. */
  readonly fixed: boolean;
}

/** What one project answers about the parts of its declarations. */
export interface ProjectParts {
  readonly parts: readonly PartFact[];
  readonly signatures: readonly SignatureFact[];
  /** Each name written as the callee of a call, by position, and whether the call's value is discarded. */
  readonly calls: ReadonlyMap<string, boolean>;
  /** Each name an import or an export specifier writes, by position, which uses no value. */
  readonly specifiers: ReadonlySet<string>;
}

/** The codes of the parts this module reads. */
export const UNUSED_PARAMETER = "DS1801";
export const UNUSED_RESULT = "DS1803";
const UNREACHABLE_STATEMENT = "DS1805";
const DEAD_STORE = "DS1807";
const UNREACHABLE_CASE = "DS1809";

/** The result types that carry no value, as the checker spells them. */
const NO_VALUE: ReadonlySet<string> = new Set([
  "void",
  "undefined",
  "never",
  "Promise<void>",
  "Promise<undefined>",
  "Promise<never>",
]);

/** The prefix that marks a parameter as unused on purpose, as the compiler's own rule reads it. */
const UNUSED_PREFIX = "_";

/** The rendered position of one node, from its first token to its last line. */
function spanOf(file: SourceFile, root: string, node: Node): FindingPosition {
  const start = renderPosition(file, root, node.getStart());
  const endLine = file.getLineAndCharacterOfPosition(node.end).line + 1;
  return { ...start, endLine };
}

/** The parenthesized expression's content, through every pair of parentheses. */
function unwrapped(node: Node): Node {
  return isParenthesizedExpression(node) ? unwrapped(node.expression) : node;
}

/** The node the parentheses around one expression sit in. */
function outerParent(node: Node): Node {
  return isParenthesizedExpression(node.parent) ? outerParent(node.parent) : node.parent;
}

/** The name a call is made through: the identifier, or the member a property access names. */
function calleeName(call: CallExpression): Identifier | undefined {
  const callee = unwrapped(call.expression);
  if (isIdentifier(callee)) {
    return callee;
  }
  return isPropertyAccessExpression(callee) && isIdentifier(callee.name) ? callee.name : undefined;
}

/**
 * Whether a call's value is discarded: the call is a statement of its own, awaited as a
 * statement, or the operand of `void`.
 */
function discarded(call: CallExpression): boolean {
  const parent = outerParent(call);
  if (isExpressionStatement(parent) || isVoidExpression(parent)) {
    return true;
  }
  return isAwaitExpression(parent) && isExpressionStatement(outerParent(parent));
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
  const node = unwrapped(expression);
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

/** Every identifier below one node whose text one of the names spells, a member's name aside. */
function identifiersNaming(node: Node, names: ReadonlySet<string>): Identifier[] {
  const found: Identifier[] = [];
  const visit = (at: Node): void => {
    if (isIdentifier(at)) {
      const parent = at.parent;
      if (names.has(at.text) && !(isPropertyAccessExpression(parent) && parent.name === at)) {
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
          const expression = unwrapped(type.expression);
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

/** What one file's walk collects before the batch that resolves its names. */
interface FileWalk {
  readonly declared: Declared[];
  readonly blocks: Block[];
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
  const kinds = new Map(held.symbols.map((symbol) => [symbol.id, symbol.kind]));
  const parts: PartFact[] = [];
  const signatures: SignatureFact[] = [];
  const calls = new Map<string, boolean>();
  const specifiers = new Set<string>();
  const sites: { readonly file: SourceFile; readonly declared: Declared }[] = [];

  for (const file of files) {
    const declarationAt = (node: Node): string | undefined => {
      const id = held.declarations.get(nodeKey(file, node));
      return id === undefined || kinds.get(id) === "file" ? undefined : id;
    };
    const holderOf = (node: Node): string | undefined => {
      for (let at = node.parent; at.kind !== SyntaxKind.SourceFile; at = at.parent) {
        const id = declarationAt(at);
        if (id !== undefined) {
          return id;
        }
      }
      return undefined;
    };
    const walk: FileWalk = { declared: [], blocks: [], unreachable: [], cases: [] };
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
      }
      if (isCallExpression(node)) {
        const name = calleeName(node);
        if (name !== undefined) {
          calls.set(position(name), discarded(node));
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
      if (isExportAssignment(node) && isIdentifier(unwrapped(node.expression))) {
        specifiers.add(position(unwrapped(node.expression)));
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
      if (isBlock(node) || isCaseClause(node) || isDefaultClause(node)) {
        statementsOf(node.statements);
        return;
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);

    // One batch per file resolves every name a parameter or a local is read through.
    const asked: Identifier[] = [];
    const readers = new Map<Declared, { names: Identifier[]; uses: Identifier[] }>();
    for (const one of walk.declared) {
      const names = one.signature.parameters
        .map((parameter) => parameter.name)
        .filter(isIdentifier);
      const spelled = new Set(names.map((name) => name.text));
      const uses = identifiersNaming(one.signature, spelled).filter((use) => !names.includes(use));
      readers.set(one, { names, uses });
      asked.push(...names, ...uses);
    }
    const stores = walk.blocks.map((block) => localsOf(block));
    for (const store of stores) {
      asked.push(...store.flatMap((local) => [local.name, ...local.uses]));
    }
    const ids = resolvedIds(project, [...new Set(asked)]);

    for (const one of walk.declared) {
      sites.push({ file, declared: one });
      signatures.push({
        declaration: one.id,
        stub: isStub(one.signature),
        fixed: hierarchyFixes(one.node, extended),
      });
      const { uses } = readers.get(one) ?? { uses: [] };
      parts.push(...parameterParts(file, targetRoot, one, uses, ids));
    }
    walk.blocks.forEach((block, at) => {
      const holder = holderOf(block);
      if (holder !== undefined) {
        parts.push(...deadStores(file, targetRoot, block, holder, stores[at] ?? [], ids));
      }
    });
    for (const { statement, holder } of walk.unreachable) {
      parts.push({
        code: UNREACHABLE_STATEMENT,
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
        code: UNREACHABLE_CASE,
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
  return { parts, signatures, calls, specifiers };
}

/** Each named parameter of one function and whether the function reads it. */
function parameterParts(
  file: SourceFile,
  root: string,
  one: Declared,
  uses: readonly Identifier[],
  ids: ReadonlyMap<Node, Answer<number>>,
): PartFact[] {
  const signature = one.signature;
  // A function that reads `arguments` reads every parameter by position.
  const readsArguments =
    !isArrowFunction(signature) && identifiersNaming(signature, new Set(["arguments"])).length > 0;
  const found: PartFact[] = [];
  for (const parameter of signature.parameters) {
    const name = parameter.name;
    if (
      !isIdentifier(name) ||
      name.text === "this" ||
      name.text.startsWith(UNUSED_PREFIX) ||
      ((parameter as { readonly modifiers?: readonly Node[] }).modifiers ?? []).some(isDecorator)
    ) {
      continue;
    }
    found.push({
      code: UNUSED_PARAMETER,
      declaration: one.id,
      kind: "parameter",
      name: name.text,
      position: spanOf(file, root, name),
      message: `parameter ${name.text} is never read in the body`,
      used:
        readsArguments ||
        uses.some((use) => use.text === name.text && readsBinding(use, name, ids)),
    });
  }
  return found;
}

/** One local a block declares by name, and every identifier of the block that spells it. */
interface Local {
  readonly name: Identifier;
  readonly statement: number;
  readonly initialized: boolean;
  readonly uses: readonly Identifier[];
}

/** The locals one block declares with `let` or `const`, each with the names that spell it. */
function localsOf(block: Block): readonly Local[] {
  const declared: { name: Identifier; statement: number; initialized: boolean }[] = [];
  block.statements.forEach((statement, at) => {
    if (!isVariableStatement(statement)) {
      return;
    }
    const list = statement.declarationList;
    if (
      (list.flags & (NodeFlags.Let | NodeFlags.Const)) === 0 ||
      (list.flags & NodeFlags.Using) !== 0
    ) {
      return;
    }
    for (const declaration of list.declarations) {
      if (isIdentifier(declaration.name)) {
        declared.push({
          name: declaration.name,
          statement: at,
          initialized: declaration.initializer !== undefined,
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

/**
 * The writes to the locals of one block that no read reaches. A write is a declaration's
 * initializer or a plain assignment written as a statement of the block itself; it is
 * dead when the statements after it in the block read the local nowhere before the next
 * such write to it, or before the block ends, which ends the local's scope. A statement
 * that writes the local inside a nested construct ends the search with the write kept,
 * and a local a nested function names is no subject, because the function may read it
 * at any time.
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
  for (const local of locals) {
    const uses = local.uses.filter((use) => readsBinding(use, local.name, ids));
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
      const expression = unwrapped(statement.expression);
      if (
        !isBinaryExpression(expression) ||
        expression.operatorToken.kind !== SyntaxKind.EqualsToken
      ) {
        return undefined;
      }
      const target = unwrapped(expression.left);
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
      const sameStatement =
        own !== undefined && write.target === local.name
          ? usesIn(own).filter((use) => use !== local.name)
          : [];
      if (sameStatement.length > 0) {
        continue;
      }
      let dead = true;
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
      if (!dead) {
        continue;
      }
      const position = spanOf(file, root, write.target);
      found.push({
        code: DEAD_STORE,
        declaration: holder,
        kind: "store",
        name: local.name.text,
        position,
        message: `value written to ${local.name.text} is never read`,
        used: false,
      });
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
  calls: ReadonlyMap<string, boolean>,
): PartFact[] {
  const discardedAt = new Set(
    references.filter((one) => calls.get(positionKey(one.position)) === true).map((one) => one.to),
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
    found.push({
      code: UNUSED_RESULT,
      declaration: id,
      kind: "result",
      name: "result",
      position: spanOf(file, root, at),
      message: "result is discarded at every call site",
      used: false,
    });
  }
  return found;
}

/** What the run answers about the parts of its declarations, over every project. */
export interface IntraFunctionFacts {
  /** Every part of the run, each once, in use where any project found it in use. */
  readonly parts: readonly PartFact[];
  /** The declarations whose signature is free to change. */
  readonly free: ReadonlySet<string>;
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
  const calls = new Map<string, boolean>();
  const specifiers = new Set<string>();
  for (const one of projects) {
    for (const [at, value] of one.calls) {
      calls.set(at, value);
    }
    for (const at of one.specifiers) {
      specifiers.add(at);
    }
  }
  const valued = new Set<string>();
  const called = new Map<string, boolean>();
  for (const reference of references) {
    if (reference.use === "decorator" || reference.use === "evaluation") {
      continue;
    }
    const at = positionKey(reference.position);
    const call = reference.consumer === undefined ? calls.get(at) : undefined;
    if (call !== undefined) {
      called.set(reference.to, (called.get(reference.to) ?? true) && call);
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
  const discardedEverywhere = new Set(
    [...called].filter(([id, all]) => all && !valued.has(id)).map(([id]) => id),
  );
  return { parts: [...parts.values()], free, discardedEverywhere };
}
