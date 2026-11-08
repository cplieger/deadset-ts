/**
 * The one syntax walk of a file every reference source and read rule shares: it finds the
 * name nodes that are uses, the stores, the re-exports, the evaluated modules, the module
 * URLs, the workers, the load calls, the decorators, the parameter properties and the keyed
 * accesses, and offers every node to the read rules with its enclosing declaration.
 */

import {
  isArrayLiteralExpression,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isDecorator,
  isDeleteExpression,
  isElementAccessExpression,
  isExportDeclaration,
  isExpressionStatement,
  isExternalModuleReference,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isMetaProperty,
  isNamespaceExport,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVoidExpression,
  SyntaxKind,
  type Identifier,
  type Node,
  type ParameterDeclaration,
  type SourceFile,
  type StringLiteralLikeNode,
} from "@typescript/native/ast";
import { amdLoadOf } from "../amd.ts";
import { writtenValue } from "../entries/static-module.ts";
import type { FlowAt, LiteralAt } from "../contextual-uses.ts";
import { propertyReadsOf, type PropertyRead } from "../destructuring.ts";
import { isParameterProperty, nodeKey } from "../inventory.ts";
import { namespaceUses } from "../namespace-objects.ts";
import { startsRelativePath } from "../paths.ts";
import { writtenName } from "../platform-calls.ts";
import type { Use } from "../references.ts";
import { isLoadCall, type LoadCall } from "../roots/unseen-loads.ts";
import { keyNameOf, type KeyedAccess } from "../symbol-keys.ts";
import { parenthesesRemoved } from "../unwrap.ts";
import { handedOn, valuesOf } from "./values.ts";

/**
 * The operators whose left side one assignment stores into. A compound assignment is
 * among them: where its value is discarded it reads its target only to write the result
 * back, so nothing else receives what it read.
 */
const ASSIGNMENTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.SlashEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.LessThanLessThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.BarEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
  SyntaxKind.CaretEqualsToken,
]);

/**
 * The assignments that read their target to decide whether to store at all, so the read
 * carries information out whatever becomes of the result.
 */
const LOGICAL_ASSIGNMENTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * Whether the value of one store expression is discarded: it is a statement of its own, a
 * clause of a `for` loop, the operand of `void`, or the left operand of a comma.
 */
function valueDiscarded(node: Node): boolean {
  let child = node;
  let parent = node.parent;
  while (isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  if (isExpressionStatement(parent) || isVoidExpression(parent)) {
    return true;
  }
  if (isForStatement(parent)) {
    return parent.initializer === child || parent.incrementor === child;
  }
  return (
    isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.CommaToken &&
    parent.left === child
  );
}

/** Whether one node is an identifier or a private name, the two forms a name takes. */
function isName(node: Node): boolean {
  return node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.PrivateIdentifier;
}

/**
 * Records the name one store writes into.
 *
 * A property access writes the member it names. An element access writes the collection
 * it stores into, since a collection a module only stores into holds nothing anything
 * reads, and joins `accesses` for the member a unique-symbol key selects. A destructuring
 * target writes each name it binds, through its spreads and nested patterns.
 */
function markWrite(target: Node, writes: Set<number>, accesses: Set<Node>): void {
  const held = parenthesesRemoved(target);
  if (isName(held)) {
    writes.add(held.pos);
    return;
  }
  if (isPropertyAccessExpression(held)) {
    if (isName(held.name)) {
      writes.add(held.name.pos);
    }
    return;
  }
  if (isElementAccessExpression(held)) {
    accesses.add(held);
    // A store through a member's value lands in storage every holder of the value
    // reads, so it reads the member; a variable only ever stored into stays written.
    if (!isPropertyAccessExpression(parenthesesRemoved(held.expression))) {
      markWrite(held.expression, writes, accesses);
    }
    return;
  }
  if (isArrayLiteralExpression(held)) {
    for (const element of held.elements) {
      markWrite(element, writes, accesses);
    }
    return;
  }
  if (isObjectLiteralExpression(held)) {
    for (const property of held.properties) {
      if (isPropertyAssignment(property)) {
        markWrite(property.initializer, writes, accesses);
        continue;
      }
      if (isShorthandPropertyAssignment(property)) {
        markWrite(property.name, writes, accesses);
        continue;
      }
      if (isSpreadAssignment(property)) {
        markWrite(property.expression, writes, accesses);
      }
    }
    return;
  }
  if (isSpreadElement(held)) {
    markWrite(held.expression, writes, accesses);
  }
}

/**
 * Records every store one node performs: an assignment, a compound assignment, an
 * increment or a decrement, a `delete`, and an iteration that assigns to a name declared
 * elsewhere. An iteration that declares its own name stores into nothing the inventory
 * holds. A store that reads its target as well records it in `reads`: a logical
 * assignment, and a compound assignment, an increment or a decrement whose value is used.
 */
function markStores(
  node: Node,
  writes: Set<number>,
  reads: Set<number>,
  accesses: { readonly written: Set<Node>; readonly read: Set<Node> },
): void {
  if (isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (ASSIGNMENTS.has(operator)) {
      markWrite(node.left, writes, accesses.written);
      if (
        LOGICAL_ASSIGNMENTS.has(operator) ||
        (operator !== SyntaxKind.EqualsToken && !valueDiscarded(node))
      ) {
        markWrite(node.left, reads, accesses.read);
      }
    }
    return;
  }
  if (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) {
    if (
      node.operator === SyntaxKind.PlusPlusToken ||
      node.operator === SyntaxKind.MinusMinusToken
    ) {
      markWrite(node.operand, writes, accesses.written);
      if (!valueDiscarded(node)) {
        markWrite(node.operand, reads, accesses.read);
      }
    }
    return;
  }
  if (isDeleteExpression(node)) {
    markWrite(node.expression, writes, accesses.written);
    return;
  }
  if (isForInStatement(node) || isForOfStatement(node)) {
    if (node.initializer.kind !== SyntaxKind.VariableDeclarationList) {
      markWrite(node.initializer, writes, accesses.written);
    }
  }
}

/** One name node the walk found, and what the walk knows about it. */
export interface Site {
  /** The name node, whose position the reference carries. */
  readonly node: Node;
  /**
   * The shorthand property assignment this name belongs to, where it belongs to one.
   * Its value is the declaration the name reads, while the name itself declares the
   * property the literal carries.
   */
  readonly shorthand: Node | undefined;
  readonly from: string;
  readonly use: Use;
}

/**
 * One re-export the walk found, which names what it carries forward without a name
 * that is a use: an export specifier, a namespace export, or a bare star re-export.
 */
export interface Link {
  /**
   * The node whose symbol says what the re-export carries: the alias a specifier or a
   * namespace export declares, or the module a bare star re-export names.
   */
  readonly node: Node;
  /** Where the reference is written: the name a specifier re-exports, or the module specifier. */
  readonly at: Node;
  /** The re-export's own declaration, or for a bare star the declaration enclosing it. */
  readonly from: string;
  /** Whether the node's symbol is an alias, which is followed one link along. */
  readonly alias: boolean;
}

/** One place the walk found that evaluates a module, and the declaration that holds it. */
export interface Evaluation {
  /** The module specifier, whose symbol is the module evaluated. */
  readonly node: Node;
  readonly from: string;
  /** The name a `require()` call is written with; {@link callsPlatform} owns which one loads. */
  readonly require?: Identifier;
  /** Whether the call's value is used, which reads the loaded file's export table. */
  readonly whole?: boolean;
  /** Whether the id is one of an AMD call's dependencies, `require` naming its callee. */
  readonly amd?: true;
}

/**
 * One module URL a source file builds: `new URL(<literal>, import.meta.url)` or
 * `import.meta.resolve(<literal>)`, the literal relative. A runtime starts the file it
 * names as a module, so it is an import of that file for its effects.
 */
interface ModuleURL {
  readonly specifier: string;
  /** The name the constructor is written with; {@link callsPlatform} owns which one is `URL`. */
  readonly constructor: Identifier | undefined;
  readonly at: Node;
}

/** One module URL, and the declaration whose code builds it. */
interface ModuleURLAt extends ModuleURL {
  readonly from: string;
}

/** One worker a call starts by a literal address (references-ts.2), and the declaration whose code starts it. */
interface WorkerSite {
  readonly address: string;
  /**
   * Whether the address is a `resolve` or `join` of the calling file's own directory and
   * literals, a path only Node's `Worker` reads, against that directory.
   */
  readonly ownDirectory: boolean;
  /** The name the constructor or `navigator` is written with. */
  readonly constructor: Identifier;
  /** The namespace the constructor is read through, as `threads` in `threads.Worker`. */
  readonly holder: Identifier | undefined;
  /** Whether an options literal writes an `eval` other than `false`, which makes a thread's address code. */
  readonly evaluated: boolean;
  readonly at: Node;
  readonly from: string;
}

/** One use of a module namespace object that may read every export of the module. */
interface WholeRead {
  /** The module specifier, whose symbol is the module read. */
  readonly specifier: Node;
  /** The use, whose position the reference carries. */
  readonly at: Node;
  readonly from: string;
}

/** One decorator expression, and the declaration it is attached to. */
interface Decorated {
  readonly decorator: Node;
  readonly declaration: string;
}

/** One parameter property, which its constructor writes, and the declaration that writes it. */
interface ParameterWrite {
  readonly name: Node;
  readonly from: string;
  readonly member: string;
}

/** One property a pattern reads, and the declaration the pattern is written inside. */
interface PatternRead extends PropertyRead {
  readonly from: string;
}

/** Everything one file's walk found to resolve, and the decorators it needs no resolution for. */
export interface FileSites {
  readonly uses: readonly Site[];
  readonly literals: readonly LiteralAt[];
  readonly flows: readonly FlowAt[];
  readonly reads: readonly PatternRead[];
  readonly links: readonly Link[];
  readonly evaluations: readonly Evaluation[];
  readonly wholes: readonly WholeRead[];
  readonly urls: readonly ModuleURLAt[];
  readonly workers: readonly WorkerSite[];
  readonly loadCalls: readonly LoadCall[];
  readonly decorated: readonly Decorated[];
  readonly parameterWrites: readonly ParameterWrite[];
  readonly keyed: readonly KeyedAccess[];
}

/** Whether one node is `import.meta.url`. */
function isImportMetaURL(node: Node): boolean {
  const at = parenthesesRemoved(node);
  return (
    isPropertyAccessExpression(at) &&
    isMetaProperty(at.expression) &&
    at.expression.keywordToken === SyntaxKind.ImportKeyword &&
    at.name.text === "url"
  );
}

/** The module URL one node builds, where it builds one. */
function moduleURLOf(node: Node): ModuleURL | undefined {
  const literal = (argument: Node | undefined): string | undefined => {
    const at = argument === undefined ? undefined : parenthesesRemoved(argument);
    return isLiteralText(at) ? at.text : undefined;
  };
  const constructor = isNewExpression(node) ? writtenName(node.expression) : undefined;
  if (isNewExpression(node) && constructor !== undefined) {
    const [reference, base] = node.arguments ?? [];
    const specifier = literal(reference);
    return specifier !== undefined && base !== undefined && isImportMetaURL(base)
      ? { specifier, constructor, at: node }
      : undefined;
  }
  if (isCallExpression(node)) {
    const callee = parenthesesRemoved(node.expression);
    const specifier = literal(node.arguments[0]);
    if (
      specifier !== undefined &&
      startsRelativePath(specifier) &&
      isPropertyAccessExpression(callee) &&
      isMetaProperty(callee.expression) &&
      callee.expression.keywordToken === SyntaxKind.ImportKeyword &&
      callee.name.text === "resolve"
    ) {
      return { specifier, constructor: undefined, at: node };
    }
  }
  return undefined;
}

/** The constructors whose first argument addresses a worker. */
export const WORKER_CONSTRUCTORS: ReadonlySet<string> = new Set(["Worker", "SharedWorker"]);

/** Whether an options argument is an object literal whose `eval` member is written as anything but `false`. */
function evaluatesCode(options: Node | undefined): boolean {
  const at = options === undefined ? undefined : parenthesesRemoved(options);
  return (
    at !== undefined &&
    isObjectLiteralExpression(at) &&
    at.properties.some(
      (property) =>
        (isShorthandPropertyAssignment(property) &&
          isIdentifier(property.name) &&
          property.name.text === "eval") ||
        (isPropertyAssignment(property) &&
          (isIdentifier(property.name) || isStringLiteral(property.name)) &&
          property.name.text === "eval" &&
          parenthesesRemoved(property.initializer).kind !== SyntaxKind.FalseKeyword),
    )
  );
}

/** The worker one node starts by a literal address or a path of its own directory, where it starts one. */
function workerOf(node: Node): Omit<WorkerSite, "from"> | undefined {
  if (isNewExpression(node)) {
    const constructor = writtenName(node.expression);
    const [address, options] = node.arguments ?? [];
    const literal = address === undefined ? undefined : parenthesesRemoved(address);
    const value = literal === undefined ? undefined : writtenValue(literal);
    const ownDirectory = value?.kind === "directory";
    const text =
      value?.kind === "directory"
        ? value.segments.join("/")
        : isLiteralText(literal)
          ? literal.text
          : undefined;
    // A thread's constructor may be imported under another name, whose path is relative.
    if (
      constructor === undefined ||
      text === undefined ||
      (!WORKER_CONSTRUCTORS.has(constructor.text) && !ownDirectory && !startsRelativePath(text))
    ) {
      return undefined;
    }
    const callee = parenthesesRemoved(node.expression);
    const holder = isPropertyAccessExpression(callee)
      ? parenthesesRemoved(callee.expression)
      : undefined;
    return {
      address: text,
      ownDirectory,
      constructor,
      holder: holder !== undefined && isIdentifier(holder) ? holder : undefined,
      evaluated: evaluatesCode(options),
      at: node,
    };
  }
  if (!isCallExpression(node)) {
    return undefined;
  }
  const callee = parenthesesRemoved(node.expression);
  const registry =
    isPropertyAccessExpression(callee) && callee.name.text === "register"
      ? parenthesesRemoved(callee.expression)
      : undefined;
  const navigator =
    registry !== undefined &&
    isPropertyAccessExpression(registry) &&
    registry.name.text === "serviceWorker"
      ? writtenName(registry.expression)
      : undefined;
  const [address] = node.arguments;
  const literal = address === undefined ? undefined : parenthesesRemoved(address);
  return navigator?.text === "navigator" && isLiteralText(literal)
    ? {
        address: literal.text,
        ownDirectory: false,
        constructor: navigator,
        holder: undefined,
        evaluated: false,
        at: node,
      }
    : undefined;
}

/** Whether one node is a string literal or a template literal with no substitution. */
export function isLiteralText(node: Node | undefined): node is StringLiteralLikeNode {
  return node !== undefined && (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node));
}

/**
 * The module specifier of the module one node evaluates, if it evaluates one: an import
 * declaration, an import-equals declaration of an external module, an export
 * declaration that names a module, an `import()` call whose argument is literal text, and
 * a call that may be a `require()` of literal text: one written as the name `require`, or
 * one of a relative specifier through another name. A type-only form evaluates nothing.
 * An `import()` of a computed argument names no module this pass can know.
 */
function evaluationOf(node: Node): Omit<Evaluation, "from"> | undefined {
  if (isCallExpression(node) && node.expression.kind !== SyntaxKind.ImportKeyword) {
    const [argument] = node.arguments;
    const require = writtenName(node.expression);
    if (
      require === undefined ||
      !isLiteralText(argument) ||
      (require.text !== "require" && !startsRelativePath(argument.text))
    ) {
      return undefined;
    }
    return { node: argument, require, whole: !discarded(node) };
  }
  const specifier = evaluatedBy(node);
  return specifier === undefined ? undefined : { node: specifier };
}

/** Whether an expression's value is thrown away: it is a statement of its own, or `void`'s operand. */
function discarded(expression: Node): boolean {
  let at = expression.parent;
  while (isParenthesizedExpression(at)) {
    at = at.parent;
  }
  return isExpressionStatement(at) || isVoidExpression(at);
}

function evaluatedBy(node: Node): Node | undefined {
  if (isImportDeclaration(node)) {
    return node.importClause?.phaseModifier === SyntaxKind.TypeKeyword
      ? undefined
      : node.moduleSpecifier;
  }
  if (isExportDeclaration(node)) {
    return node.isTypeOnly ? undefined : node.moduleSpecifier;
  }
  if (isImportEqualsDeclaration(node)) {
    const reference = node.moduleReference;
    return !node.isTypeOnly && isExternalModuleReference(reference)
      ? reference.expression
      : undefined;
  }
  if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
    const [argument] = node.arguments;
    return isLiteralText(argument) ? argument : undefined;
  }
  return undefined;
}

/**
 * The re-exports one node writes, if it is an export declaration. A specifier and a
 * namespace export are declarations whose names are where they are written, so no use is
 * read from them; each references what it carries forward instead. A bare star declares
 * nothing, so the declaration enclosing it, at the top level the file, references the
 * module it names.
 */
function linksOf(
  file: SourceFile,
  node: Node,
  declarations: ReadonlyMap<string, string>,
  enclosing: string,
): Link[] {
  if (!isExportDeclaration(node)) {
    return [];
  }
  const clause = node.exportClause;
  const specifier = node.moduleSpecifier;
  if (clause === undefined) {
    return specifier === undefined
      ? []
      : [{ node: specifier, at: specifier, from: enclosing, alias: false }];
  }
  if (isNamespaceExport(clause)) {
    const from = declarations.get(nodeKey(file, clause));
    return from === undefined
      ? []
      : [{ node: clause.name, at: specifier ?? clause.name, from, alias: true }];
  }
  const found: Link[] = [];
  for (const element of clause.elements) {
    const from = declarations.get(nodeKey(file, element));
    if (from !== undefined) {
      found.push({
        node: element.name,
        at: element.propertyName ?? element.name,
        from,
        alias: true,
      });
    }
  }
  return found;
}

/**
 * Whether one object literal is a destructuring target, written on the left of an
 * assignment or as a `for` loop's initializer, through the literals and spreads it nests in.
 */
function isAssignmentPattern(node: Node): boolean {
  let child = node;
  let parent = node.parent;
  while (
    isParenthesizedExpression(parent) ||
    isArrayLiteralExpression(parent) ||
    isObjectLiteralExpression(parent) ||
    isSpreadElement(parent) ||
    isSpreadAssignment(parent) ||
    (isPropertyAssignment(parent) && parent.initializer === child)
  ) {
    child = parent;
    parent = parent.parent;
  }
  if (isBinaryExpression(parent)) {
    return parent.operatorToken.kind === SyntaxKind.EqualsToken && parent.left === child;
  }
  return (isForInStatement(parent) || isForOfStatement(parent)) && parent.initializer === child;
}

/**
 * Every name node one file holds that is a use rather than a declaration, in source
 * order, each with its enclosing declaration and its use, and every re-export the file
 * writes. One walk answers all of it, because a second would have to agree with this one
 * about which nodes are names. A declaration's own declared name is left out, which is
 * what makes a declaration referenced only from its own site an unreferenced one, and so
 * is every node of `unread`, a subtree that is no use.
 */
export function sitesOf(
  file: SourceFile,
  declarations: ReadonlyMap<string, string>,
  fileId: string,
  unread: ReadonlySet<Node>,
  offer: (node: Node, from: string) => void,
): FileSites {
  const found: Site[] = [];
  const reads: PatternRead[] = [];
  const links: Link[] = [];
  const evaluations: Evaluation[] = [];
  const wholes: WholeRead[] = [];
  const urls: ModuleURLAt[] = [];
  const workers: WorkerSite[] = [];
  const loadCalls: LoadCall[] = [];
  const decorated: Decorated[] = [];
  const parameterWrites: ParameterWrite[] = [];
  const namespaces = namespaceUses(file);
  const literals: LiteralAt[] = [];
  const flows: FlowAt[] = [];
  const writes = new Set<number>();
  const alsoRead = new Set<number>();
  const accesses = { written: new Set<Node>(), read: new Set<Node>() };
  const keyed: KeyedAccess[] = [];
  const declared = new Set<number>();
  const shorthands = new Map<number, Node>();
  let enclosing = fileId;

  const markNames = (node: Node): void => {
    if (isShorthandPropertyAssignment(node)) {
      shorthands.set(node.name.pos, node);
      return;
    }
    // A property access carries the member it names where a declaration carries its
    // declared name, and it is the one form of the grammar that does.
    if (isPropertyAccessExpression(node)) {
      return;
    }
    const named = node as { readonly name?: Node; readonly propertyName?: Node };
    for (const name of [named.name, named.propertyName]) {
      if (name !== undefined && isName(name)) {
        declared.add(name.pos);
      }
    }
  };

  // A read rule sees every node, an unread subtree's too, each with its enclosing declaration.
  const offerAll = (node: Node): void => {
    offer(node, enclosing);
    node.forEachChild(offerAll);
  };
  const visit = (node: Node): void => {
    if (unread.has(node)) {
      offerAll(node);
      return;
    }
    offer(node, enclosing);
    const namespace = namespaces.get(node);
    if (namespace?.kind === "whole") {
      wholes.push({ specifier: namespace.specifier, at: node, from: enclosing });
    } else if (namespace?.kind === "indexed") {
      found.push({ node: namespace.literal, shorthand: undefined, from: enclosing, use: "read" });
    }
    if (isName(node)) {
      if (!declared.has(node.pos)) {
        const site = { node, shorthand: shorthands.get(node.pos), from: enclosing };
        if (writes.has(node.pos)) {
          found.push({ ...site, use: "write" });
        }
        if (!writes.has(node.pos) || alsoRead.has(node.pos)) {
          found.push({ ...site, use: "read" });
        }
      }
      return;
    }
    markNames(node);
    markStores(node, writes, alsoRead, accesses);
    const key = isElementAccessExpression(node) ? keyNameOf(node.argumentExpression) : undefined;
    if (key !== undefined && isElementAccessExpression(node)) {
      const written = accesses.written.has(node);
      keyed.push({
        access: node,
        key,
        from: enclosing,
        use: written ? (accesses.read.has(node) ? "both" : "write") : "read",
      });
    }
    if (isObjectLiteralExpression(node) && !isAssignmentPattern(node)) {
      literals.push({ literal: node, from: enclosing });
    }
    // An assertion needs only comparability, so no member of its operand is read by it.
    for (const written of isAsExpression(node) ? [] : handedOn(node)) {
      flows.push(...valuesOf(written).map((value) => ({ value, from: enclosing })));
    }
    for (const read of propertyReadsOf(node)) {
      reads.push({ ...read, from: enclosing });
    }
    links.push(...linksOf(file, node, declarations, enclosing));
    const evaluated = evaluationOf(node);
    if (evaluated !== undefined) {
      evaluations.push({ ...evaluated, from: enclosing });
    }
    const amd = amdLoadOf(node);
    if (amd !== undefined) {
      const { callee, ids } = amd;
      for (const { id, received } of ids) {
        evaluations.push({
          node: id,
          require: callee,
          whole: received,
          amd: true,
          from: enclosing,
        });
      }
    }
    const url = moduleURLOf(node);
    if (url !== undefined) {
      urls.push({ ...url, from: enclosing });
    }
    const worker = workerOf(node);
    if (worker !== undefined) {
      workers.push({ ...worker, from: enclosing });
    }
    if (isLoadCall(node)) {
      loadCalls.push({ call: node, from: enclosing });
    }
    const held = declarations.get(nodeKey(file, node));
    const outer = enclosing;
    // A parameter property's annotation, initializer and decorators stay with the
    // parameter when the member goes, so they are written inside the constructor's class.
    if (held !== undefined && isParameterProperty(node)) {
      parameterWrites.push({
        name: (node as ParameterDeclaration).name,
        from: outer,
        member: held,
      });
    } else if (held !== undefined) {
      enclosing = held;
      for (const modifier of (node as { readonly modifiers?: readonly Node[] }).modifiers ?? []) {
        if (isDecorator(modifier)) {
          decorated.push({ decorator: modifier, declaration: held });
        }
      }
    }
    node.forEachChild(visit);
    enclosing = outer;
  };

  file.forEachChild(visit);
  return {
    uses: found,
    literals,
    flows,
    reads,
    links,
    evaluations,
    wholes,
    urls,
    workers,
    loadCalls,
    decorated,
    parameterWrites,
    keyed,
  };
}
