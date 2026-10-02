import { evaluateEdges, type EdgeEvaluation } from "../edges.ts";
import type { CompletedFinding } from "../finding.ts";
import { ledgerOf, type Dials, type Ledger, type SuppressionRecord } from "../suppress.ts";
import { completed, dialsOf, reportable } from "./completion.ts";
import { dependenciesAndModuleMachinery } from "./dependencies-and-module-machinery.ts";
import type { Emitter, EmitterInput, Emitters } from "./emitter.ts";
import { interfaces } from "./interfaces.ts";
import { intraFunction } from "./intra-function.ts";
import { nonCodeArtifacts } from "./non-code-artifacts.ts";
import { readsAndWrites } from "./reads-and-writes.ts";
import { selfCheck } from "./self-check.ts";
import { unusedDeclarations } from "./unused-declarations.ts";
import { visibilityNarrowing } from "./visibility-narrowing.ts";

/** Every kind family this analyzer reports, each by its emitter, in code order. */
export const EMITTERS: Emitters = new Map<string, Emitter>([
  ["unused-declarations", unusedDeclarations],
  ["visibility-narrowing", visibilityNarrowing],
  ["interfaces", interfaces],
  ["reads-and-writes", readsAndWrites],
  ["non-code-artifacts", nonCodeArtifacts],
  ["dependencies-and-module-machinery", dependenciesAndModuleMachinery],
  ["self-check", selfCheck],
  ["intra-function", intraFunction],
]);

/** What the suppressions of a run swept under their marks are decided against. */
export interface Suppressed {
  /** The same run swept with no mark, which is where a kind about liveness reports a marked declaration. */
  readonly unmarked: EmitterInput;
  /** The run's suppression records, in reading order. */
  readonly records: readonly SuppressionRecord[];
}

/** What the emitter table answers about one run. */
export interface DecidedFindings {
  /** Every finding the run reports, each family's in table order. */
  readonly findings: readonly CompletedFinding[];
  /** One evaluation per declared edge side of this language, ordered by edge, then by side. */
  readonly evaluations: readonly EdgeEvaluation<CompletedFinding>[];
  /** What every suppression record did, in reading order. */
  readonly ledger: Ledger<CompletedFinding>;
  /** Every finding a record could name: the run's with no mark, then the run's as swept. */
  readonly would: readonly CompletedFinding[];
}

/** Every family's findings over one sweep, completed by one step. */
function completedOver(input: EmitterInput): readonly CompletedFinding[] {
  return completed(
    input,
    [...EMITTERS.values()].flatMap((emit) => emit(input)),
  );
}

/**
 * The dials over the findings a record could name, each read against the sweep that
 * produced it, so a component one sweep numbers withholds nothing of the other's.
 */
function dialsOver(
  input: EmitterInput,
  found: readonly CompletedFinding[],
  suppressed: Suppressed,
  unmarked: readonly CompletedFinding[],
): Dials<CompletedFinding> {
  const marked = dialsOf(input, found);
  const before = dialsOf(suppressed.unmarked, unmarked);
  const fromUnmarked = new Set(unmarked);
  return {
    withholdsCode: marked.withholdsCode,
    withholds: (finding) =>
      fromUnmarked.has(finding) ? before.withholds(finding) : marked.withholds(finding),
  };
}

/**
 * Every finding of one run swept under its suppressions' marks, decided in one pass: every
 * family's findings completed by one step, so every component number is minted once, a
 * pending finding's among them; the finding each record claims withheld, whatever its
 * kind; the rest withheld by the dials, so a root one family reports withholds what
 * another family reports in its component; and every declared edge evaluated over what
 * remains, so a finding it holds pending is in its evaluation and nowhere else.
 */
export function decidedFindings(
  input: EmitterInput,
  suppressed: Suppressed = { unmarked: input, records: [] },
): DecidedFindings {
  const found = completedOver(input);
  const unmarked = suppressed.records.length === 0 ? [] : completedOver(suppressed.unmarked);
  const would = [...unmarked, ...found];
  const ledger = ledgerOf(suppressed.records, would, dialsOver(input, found, suppressed, unmarked));
  const kept = reportable(
    input,
    found.filter((finding) => !ledger.withheld(finding)),
  );
  const evaluated = evaluateEdges(kept, input.boundary.edges, input.swept.matrix.union.symbols);
  return {
    findings: evaluated.findings,
    evaluations: evaluated.evaluations,
    ledger,
    would,
  };
}

/** Every finding the run reports, each family's in table order. */
export function findingsOf(input: EmitterInput): readonly CompletedFinding[] {
  return decidedFindings(input).findings;
}
