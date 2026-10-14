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
 * Per declaration, the interfaces and namespaces between it and the augmentation block or
 * the file in `scripts` that holds it, with the block itself, or none where no such block
 * or file holds it; and whether that holder is the global scope rather than a module
 * declaration. `scripts` holds the files that are no module, by identifier.
 */
function holdersOf(
  held: Inventory,
  scripts: ReadonlySet<string>,
): ((id: string) => { readonly ids: readonly string[]; readonly global: boolean }) | undefined {
  const files = new Set(held.symbols.filter((one) => one.kind === "file").map((one) => one.id));
  const globals = new Set(
    held.symbols.filter((one) => isGlobalBlock(one, held, files)).map((one) => one.id),
  );
  if (globals.size === 0 && held.modules.size === 0 && scripts.size === 0) {
    return undefined;
  }
  const byId = new Map(held.symbols.map((one) => [one.id, one]));
  return (id) => {
    const ids: string[] = [];
    for (
      let at = byId.get(byId.get(id)?.parent ?? "");
      at !== undefined;
      at = byId.get(at.parent)
    ) {
      if (globals.has(at.id) || held.modules.has(at.id)) {
        return { ids: [...ids, at.id], global: globals.has(at.id) };
      }
      if (scripts.has(at.id)) {
        return { ids, global: true };
      }
      if (at.kind === "interface" || at.kind === "namespace") {
        ids.push(at.id);
      }
    }
    return { ids: [], global: false };
  };
}

/**
 * The ambient interfaces of the global scope among `interfaces`: each one a declaration
 * file or a `declare` holds that a `declare global` block, or the top level of a file in
 * `scripts`, declares, directly or inside a namespace there.
 */
export function ambientGlobalInterfaces(
  held: Inventory,
  interfaces: readonly string[],
  scripts: ReadonlySet<string>,
): readonly string[] {
  const holders = holdersOf(held, scripts);
  return holders === undefined
    ? []
    : interfaces.filter((id) => held.ambient.has(id) && holders(id).global);
}

/**
 * For each reference to a declaration an augmentation block, or the global scope of a
 * file in `scripts` (the files that are no module), holds, a read at the same place of
 * every interface and namespace between it and the block or the file, and of the block
 * itself. A read through an interface of `merged`, an ambient global interface merging
 * into a language or library one, is a production read whoever writes it: it types a
 * value the runtime provides, so a test reading a member needs it as code does.
 */
export function augmentationReferences(
  held: Inventory,
  found: readonly Reference[],
  scripts: ReadonlySet<string> = new Set(),
  merged: ReadonlySet<string> = new Set(),
): readonly Reference[] {
  const holders = holdersOf(held, scripts);
  if (holders === undefined) {
    return [];
  }
  const fileOf = new Map(
    held.symbols.filter((one) => one.kind === "file").map((one) => [one.position.path, one.id]),
  );
  // Two uses at one place of declarations one block holds read the block once there.
  const made = new Set(found.map(referenceKey));
  const reads = new Map<string, Reference>();
  for (const reference of found) {
    const { ids } = holders(reference.to);
    // A test's read through such an interface is held by the test file, which the test
    // runner loads whichever of its declarations runs.
    const typed = reference.test && ids.some((id) => merged.has(id));
    const from = typed ? (fileOf.get(reference.position.path) ?? reference.from) : reference.from;
    for (const to of ids) {
      const read: Reference = {
        from,
        to,
        position: reference.position,
        use: "read",
        resolution: reference.resolution,
        test: reference.test && !typed,
      };
      const key = referenceKey(read);
      if (!made.has(key) && !reads.has(key)) {
        reads.set(key, read);
      }
    }
  }
  return [...reads.values()];
}
