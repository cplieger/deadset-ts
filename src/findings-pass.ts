/**
 * The findings pass over one run: the emitter table's findings with the suppressions
 * applied and the declared edges evaluated, and the stale suppressions, the totals and the
 * verdict a report carries beside them.
 */

import { EXIT_CLEAN, EXIT_FINDINGS, EXIT_PENDING } from "./contract/contract.generated.ts";
import type { AnalysisInputs } from "./analysis.ts";
import { fails, type ResolvedConfig } from "./config.ts";
import { evaluateEdges, type EdgeEvaluation } from "./edges.ts";
import type { CompletedFinding, Finding } from "./finding.ts";
import { dialsOver, reportable, withheldOf, type Withheld } from "./findings/dials.ts";
import type { EmitterInput } from "./findings/emitter.ts";
import { findingKey, keysOf, runEmitters } from "./findings/emitters.ts";
import { fileRefsOf, suppressionRef } from "./findings/self-check.ts";
import { subjectsOf } from "./findings/subjects.ts";
import { OUTSIDE } from "./liveness/graph.ts";
import { positionKey } from "./position.ts";
import { PRODUCT } from "./product.ts";
import { declarationKey } from "./ref.ts";
import type { Provenance } from "./suppression/baseline.ts";
import {
  counts,
  decide,
  staleRecords,
  staleSuppressions,
  type Judged,
  type Ledger,
  type StaleSuppression,
} from "./suppression/ledger.ts";
import { isRowSubject, type SuppressionRecord } from "./suppression/records.ts";
import { bytewise } from "./text/compare.ts";
import { insideSkipped } from "./type-errors.ts";

/** The counts a report's totals carry beside its findings. */
interface PassTotals {
  readonly suppressionsInEffect: number;
  readonly reasonsRecorded: number;
  readonly staleSuppressions: number;
  /** The evaluations that hold a finding pending. */
  readonly pending: number;
  /** The findings the minimum confidence withheld, by confidence. */
  readonly withheld: Withheld;
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
  /** Each record the ledger judged stale that a stale suppression reports, in reading order. */
  readonly stale: readonly SuppressionRecord[];
}

/** The canonical order: path, line, column, code, then the symbol reference. */
function canonical(a: Finding, b: Finding): number {
  return (
    bytewise(a.position.path, b.position.path) ||
    a.position.line - b.position.line ||
    a.position.column - b.position.column ||
    bytewise(a.code, b.code) ||
    bytewise(a.symbol.ref, b.symbol.ref)
  );
}

/** What the suppressions of a run swept under their marks are decided against. */
interface Suppressed {
  /** The same run swept with no mark, which is where a kind about liveness reports a marked declaration. */
  readonly unmarked: EmitterInput;
  /** The run's suppression records, in reading order. */
  readonly records: readonly SuppressionRecord[];
}

/** What the findings stage answers about one run. */
interface DecidedFindings {
  /** Every finding the run reports, each emitter's in table order. */
  readonly findings: readonly CompletedFinding[];
  /** One evaluation per declared edge side of this language, ordered by edge, then by side. */
  readonly evaluations: readonly EdgeEvaluation<CompletedFinding>[];
  /** What every suppression record did, in reading order. */
  readonly ledger: Ledger;
  /** Every finding a record could name, and what the ledger read beside them. */
  readonly would: readonly CompletedFinding[];
  readonly judged: Judged<CompletedFinding>;
  /** The findings the minimum confidence withheld, by confidence. */
  readonly withheld: Withheld;
}

/**
 * The declaration each finding of one run is about, or the one holding the part it is
 * about, as a record binds it: the declaration at the finding's position where its
 * reference is the finding's, else the first of its file carrying that reference, and none
 * for a row of a document.
 */
function declarationsOf(input: EmitterInput): (finding: Finding) => string {
  const union = input.swept.matrix.union;
  const byReference = new Map<string, string>();
  for (const symbol of union.symbols) {
    const key = declarationKey(symbol.ref, symbol.position.path);
    if (!byReference.has(key)) {
      byReference.set(key, symbol.id);
    }
  }
  return (finding) => {
    if (isRowSubject(finding.symbol.kind)) {
      return "";
    }
    const ref = finding.symbol.holder ?? finding.symbol.ref;
    const at = union.at(positionKey(finding.position));
    const declared = at === OUTSIDE ? undefined : union.symbols[at];
    if (declared?.ref === ref) {
      return declared.id;
    }
    return (
      byReference.get(declarationKey(ref, finding.position.path)) ??
      (finding.symbol.kind === "import" ? positionKey(finding.position) : "")
    );
  };
}

/**
 * Every finding of one run swept under its suppressions' marks, decided in one pass, so a
 * root one emitter reports withholds what another reports in its component and a pending
 * finding is in its edge's evaluation alone. A record is decided against a finding a mark
 * can remove, one that carries a liveness relation or falls with dead declarations, as the
 * run swept with every mark withdrawn reports it, and against any other as the run swept
 * under the marks reports it.
 */
export function decidedFindings(
  input: EmitterInput,
  suppressed: Suppressed = { unmarked: input, records: [] },
): DecidedFindings {
  const found = runEmitters(input);
  const unmarked = suppressed.records.length === 0 ? [] : runEmitters(suppressed.unmarked, true);
  const markable = (finding: CompletedFinding): boolean =>
    finding.livenessRelation !== undefined || finding.fallsWith !== undefined;
  const would = [
    ...unmarked.filter(markable),
    ...(suppressed.records.length === 0 ? [] : found.filter((finding) => !markable(finding))),
  ];
  const { sweep } = input.swept;
  const s = subjectsOf(input);
  // A hold is a gap of the analysis, which leaves a record it touches dormant; a live
  // component file's markup is no gap, so a record on one of its bindings stays in effect.
  const unanswered = keysOf(s, sweep.held);
  const markup = keysOf(s, sweep.bindings);
  const heldIds = new Set(sweep.held);
  const held = (finding: CompletedFinding): boolean =>
    unanswered.has(findingKey(finding)) || insideSkipped(input.swept.skipped, finding.position);
  const judged: Judged<CompletedFinding> = {
    dials: dialsOver({ input, found }, { input: suppressed.unmarked, found: unmarked }),
    holds: { withholds: held, holdsRecord: (record) => heldIds.has(record.bound) },
    declarationOf: declarationsOf(input),
  };
  const ledger = decide(suppressed.records, would, judged);
  const candidates = found.filter(
    (finding) => !ledger.withheld(finding) && !held(finding) && !markup.has(findingKey(finding)),
  );
  const evaluated = evaluateEdges(
    reportable(input, candidates),
    input.boundary.edges,
    input.swept.matrix.union.symbols,
  );
  return {
    findings: evaluated.findings,
    evaluations: evaluated.evaluations,
    ledger,
    would,
    judged,
    withheld: withheldOf(input, candidates),
  };
}

/**
 * The pass over one run. The findings stage decides every record against every finding
 * the run would produce with no record there, withholds what the records claim, and
 * evaluates the declared edges; a stale suppression then names the codes its declaration
 * reports instead.
 */
export function findingsPass(inputs: AnalysisInputs): PassResult {
  const { marked, unmarked, suppressions } = inputs;
  const decided = decidedFindings(marked, { unmarked, records: suppressions.records });
  const { ledger } = decided;
  const stale = staleRecords(suppressions.records, ledger);
  const files = fileRefsOf(marked.swept.matrix.union.symbols);
  const records = staleSuppressions(stale, decided.would, decided.judged, (record) =>
    suppressionRef(record.symbol, record.path, files),
  );
  const counted = counts(suppressions.records, ledger);
  return {
    findings: [...decided.findings].sort(canonical),
    staleSuppressions: records,
    edgeEvaluations: decided.evaluations,
    totals: {
      suppressionsInEffect: counted.inEffect,
      reasonsRecorded: counted.reasonsRecorded,
      staleSuppressions: records.length,
      pending: decided.evaluations.filter((one) => one.finding !== undefined).length,
      withheld: decided.withheld,
    },
    stale,
  };
}

/**
 * The exit code of a report the pass answered: pending when an evaluation holds a finding,
 * which outranks the rest because an unmerged report is not an answer; findings when a
 * suppression is stale or a finding's severity reaches the configured failing severity;
 * clean otherwise.
 */
export function verdictOf(result: PassResult, config: ResolvedConfig): number {
  if (result.totals.pending > 0) {
    return EXIT_PENDING;
  }
  if (result.totals.staleSuppressions > 0) {
    return EXIT_FINDINGS;
  }
  const failing = result.findings.some((finding) =>
    fails(finding.severity, config.reporters.fail_on),
  );
  return failing ? EXIT_FINDINGS : EXIT_CLEAN;
}

/** The analyzer identity a baseline this analyzer writes names as its rows' provenance. */
export function analyzerProvenance(version: string): Provenance {
  return { analyzer: PRODUCT, version };
}
