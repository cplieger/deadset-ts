import type { Confidence } from "../config.ts";
import { evaluateEdges, type EdgeEvaluation } from "../edges.ts";
import type { CompletedFinding } from "../finding.ts";
import { liveFilesAt } from "../matrix.ts";
import { declarationKey } from "../ref.ts";
import { ledgerOf, type Dials, type Ledger, type SuppressionRecord } from "../suppress.ts";
import { insideSkipped } from "../type-errors.ts";
import { completed, dialsOf, reportable } from "./completion.ts";
import { dependenciesAndModuleMachinery } from "./dependencies-and-module-machinery.ts";
import type { Emitter, EmitterInput, Emitters } from "./emitter.ts";
import { interfaces } from "./interfaces.ts";
import { intraFunction } from "./intra-function.ts";
import { nonCodeArtifacts } from "./non-code-artifacts.ts";
import { readsAndWrites } from "./reads-and-writes.ts";
import { selfCheck } from "./self-check.ts";
import { fallenMembers, unusedDeclarations } from "./unused-declarations.ts";
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

/**
 * The keys of every declaration an unanswered question could have kept live, which the run
 * reports nothing about: a finding about one would be computed from the gap.
 */
function heldKeys(input: EmitterInput): ReadonlySet<string> {
  const held = new Set(input.swept.heldByUnanswered);
  if (held.size === 0) {
    return held;
  }
  return new Set(
    input.swept.matrix.union.symbols
      .filter((symbol) => held.has(symbol.id))
      .map((symbol) => declarationKey(symbol.ref, symbol.position.path)),
  );
}

/**
 * The keys of every top-level declaration of a live component file. The file's
 * markup may use each of them, which no analysis of the markup can rule out, so the run
 * reports nothing about one while the file is live.
 */
function markupKeys(input: EmitterInput): ReadonlySet<string> {
  const { swept } = input;
  if (swept.componentFiles.length === 0) {
    return new Set();
  }
  const live = new Set(
    liveFilesAt(swept.matrix, swept.sweep, new Set(swept.componentFiles)).map(
      (symbol) => symbol.id,
    ),
  );
  return new Set(
    swept.matrix.union.symbols
      .filter((symbol) => live.has(symbol.parent))
      .map((symbol) => declarationKey(symbol.ref, symbol.position.path)),
  );
}

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
  /** The findings the minimum confidence withheld, by confidence. */
  readonly withheld: Withheld;
}

/** How many findings the minimum confidence withheld at each confidence. */
export type Withheld = Readonly<Record<Confidence, number>>;

/** Every family's findings over one sweep, and those of any further emitter, completed by one step. */
function completedOver(
  input: EmitterInput,
  ...more: readonly Emitter[]
): readonly CompletedFinding[] {
  return completed(
    input,
    [...EMITTERS.values(), ...more].flatMap((emit) => emit(input)),
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
 * Every finding of one run swept under its suppressions' marks, decided in one pass: each
 * family's findings completed by one step, so every component number is minted once, the
 * finding each record claims withheld, the rest withheld by the dials, so a root one family
 * reports withholds what another reports in its component, and every declared edge
 * evaluated over what remains, so a pending finding is in its evaluation alone. What the
 * minimum confidence withheld is what the same decision at the lowest minimum adds.
 */
export function decidedFindings(
  input: EmitterInput,
  suppressed: Suppressed = { unmarked: input, records: [] },
): DecidedFindings {
  const found = completedOver(input);
  const unmarked =
    suppressed.records.length === 0 ? [] : completedOver(suppressed.unmarked, fallenMembers);
  const would = [...unmarked, ...found];
  const decided = dialledOver(input, suppressed, found, unmarked);
  const shown =
    input.config.analysis.minConfidence === "possible"
      ? decided
      : dialledOver(
          atPossible(input),
          {
            unmarked: atPossible(suppressed.unmarked),
            records: suppressed.records,
          },
          found,
          unmarked,
        );
  return { ...decided, would, withheld: withheldOf(decided.findings, shown.findings) };
}

/** The run's input with the minimum confidence at its lowest, which withholds nothing. */
function atPossible(input: EmitterInput): EmitterInput {
  const { config } = input;
  return {
    ...input,
    config: { ...config, analysis: { ...config.analysis, minConfidence: "possible" } },
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
): Omit<DecidedFindings, "would" | "withheld"> {
  const would = [...unmarked, ...found];
  const ledger = ledgerOf(suppressed.records, would, dialsOver(input, found, suppressed, unmarked));
  const unanswered = heldKeys(input);
  const markup = markupKeys(input);
  const kept = reportable(
    input,
    found.filter((finding) => {
      const key = declarationKey(finding.symbol.ref, finding.position.path);
      return (
        !ledger.withheld(finding) &&
        !unanswered.has(key) &&
        !markup.has(key) &&
        !insideSkipped(input.swept.skipped, finding.position)
      );
    }),
  );
  const evaluated = evaluateEdges(kept, input.boundary.edges, input.swept.matrix.union.symbols);
  return { findings: evaluated.findings, evaluations: evaluated.evaluations, ledger };
}

/** The findings the lowest minimum would report that the run does not, counted by confidence. */
function withheldOf(
  reported: readonly CompletedFinding[],
  shown: readonly CompletedFinding[],
): Withheld {
  const kept = new Set(reported.map(findingKey));
  const counts = { certain: 0, probable: 0, possible: 0 };
  for (const finding of shown) {
    if (!kept.has(findingKey(finding))) {
      counts[finding.confidence] += 1;
    }
  }
  return counts;
}

/** A finding's identity across two decisions of one run: its position, code and subject. */
function findingKey(finding: CompletedFinding): string {
  const { path, line, column } = finding.position;
  return JSON.stringify([path, line, column, finding.code, finding.symbol.ref]);
}

/** Every finding the run reports, each family's in table order. */
export function findingsOf(input: EmitterInput): readonly CompletedFinding[] {
  return decidedFindings(input).findings;
}
