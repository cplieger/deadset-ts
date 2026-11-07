import type { Confidence } from "../contract/contract.generated.ts";
import { evaluateEdges, type EdgeEvaluation } from "../edges.ts";
import type { CompletedFinding } from "../finding.ts";
import { declarationKey } from "../ref.ts";
import { ledgerOf, type Dials, type Ledger, type SuppressionRecord } from "../suppress.ts";
import { insideSkipped } from "../type-errors.ts";
import { completed, dialsOf, reportable } from "./completion.ts";
import { dependenciesAndModuleMachinery } from "./dependencies-and-module-machinery.ts";
import type { Emitter, EmitterInput, Emitters } from "./emitter.ts";
import { interfaces } from "./interfaces.ts";
import { intraFunction } from "./intra-function.ts";
import { nonCodeArtifacts } from "./non-code-artifacts.ts";
import { fallingWithWrites, readsAndWrites } from "./reads-and-writes.ts";
import { selfCheck } from "./self-check.ts";
import { fallenMembers, unusedDeclarations } from "./unused-declarations.ts";
import { visibilityNarrowing } from "./visibility-narrowing.ts";

/** Every emitter this analyzer runs, by the name its tests select it by. */
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

/** The keys of the declarations the identifiers name, as {@link findingKey} keys a finding. */
function keysOf(input: EmitterInput, ids: Iterable<string>): ReadonlySet<string> {
  const named = new Set(ids);
  return new Set(
    input.swept.matrix.union.symbols
      .filter((symbol) => named.has(symbol.id))
      .map((symbol) => declarationKey(symbol.ref, symbol.position.path)),
  );
}

/** The key of the declaration a finding is about, or of the one holding the part it is about. */
function findingKey(finding: CompletedFinding): string {
  return declarationKey(finding.symbol.holder ?? finding.symbol.ref, finding.position.path);
}

/** What the suppressions of a run swept under their marks are decided against. */
interface Suppressed {
  /** The same run swept with no mark, which is where a kind about liveness reports a marked declaration. */
  readonly unmarked: EmitterInput;
  /** The run's suppression records, in reading order. */
  readonly records: readonly SuppressionRecord[];
}

/** What the emitter table answers about one run. */
interface DecidedFindings {
  /** Every finding the run reports, each emitter's in table order. */
  readonly findings: readonly CompletedFinding[];
  /** One evaluation per declared edge side of this language, ordered by edge, then by side. */
  readonly evaluations: readonly EdgeEvaluation<CompletedFinding>[];
  /** What every suppression record did, in reading order. */
  readonly ledger: Ledger;
  /** Every finding a record could name: the run's with no mark, then the run's as swept. */
  readonly would: readonly CompletedFinding[];
  /** The findings the minimum confidence withheld, by confidence. */
  readonly withheld: Withheld;
}

/** How many findings the minimum confidence withheld at each confidence. */
export type Withheld = Readonly<Record<Confidence, number>>;

/**
 * Every emitter's findings over one sweep, and those of any further emitter, completed by
 * one step, but none about a declaration that falls with a write-only subject: that
 * subject's finding names it, so no finding about it exists for a record to match.
 */
function completedOver(
  input: EmitterInput,
  ...more: readonly Emitter[]
): readonly CompletedFinding[] {
  const falls = keysOf(input, fallingWithWrites(input));
  return completed(
    input,
    [...EMITTERS.values(), ...more].flatMap((emit) => emit(input)),
  ).filter((finding) => !falls.has(findingKey(finding)));
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
    allows: marked.allows,
    withholds: (finding) =>
      fromUnmarked.has(finding) ? before.withholds(finding) : marked.withholds(finding),
  };
}

/**
 * Every finding of one run swept under its suppressions' marks, decided in one pass: each
 * emitter's findings completed by one step, so every component number is minted once, the
 * finding each record claims withheld, the rest withheld by the dials, so a root one emitter
 * reports withholds what another reports in its component, and every declared edge
 * evaluated over what remains, so a pending finding is in its evaluation alone.
 */
export function decidedFindings(
  input: EmitterInput,
  suppressed: Suppressed = { unmarked: input, records: [] },
): DecidedFindings {
  const found = completedOver(input);
  const unmarked =
    suppressed.records.length === 0 ? [] : completedOver(suppressed.unmarked, fallenMembers);
  const would = [...unmarked, ...found];
  return { ...dialledOver(input, suppressed, found, unmarked), would };
}

/** The run's input with the minimum confidence at its lowest, which withholds nothing. */
function atPossible(input: EmitterInput): EmitterInput {
  const { config } = input;
  return {
    ...input,
    config: { ...config, analysis: { ...config.analysis, min_confidence: "possible" } },
  };
}

/**
 * The run's completed findings decided under its dials: the finding each record claims
 * withheld, the rest withheld by the dials, and every declared edge evaluated over what
 * remains.
 */
function dialledOver(
  input: EmitterInput,
  suppressed: Suppressed,
  found: readonly CompletedFinding[],
  unmarked: readonly CompletedFinding[],
): Omit<DecidedFindings, "would"> {
  const would = [...unmarked, ...found];
  const { sweep } = input.swept;
  // A hold is a gap of the analysis, which leaves a record it touches dormant; a live
  // component file's markup is no gap, so a record on one of its bindings stays in effect.
  const unanswered = keysOf(input, sweep.held);
  const markup = keysOf(input, sweep.bindings);
  const heldIds = new Set(sweep.held);
  const held = (finding: CompletedFinding): boolean =>
    unanswered.has(findingKey(finding)) || insideSkipped(input.swept.skipped, finding.position);
  const ledger = ledgerOf(
    suppressed.records,
    would,
    dialsOver(input, found, suppressed, unmarked),
    { withholds: held, holdsRecord: (record) => heldIds.has(record.bound) },
  );
  const candidates = found.filter(
    (finding) => !ledger.withheld(finding) && !held(finding) && !markup.has(findingKey(finding)),
  );
  const kept = reportable(input, candidates);
  const evaluated = evaluateEdges(kept, input.boundary.edges, input.swept.matrix.union.symbols);
  return {
    findings: evaluated.findings,
    evaluations: evaluated.evaluations,
    ledger,
    withheld: withheldOf(input, candidates),
  };
}

/**
 * The findings the dials withhold only because their confidence is below the minimum, each
 * counted at the confidence this run gives it: the dials at the lowest minimum keep them.
 */
function withheldOf(input: EmitterInput, candidates: readonly CompletedFinding[]): Withheld {
  const dials = dialsOf(input, candidates);
  const lowest = dialsOf(atPossible(input), candidates);
  const counts = { certain: 0, probable: 0, possible: 0 };
  for (const finding of candidates) {
    if (dials.withholds(finding) && !lowest.withholds(finding)) {
      counts[finding.confidence] += 1;
    }
  }
  return counts;
}
