/**
 * Where an import or export chain leads in one project: from one symbol to each
 * declaration of the target it is, and along the chain of aliases it heads to each
 * declaration every link of that chain is.
 */

import { SymbolFlags, type Symbol as TSSymbol } from "@typescript/native/unstable/sync";
import { nodeKey, type Inventory } from "./inventory.ts";
import type { ProjectView } from "./session.ts";

/** One declaration a chain reaches, and whether a step along an alias reached it. */
export interface ChainTarget {
  readonly id: string;
  /** False for a declaration the head symbol itself is, true for one a link stands for. */
  readonly stepped: boolean;
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
  nextDeclared(symbol: TSSymbol): readonly string[];
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
  const ownFiles = new Set(project.ownSourceFiles().map((file) => file.fileName));
  const steps = new Map<number, TSSymbol | undefined>();
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
  const stepOf = (symbol: TSSymbol): TSSymbol | undefined => {
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

  const chainOf = (symbol: TSSymbol): readonly ChainTarget[] => {
    const cached = chains.get(symbol.id);
    if (cached !== undefined) {
      return cached;
    }
    const targets: ChainTarget[] = [];
    const walked = new Set<number>();
    let at: TSSymbol | undefined = symbol;
    let stepped = false;
    while (at !== undefined && !walked.has(at.id)) {
      walked.add(at.id);
      for (const id of declarationsOf(at)) {
        if (!targets.some((target) => target.id === id)) {
          targets.push({ id, stepped });
        }
      }
      at = stepOf(at);
      stepped = true;
    }
    chains.set(symbol.id, targets);
    return targets;
  };

  const nextDeclared = (symbol: TSSymbol): readonly string[] => {
    const walked = new Set<number>([symbol.id]);
    let at = stepOf(symbol);
    while (at !== undefined && !walked.has(at.id)) {
      walked.add(at.id);
      const ids = declarationsOf(at);
      if (ids.length > 0) {
        return ids;
      }
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
