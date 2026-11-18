/**
 * The order every list of symbols and declarations the checker answers is read in, which
 * deadset-ts defines itself: a compiler release may bind files or build a type's members in
 * another order, and no result may follow it.
 */

import type { NodeHandle, Symbol as TSSymbol } from "@typescript/native/sync";
import { bytewise } from "./text/compare.ts";

/** Two declarations by their file's path, bytewise, then by source order in that file. */
export function compareHandles(a: NodeHandle, b: NodeHandle): number {
  return bytewise(a.path, b.path) || a.index - b.index;
}

const sorted = new WeakMap<TSSymbol, TSSymbol["declarations"]>();

/**
 * One symbol's declarations, in the order {@link compareHandles} gives; none for no symbol.
 * Every read of a symbol's declarations goes through it.
 */
export function canonicalDeclarations(symbol: TSSymbol | undefined): TSSymbol["declarations"] {
  if (symbol === undefined) {
    return [];
  }
  const known = sorted.get(symbol);
  if (known !== undefined) {
    return known;
  }
  const ordered = [...symbol.declarations].sort(compareHandles);
  sorted.set(symbol, ordered);
  return ordered;
}

/** Two symbols by their first declaration, one no file declares after every declared one, then by name. */
function compareSymbols(a: TSSymbol, b: TSSymbol): number {
  const [x] = canonicalDeclarations(a);
  const [y] = canonicalDeclarations(b);
  if (x !== undefined && y !== undefined) {
    const placed = compareHandles(x, y);
    if (placed !== 0) {
      return placed;
    }
  } else if (x !== undefined || y !== undefined) {
    return x === undefined ? 1 : -1;
  }
  return bytewise(a.escapedName, b.escapedName);
}

/** A list of symbols in the order {@link compareSymbols} gives. */
export function canonicalSymbols(symbols: readonly TSSymbol[]): readonly TSSymbol[] {
  return [...symbols].sort(compareSymbols);
}

/** A symbol table with its entries in the order {@link compareSymbols} gives. */
export function canonicalTable<K>(table: ReadonlyMap<K, TSSymbol>): ReadonlyMap<K, TSSymbol> {
  return new Map([...table].sort(([, a], [, b]) => compareSymbols(a, b)));
}

/**
 * Types in the order {@link compareSymbols} gives their declaring symbols; a type no
 * symbol declares keeps its place after every declared one.
 */
export function canonicalTypes<T>(
  types: readonly T[],
  symbolOf: (type: T) => TSSymbol | undefined,
): readonly T[] {
  const keyed = types.map((type) => ({ type, symbol: symbolOf(type) }));
  return keyed
    .sort((a, b) =>
      a.symbol === undefined || b.symbol === undefined
        ? Number(a.symbol === undefined) - Number(b.symbol === undefined)
        : compareSymbols(a.symbol, b.symbol),
    )
    .map(({ type }) => type);
}
