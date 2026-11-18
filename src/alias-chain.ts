/**
 * Where an import or export chain leads in one project: from one symbol to each
 * declaration of the target it is, and along the chain of aliases it heads to each
 * declaration every link of that chain is, and what a name resolves to through them.
 */

import {
  isExportAssignment,
  isExportSpecifier,
  isIdentifier,
  isImportClause,
  isImportSpecifier,
  isModuleBlock,
  isModuleDeclaration,
  isNamespaceExport,
  isNamespaceImport,
  isSourceFile,
  SyntaxKind,
  type Node,
} from "@typescript/native/ast";
import { SymbolFlags, type Symbol as TSSymbol } from "@typescript/native/sync";
import { isParameterProperty, nodeKey, type Inventory } from "./inventory.ts";
import { boundValue, declaredTypeOnly } from "./namespace-objects.ts";
import { must, UNANSWERED, type Answer } from "./query.ts";
import type { ProjectView } from "./session.ts";
import { canonicalDeclarations } from "./canonical-order.ts";

/** One declaration a chain reaches, and whether a step along an alias reached it. */
export interface ChainTarget {
  readonly id: string;
  /** False for a declaration the head symbol itself is, true for one a link stands for. */
  readonly stepped: boolean;
  /**
   * True where the compiler did not answer a step and the declaration is one the link
   * may stand for by the name it carries.
   */
  readonly guessed: boolean;
}

/** The chain walks over one project's aliases, each step asked of the compiler once. */
export interface AliasChains {
  /**
   * The declarations of the inventory one symbol is, each once. A declaration outside
   * the project's own files belongs to another program and is not one of them.
   */
  declarationsOf(symbol: TSSymbol): readonly string[];
  /**
   * The declarations one symbol is, and those of every link of the alias chain it
   * stands at the head of, each once and in chain order. A link the inventory does
   * not declare is stepped over rather than named.
   */
  chainOf(symbol: TSSymbol): readonly ChainTarget[];
  /**
   * The declarations of the first link after `symbol` along its chain that the
   * inventory declares, stepping over the links it does not, or none where no later
   * link is declared.
   */
  nextDeclared(symbol: TSSymbol): readonly ChainTarget[];
  /**
   * The namespace one symbol stands for as a value: a module, whose namespace object it binds
   * (references-ts.3), or a `namespace` declaration. It is the symbol the alias chain ends at,
   * every step answered and no link declared type-only, where that is either; `UNANSWERED` where
   * a step is, and undefined where the chain ends elsewhere or a link is type-only, which binds
   * no value. A variable or parameter that binds a namespace value (`boundValue`) stands for it
   * where nothing exports the binding.
   */
  namespaceOf(symbol: TSSymbol): Answer<TSSymbol | undefined>;
  /**
   * Whether an answer resolves to no declaration of the program, so an `eval` callee is the global
   * one: an unanswered or empty answer, an alias, a symbol with no declaration, or one declared
   * outside the project's own non-declaration files. A symbol that is not an alias, and whose
   * declarations are all in the project's own non-declaration files, does not.
   */
  undeclared(answer: Answer<TSSymbol | undefined>): boolean;
}

/**
 * The chain walks over one project, against the declarations of `held`, the same
 * project's inventory.
 *
 * A declaration handle carries the file it is in, so whether it is one of the
 * project's own files is answered before the handle is resolved: a declaration of a
 * library file is never fetched to find out that the inventory does not hold it.
 */
export function aliasChains<Brand>(project: ProjectView<Brand>, held: Inventory): AliasChains {
  const ownFiles = project.ownPaths();
  const steps = new Map<number, Answer<TSSymbol | undefined>>();
  const chains = new Map<number, readonly ChainTarget[]>();

  const declarationsOf = (symbol: TSSymbol): string[] => {
    const ids: string[] = [];
    for (const handle of canonicalDeclarations(symbol)) {
      if (!ownFiles.has(handle.path)) {
        continue;
      }
      const node = project.declarationAt(handle)?.node;
      const id =
        node === undefined ? undefined : held.declarations.get(nodeKey(node.getSourceFile(), node));
      // A parameter property's node declares the parameter too, whose reads are no member's.
      const parameter =
        node !== undefined &&
        isParameterProperty(node) &&
        (symbol.flags & SymbolFlags.Property) === 0;
      if (id !== undefined && !parameter && !ids.includes(id)) {
        ids.push(id);
      }
    }
    return ids;
  };

  /**
   * What one alias names, one link along. Only a symbol the binder flagged an alias is
   * asked, which is the condition the step asserts on: a default export of an
   * expression is written in an alias form and names nothing declared elsewhere, so its
   * chain ends at itself.
   */
  const stepOf = (symbol: TSSymbol): Answer<TSSymbol | undefined> => {
    if ((symbol.flags & SymbolFlags.Alias) === 0) {
      return undefined;
    }
    if (steps.has(symbol.id)) {
      return steps.get(symbol.id);
    }
    const next = project.aliasStepOf(symbol);
    steps.set(symbol.id, next);
    return next;
  };

  const files = held.symbols.filter((one) => one.kind === "file").map((one) => one.id);

  const endOf = (symbol: TSSymbol): Answer<TSSymbol | undefined> => {
    const walked = new Set<number>();
    let at = symbol;
    while ((at.flags & SymbolFlags.Alias) !== 0) {
      if (walked.has(at.id)) {
        return undefined;
      }
      walked.add(at.id);
      const next = stepOf(at);
      if (next === UNANSWERED || next === undefined) {
        return next;
      }
      at = next;
    }
    return at;
  };

  /** Whether a link of one symbol's alias chain is declared type-only, which binds no value. */
  const typeOnly = (symbol: TSSymbol): boolean => {
    const walked = new Set<number>();
    for (
      let at: Answer<TSSymbol | undefined> = symbol;
      typeof at === "object" && (at.flags & SymbolFlags.Alias) !== 0 && !walked.has(at.id);
      at = stepOf(at)
    ) {
      walked.add(at.id);
      const declared = at.declarations.some((handle) => {
        const node = ownFiles.has(handle.path) ? project.declarationAt(handle)?.node : undefined;
        return node !== undefined && declaredTypeOnly(node);
      });
      if (declared) {
        return true;
      }
    }
    return false;
  };

  const undeclared = (answer: Answer<TSSymbol | undefined>): boolean =>
    typeof answer !== "object" ||
    // An imported `eval` may be the global one.
    (answer.flags & SymbolFlags.Alias) !== 0 ||
    answer.declarations.length === 0 ||
    answer.declarations.some(
      (handle) => !ownFiles.has(handle.path) || /\.d\.[^/]*ts$/.test(handle.path),
    );

  /** The symbols the entries of one export table end at, `UNANSWERED` where any entry's end is. */
  const endsOf = (table: readonly TSSymbol[]): Answer<ReadonlySet<number>> => {
    const ids = new Set<number>();
    for (const entry of table) {
      const end = endOf(entry);
      if (end === UNANSWERED) {
        return UNANSWERED;
      }
      if (end !== undefined) {
        ids.add(end.id);
      }
    }
    return ids;
  };

  const tables = new Map<number, Answer<ReadonlySet<number>>>();
  /** The symbols one container's export table ends at, its table read once; `UNANSWERED` where any step is. */
  const exportedBy = (container: TSSymbol): Answer<ReadonlySet<number>> => {
    const known = tables.get(container.id);
    if (known !== undefined) {
      return known;
    }
    const table = project.queries.exportsOfModule(container);
    const ends = table === UNANSWERED ? UNANSWERED : endsOf(table);
    tables.set(container.id, ends);
    return ends;
  };

  /**
   * Whether a binding a module's or a namespace's top level holds is exported, by its modifier or
   * by an entry of its container's export table that ends at it; an unanswered table may export it.
   */
  const exportedBinding = (symbol: TSSymbol, declaration: Node): boolean => {
    const statement = declaration.parent.parent;
    const modifiers = (statement as { readonly modifiers?: readonly Node[] }).modifiers ?? [];
    if (modifiers.some((one) => one.kind === SyntaxKind.ExportKeyword)) {
      return true;
    }
    const top = statement.parent;
    const holder = isSourceFile(top)
      ? top
      : isModuleBlock(top) && isModuleDeclaration(top.parent)
        ? top.parent.name
        : undefined;
    const container =
      holder === undefined ? undefined : project.symbolsAt([project.handle(holder)])[0];
    const ends = typeof container === "object" ? exportedBy(container) : UNANSWERED;
    return ends === UNANSWERED || ends.has(symbol.id);
  };

  /**
   * The namespace a variable or parameter binds (`boundValue`): the namespace its value names, an
   * import's the module its specifier names, where no export carries the binding on, which leaves
   * it a holder. The binding has no type of its own, so the checker types it as the value, and a
   * member read through it resolves to the namespace's member, through a CommonJS module's interop
   * object too; the type does not decide whether the binding exists.
   */
  const boundNamespace = (symbol: TSSymbol): TSSymbol | undefined => {
    const [handle, ...others] = canonicalDeclarations(symbol);
    const node =
      handle !== undefined && others.length === 0 && ownFiles.has(handle.path)
        ? project.declarationAt(handle)?.node
        : undefined;
    const bound = node === undefined ? undefined : boundValue(node);
    if (node === undefined || bound === undefined) {
      return undefined;
    }
    // A question about the binding left unanswered leaves it a holder, read whole where given.
    const value = project.symbolsAt([project.handle(bound.node)])[0];
    const namespace = typeof value === "object" ? namespaceOf(value) : undefined;
    if (typeof namespace !== "object") {
      return undefined;
    }
    return bound.held && exportedBinding(symbol, node) ? undefined : namespace;
  };

  const namespaces = new Map<number, Answer<TSSymbol | undefined>>();
  const namespaceOf = (symbol: TSSymbol): Answer<TSSymbol | undefined> => {
    if (namespaces.has(symbol.id)) {
      return namespaces.get(symbol.id);
    }
    // A binding bound to itself through others binds nothing.
    namespaces.set(symbol.id, undefined);
    const end = typeOnly(symbol) ? undefined : endOf(symbol);
    // A module and a `namespace` are both value modules.
    const namespace =
      end === UNANSWERED || (typeof end === "object" && (end.flags & SymbolFlags.ValueModule) !== 0)
        ? end
        : typeof end === "object" && (end.flags & SymbolFlags.Variable) !== 0
          ? boundNamespace(end)
          : undefined;
    namespaces.set(symbol.id, namespace);
    return namespace;
  };

  /**
   * The declarations an alias whose step went unanswered may stand for: every one the
   * inventory holds under its own name or the name it carries forward, and every file
   * where it carries a module, so a use through it still counts for what it reaches.
   */
  const sameNamed = (alias: TSSymbol): readonly ChainTarget[] => {
    const names = new Set([alias.name]);
    let module = false;
    for (const handle of canonicalDeclarations(alias)) {
      const node = ownFiles.has(handle.path) ? project.declarationAt(handle)?.node : undefined;
      if (node === undefined) {
        continue;
      }
      if ((isImportSpecifier(node) || isExportSpecifier(node)) && node.propertyName !== undefined) {
        names.add(node.propertyName.text);
      } else if (isImportClause(node)) {
        names.add("default");
      } else if (isNamespaceImport(node) || isNamespaceExport(node)) {
        module = true;
      } else if (isExportAssignment(node) && isIdentifier(node.expression)) {
        names.add(node.expression.text);
      }
    }
    const byName = held.byName;
    const ids = [...names].flatMap((name) => byName.get(name) ?? []);
    return [...new Set([...ids, ...(module ? files : [])])].map((id) => ({
      id,
      stepped: true,
      guessed: true,
    }));
  };

  const chainOf = (symbol: TSSymbol): readonly ChainTarget[] => {
    const cached = chains.get(symbol.id);
    if (cached !== undefined) {
      return cached;
    }
    const targets: ChainTarget[] = [];
    const add = (id: string, stepped: boolean, guessed = false): void => {
      if (!targets.some((target) => target.id === id)) {
        targets.push({ id, stepped, guessed });
      }
    };
    const walked = new Set<number>();
    let at: TSSymbol | undefined = symbol;
    let stepped = false;
    while (at !== undefined && !walked.has(at.id)) {
      walked.add(at.id);
      for (const id of declarationsOf(at)) {
        add(id, stepped);
      }
      const next = stepOf(at);
      if (next === UNANSWERED) {
        for (const target of sameNamed(at)) {
          add(target.id, true, true);
        }
        break;
      }
      at = next;
      stepped = true;
    }
    chains.set(symbol.id, targets);
    return targets;
  };

  const nextDeclared = (symbol: TSSymbol): readonly ChainTarget[] => {
    const walked = new Set<number>([symbol.id]);
    let from = symbol;
    let at = stepOf(symbol);
    while (at !== undefined && (at === UNANSWERED || !walked.has(at.id))) {
      if (at === UNANSWERED) {
        return sameNamed(from);
      }
      walked.add(at.id);
      const ids = declarationsOf(at);
      if (ids.length > 0) {
        return ids.map((id) => ({ id, stepped: true, guessed: false }));
      }
      from = at;
      at = stepOf(at);
    }
    return [];
  };

  return {
    declarationsOf,
    chainOf,
    nextDeclared,
    namespaceOf,
    undeclared,
  };
}

/**
 * What each of a batch of nodes resolves to, every alias followed to the declaration
 * it stands for. A node the checker resolves to nothing, and an alias that resolves
 * to nothing, are absent from the answer. Each alias is followed once. A question the
 * checker does not answer stops the pass, as {@link must} stops.
 */
export function resolvedTargets<Brand>(
  project: ProjectView<Brand>,
  nodes: readonly Node[],
): ReadonlyMap<Node, TSSymbol> {
  const followed = new Map<number, TSSymbol | undefined>();
  const targets = new Map<Node, TSSymbol>();
  project
    .symbolsAt(nodes.map((node) => project.handle(node)))
    .map(must)
    .forEach((symbol, index) => {
      const node = nodes[index];
      if (symbol === undefined || node === undefined) {
        return;
      }
      let target: TSSymbol | undefined = symbol;
      if ((symbol.flags & SymbolFlags.Alias) !== 0) {
        if (!followed.has(symbol.id)) {
          const aliased = must(project.queries.aliased(symbol));
          followed.set(symbol.id, aliased.declarations.length === 0 ? undefined : aliased);
        }
        target = followed.get(symbol.id);
      }
      if (target !== undefined) {
        targets.set(node, target);
      }
    });
  return targets;
}
