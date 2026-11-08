import { EXIT_CLEAN } from "../contract/contract.generated.ts";
import { productionMode, runSweep } from "../analysis.ts";
import type { Exemption } from "../exemptions/lifecycle.ts";
import type { InventorySymbol } from "../inventory.ts";
import { partialNotes } from "../partial.ts";
import { positionKey } from "../position.ts";
import { resolvePath } from "../paths.ts";
import { resolve } from "../resolve.ts";
import { type Verb } from "./verb.ts";
import { diagnose } from "../product.ts";

/**
 * One line per held-back declaration, in site order: its reference and position, then
 * each record's class, site and detail, all separated by tabs.
 */
function retainedLines(
  symbols: readonly InventorySymbol[],
  retained: readonly Exemption[],
): readonly string[] {
  const held = new Map<string, Exemption[]>();
  for (const record of retained) {
    held.set(record.id, [...(held.get(record.id) ?? []), record]);
  }
  return symbols.flatMap((symbol) => {
    const records = held.get(symbol.id);
    if (records === undefined) {
      return [];
    }
    const fields = records.flatMap((record) => [
      record.class,
      positionKey(record.site),
      record.detail,
    ]);
    return [[symbol.ref, positionKey(symbol.position), ...fields].join("\t")];
  });
}

/**
 * Writes every declaration an exemption held back in the production sweep a report is
 * built from, one per line, and nothing where no exemption held one back. One fact
 * several configurations found is one record, so the line names no configuration. The
 * line shape is this command's own rather than a Contract format, so that sort and cut
 * read it. Where the analysis was partial, the error stream says so.
 */
export const printRetainedVerb: Verb = ({ out, err, host, inputs, scope, openClient }) => {
  const { config } = resolve(inputs());
  const scoped = scope();
  const swept = runSweep(openClient(config), host, scoped, config, {
    marked: [],
    mode: productionMode(config),
  });
  for (const line of retainedLines(swept.matrix.union.symbols, swept.sweep.retained)) {
    out.write(`${line}\n`);
  }
  for (const note of partialNotes({
    notBuilt: swept.notBuilt,
    unanswered: swept.unanswered,
    targetRoot: resolvePath(host.workingDirectory(), scoped.target.path),
  })) {
    diagnose(err, note);
  }
  return EXIT_CLEAN;
};
