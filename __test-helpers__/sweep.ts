import type { InventorySymbol } from "../src/inventory.ts";
import { matrixOf, type Matrix } from "../src/liveness/matrix.ts";
import type { SweepPolicy } from "../src/liveness/sweep.ts";
import type { Reference } from "../src/references.ts";
import type { Root } from "../src/roots/root-set.ts";

/** The matrix of one configuration holding the declarations, references and roots given. */
export function matrixFor(
  symbols: readonly InventorySymbol[],
  references: readonly Reference[],
  roots: readonly Root[],
  testFiles: readonly string[],
  supportFiles: readonly string[] = [],
): Matrix {
  return matrixOf([{ configuration: "c", symbols, references, roots, testFiles, supportFiles }]);
}

/** A sweep policy with nothing held, no component file and a declared consumer, beside what is given. */
export function policyOf(
  given: Partial<SweepPolicy> & Pick<SweepPolicy, "marked" | "mode">,
): SweepPolicy {
  return {
    exempt: [],
    unanswered: [],
    componentFiles: [],
    unseenCallers: false,
    writeOnly: new Set(),
    ...given,
  };
}

/** The component files among the declarations given, by path, ascending and each once. */
export function componentFilesOf(symbols: readonly InventorySymbol[]): readonly string[] {
  return [
    ...new Set(
      symbols
        .filter(
          (symbol) =>
            symbol.kind === "file" && /\.(?:vue|svelte|astro)$/u.test(symbol.position.path),
        )
        .map((symbol) => symbol.position.path),
    ),
  ].sort();
}
