import { coalesced } from "../json-chunks.ts";
import type { Report, WireTotals } from "../report.ts";

/** The kind token and the confidence a stale suppression is rendered with, both fixed. */
const STALE_KIND = "suppression";
const STALE_CONFIDENCE = "certain";

/** A count with the word for it, so the summary reads as a sentence. */
function counted(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** The report's totals in one line, in the order the report declares them. */
function summary(totals: WireTotals): string {
  const { allow, warn, deny } = totals.by_severity;
  return [
    `summary: ${counted(totals.findings, "finding", "findings")} (${String(allow)} allow, ${String(warn)} warn, ${String(deny)} deny)`,
    counted(totals.deletable_lines, "deletable line", "deletable lines"),
    counted(totals.suppressions_in_effect, "suppression in effect", "suppressions in effect"),
    counted(totals.reasons_recorded, "reason recorded", "reasons recorded"),
    counted(totals.stale_suppressions, "stale suppression", "stale suppressions"),
    `${String(totals.pending)} pending`,
    `${String(totals.omitted)} omitted`,
  ].join(", ");
}

/** The confidences a withheld line names, from the highest the minimum can withhold. */
const WITHHELD_ORDER = ["probable", "possible"] as const;

/**
 * The line naming what the minimum confidence withheld and the setting that shows it all,
 * or undefined where it withheld nothing.
 */
export function withheldLine(totals: WireTotals): string | undefined {
  const named = WITHHELD_ORDER.filter((confidence) => totals.withheld[confidence] > 0);
  const lowest = named.at(-1);
  if (lowest === undefined) {
    return undefined;
  }
  const counts = named.map((confidence) => `${String(totals.withheld[confidence])} ${confidence}`);
  return `withheld by analysis.min_confidence: ${counts.join(", ")}, shown with analysis.min_confidence set to ${lowest}`;
}

/**
 * One line per finding in the report's order, then one per stale suppression, then the
 * withheld line where the minimum withheld a finding, then the summary. A finding line is
 * `path:line:col: kind name: message [confidence] (CODE)`; the summary is deliberately not
 * in that shape, so a filter for finding lines yields exactly them. Nothing else is
 * written: no timestamp, duration or host detail.
 */
export const text = (report: Report): Iterable<string> =>
  coalesced(
    (function* lines(): Generator<string, void, undefined> {
      for (const found of report.findings) {
        yield `${found.position.path}:${String(found.position.line)}:${String(found.position.column)}: ${found.symbol.kind} ${found.symbol.name}: ${found.message} [${found.confidence}] (${found.code})\n`;
      }
      for (const stale of report.stale_suppressions) {
        yield `${stale.position.path}:${String(stale.position.line)}:${String(stale.position.column)}: ${STALE_KIND} ${stale.symbol}: ${stale.message} [${STALE_CONFIDENCE}] (${stale.code})\n`;
      }
      const withheld = withheldLine(report.totals);
      if (withheld !== undefined) {
        yield `${withheld}\n`;
      }
      yield `${summary(report.totals)}\n`;
    })(),
  );
