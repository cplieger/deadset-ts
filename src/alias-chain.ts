/**
 * Where an import or export chain leads in one project: from one symbol to each
 * declaration of the target it is, and along the chain of aliases it heads to each
 * declaration every link of that chain is.
 */

import {
  isExportAssignment,
  isExportSpecifier,
  isIdentifier,
  isImportClause,
  isImportSpecifier,
  isNamespaceExport,
  isNamespaceImport,
} from "@typescript/native/unstable/ast";
import { SymbolFlags, type Symbol as TSSymbol } from "@typescript/native/unstable/sync";
import { declarationsByName, nodeKey, type Inventory } from "./inventory.ts";
import { UNANSWERED, type Answer } from "./query.ts";
import type { ProjectView } from "./session.ts";

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
  /** How many steps the compiler was asked for: one per alias, whatever the chains it heads. */
  readonly steps: number;
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
  let asked = 0;

  const declarationsOf = (symbol: TSSymbol): string[] => {
    const ids: string[] = [];
    for (const handle of symbol.declarations) {
      if (!ownFiles.has(handle.path)) {
        continue;
      }
      const node = project.declarationAt(handle)?.node;
      const id =
        node === undefined ? undefined : held.declarations.get(nodeKey(node.getSourceFile(), node));
      if (id !== undefined && !ids.includes(id)) {
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
    asked += 1;
    steps.set(symbol.id, next);
    return next;
  };

  const files = held.symbols.filter((one) => one.kind === "file").map((one) => one.id);

  /**
   * The declarations an alias whose step went unanswered may stand for: every one the
   * inventory holds under its own name or the name it carries forward, and every file
   * where it carries a module, so a use through it still counts for what it reaches.
   */
  const sameNamed = (alias: TSSymbol): readonly ChainTarget[] => {
    const names = new Set([alias.name]);
    let module = false;
    for (const handle of alias.declarations) {
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
    const byName = declarationsByName(held);
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
    get steps() {
      return asked;
    },
  };
}
