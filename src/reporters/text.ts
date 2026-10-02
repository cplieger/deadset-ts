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

/**
 * One line per finding in the report's order, then one per stale suppression, then the
 * summary. A finding line is `path:line:col: kind name: message [confidence] (CODE)`; the
 * summary is deliberately not in that shape, so a filter for finding lines yields exactly
 * them. Nothing else is written: no timestamp, duration or host detail.
 */
export const text = (report: Report): string => {
  const lines = report.findings.map(
    (found) =>
      `${found.position.path}:${String(found.position.line)}:${String(found.position.column)}: ${found.symbol.kind} ${found.symbol.name}: ${found.message} [${found.confidence}] (${found.code})`,
  );
  for (const stale of report.stale_suppressions) {
    lines.push(
      `${stale.position.path}:${String(stale.position.line)}:${String(stale.position.column)}: ${STALE_KIND} ${stale.symbol}: ${stale.message} [${STALE_CONFIDENCE}] (${stale.code})`,
    );
  }
  lines.push(summary(report.totals));
  return `${lines.join("\n")}\n`;
};
