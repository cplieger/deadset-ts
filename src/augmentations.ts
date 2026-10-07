/**
 * The references a use of an augmentation's declaration makes to what holds it. No name
 * spells a `declare global` block, so a use of a declaration it holds is a use of the
 * block. An interface or namespace an augmentation block holds merges with the one of its
 * name, which the language or a library may type a value by where the target never names
 * it, as it types `import.meta` or `process.env`, so a use of its member is a use of it.
 */

import type { Inventory, InventorySymbol } from "./inventory.ts";
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
 * For each reference to a declaration an augmentation block holds, a read at the same place
 * of every interface and namespace between it and the block, and of a `declare global` block
 * itself.
 */
export function augmentationReferences(
  held: Inventory,
  found: readonly Reference[],
): readonly Reference[] {
  const files = new Set(held.symbols.filter((one) => one.kind === "file").map((one) => one.id));
  const globals = new Set(
    held.symbols.filter((one) => isGlobalBlock(one, held, files)).map((one) => one.id),
  );
  if (globals.size === 0 && held.modules.size === 0) {
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
      if (globals.has(at.id)) {
        return [...ids, at.id];
      }
      if (held.modules.has(at.id)) {
        return ids;
      }
      if (at.kind === "interface" || at.kind === "namespace") {
        ids.push(at.id);
      }
    }
    return [];
  };
  return found.flatMap((reference) =>
    holders(reference.to).map((to) => ({
      from: reference.from,
      to,
      position: reference.position,
      use: "read" as const,
      resolution: reference.resolution,
      test: reference.test,
    })),
  );
}
