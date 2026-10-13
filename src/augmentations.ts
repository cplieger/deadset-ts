/**
 * The references a use of an augmentation's declaration makes to what holds it. A use of
 * a declaration a `declare global` block or a module declaration holds is a use of the
 * block, which no name spells or no import may name. An interface or namespace such a
 * block, or the top level of a file that is no module, holds merges with the one of its
 * name, which the language or a library types values by where the target never names it,
 * as `import.meta` or `process.env`, so a use of its member is a use of it.
 */

import type { Inventory, InventorySymbol } from "./inventory.ts";
import { referenceKey } from "./matrix.ts";
import type { Reference } from "./references.ts";

/** Whether one declaration is a `declare global` block: a module-level namespace named `global`. */
function isGlobalBlock(
  symbol: InventorySymbol,
  held: Inventory,
  files: ReadonlySet<string>,
): boolean {
  return (
    symbol.kind === "namespace" &&
    files.has(symbol.parent) &&
    symbol.ref.endsWith("#global") &&
    !held.modules.has(symbol.id)
  );
}

/**
 * For each reference to a declaration an augmentation block, or the global scope of a
 * file in `scripts`, holds, a read at the same place of every interface and namespace
 * between it and the block or the file, and of the block itself. `scripts` holds the
 * files that are no module, by identifier.
 */
export function augmentationReferences(
  held: Inventory,
  found: readonly Reference[],
  scripts: ReadonlySet<string> = new Set(),
): readonly Reference[] {
  const files = new Set(held.symbols.filter((one) => one.kind === "file").map((one) => one.id));
  const globals = new Set(
    held.symbols.filter((one) => isGlobalBlock(one, held, files)).map((one) => one.id),
  );
  if (globals.size === 0 && held.modules.size === 0 && scripts.size === 0) {
    return [];
  }
  const byId = new Map(held.symbols.map((one) => [one.id, one]));
  const holders = (id: string): string[] => {
    const ids: string[] = [];
    for (
      let at = byId.get(byId.get(id)?.parent ?? "");
      at !== undefined;
      at = byId.get(at.parent)
    ) {
      if (globals.has(at.id) || held.modules.has(at.id)) {
        return [...ids, at.id];
      }
      if (scripts.has(at.id)) {
        return ids;
      }
      if (at.kind === "interface" || at.kind === "namespace") {
        ids.push(at.id);
      }
    }
    return [];
  };
  // Two uses at one place of declarations one block holds read the block once there.
  const made = new Set(found.map(referenceKey));
  const reads = new Map<string, Reference>();
  for (const reference of found) {
    for (const to of holders(reference.to)) {
      const read: Reference = {
        from: reference.from,
        to,
        position: reference.position,
        use: "read",
        resolution: reference.resolution,
        test: reference.test,
      };
      const key = referenceKey(read);
      if (!made.has(key) && !reads.has(key)) {
        reads.set(key, read);
      }
    }
  }
  return [...reads.values()];
}
