/**
 * The findings pass over one run: the emitter table's findings with the suppressions
 * applied and the declared edges evaluated, and the stale suppressions, the totals and the
 * verdict a report carries beside them.
 */

import type { AnalysisInputs } from "./analysis.ts";
import type { Config, Severity } from "./config.ts";
import type { EdgeEvaluation } from "./edges.ts";
import type { CompletedFinding, Finding } from "./finding.ts";
import { decidedFindings } from "./findings/emitters.ts";
import {
  fileRefsOf,
  staleSuppressions,
  type StaleRecord,
  type StaleSuppression,
} from "./findings/self-check.ts";
import { isRowSubject, pairs, suppressionCounts, type Ledger } from "./suppress.ts";
import type { Provenance, Recorded } from "./suppress-file.ts";
import { EXIT_CLEAN, EXIT_FINDINGS } from "./verbs/verb.ts";

/** The counts a report's totals carry beside its findings. */
export interface PassTotals {
  readonly suppressionsInEffect: number;
  readonly reasonsRecorded: number;
  readonly staleSuppressions: number;
  /** The evaluations that hold a finding pending. */
  readonly pending: number;
}

/** What the pass answers about one run. */
export interface PassResult {
  /** Every finding the report publishes, in the canonical order. */
  readonly findings: readonly CompletedFinding[];
  /** One record per site at which a suppression matched nothing, in reading order. */
  readonly staleSuppressions: readonly StaleSuppression[];
  /** One evaluation per declared edge side of this language. */
  readonly edgeEvaluations: readonly EdgeEvaluation<CompletedFinding>[];
  readonly totals: PassTotals;
  /** What every suppression record did, in reading order. */
  readonly ledger: Ledger<CompletedFinding>;
}

/** The exit code of a report holding at least one pending finding. */
export const EXIT_PENDING = 4;

/** The severities ranked, the strongest highest. */
const SEVERITY_RANK: Readonly<Record<Severity, number>> = { allow: 0, warn: 1, deny: 2 };

/** Two strings ordered bytewise. */
function compare(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** The canonical order: path, line, column, code, then the symbol reference. */
function canonical(a: Finding, b: Finding): number {
  return (
    compare(a.position.path, b.position.path) ||
    a.position.line - b.position.line ||
    a.position.column - b.position.column ||
    compare(a.code, b.code) ||
    compare(a.symbol.ref, b.symbol.ref)
  );
}

/**
 * The pass over one run. The emitter table decides every record against every finding the
 * run would produce with no record there, withholds what the records claim, and evaluates
 * the declared edges; a stale record then names the codes its declaration reports instead.
 */
export function findingsPass(inputs: AnalysisInputs): PassResult {
  const { marked, unmarked, suppressions } = inputs;
  const decided = decidedFindings(marked, { unmarked, records: suppressions.records });
  const { ledger, would } = decided;

  const stale: StaleRecord[] = [];
  suppressions.records.forEach((record, at) => {
    if (ledger.verdicts[at] !== "stale") {
      return;
    }
    const reports = would
      .filter(
        (finding) =>
          finding.code !== record.code && pairs({ ...record, code: finding.code }, finding),
      )
      .map((finding) => finding.code);
    stale.push({ record, reports });
  });

  const records = staleSuppressions(stale, fileRefsOf(marked.swept.matrix.union.symbols));
  const counts = suppressionCounts(suppressions.records, ledger);
  return {
    findings: [...decided.findings].sort(canonical),
    staleSuppressions: records,
    edgeEvaluations: decided.evaluations,
    totals: {
      suppressionsInEffect: counts.inEffect,
      reasonsRecorded: counts.reasonsRecorded,
      staleSuppressions: records.length,
      pending: decided.evaluations.filter((one) => one.finding !== undefined).length,
    },
    ledger,
  };
}

/**
 * The exit code of a report the pass answered: pending when an evaluation holds a finding,
 * which outranks the rest because an unmerged report is not an answer; findings when a
 * suppression is stale or a finding's severity reaches the configured failing severity;
 * clean otherwise.
 */
export function verdictOf(result: PassResult, config: Config): number {
  if (result.totals.pending > 0) {
    return EXIT_PENDING;
  }
  if (result.totals.staleSuppressions > 0) {
    return EXIT_FINDINGS;
  }
  const failing = SEVERITY_RANK[config.reporters.failOn];
  const fails = result.findings.some((finding) => SEVERITY_RANK[finding.severity] >= failing);
  return fails ? EXIT_FINDINGS : EXIT_CLEAN;
}

/**
 * The findings of a report as a baseline records them, in report order. A finding about a
 * row of a document is not recorded: no record withholds one, so a row recording it would
 * be stale on the first read back.
 */
export function recordedFindings(result: PassResult): readonly Recorded[] {
  return result.findings
    .filter((finding) => !isRowSubject(finding.symbol.kind))
    .map((finding) => ({
      code: finding.code,
      symbol: finding.symbol.ref,
      path: finding.position.path,
    }));
}

/** The analyzer identity a baseline this analyzer writes names as its rows' provenance. */
export function analyzerProvenance(version: string): Provenance {
  return { analyzer: "deadset-ts", version };
}
