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
  isNewExpression,
  isNamespaceExport,
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
  type Node,
  type SourceFile,
} from "@typescript/native/unstable/ast";
import type { Symbol as TSSymbol } from "@typescript/native/unstable/sync";
import { aliasChains, type ChainTarget } from "./alias-chain.ts";
import { contextualUses, type FlowAt, type LiteralAt } from "./contextual-uses.ts";
import { destructuring, propertyReadsOf, type PropertyRead } from "./destructuring.ts";
import { specifierCandidates } from "./configuration-files.ts";
import { namespaceUses } from "./namespace-objects.ts";
import { globExpression } from "./glob.ts";
import { declarationsByName, nodeKey, type Inventory, type InventorySymbol } from "./inventory.ts";
import { augmentationReferences } from "./augmentations.ts";
import { indexedAccessReferences } from "./indexed-access.ts";
import { moduleDeclarationReferences } from "./module-declarations.ts";
import { overrideReferences } from "./overrides.ts";
import { dirnamePath, queriedModulePath, relativePath, resolvePath } from "./paths.ts";
import { byPosition, isComponentFile, renderPosition, type Position } from "./position.ts";
import { DEFAULT_BATCH_CAP, propertyTables, UNANSWERED, type Answer } from "./query.ts";
import type { ProjectView } from "./session.ts";
import { typeQueryAliases } from "./type-query-alias.ts";
import { handedOn, valuesOf } from "./value-flow.ts";

/**
 * Every use one project's own files make of the project's own declarations.
 *
 * The pass is one local walk per file and one batched resolution per file, never a
 * query per symbol: a per-symbol reference query is the shape whose answers depend on
 * the order the symbols are asked about, so no answer here depends on that order. The
 * tree is on this side of the client boundary and the resolution is not, which is why a
 * file's name nodes are gathered whole and handed over together.
 *
 * What the pass records and what it does not: a reference carries its use, its
 * position, the declaration that encloses it and the classification of the file that
 * made it, and every place that imports one of the project's own modules is an
 * evaluation of that module's file. It carries no mode. Which of the references a run
 * counts is the reading the sweep makes of this set, so the mode is one value the run
 * decides once and this pass never sees it.
 */

/**
 * How one reference uses the declaration it names. An `evaluation` names a file: the
 * place it is written imports the module, which runs the module's top level and reads
 * none of what it exports. A `read` of a file reads the module's namespace. A
 * `decorator` names the declaration a decorator expression is attached to, which the
 * decorator receives when the class is defined.
 */
export type Use = "read" | "write" | "evaluation" | "decorator";

/**
 * Which path answered for one reference: `batch`, a file's batched lookup; `resolved-symbol`,
 * the per-node lookup for its residue; `shorthand`, the value `{ a }` reads; `alias`, a step
 * along an import or export chain; `syntax`, the tree alone (a decorator's target, a
 * component's markup); `destructured`, the property a pattern names; `contextual`, the member
 * a literal property writes or a value's position reads; `override`, the override a base
 * member's call dispatches to; `by-name`, every declaration so spelled, where the checker failed.
 */
export type Resolution =
  | "batch"
  | "resolved-symbol"
  | "shorthand"
  | "alias"
  | "syntax"
  | "destructured"
  | "contextual"
  | "override"
  | "by-name";

/** One use of one declaration by one declaration. */
export interface Reference {
  /**
   * The identifier of the declaration the referencing name is written inside. A
   * reference written outside every declaration of a file belongs to the file and
   * carries the file's own identifier, the way an import belongs to the file that
   * writes it rather than to the first declaration below it.
   */
  readonly from: string;
  /** The identifier of the declaration the reference names. */
  readonly to: string;
  /** Where the referencing name is written. */
  readonly position: Position;
  readonly use: Use;
  readonly resolution: Resolution;
  /** Whether the file that made the reference is classified as a test file. */
  readonly test: boolean;
  /**
   * The identifier of the consumer whose file made the reference, absent for one the
   * target made. A consumer's declarations are no declarations of the run, so such a
   * reference comes from outside the inventory, and its position is rendered against
   * the consumer's root.
   */
  readonly consumer?: string;
  /** Made by a target file no project of the run holds, so it enters as a consumer's reference does. */
  readonly unheld?: true;
  /**
   * On a write, the local names of the writing file's import bindings that only the
   * values its file writes into the same declaration use, which deleting the
   * declaration with its writes deletes too.
   */
  readonly alone?: readonly string[];
}

/** The consumer one reference pass reads the files of, beside the target it names. */
export interface ConsumerSide {
  /** The name the consumer publishes itself under. */
  readonly id: string;
  /** The consumer's directory, absolute: the files below it are its own. */
  readonly root: string;
}

/** One rule that classified files as test files, and how many files it matched. */
export interface TestFileRule {
  /** The rule's name, as a report's own rule list spells one. */
  readonly rule: string;
  readonly matched: number;
}

/** What one project's reference pass cost at the client boundary. */
export interface ReferenceCost {
  /**
   * The name nodes the batches asked about, summed over the files. It is the size of
   * the question rather than a cost of its own, and it is reported so that the number
   * of batches is readable against it.
   */
  readonly batched: number;
  /**
   * Batched lookups: per file, the name-node count divided by the batch cap, rounded
   * up. It is what keeps the pass's cost off the identifier count.
   */
  readonly fileBatches: number;
  /** Per-node lookups for the name nodes a batch left unresolved. */
  readonly residueFallbacks: number;
  /** Per-node lookups for a shorthand property assignment's value. */
  readonly shorthandLookups: number;
  /** Per-symbol lookups that step from one alias to what it names, one per alias. */
  readonly aliasSteps: number;
  /**
   * Batched type lookups for the object patterns: per file, the patterns and the values
   * assigned to destructuring targets, divided by the batch cap, rounded up.
   */
  readonly patternBatches: number;
  /**
   * Per-type lookups for the object patterns: one property table per distinct type a
   * pattern destructures, and each step a nested assignment target takes into its value.
   */
  readonly patternLookups: number;
  /**
   * Batched lookups for the contextual uses: the contextual types of the object literals
   * and of the values that carry a member, and the values' types, each per capped run.
   */
  readonly contextualBatches: number;
  /** Per-type lookups for the contextual uses: each distinct type's constituents, properties and symbol. */
  readonly contextualLookups: number;
}

/** One project's references, in position order, and what reading them cost. */
export interface References {
  /** The compiler configuration the project was opened from. */
  readonly configFile: string;
  readonly references: readonly Reference[];
  /**
   * Every file the rules classified as a test file, by its path below the target root,
   * ascending. A declaration such a file holds is a test declaration, by the same
   * classification that marks the references the file makes.
   */
  readonly testFilePaths: readonly string[];
  readonly cost: ReferenceCost;
}

/** How one run resolves references. */
export interface ReferenceOptions {
  /**
   * The greatest number of name nodes one batched lookup asks about. A batch is
   * answered by an array of its own length, so an uncapped batch over a large file
   * makes one answer proportional to that file. Absent takes {@link DEFAULT_BATCH_CAP}.
   */
  readonly batchCap?: number;
  /**
   * Glob patterns, relative to the target root, naming the files that are test files.
   * Each pattern is a rule of its own, which {@link testFileRulesOf} counts.
   */
  readonly testFiles: readonly string[];
  /**
   * The consumer whose files the pass walks instead of the target's. Its files are the
   * program's own files below its root and not below the target root, each position is
   * rendered against its root and the test patterns read the path below it, and only a
   * reference to a declaration of `held`, the target's, is recorded.
   */
  readonly consumer?: ConsumerSide;
}

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

/** The expression one node is, through however many parentheses are written around it. */
function unparenthesized(node: Node): Node {
  let held = node;
  while (isParenthesizedExpression(held)) {
    held = held.expression;
  }
  return held;
}

/**
 * Records the name one store writes into.
 *
 * A property access writes the member it names. An element access writes the collection
 * it stores into, because a collection a module only ever stores into holds nothing
 * anything reads, and the key is no declaration of the target. A destructuring target
 * writes each name it binds, through the spreads and the nested patterns it binds them
 * in.
 */
function markWrite(target: Node, writes: Set<number>): void {
  const held = unparenthesized(target);
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
    // A store through a member's value lands in storage every holder of the value
    // reads, so it reads the member; a variable only ever stored into stays written.
    if (!isPropertyAccessExpression(unparenthesized(held.expression))) {
      markWrite(held.expression, writes);
    }
    return;
  }
  if (isArrayLiteralExpression(held)) {
    for (const element of held.elements) {
      markWrite(element, writes);
    }
    return;
  }
  if (isObjectLiteralExpression(held)) {
    for (const property of held.properties) {
      if (isPropertyAssignment(property)) {
        markWrite(property.initializer, writes);
        continue;
      }
      if (isShorthandPropertyAssignment(property)) {
        markWrite(property.name, writes);
        continue;
      }
      if (isSpreadAssignment(property)) {
        markWrite(property.expression, writes);
      }
    }
    return;
  }
  if (isSpreadElement(held)) {
    markWrite(held.expression, writes);
  }
}

/**
 * Records every store one node performs: an assignment, a compound assignment, an
 * increment or a decrement, a `delete`, and an iteration that assigns to a name declared
 * elsewhere. An iteration that declares its own name stores into nothing the inventory
 * holds. A store that reads its target as well records it in `reads`: a logical
 * assignment, and a compound assignment, an increment or a decrement whose value is used.
 */
function markStores(node: Node, writes: Set<number>, reads: Set<number>): void {
  if (isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (ASSIGNMENTS.has(operator)) {
      markWrite(node.left, writes);
      if (
        LOGICAL_ASSIGNMENTS.has(operator) ||
        (operator !== SyntaxKind.EqualsToken && !valueDiscarded(node))
      ) {
        markWrite(node.left, reads);
      }
    }
    return;
  }
  if (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) {
    if (
      node.operator === SyntaxKind.PlusPlusToken ||
      node.operator === SyntaxKind.MinusMinusToken
    ) {
      markWrite(node.operand, writes);
      if (!valueDiscarded(node)) {
        markWrite(node.operand, reads);
      }
    }
    return;
  }
  if (isDeleteExpression(node)) {
    markWrite(node.expression, writes);
    return;
  }
  if (isForInStatement(node) || isForOfStatement(node)) {
    if (node.initializer.kind !== SyntaxKind.VariableDeclarationList) {
      markWrite(node.initializer, writes);
    }
  }
}

/** One name node the walk found, and what the walk knows about it. */
interface Site {
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
interface Link {
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
interface Evaluation {
  /** The module specifier, whose symbol is the module evaluated. */
  readonly node: Node;
  readonly from: string;
}

/**
 * One module URL a source file builds: `new URL(<literal>, import.meta.url)` or
 * `import.meta.resolve(<literal>)`, the literal relative. A runtime starts the file it
 * names as a module, so it is an import of that file for its effects.
 */
interface ModuleURL {
  readonly specifier: string;
  /** The `URL` the constructor names, which must name no declaration of the target. */
  readonly constructor: Node | undefined;
  readonly at: Node;
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

/** One property a pattern reads, and the declaration the pattern is written inside. */
interface Read extends PropertyRead {
  readonly from: string;
}

/** Everything one file's walk found to resolve, and the decorators it needs no resolution for. */
interface FileSites {
  readonly uses: readonly Site[];
  readonly literals: readonly LiteralAt[];
  readonly flows: readonly FlowAt[];
  readonly reads: readonly Read[];
  readonly links: readonly Link[];
  readonly evaluations: readonly Evaluation[];
  readonly wholes: readonly WholeRead[];
  readonly urls: readonly ModuleURL[];
  readonly decorated: readonly Decorated[];
}

/** Whether one node is `import.meta.url`. */
function isImportMetaURL(node: Node): boolean {
  const at = unparenthesized(node);
  return (
    isPropertyAccessExpression(at) &&
    isMetaProperty(at.expression) &&
    at.expression.keywordToken === SyntaxKind.ImportKeyword &&
    at.name.text === "url"
  );
}

/** The module URL one node builds, where it builds one. */
function moduleURLOf(node: Node): ModuleURL | undefined {
  const relative = (argument: Node | undefined): string | undefined => {
    const at = argument === undefined ? undefined : unparenthesized(argument);
    return at !== undefined &&
      (isStringLiteral(at) || isNoSubstitutionTemplateLiteral(at)) &&
      /^\.\.?\//u.test(at.text)
      ? at.text
      : undefined;
  };
  if (isNewExpression(node) && isIdentifier(node.expression) && node.expression.text === "URL") {
    const [reference, base] = node.arguments ?? [];
    const specifier = relative(reference);
    return specifier !== undefined && base !== undefined && isImportMetaURL(base)
      ? { specifier, constructor: node.expression, at: node }
      : undefined;
  }
  if (isCallExpression(node)) {
    const callee = unparenthesized(node.expression);
    const specifier = relative(node.arguments[0]);
    if (
      specifier !== undefined &&
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

/** Whether one node is a string literal or a template literal with no substitution. */
function isLiteralText(node: Node | undefined): node is Node {
  return node !== undefined && (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node));
}

/**
 * The module specifier of the module one node evaluates, if it evaluates one: an import
 * declaration, an import-equals declaration of an external module, an export
 * declaration that names a module, and an `import()` call whose argument is literal
 * text. A type-only form evaluates nothing. An `import()` of a computed argument names
 * no module this pass can know.
 */
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
 * The own file a module specifier with a query evaluates ({@link queriedModulePath}): the
 * checker resolves the whole specifier to whatever module declaration matches it.
 */
function queriedFile(
  file: SourceFile,
  specifier: Node,
  fileIdByName: ReadonlyMap<string, string>,
): string | undefined {
  if (!isStringLiteral(specifier) && !isNoSubstitutionTemplateLiteral(specifier)) {
    return undefined;
  }
  const path = queriedModulePath(specifier.text);
  return path === undefined
    ? undefined
    : fileIdByName.get(resolvePath(dirnamePath(file.fileName), path));
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
function sitesOf(
  file: SourceFile,
  declarations: ReadonlyMap<string, string>,
  fileId: string,
  unread: ReadonlySet<Node>,
): FileSites {
  const found: Site[] = [];
  const reads: Read[] = [];
  const links: Link[] = [];
  const evaluations: Evaluation[] = [];
  const wholes: WholeRead[] = [];
  const urls: ModuleURL[] = [];
  const decorated: Decorated[] = [];
  const namespaces = namespaceUses(file);
  const literals: LiteralAt[] = [];
  const flows: FlowAt[] = [];
  const writes = new Set<number>();
  const alsoRead = new Set<number>();
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

  const visit = (node: Node): void => {
    if (unread.has(node)) {
      return;
    }
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
    markStores(node, writes, alsoRead);
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
    const evaluated = evaluatedBy(node);
    if (evaluated !== undefined) {
      evaluations.push({ node: evaluated, from: enclosing });
    }
    const url = moduleURLOf(node);
    if (url !== undefined) {
      urls.push(url);
    }
    const held = declarations.get(nodeKey(file, node));
    const outer = enclosing;
    if (held !== undefined) {
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
  return { uses: found, literals, flows, reads, links, evaluations, wholes, urls, decorated };
}

/** The declaration kinds of a property an object literal declares. */
const LITERAL_PROPERTY_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.PropertyAssignment,
  SyntaxKind.ShorthandPropertyAssignment,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);

/** The rule a file the analysis classified as test-support code is counted under. */
const TEST_SUPPORT_RULE = "test-support";

/**
 * The name one test-file rule takes. A rule's name is a word list the report's own
 * vocabulary spells, which cannot carry a pattern, so a rule is named by the place of
 * its pattern in the configured list.
 */
function patternRule(index: number): string {
  return `test-file-pattern-${String(index + 1)}`;
}

/**
 * The rules over the test files of several projects at once, ordered by rule: a file two
 * projects hold is one file, so each rule counts the distinct paths it matches.
 */
export function testFileRulesOf(
  testFiles: readonly string[],
  paths: readonly string[],
  supportFiles: readonly string[] = [],
): readonly TestFileRule[] {
  const distinct = [...new Set(paths)];
  const support = new Set(supportFiles).size;
  return [
    ...testFiles.map((pattern, index) => {
      const expression = globExpression(pattern);
      return {
        rule: patternRule(index),
        matched: distinct.filter((path) => expression.test(path)).length,
      };
    }),
    ...(support === 0 ? [] : [{ rule: TEST_SUPPORT_RULE, matched: support }]),
  ].sort((a, b) => compare(a.rule, b.rule));
}

const importedCache = new WeakMap<
  SourceFile,
  ReadonlyMap<string, readonly (string | undefined)[]>
>();

/**
 * Each local name one file's imports bind, mapped to the names it imports: the
 * exported name of a named import, `default` for a default import, and `undefined` for
 * a namespace import or an import assignment, which binds a whole module.
 */
function importedNames(file: SourceFile): ReadonlyMap<string, readonly (string | undefined)[]> {
  const known = importedCache.get(file);
  if (known !== undefined) {
    return known;
  }
  const names = new Map<string, (string | undefined)[]>();
  const bind = (local: string, imported: string | undefined): void => {
    names.set(local, [...(names.get(local) ?? []), imported]);
  };
  for (const statement of file.statements) {
    if (isImportEqualsDeclaration(statement)) {
      bind(statement.name.text, undefined);
      continue;
    }
    const clause = isImportDeclaration(statement) ? statement.importClause : undefined;
    if (clause === undefined) {
      continue;
    }
    if (clause.name !== undefined) {
      bind(clause.name.text, "default");
    }
    const bindings = clause.namedBindings;
    if (bindings === undefined) {
      continue;
    }
    if (bindings.kind === SyntaxKind.NamespaceImport) {
      bind(bindings.name.text, undefined);
    } else {
      for (const element of bindings.elements) {
        bind(element.name.text, element.propertyName?.text ?? element.name.text);
      }
    }
  }
  importedCache.set(file, names);
  return names;
}

/**
 * The name node of every import binding one file's top level declares, and whether it
 * binds a whole module.
 */
function importBindings(file: SourceFile): readonly { node: Node; whole: boolean }[] {
  const found: { node: Node; whole: boolean }[] = [];
  for (const statement of file.statements) {
    if (isImportEqualsDeclaration(statement)) {
      found.push({ node: statement.name, whole: true });
      continue;
    }
    const clause = isImportDeclaration(statement) ? statement.importClause : undefined;
    if (clause === undefined) {
      continue;
    }
    if (clause.name !== undefined) {
      found.push({ node: clause.name, whole: false });
    }
    const bindings = clause.namedBindings;
    if (bindings === undefined) {
      continue;
    }
    if (bindings.kind === SyntaxKind.NamespaceImport) {
      found.push({ node: bindings.name, whole: true });
    } else {
      found.push(...bindings.elements.map((element) => ({ node: element.name, whole: false })));
    }
  }
  return found;
}

/** The value one assignment stores through the name it writes, where it is a plain assignment. */
function storedValue(name: Node): Node | undefined {
  let target: Node = name;
  if (isPropertyAccessExpression(name.parent) && name.parent.name === name) {
    target = name.parent;
  }
  while (isParenthesizedExpression(target.parent)) {
    target = target.parent;
  }
  const parent = target.parent;
  return isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    parent.left === target
    ? parent.right
    : undefined;
}

/**
 * The import bindings of one file that only the values written into one declaration
 * use, for each write into it. A binding is named by an identifier that spells its
 * local name and is not the member a property access names.
 */
function aloneIn(
  file: SourceFile,
  uses: readonly Site[],
  writes: readonly { index: number; value: Node }[],
  found: readonly Reference[],
): readonly { index: number; names: readonly string[] }[] {
  const bindings = new Set(importBindings(file).map((binding) => binding.node.getText()));
  if (bindings.size === 0) {
    return [];
  }
  const occurrences = new Map<string, Node[]>();
  for (const site of uses) {
    const text = site.node.getText();
    const parent = site.node.parent;
    if (!bindings.has(text) || (isPropertyAccessExpression(parent) && parent.name === site.node)) {
      continue;
    }
    if (!occurrences.get(text)?.includes(site.node)) {
      occurrences.set(text, [...(occurrences.get(text) ?? []), site.node]);
    }
  }
  const inside = (node: Node, value: Node): boolean =>
    node.pos >= value.pos && node.end <= value.end;
  const result: { index: number; names: readonly string[] }[] = [];
  for (const write of writes) {
    const to = found[write.index]?.to;
    const sameTarget = writes.filter((one) => found[one.index]?.to === to);
    const names = [...occurrences]
      .filter(
        ([, nodes]) =>
          nodes.some((node) => inside(node, write.value)) &&
          nodes.every((node) => sameTarget.some((one) => inside(node, one.value))),
      )
      .map(([name]) => name)
      .sort(compare);
    if (names.length > 0) {
      result.push({ index: write.index, names });
    }
  }
  return result;
}

/** Two strings ordered bytewise, which is the order every set of a run is read in. */
function compare(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Every reference one project's own files make to the project's own declarations, in
 * position order, and the files the test-file rules classified.
 *
 * `held` is the inventory of the same project, whose declaration map is what a resolved
 * symbol is looked up in; `targetRoot` is the absolute path every position is rendered
 * against, which is the root the inventory was read against. A pass over a consumer
 * walks the consumer's files instead and renders against its root, as
 * {@link ReferenceOptions.consumer} states.
 *
 * The order is by the referencing position, then by the declaration named, the
 * declaration referencing it and the use. That is a total order because one name
 * references one declaration once from one declaration, while a chain of aliases reaches
 * several declarations at one position and a bare star re-export's specifier both reads
 * and evaluates the module it names.
 */
export function references<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  targetRoot: string,
  options: ReferenceOptions,
): References {
  const cap = options.batchCap ?? DEFAULT_BATCH_CAP;
  const declarations = held.declarations;
  const patterns = options.testFiles.map(globExpression);
  const found: Reference[] = [];
  const tests: string[] = [];
  const chains = aliasChains(project, held);
  const tables = propertyTables(project.queries);
  const destructured = destructuring(project, cap, tables);
  let batched = 0;
  let fileBatches = 0;
  let residueFallbacks = 0;
  let shorthandLookups = 0;

  const consumer = options.consumer;
  const root = consumer?.root ?? targetRoot;
  const files =
    consumer === undefined
      ? project.ownSourceFiles()
      : project
          .ownSourceFiles()
          .filter(
            (file) =>
              relativePath(consumer.root, file.fileName) !== undefined &&
              relativePath(targetRoot, file.fileName) === undefined,
          );
  const ownPaths = project.ownPaths();
  const fileIds = new Set(
    held.symbols.filter((symbol) => symbol.kind === "file").map((symbol) => symbol.id),
  );
  let topLevel: ReadonlyMap<string, readonly InventorySymbol[]> | undefined;
  /** The declarations one file's top level holds. */
  const declaredIn = (fileId: string): readonly InventorySymbol[] => {
    if (topLevel === undefined) {
      const byParent = new Map<string, InventorySymbol[]>();
      for (const symbol of held.symbols) {
        if (fileIds.has(symbol.parent)) {
          byParent.set(symbol.parent, [...(byParent.get(symbol.parent) ?? []), symbol]);
        }
      }
      topLevel = byParent;
    }
    return topLevel.get(fileId) ?? [];
  };

  const exportsCache = new Map<number, readonly ChainTarget[]>();
  /**
   * Every declaration one module exports, each re-export walked along its chain. A module
   * the checker left unanswered may be any file, so it reads every file's exports.
   */
  const exportsRead = (module: Answer<TSSymbol>): readonly ChainTarget[] => {
    if (module === UNANSWERED) {
      return [...fileIds].flatMap((id) =>
        declaredIn(id)
          .filter((symbol) => symbol.exported)
          .map((symbol) => ({ id: symbol.id, stepped: false, guessed: true })),
      );
    }
    const known = exportsCache.get(module.id);
    if (known !== undefined) {
      return known;
    }
    const table = project.queries.exportsOfModule(module);
    const read =
      table === UNANSWERED
        ? chains.declarationsOf(module).flatMap((id) =>
            declaredIn(id)
              .filter((symbol) => symbol.exported)
              .map((symbol) => ({ id: symbol.id, stepped: false, guessed: true })),
          )
        : table.flatMap((exported) => chains.chainOf(exported));
    exportsCache.set(module.id, read);
    return read;
  };

  /** The identifier of the declaration one node of this program is, where it is one. */
  const declaredAt = (node: Node): string | undefined =>
    declarations.get(nodeKey(node.getSourceFile(), node));

  /**
   * The declarations one re-export carries forward: for an alias, the first link along
   * its chain that the inventory declares, stepping over the links it does not, such as
   * an import the re-export is written against; for a bare star, the module it names.
   * Each later link is a declaration of its own that references the next, so one link
   * per re-export is what lets a chain be followed one declaration at a time.
   */
  const carriedBy = (link: Link, symbol: TSSymbol): readonly ChainTarget[] =>
    link.alias
      ? chains.nextDeclared(symbol)
      : chains.declarationsOf(symbol).map((id) => ({ id, stepped: false, guessed: false }));

  /**
   * Every declaration bearing the name one node spells, or the name an import of its
   * file binds that name to, which is what a reference the checker could not resolve is
   * counted as: it may be a use of any of them, and a declaration it may use is kept
   * live. A name a namespace import binds may be a use of any file.
   */
  const named = (node: Node): readonly string[] => {
    const byName = declarationsByName(held);
    const text = node.getText();
    const imported = importedNames(node.getSourceFile()).get(text) ?? [];
    return [
      ...new Set([
        ...(byName.get(text) ?? []),
        ...imported.flatMap((name) =>
          name === undefined ? [...fileIds] : (byName.get(name) ?? []),
        ),
      ]),
    ];
  };

  // A type-query alias's own type names its export without using it; a use of the
  // global is the use, so it names every link of the export's chain as well.
  const aliases = project.ownSourceFiles().flatMap(typeQueryAliases);
  const unread = new Set(aliases.map((alias) => alias.type));
  const aliased = new Map<string, readonly ChainTarget[]>();
  if (aliases.length > 0) {
    const exported = project.symbolsAt(aliases.map((alias) => project.handle(alias.exported)));
    aliases.forEach((alias, index) => {
      const id = declaredAt(alias.declaration);
      const symbol = exported[index];
      if (id === undefined || symbol === undefined) {
        return;
      }
      aliased.set(
        id,
        symbol === UNANSWERED
          ? (declarationsByName(held).get(alias.name) ?? []).map((one) => ({
              id: one,
              stepped: true,
              guessed: true,
            }))
          : chains.chainOf(symbol).map((target) => ({ ...target, stepped: true })),
      );
    });
  }
  /** One use's targets, then every link an alias global among them stands for, each once. */
  const throughAliases = (targets: readonly ChainTarget[]): readonly ChainTarget[] => {
    if (aliased.size === 0) {
      return targets;
    }
    const all = [...targets];
    const seen = new Set(targets.map((target) => target.id));
    for (const target of targets) {
      for (const forwarded of aliased.get(target.id) ?? []) {
        if (!seen.has(forwarded.id)) {
          seen.add(forwarded.id);
          all.push(forwarded);
        }
      }
    }
    return all;
  };

  /** The symbol one site resolves to, asking only the accessor the site's form names. */
  const symbolFor = (
    site: Site,
    answered: ReadonlyMap<Node, Answer<TSSymbol>>,
  ): Answer<TSSymbol | undefined> => {
    if (site.shorthand !== undefined) {
      shorthandLookups += 1;
      return project.shorthandValueAt(project.handle(site.shorthand));
    }
    const batched = answered.get(site.node);
    if (batched === UNANSWERED || typeof batched === "object") {
      return batched;
    }
    residueFallbacks += 1;
    return project.resolvedSymbolAt(project.handle(site.node));
  };

  const walked = files.map((file) => {
    const fileId = declaredAt(file) ?? "";
    return { file, fileId, ...sitesOf(file, declarations, fileId, unread) };
  });
  const fileIdByName = new Map<string, string>(
    walked.filter((one) => fileIds.has(one.fileId)).map((one) => [one.file.fileName, one.fileId]),
  );
  const contextual = contextualUses(
    project,
    held,
    chains,
    walked.flatMap((one) => one.literals),
    walked.flatMap((one) => one.flows),
    cap,
    tables,
  );
  const writtenBy = new Map<string, readonly string[]>();
  for (const write of contextual.writes) {
    const property = write.at.parent;
    writtenBy.set(nodeKey(property.getSourceFile(), property), write.ids);
  }
  const forwardedCache = new Map<number, readonly ChainTarget[]>();
  /**
   * The members a literal property one symbol declares writes: a use of the property
   * reaches them, because the literal's type carries the data the member describes.
   */
  const forwarded = (symbol: TSSymbol): readonly ChainTarget[] => {
    const known = forwardedCache.get(symbol.id);
    if (known !== undefined) {
      return known;
    }
    const found: ChainTarget[] = [];
    if (writtenBy.size > 0) {
      for (const handle of symbol.declarations) {
        if (!LITERAL_PROPERTY_KINDS.has(handle.kind) || !ownPaths.has(handle.path)) {
          continue;
        }
        const node = project.declarationAt(handle)?.node;
        const ids =
          node === undefined ? undefined : writtenBy.get(nodeKey(node.getSourceFile(), node));
        for (const id of ids ?? []) {
          if (!found.some((target) => target.id === id)) {
            found.push({ id, stepped: true, guessed: false });
          }
        }
      }
    }
    forwardedCache.set(symbol.id, found);
    return found;
  };
  /** One resolved symbol's declarations along its chain, and the members its literal properties write. */
  const targetsOf = (symbol: TSSymbol): readonly ChainTarget[] => {
    const through = forwarded(symbol);
    return through.length === 0 ? chains.chainOf(symbol) : [...chains.chainOf(symbol), ...through];
  };
  const testFile = new Map<SourceFile, boolean>();
  for (const { file } of walked) {
    const path = renderPosition(file, root, 0).path;
    const test = patterns.some((pattern) => pattern.test(path));
    testFile.set(file, test);
    if (test) {
      tests.push(path);
    }
  }
  /** Each write reference's index in `found`, by its file, with the value it stores. */
  const valued = new Map<SourceFile, { index: number; value: Node }[]>();
  const holdsValue = (file: SourceFile, value: Node | undefined): void => {
    if (value !== undefined) {
      valued.set(file, [...(valued.get(file) ?? []), { index: found.length - 1, value }]);
    }
  };
  for (const [use, sites] of [
    ["write", contextual.writes],
    ["read", contextual.reads],
  ] as const) {
    for (const site of sites) {
      const file = site.at.getSourceFile();
      const position = renderPosition(file, root, site.at.getStart());
      for (const id of site.ids) {
        found.push({
          from: site.from,
          to: id,
          position,
          use,
          resolution: "contextual",
          test: testFile.get(file) === true,
        });
        if (use === "write") {
          holdsValue(file, site.at.parent);
        }
      }
    }
  }

  for (const { file, fileId, uses, reads, links, evaluations, wholes, urls, decorated } of walked) {
    const test = testFile.get(file) === true;
    // A component file's markup may use any binding its blocks declare at the top level.
    const markup = isComponentFile(file);
    const bindings = markup ? importBindings(file) : [];

    // A decorator is written inside the declaration it is attached to and receives it,
    // so the declaration is used where the decorator is written, whatever the
    // decorator does with it.
    for (const { decorator, declaration } of decorated) {
      found.push({
        from: declaration,
        to: declaration,
        position: renderPosition(file, root, decorator.getStart()),
        use: "decorator",
        resolution: "syntax",
        test,
      });
    }

    // One batch per capped run of the file's name nodes, the re-exports' nodes after
    // the uses and the evaluated modules' specifiers last, each node once: a bare star
    // re-export's specifier is a link and an evaluation both. A shorthand is left out
    // of the batch: its name resolves to the property the literal declares, so the
    // batch's answer for it would name something this project's inventory never holds.
    const batching = [
      ...new Set([
        ...uses.filter((site) => site.shorthand === undefined).map((site) => site.node),
        ...links.map((link) => link.node),
        ...evaluations.map((evaluation) => evaluation.node),
        ...wholes.map((whole) => whole.specifier),
        ...urls.flatMap((url) => url.constructor ?? []),
        ...bindings.map((binding) => binding.node),
      ]),
    ];
    const answered = new Map<Node, Answer<TSSymbol>>();
    batched += batching.length;
    for (let from = 0; from < batching.length; from += cap) {
      const run = batching.slice(from, from + cap);
      const answers = project.symbolsAt(
        run.map((node) => project.handle(node)),
        cap,
      );
      fileBatches += 1;
      run.forEach((node, index) => {
        const symbol = answers[index];
        if (symbol !== undefined) {
          answered.set(node, symbol);
        }
      });
    }

    for (const link of links) {
      const symbol = answered.get(link.node);
      if (symbol === undefined) {
        continue;
      }
      const position = renderPosition(file, root, link.at.getStart());
      const carried =
        symbol === UNANSWERED
          ? named(link.at).map((id) => ({ id, stepped: false, guessed: true }))
          : carriedBy(link, symbol);
      for (const target of carried) {
        found.push({
          from: link.from,
          to: target.id,
          position,
          use: "read",
          resolution: target.guessed ? "by-name" : link.alias ? "alias" : "batch",
          test,
        });
      }
    }

    for (const evaluation of evaluations) {
      const queried = queriedFile(file, evaluation.node, fileIdByName);
      if (queried !== undefined) {
        found.push({
          from: evaluation.from,
          to: queried,
          position: renderPosition(file, root, evaluation.node.getStart()),
          use: "evaluation",
          resolution: "syntax",
          test,
        });
      }
      const module = answered.get(evaluation.node);
      if (module === undefined) {
        continue;
      }
      const position = renderPosition(file, root, evaluation.node.getStart());
      // A module the checker could not resolve may be any file of the target.
      const evaluated = module === UNANSWERED ? [...fileIds] : chains.declarationsOf(module);
      for (const id of evaluated) {
        if (fileIds.has(id)) {
          found.push({
            from: evaluation.from,
            to: id,
            position,
            use: "evaluation",
            resolution: module === UNANSWERED ? "by-name" : "batch",
            test,
          });
        }
      }
    }

    for (const url of urls) {
      const constructor = url.constructor === undefined ? undefined : answered.get(url.constructor);
      if (
        typeof constructor === "object" &&
        constructor.declarations.some((handle) => ownPaths.has(handle.path))
      ) {
        continue;
      }
      const loaded = specifierCandidates(dirnamePath(file.fileName), url.specifier)
        .map((path) => fileIdByName.get(path))
        .find((id) => id !== undefined);
      if (loaded !== undefined) {
        found.push({
          from: fileId,
          to: loaded,
          position: renderPosition(file, root, url.at.getStart()),
          use: "evaluation",
          resolution: "syntax",
          test,
        });
      }
    }

    for (const whole of wholes) {
      const module = answered.get(whole.specifier);
      if (module === undefined) {
        continue;
      }
      const position = renderPosition(file, root, whole.at.getStart());
      for (const target of exportsRead(module)) {
        found.push({
          from: whole.from,
          to: target.id,
          position,
          use: "read",
          resolution: target.guessed ? "by-name" : "batch",
          test,
        });
      }
    }

    if (markup) {
      for (const symbol of declaredIn(fileId)) {
        found.push({
          from: fileId,
          to: symbol.id,
          position: symbol.position,
          use: "read",
          resolution: "syntax",
          test,
        });
      }
      for (const binding of bindings) {
        const symbol = answered.get(binding.node);
        if (symbol === undefined) {
          continue;
        }
        const position = renderPosition(file, root, binding.node.getStart());
        const chained =
          symbol === UNANSWERED
            ? named(binding.node).map((id) => ({ id, stepped: false, guessed: true }))
            : chains.chainOf(symbol);
        // The markup may name any export of a module a binding holds whole.
        const targets = binding.whole
          ? chained.flatMap((target) => [
              target,
              ...declaredIn(target.id)
                .filter((one) => one.exported)
                .map((one) => ({ ...target, id: one.id })),
            ])
          : chained;
        for (const target of targets) {
          found.push({
            from: fileId,
            to: target.id,
            position,
            use: "read",
            resolution: target.guessed ? "by-name" : target.stepped ? "alias" : "batch",
            test,
          });
        }
      }
    }

    // A pattern names a property of the value it destructures, which no name node of
    // the pattern resolves to: a shorthand's name is the local it binds.
    destructured.resolve(reads).forEach((symbol, index) => {
      const read = reads[index];
      if (symbol === undefined || read === undefined) {
        return;
      }
      const position = renderPosition(file, root, read.key.getStart());
      const targets =
        symbol === UNANSWERED
          ? (declarationsByName(held).get(read.name) ?? []).map((id) => ({
              id,
              stepped: false,
              guessed: true,
            }))
          : targetsOf(symbol);
      for (const target of targets) {
        found.push({
          from: read.from,
          to: target.id,
          position,
          use: "read",
          resolution: target.guessed ? "by-name" : "destructured",
          test,
        });
      }
    });

    for (const site of uses) {
      const direct: Resolution =
        site.shorthand !== undefined
          ? "shorthand"
          : typeof answered.get(site.node) === "object"
            ? "batch"
            : "resolved-symbol";
      const symbol = symbolFor(site, answered);
      if (symbol === undefined) {
        continue;
      }
      const position = renderPosition(file, root, site.node.getStart());
      // A re-export something imports is used and so is the declaration behind it, so
      // the use names every link of the chain its name stands at the head of.
      const targets = throughAliases(
        symbol === UNANSWERED
          ? named(site.node).map((id) => ({ id, stepped: false, guessed: true }))
          : targetsOf(symbol),
      );
      for (const target of targets) {
        found.push({
          from: site.from,
          to: target.id,
          position,
          use: site.use,
          resolution: target.guessed ? "by-name" : target.stepped ? "alias" : direct,
          test,
        });
        if (site.use === "write") {
          holdsValue(file, storedValue(site.node));
        }
      }
    }
  }

  const usesOf = new Map(walked.map((one) => [one.file, one.uses]));
  for (const [file, writes] of valued) {
    const uses = usesOf.get(file) ?? [];
    for (const { index, names } of aloneIn(file, uses, writes, found)) {
      const reference = found[index];
      if (reference !== undefined) {
        found[index] = { ...reference, alone: names };
      }
    }
  }

  if (consumer === undefined) {
    found.push(...overrideReferences(project, held, chains, new Set(tests)));
    found.push(...indexedAccessReferences(project, held, chains, root, new Set(tests)));
    found.push(...moduleDeclarationReferences(project, held, root, new Set(tests)));
  }
  found.push(...augmentationReferences(held, found));
  found.sort(
    (a, b) =>
      byPosition(a.position, b.position) ||
      compare(a.to, b.to) ||
      compare(a.from, b.from) ||
      compare(a.use, b.use),
  );

  return {
    configFile: project.configFile,
    references:
      consumer === undefined
        ? found
        : found.map((reference) => ({ ...reference, consumer: consumer.id })),
    testFilePaths: tests.sort(compare),
    cost: {
      batched,
      fileBatches,
      residueFallbacks,
      shorthandLookups,
      aliasSteps: chains.steps,
      patternBatches: destructured.cost.patternBatches,
      patternLookups: destructured.cost.patternLookups,
      contextualBatches: contextual.batches,
      contextualLookups: contextual.lookups,
    },
  };
}
