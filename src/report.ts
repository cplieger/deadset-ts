/**
 * The report one analysis writes: the Contract's report document, member for member and
 * in the order its schema lists them, built from what one run answered. Every reporter
 * renders this document, so no two renderings disagree about which findings exist.
 */

import type { Severity, Sort, TargetKind } from "./config.ts";
import type { Conformance, DeclaredGap } from "./conformance.ts";
import type { EdgeEvaluation } from "./edges.ts";
import type {
  CompletedFinding,
  FindingDetails,
  FindingPosition,
  PositionedSymbol,
} from "./finding.ts";
import type { PassResult } from "./findings-pass.ts";
import type { StaleSuppression } from "./findings/self-check.ts";
import type { TestFileRule } from "./references.ts";

/** The version of the report schema this analyzer writes a report to. */
const SCHEMA_VERSION = "6.1.0";

/**
 * Every report schema version this analyzer reads: the schema versions the Contract it
 * implements admits, each an instance of the one it writes.
 */
export const SCHEMA_VERSIONS_ACCEPTED: readonly string[] = ["6.0.0", SCHEMA_VERSION];

/** The name this analyzer writes every document under and mints every identifier with. */
export const ANALYZER_NAME = "deadset-ts";

/** The language this analyzer claims. */
export const LANGUAGE = "ts";

export interface WirePosition {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly end_line: number;
}

export interface WireDetails {
  readonly narrower_visibility?: string;
  readonly implementations?: readonly {
    readonly ref: string;
    readonly name: string;
    readonly position: WirePosition;
  }[];
  readonly write_positions?: readonly WirePosition[];
  readonly dependency_class?: string;
  readonly mechanism?: string;
  readonly entry?: {
    readonly code: string;
    readonly symbol?: string;
    readonly path?: string;
    readonly reason?: string;
  };
  readonly overlap?: readonly string[];
}

/** One finding as the finding schema spells it. */
export interface WireFinding {
  readonly code: string;
  readonly kind: string;
  readonly language: string;
  readonly position: WirePosition;
  readonly symbol: {
    readonly ref: string;
    readonly kind: string;
    readonly name: string;
    readonly size_lines: number;
  };
  readonly reachability_class: string;
  readonly confidence: string;
  readonly liveness_relation?: string;
  readonly test_only: boolean;
  readonly generated: boolean;
  readonly component: {
    readonly id: string;
    readonly root: boolean;
    readonly symbol_count: number;
    readonly deletable_lines: number;
    readonly members?: readonly {
      readonly ref: string;
      readonly name: string;
      readonly position: WirePosition;
    }[];
  };
  readonly retained_by: readonly string[];
  readonly configurations: readonly string[];
  readonly consumers_loaded: readonly string[];
  readonly fixability: string;
  readonly severity: Severity;
  readonly message: string;
  readonly details: WireDetails;
}

export interface WireEdgeEvaluation {
  readonly edge: string;
  readonly side: string;
  readonly symbol: string;
  readonly state: string;
  readonly finding?: WireFinding;
}

export interface WireStaleSuppression {
  readonly code: string;
  readonly mechanism: string;
  readonly entry: {
    readonly code: string;
    readonly symbol?: string;
    readonly path: string;
    readonly reason: string;
  };
  readonly position: { readonly path: string; readonly line: number; readonly column: number };
  readonly symbol: string;
  readonly message: string;
}

interface WireDeclaredGap {
  readonly fixture: string;
  readonly symbol?: string;
  readonly capability: string;
  readonly reason: string;
}

export interface WireTotals {
  readonly findings: number;
  readonly by_severity: { readonly allow: number; readonly warn: number; readonly deny: number };
  readonly deletable_lines: number;
  readonly suppressions_in_effect: number;
  readonly reasons_recorded: number;
  readonly stale_suppressions: number;
  readonly pending: number;
  readonly omitted: number;
}

/** One project configuration of the matrix a run analyzed. */
export interface ReportConfiguration {
  readonly id: string;
  /** The compiler configuration file below the target root. */
  readonly project: string;
}

/** One consumer the run loaded, at the directory a report names it by. */
interface ReportConsumer {
  readonly id: string;
  /** The consumer's directory, as the report names its target's: below the run directory. */
  readonly path: string;
}

/** One consumer the scope declared and the run did not load, with why. */
export interface UnavailableConsumer {
  readonly id: string;
  readonly reason: string;
}

/** The report document. */
export interface Report {
  readonly schema_version: string;
  readonly contract_version: string;
  readonly analyzer: {
    readonly name: string;
    readonly version: string;
    readonly languages: readonly string[];
    readonly schema_versions_accepted: readonly string[];
    readonly conformance: {
      readonly corpus_version: string;
      readonly result: string;
      readonly digest: string;
    };
  };
  readonly target: { readonly kind: TargetKind; readonly root: string; readonly identity: string };
  readonly configurations: readonly ReportConfiguration[];
  readonly configurations_not_built: readonly never[];
  readonly consumers: {
    readonly declared: number;
    readonly loaded: readonly {
      readonly id: string;
      readonly role: "consumer";
      readonly path: string;
    }[];
    readonly unavailable: readonly {
      readonly id: string;
      readonly role: "consumer";
      readonly reason: string;
    }[];
  };
  readonly findings: readonly WireFinding[];
  readonly edge_evaluations: readonly WireEdgeEvaluation[];
  readonly stale_suppressions: readonly WireStaleSuppression[];
  readonly declared_gaps: readonly WireDeclaredGap[];
  readonly excluded_by_cgo: readonly never[];
  readonly test_file_rules: readonly TestFileRule[];
  readonly totals: WireTotals;
}

/** What one run answered, from which its report is built. */
export interface ReportInput {
  readonly contractVersion: string;
  readonly version: string;
  readonly conformance: Conformance;
  readonly declaredGaps: readonly DeclaredGap[];
  readonly target: { readonly kind: TargetKind; readonly root: string; readonly identity: string };
  readonly configurations: readonly ReportConfiguration[];
  readonly loaded: readonly ReportConsumer[];
  readonly unavailable: readonly UnavailableConsumer[];
  readonly result: PassResult;
  readonly testFileRules: readonly TestFileRule[];
}

/** Two strings ordered bytewise. */
function compare(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function wirePosition(position: FindingPosition): WirePosition {
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
  position: WirePosition;
} {
  return { ref: symbol.ref, name: symbol.name, position: wirePosition(symbol.position) };
}

/** The details one code carries, in the order the finding schema lists them. */
function wireDetails(details: FindingDetails): WireDetails {
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
  };
}

/** One finding as the finding schema spells it, member for member in its order. */
export function wireFinding(finding: CompletedFinding): WireFinding {
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
      ...(finding.component.members === undefined
        ? {}
        : { members: finding.component.members.map(wireSymbol) }),
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

function wireEvaluation(evaluation: EdgeEvaluation<CompletedFinding>): WireEdgeEvaluation {
  return {
    edge: evaluation.edge,
    side: evaluation.side,
    symbol: evaluation.symbol,
    state: evaluation.state,
    ...(evaluation.finding === undefined ? {} : { finding: wireFinding(evaluation.finding) }),
  };
}

function wireStale(stale: StaleSuppression): WireStaleSuppression {
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
function canonical(a: WireFinding, b: WireFinding): number {
  return (
    compare(a.position.path, b.position.path) ||
    a.position.line - b.position.line ||
    a.position.column - b.position.column ||
    compare(a.code, b.code) ||
    compare(a.symbol.ref, b.symbol.ref)
  );
}

/** The canonical key over two stale suppressions, each component from the record's own member. */
function canonicalStale(a: WireStaleSuppression, b: WireStaleSuppression): number {
  return (
    compare(a.position.path, b.position.path) ||
    a.position.line - b.position.line ||
    a.position.column - b.position.column ||
    compare(a.code, b.code) ||
    compare(a.symbol, b.symbol)
  );
}

/** One declared gap as a report carries it, its members in the schema's order. */
function wireGap(gap: DeclaredGap): WireDeclaredGap {
  return {
    fixture: gap.fixture,
    ...(gap.symbol === undefined ? {} : { symbol: gap.symbol }),
    capability: gap.capability,
    reason: gap.reason,
  };
}

/** Edge evaluations by edge, then side, then their compact encodings. */
function byEdge(a: WireEdgeEvaluation, b: WireEdgeEvaluation): number {
  return (
    compare(a.edge, b.edge) ||
    compare(a.side, b.side) ||
    compare(JSON.stringify(a), JSON.stringify(b))
  );
}

/**
 * The lines a reader deletes by acting on every finding: each distinct component a root
 * finding names, counted once however many of its roots the findings hold.
 */
function deletableLines(findings: readonly WireFinding[]): number {
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
function totalsOf(findings: readonly WireFinding[], result: PassResult): WireTotals {
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
  };
}

/** Builds the report of one run, every array in the order the Contract fixes for it. */
export function buildReport(input: ReportInput): Report {
  const findings = input.result.findings.map(wireFinding).sort(canonical);
  const unavailable = [...new Map(input.unavailable.map((one) => [one.id, one])).values()]
    .sort((a, b) => compare(a.id, b.id))
    .map((one) => ({ id: one.id, role: "consumer" as const, reason: one.reason }));
  const loaded = [...input.loaded]
    .sort((a, b) => compare(a.id, b.id) || compare(a.path, b.path))
    .map((one) => ({ id: one.id, role: "consumer" as const, path: one.path }));
  return {
    schema_version: SCHEMA_VERSION,
    contract_version: input.contractVersion,
    analyzer: {
      name: ANALYZER_NAME,
      version: input.version,
      languages: [LANGUAGE],
      schema_versions_accepted: SCHEMA_VERSIONS_ACCEPTED,
      conformance: {
        corpus_version: input.conformance.corpusVersion,
        result: input.conformance.result,
        digest: input.conformance.digest,
      },
    },
    target: { kind: input.target.kind, root: input.target.root, identity: input.target.identity },
    configurations: [...input.configurations]
      .sort((a, b) => compare(a.id, b.id))
      .map((one) => ({ id: one.id, project: one.project })),
    configurations_not_built: [],
    consumers: { declared: loaded.length + unavailable.length, loaded, unavailable },
    findings,
    edge_evaluations: input.result.edgeEvaluations.map(wireEvaluation).sort(byEdge),
    stale_suppressions: input.result.staleSuppressions.map(wireStale).sort(canonicalStale),
    // Every gap shares the one component of the canonical key a gap supplies, the analyzer's
    // name, so the compact encodings alone order them.
    declared_gaps: input.declaredGaps
      .map(wireGap)
      .sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b))),
    excluded_by_cgo: [],
    test_file_rules: [...input.testFileRules]
      .sort((a, b) => compare(a.rule, b.rule) || a.matched - b.matched)
      .map((one) => ({ rule: one.rule, matched: one.matched })),
    totals: totalsOf(findings, input.result),
  };
}

/**
 * The report with its findings in the order a configuration asks for. By size, a finding
 * whose component a deletion shrinks more comes first, then one whose subject is larger,
 * then the canonical key, so the order stays total; by position it is the canonical key.
 */
export function sortFindings(report: Report, by: Sort): Report {
  const bySize = (a: WireFinding, b: WireFinding): number =>
    b.component.deletable_lines - a.component.deletable_lines ||
    b.symbol.size_lines - a.symbol.size_lines ||
    canonical(a, b);
  return { ...report, findings: [...report.findings].sort(by === "size" ? bySize : canonical) };
}

/**
 * The report holding the first `most` findings of its order, the rest counted as omitted.
 * Every other total keeps describing the whole set. Zero keeps every finding.
 */
export function capFindings(report: Report, most: number): Report {
  if (most <= 0 || report.findings.length <= most) {
    return report;
  }
  return {
    ...report,
    findings: report.findings.slice(0, most),
    totals: { ...report.totals, omitted: report.findings.length - most },
  };
}
