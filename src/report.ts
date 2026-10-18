/**
 * The report one analysis writes: the Contract's report document, member for member and
 * in the order its schema lists them, built from what one run answered. Every reporter
 * renders this document, so no two renderings disagree about which findings exist.
 */

import { SCHEMA_VERSION, SCHEMA_VERSIONS } from "./contract/contract.generated.ts";
import type * as wire from "./contract/report.generated.ts";
import type { Sort, TargetKind } from "./config.ts";
import type { Conformance, DeclaredGap } from "./conformance.ts";
import type { EdgeEvaluation } from "./edges.ts";
import type {
  CompletedFinding,
  FindingDetails,
  FindingPosition,
  PositionedSymbol,
} from "./finding.ts";
import type { AppliedConvention } from "./conventions.ts";
import type { PassResult } from "./findings-pass.ts";
import type { StaleSuppression } from "./findings/self-check.ts";
import type { TestFileRule } from "./references.ts";
import { bytewise } from "./text/compare.ts";
import { LANGUAGE, PRODUCT } from "./product.ts";

/** One project configuration of the matrix a run analyzed. */
export interface ReportConfiguration {
  readonly id: string;
  /** The compiler configuration file below the target root. */
  readonly project: string;
}

/** One project configuration the run derived and could not build, with why. */
export interface ReportNotBuilt {
  readonly id: string;
  /** The compiler configuration file below the target root. */
  readonly project: string;
  /** The first line of the error that dropped it, naming no path outside the target. */
  readonly error: string;
}

/** One type error that skipped the function or statement holding it. */
export interface TypeErrorSkip {
  /** The file holding the error, below the target root. */
  readonly path: string;
  readonly line: number;
  /** The compiler's message, on one line. */
  readonly message: string;
}

/** One configuration in which the checker left questions unanswered, with what they held. */
export interface UnansweredCount {
  readonly configuration: string;
  readonly questions: number;
  readonly declarations: number;
}

/** One consumer the run loaded, at the directory a report names it by. */
interface ReportConsumer {
  readonly id: string;
  /** The consumer's directory, as the report names its target's: below the run directory. */
  readonly path: string;
}

/** One consumer the scope declared and the run did not load, with why. */
interface UnavailableConsumer {
  readonly id: string;
  readonly reason: string;
}

/** One hint about the run's setup, as the report schema's `notes` spells it. */
export type ReportNote =
  | {
      readonly kind: "unmapped-entry";
      /** The directory of the manifest the note is about, below the target root. */
      readonly path: string;
      readonly key: "ts.entry_files";
      readonly message: string;
    }
  | {
      readonly kind: "computed-load" | "unread-command" | "unresolved-specifier";
      /** The directory of the file that writes the load or the specifier, or of the manifest, below the target root. */
      readonly path: string;
      readonly message: string;
    };

/** What one run answered, from which its report is built. */
export interface ReportInput {
  readonly contractVersion: string;
  readonly version: string;
  readonly conformance: Conformance;
  readonly declaredGaps: readonly DeclaredGap[];
  readonly target: { readonly kind: TargetKind; readonly root: string; readonly identity: string };
  readonly configurations: readonly ReportConfiguration[];
  readonly notBuilt: readonly ReportNotBuilt[];
  readonly loaded: readonly ReportConsumer[];
  readonly unavailable: readonly UnavailableConsumer[];
  readonly result: PassResult;
  readonly testFileRules: readonly TestFileRule[];
  readonly typeErrorSkips: readonly TypeErrorSkip[];
  readonly unanswered: readonly UnansweredCount[];
  /** The convention rows the run applied, in the report's order. */
  readonly conventionsApplied: readonly AppliedConvention[];
  /** The notes the run states, in any order. */
  readonly notes?: readonly ReportNote[];
  /** Whether the run lists each component in full, which `reporters.cascade: full` asks for. */
  readonly listsComponents?: boolean;
}

/**
 * Each component the findings name, once, with the members the first finding naming it
 * carries, in the order the findings are: `findings` paired with their wire forms and
 * sorted, then the edge evaluations' findings.
 */
function componentsOf(
  findings: readonly (readonly [wire.Finding, CompletedFinding])[],
): readonly wire.ComponentsEntry[] {
  const listed = new Map<string, wire.ComponentsEntry>();
  for (const [written, finding] of findings) {
    const { members } = finding.component;
    if (members !== undefined && !listed.has(written.component.id)) {
      listed.set(written.component.id, {
        id: written.component.id,
        members: members.map(wireSymbol),
      });
    }
  }
  return [...listed.values()];
}

function wirePosition(position: FindingPosition): wire.Position {
  return {
    path: position.path,
    line: position.line,
    column: position.column,
    end_line: position.endLine,
  };
}

function wireSymbol(symbol: PositionedSymbol): {
  ref: string;
  name: string;
  position: wire.Position;
} {
  return { ref: symbol.ref, name: symbol.name, position: wirePosition(symbol.position) };
}

/** The details one code carries, in the order the finding schema lists them. */
function wireDetails(details: FindingDetails): wire.Details {
  const { entry } = details;
  return {
    ...(details.narrowerVisibility === undefined
      ? {}
      : { narrower_visibility: details.narrowerVisibility }),
    ...(details.implementations === undefined
      ? {}
      : { implementations: details.implementations.map(wireSymbol) }),
    ...(details.writePositions === undefined
      ? {}
      : { write_positions: details.writePositions.map(wirePosition) }),
    ...(details.dependencyClass === undefined ? {} : { dependency_class: details.dependencyClass }),
    ...(details.mechanism === undefined ? {} : { mechanism: details.mechanism }),
    ...(entry === undefined
      ? {}
      : {
          entry: {
            code: entry.code,
            ...(entry.symbol === undefined ? {} : { symbol: entry.symbol }),
            ...(entry.path === undefined ? {} : { path: entry.path }),
            ...(entry.reason === undefined ? {} : { reason: entry.reason }),
          },
        }),
    ...(details.overlap === undefined ? {} : { overlap: details.overlap }),
    ...(details.removesLastUseOf === undefined
      ? {}
      : { removes_last_use_of: details.removesLastUseOf }),
  };
}

/** One finding as the finding schema spells it, member for member in its order. */
export function wireFinding(finding: CompletedFinding): wire.Finding {
  return {
    code: finding.code,
    kind: finding.kind,
    language: finding.language,
    position: wirePosition(finding.position),
    symbol: {
      ref: finding.symbol.ref,
      kind: finding.symbol.kind,
      name: finding.symbol.name,
      size_lines: finding.symbol.sizeLines,
    },
    reachability_class: finding.reachabilityClass,
    confidence: finding.confidence,
    ...(finding.livenessRelation === undefined
      ? {}
      : { liveness_relation: finding.livenessRelation }),
    test_only: finding.testOnly,
    generated: finding.generated,
    component: {
      id: finding.component.id,
      root: finding.component.root,
      symbol_count: finding.component.symbolCount,
      deletable_lines: finding.component.deletableLines,
    },
    retained_by: finding.retainedBy,
    configurations: finding.configurations,
    consumers_loaded: finding.consumersLoaded,
    fixability: finding.fixability,
    severity: finding.severity,
    message: finding.message,
    details: wireDetails(finding.details),
  };
}

function wireEvaluation(evaluation: EdgeEvaluation<CompletedFinding>): wire.EdgeEvaluationsEntry {
  return {
    edge: evaluation.edge,
    side: evaluation.side,
    symbol: evaluation.symbol,
    state: evaluation.state,
    ...(evaluation.finding === undefined ? {} : { finding: wireFinding(evaluation.finding) }),
  };
}

function wireStale(stale: StaleSuppression): wire.StaleSuppressionsEntry {
  return {
    code: stale.code,
    mechanism: stale.mechanism,
    entry: {
      code: stale.entry.code,
      ...(stale.entry.symbol === undefined ? {} : { symbol: stale.entry.symbol }),
      path: stale.entry.path,
      reason: stale.entry.reason,
    },
    position: {
      path: stale.position.path,
      line: stale.position.line,
      column: stale.position.column,
    },
    symbol: stale.symbol,
    message: stale.message,
  };
}

/** The canonical key over two findings: path, line, column, code, then the symbol reference. */
function canonical(a: wire.Finding, b: wire.Finding): number {
  return (
    bytewise(a.position.path, b.position.path) ||
    a.position.line - b.position.line ||
    a.position.column - b.position.column ||
    bytewise(a.code, b.code) ||
    bytewise(a.symbol.ref, b.symbol.ref)
  );
}

/** The canonical key over two stale suppressions, each component from the record's own member. */
function canonicalStale(a: wire.StaleSuppressionsEntry, b: wire.StaleSuppressionsEntry): number {
  return (
    bytewise(a.position.path, b.position.path) ||
    a.position.line - b.position.line ||
    a.position.column - b.position.column ||
    bytewise(a.code, b.code) ||
    bytewise(a.symbol, b.symbol)
  );
}

/** One declared gap as a report carries it, its members in the schema's order. */
function wireGap(gap: DeclaredGap): wire.DeclaredGapsEntry {
  return {
    fixture: gap.fixture,
    ...(gap.symbol === undefined ? {} : { symbol: gap.symbol }),
    capability: gap.capability,
    reason: gap.reason,
  };
}

/** Edge evaluations by edge, then side, then their compact encodings. */
function byEdge(a: wire.EdgeEvaluationsEntry, b: wire.EdgeEvaluationsEntry): number {
  return (
    bytewise(a.edge, b.edge) ||
    bytewise(a.side, b.side) ||
    bytewise(JSON.stringify(a), JSON.stringify(b))
  );
}

/**
 * The lines a reader deletes by acting on every finding: each distinct component a root
 * finding names, counted once however many of its roots the findings hold.
 */
function deletableLines(findings: readonly wire.Finding[]): number {
  const counted = new Map<string, number>();
  for (const finding of findings) {
    if (finding.component.root) {
      counted.set(finding.component.id, finding.component.deletable_lines);
    }
  }
  let total = 0;
  for (const lines of counted.values()) {
    total += lines;
  }
  return total;
}

/** The totals of one finding set, counted over the whole set. */
function totalsOf(findings: readonly wire.Finding[], result: PassResult): wire.Totals {
  const bySeverity = { allow: 0, warn: 0, deny: 0 };
  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
  }
  return {
    findings: findings.length,
    by_severity: bySeverity,
    deletable_lines: deletableLines(findings),
    suppressions_in_effect: result.totals.suppressionsInEffect,
    reasons_recorded: result.totals.reasonsRecorded,
    stale_suppressions: result.staleSuppressions.length,
    pending: result.totals.pending,
    omitted: 0,
    withheld: {
      certain: result.totals.withheld.certain,
      probable: result.totals.withheld.probable,
      possible: result.totals.withheld.possible,
    },
  };
}

/** Builds the report of one run, every array in the order the Contract fixes for it. */
export function buildReport(input: ReportInput): wire.Report {
  const paired = input.result.findings
    .map((finding) => [wireFinding(finding), finding] as const)
    .sort(([a], [b]) => canonical(a, b));
  const findings = paired.map(([wire]) => wire);
  const evaluated = input.result.edgeEvaluations.flatMap((one) =>
    one.finding === undefined ? [] : [[wireFinding(one.finding), one.finding] as const],
  );
  const unavailable = [...new Map(input.unavailable.map((one) => [one.id, one])).values()]
    .sort((a, b) => bytewise(a.id, b.id))
    .map((one) => ({ id: one.id, role: "consumer" as const, reason: one.reason }));
  const loaded = [...input.loaded]
    .sort((a, b) => bytewise(a.id, b.id) || bytewise(a.path, b.path))
    .map((one) => ({ id: one.id, role: "consumer" as const, path: one.path }));
  return {
    schema_version: SCHEMA_VERSION,
    contract_version: input.contractVersion,
    analyzer: {
      name: PRODUCT,
      version: input.version,
      languages: [LANGUAGE],
      schema_versions_accepted: SCHEMA_VERSIONS,
      conformance: {
        corpus_version: input.conformance.corpusVersion,
        result: input.conformance.result,
        digest: input.conformance.digest,
      },
    },
    target: { kind: input.target.kind, root: input.target.root, identity: input.target.identity },
    configurations: [...input.configurations]
      .sort((a, b) => bytewise(a.id, b.id))
      .map((one) => ({ id: one.id, project: one.project })),
    configurations_not_built: [...input.notBuilt]
      .sort((a, b) => bytewise(a.id, b.id))
      .map((one) => ({ id: one.id, project: one.project, error: one.error })),
    consumers: { declared: loaded.length + unavailable.length, loaded, unavailable },
    findings,
    ...(input.listsComponents === true
      ? { components: componentsOf([...paired, ...evaluated]) }
      : {}),
    edge_evaluations: input.result.edgeEvaluations.map(wireEvaluation).sort(byEdge),
    stale_suppressions: input.result.staleSuppressions.map(wireStale).sort(canonicalStale),
    // Every gap shares the one component of the canonical key a gap supplies, the analyzer's
    // name, so the compact encodings alone order them.
    declared_gaps: input.declaredGaps
      .map(wireGap)
      .sort((a, b) => bytewise(JSON.stringify(a), JSON.stringify(b))),
    excluded_by_cgo: [],
    test_file_rules: [...input.testFileRules]
      .sort((a, b) => bytewise(a.rule, b.rule) || a.matched - b.matched)
      .map((one) => ({ rule: one.rule, matched: one.matched })),
    type_error_skips: [
      ...new Map(
        input.typeErrorSkips.map((one) => {
          const skip = { path: one.path, line: one.line, message: one.message };
          return [JSON.stringify(skip), skip] as const;
        }),
      ),
    ]
      .sort(([a, x], [b, y]) => bytewise(x.path, y.path) || x.line - y.line || bytewise(a, b))
      .map(([, skip]) => skip),
    notes: [...new Map((input.notes ?? []).map((one) => [JSON.stringify(one), one])).entries()]
      .sort(
        ([a, x], [b, y]) => bytewise(x.kind, y.kind) || bytewise(x.path, y.path) || bytewise(a, b),
      )
      .map(([, note]) => note),
    unanswered_questions: [...input.unanswered]
      .sort(
        (a, b) =>
          bytewise(a.configuration, b.configuration) ||
          bytewise(JSON.stringify(a), JSON.stringify(b)),
      )
      .map((one) => ({
        configuration: one.configuration,
        questions: one.questions,
        declarations: one.declarations,
      })),
    conventions_applied: input.conventionsApplied.map((one) => ({
      name: one.name,
      package: one.package,
      version: one.version,
      manifest: one.manifest,
    })),
    totals: totalsOf(findings, input.result),
  };
}

/**
 * The report with its findings in the order a configuration asks for. By size, a finding
 * whose component a deletion shrinks more comes first, then one whose subject is larger,
 * then the canonical key, so the order stays total; by position it is the canonical key.
 */
export function sortFindings(report: wire.Report, by: Sort): wire.Report {
  const bySize = (a: wire.Finding, b: wire.Finding): number =>
    b.component.deletable_lines - a.component.deletable_lines ||
    b.symbol.size_lines - a.symbol.size_lines ||
    canonical(a, b);
  return { ...report, findings: [...report.findings].sort(by === "size" ? bySize : canonical) };
}

/**
 * The report holding the first `most` findings of its order, the rest counted as omitted,
 * and listing only the components those findings name. Every other total keeps describing
 * the whole set. Zero keeps every finding.
 */
export function capFindings(report: wire.Report, most: number): wire.Report {
  if (most <= 0 || report.findings.length <= most) {
    return report;
  }
  const findings = report.findings.slice(0, most);
  const named = new Set(
    [...findings, ...report.edge_evaluations.flatMap((one) => one.finding ?? [])].map(
      (finding) => finding.component.id,
    ),
  );
  return {
    ...report,
    findings,
    ...(report.components === undefined
      ? {}
      : { components: report.components.filter((listed) => named.has(listed.id)) }),
    totals: { ...report.totals, omitted: report.findings.length - most },
  };
}
