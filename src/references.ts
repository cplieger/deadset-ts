import {
  isArrayLiteralExpression,
  isBinaryExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  SyntaxKind,
  type Node,
  type SourceFile,
} from "@typescript/native/unstable/ast";
import { SymbolFlags, type Symbol as TSSymbol } from "@typescript/native/unstable/sync";
import { nodeKey, type Inventory } from "./inventory.ts";
import { byPosition, renderPosition, type Position } from "./position.ts";
import type { ProjectView } from "./session.ts";

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
 * made it. It carries no mode. Which of the references a run counts is the reading the
 * sweep makes of this set, so the mode is one value the run decides once and this pass
 * never sees it.
 */

/** How one reference uses the declaration it names. */
export type Use = "read" | "write";

/**
 * Which accessor answered for one reference, so that the cost of a run is attributable
 * and a table of references shows the path each row took.
 *
 * - `batch` is the batched lookup over a file's name nodes, which answers for almost
 *   every one of them.
 * - `resolved-symbol` is the per-node lookup for the residue a batch left.
 * - `shorthand` is the per-node lookup for `{ a }`, whose name resolves to the property
 *   the literal declares rather than to the declaration that name reads.
 * - `alias` is a step along an import or export chain, from one link to what it names.
 */
export type Resolution = "batch" | "resolved-symbol" | "shorthand" | "alias";

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
}

/** One project's references, in position order, and what reading them cost. */
export interface References {
  /** The compiler configuration the project was opened from. */
  readonly configFile: string;
  readonly references: readonly Reference[];
  /** The rules that classified files as test files, ordered by rule. */
  readonly testFileRules: readonly TestFileRule[];
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
   * Each pattern is a rule of its own and reports the files it matched.
   */
  readonly testFiles: readonly string[];
}

/**
 * The batch cap a run takes when the configuration names none. It bounds the size of
 * one answer rather than the work: the median file is one batch at this cap and the
 * largest production file a handful.
 */
export const DEFAULT_BATCH_CAP = 4096;

/**
 * The operators whose left side one assignment stores into. A compound assignment is
 * among them: it reads its target only to write the result back, so nothing else
 * receives what it read, and a declaration whose every other reference is one of these
 * carries no information out of itself.
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
    markWrite(held.expression, writes);
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
 * holds.
 */
function markStores(node: Node, writes: Set<number>): void {
  if (isBinaryExpression(node)) {
    if (ASSIGNMENTS.has(node.operatorToken.kind)) {
      markWrite(node.left, writes);
    }
    return;
  }
  if (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) {
    if (
      node.operator === SyntaxKind.PlusPlusToken ||
      node.operator === SyntaxKind.MinusMinusToken
    ) {
      markWrite(node.operand, writes);
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
 * Every name node one file holds that is a use rather than a declaration, in source
 * order, each with the declaration that encloses it and the use it makes.
 *
 * One walk answers all three, because the three facts are positional and a second walk
 * would have to agree with this one about which nodes are names. A name that is the
 * declared name of the declaration it belongs to is left out: it is where that
 * declaration is written rather than a use of it, which is what makes a declaration
 * referenced only from its own site an unreferenced declaration.
 */
function sitesOf(
  file: SourceFile,
  declarations: ReadonlyMap<string, string>,
  fileId: string,
): Site[] {
  const found: Site[] = [];
  const writes = new Set<number>();
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
    if (isName(node)) {
      if (!declared.has(node.pos)) {
        found.push({
          node,
          shorthand: shorthands.get(node.pos),
          from: enclosing,
          use: writes.has(node.pos) ? "write" : "read",
        });
      }
      return;
    }
    markNames(node);
    markStores(node, writes);
    const held = declarations.get(nodeKey(file, node));
    const outer = enclosing;
    if (held !== undefined) {
      enclosing = held;
    }
    node.forEachChild(visit);
    enclosing = outer;
  };

  file.forEachChild(visit);
  return found;
}

/**
 * One literal run of a pattern, with every character the expression syntax claims
 * escaped.
 *
 * The set is the syntax characters and the solidus, and it is closed: an escape of any
 * other character is refused outright by the expression syntax under the unicode flag,
 * so escaping a hyphen, which needs none outside a character class, would refuse every
 * pattern that names a hyphenated path.
 */
function quoted(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\/]/gu, (character) => `\\${character}`);
}

/**
 * The expression one glob pattern denotes. `**` spans path separators while `*` and `?`
 * do not, a brace list is an alternation of its members, and every other character
 * stands for itself.
 */
function expressionOf(pattern: string): RegExp {
  let source = "^";
  let at = 0;
  while (at < pattern.length) {
    const rest = pattern.slice(at);
    if (rest.startsWith("**/")) {
      source += "(?:[^/]*/)*";
      at += 3;
      continue;
    }
    if (rest.startsWith("**")) {
      source += ".*";
      at += 2;
      continue;
    }
    const character = pattern[at] ?? "";
    at += 1;
    if (character === "*") {
      source += "[^/]*";
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    if (character === "{") {
      const close = pattern.indexOf("}", at);
      if (close < 0) {
        source += "\\{";
        continue;
      }
      source += `(?:${pattern.slice(at, close).split(",").map(quoted).join("|")})`;
      at = close + 1;
      continue;
    }
    source += quoted(character);
  }
  return new RegExp(`${source}$`, "u");
}

/**
 * The name one test-file rule takes. A rule's name is a word list the report's own
 * vocabulary spells, which cannot carry a pattern, so a rule is named by the place of
 * its pattern in the configured list.
 */
function patternRule(index: number): string {
  return `test-file-pattern-${String(index + 1)}`;
}

/** Two strings ordered bytewise, which is the order every set of a run is read in. */
function compare(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** One declaration one symbol reaches, and whether a step along an alias reached it. */
interface Target {
  readonly id: string;
  readonly stepped: boolean;
}

/**
 * Every reference one project's own files make to the project's own declarations, in
 * position order, and the test-file rules that classified those files.
 *
 * `held` is the inventory of the same project, whose declaration map is what a resolved
 * symbol is looked up in; `targetRoot` is the absolute path every position is rendered
 * against, which is the root the inventory was read against.
 *
 * The order is by the referencing position, then by the declaration named, the
 * declaration referencing it and the use. That is a total order because one name
 * references one declaration once from one declaration, while a chain of aliases reaches
 * several declarations at one position.
 */
export function references<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  targetRoot: string,
  options: ReferenceOptions,
): References {
  const cap = options.batchCap ?? DEFAULT_BATCH_CAP;
  const declarations = held.declarations;
  const patterns = options.testFiles.map(expressionOf);
  const matched = options.testFiles.map(() => 0);
  const found: Reference[] = [];
  const reached = new Map<number, readonly Target[]>();
  let batched = 0;
  let fileBatches = 0;
  let residueFallbacks = 0;
  let shorthandLookups = 0;
  let aliasSteps = 0;

  const files = project.ownSourceFiles();
  const ownFiles = new Set(files.map((file) => file.fileName));

  /** The identifier of the declaration one node of this program is, where it is one. */
  const declaredAt = (node: Node): string | undefined =>
    declarations.get(nodeKey(node.getSourceFile(), node));

  /**
   * The declarations one symbol names: the declaration it is, and every link of the
   * alias chain it stands at the head of. A re-export something imports is used and so
   * is the declaration behind it, so both are named; a link this project does not
   * declare is stepped over rather than recorded.
   *
   * A symbol is asked to step only where the binder flagged it an alias, which is the
   * same condition the step itself asserts on. The declaration's syntax is not that
   * condition and does not stand in for it: a default export of an expression is
   * written as one of the alias forms and names nothing declared elsewhere, so it is
   * recorded as the declaration it is and the chain ends there.
   *
   * A declaration handle carries the file it is in, so the question the walk asks of a
   * declaration is answered before it is resolved: a declaration outside the project's
   * own files belongs to another program and is never read, which is what keeps the
   * pass from fetching a library file to discover that the inventory does not hold what
   * is in it.
   */
  const targetsOf = (symbol: TSSymbol): readonly Target[] => {
    const cached = reached.get(symbol.id);
    if (cached !== undefined) {
      return cached;
    }
    const targets: Target[] = [];
    const walked = new Set<number>();
    let at: TSSymbol | undefined = symbol;
    let stepped = false;
    while (at !== undefined && !walked.has(at.id)) {
      walked.add(at.id);
      const alias = (at.flags & SymbolFlags.Alias) !== 0;
      for (const handle of at.declarations) {
        if (!ownFiles.has(handle.path)) {
          continue;
        }
        const node = project.declarationAt(handle)?.node;
        const id = node === undefined ? undefined : declaredAt(node);
        if (id !== undefined && !targets.some((target) => target.id === id)) {
          targets.push({ id, stepped });
        }
      }
      if (!alias) {
        break;
      }
      at = project.aliasStepOf(at);
      aliasSteps += 1;
      stepped = true;
    }
    reached.set(symbol.id, targets);
    return targets;
  };

  /** The symbol one site resolves to, asking only the accessor the site's form names. */
  const symbolFor = (site: Site, answered: ReadonlyMap<number, TSSymbol>): TSSymbol | undefined => {
    if (site.shorthand !== undefined) {
      shorthandLookups += 1;
      return project.shorthandValueAt(project.handle(site.shorthand));
    }
    const batched = answered.get(site.node.pos);
    if (batched !== undefined) {
      return batched;
    }
    residueFallbacks += 1;
    return project.resolvedSymbolAt(project.handle(site.node));
  };

  for (const file of files) {
    const path = renderPosition(file, targetRoot, 0).path;
    let test = false;
    patterns.forEach((pattern, index) => {
      if (pattern.test(path)) {
        matched[index] = (matched[index] ?? 0) + 1;
        test = true;
      }
    });
    const sites = sitesOf(file, declarations, declaredAt(file) ?? "");

    // One batch per capped run of the file's name nodes. A shorthand is left out of
    // the batch: its name resolves to the property the literal declares, so the batch's
    // answer for it would name something this project's inventory never holds.
    const batching = sites.filter((site) => site.shorthand === undefined);
    const answered = new Map<number, TSSymbol>();
    batched += batching.length;
    for (let from = 0; from < batching.length; from += cap) {
      const run = batching.slice(from, from + cap);
      const answers = project.symbolsAt(run.map((site) => project.handle(site.node)));
      fileBatches += 1;
      run.forEach((site, index) => {
        const symbol = answers[index];
        if (symbol !== undefined) {
          answered.set(site.node.pos, symbol);
        }
      });
    }

    for (const site of sites) {
      const direct: Resolution =
        site.shorthand !== undefined
          ? "shorthand"
          : answered.has(site.node.pos)
            ? "batch"
            : "resolved-symbol";
      const symbol = symbolFor(site, answered);
      if (symbol === undefined) {
        continue;
      }
      const position = renderPosition(file, targetRoot, site.node.getStart());
      for (const target of targetsOf(symbol)) {
        found.push({
          from: site.from,
          to: target.id,
          position,
          use: site.use,
          resolution: target.stepped ? "alias" : direct,
          test,
        });
      }
    }
  }

  found.sort(
    (a, b) =>
      byPosition(a.position, b.position) ||
      compare(a.to, b.to) ||
      compare(a.from, b.from) ||
      compare(a.use, b.use),
  );

  return {
    configFile: project.configFile,
    references: found,
    testFileRules: options.testFiles
      .map((_pattern, index) => ({ rule: patternRule(index), matched: matched[index] ?? 0 }))
      .sort((a, b) => compare(a.rule, b.rule)),
    cost: { batched, fileBatches, residueFallbacks, shorthandLookups, aliasSteps },
  };
}
