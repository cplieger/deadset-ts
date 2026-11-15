/**
 * The configuration's two dials over a run's completed findings: the severity it gives a
 * code and the minimum confidence. Each decides whether the run reports a finding rather
 * than whether one exists, and a dial that withholds a root finding withholds its
 * component with it.
 */

import {
  FAMILY_KEY_LENGTH,
  type Confidence,
  type Severity,
} from "../contract/contract.generated.ts";
import type { CompletedFinding } from "../finding.ts";
import { KINDS } from "../kinds.ts";
import type { Dials } from "../suppression/ledger.ts";
import { componentConfidenceOf } from "./confidence.ts";
import type { EmitterInput } from "./emitter.ts";
import { RANK } from "./subjects.ts";

/** How many findings the minimum confidence withheld at each confidence. */
export type Withheld = Readonly<Record<Confidence, number>>;

/**
 * The severity the configuration gives one code: the key naming the code, else the key
 * naming its family, else the code's default.
 */
export function severityOf(input: EmitterInput, code: string, fallback: Severity): Severity {
  const { severity } = input.config;
  const key = [code, code.slice(0, FAMILY_KEY_LENGTH)].find((one) => Object.hasOwn(severity, one));
  return key === undefined ? fallback : (severity[key] ?? fallback);
}

/** Whether the dials withhold a finding by its own severity or confidence. */
function dialed(
  finding: Pick<CompletedFinding, "severity" | "confidence">,
  minConfidence: Confidence,
): boolean {
  return finding.severity === "allow" || RANK[finding.confidence] < RANK[minConfidence];
}

/**
 * The configuration's dials over one run's completed findings. A finding at `allow` or
 * below the minimum confidence is withheld, and so is every finding of the component of a
 * root the dials withhold, because a symbol that falls with a root is dead only through it
 * and its deletion does not compile while the root stays. A withheld finding that is no
 * root withholds itself alone.
 */
function dialsOf(
  input: EmitterInput,
  findings: readonly CompletedFinding[],
): Dials<CompletedFinding> {
  const minConfidence = input.config.analysis.min_confidence;
  const components = new Set(
    findings
      .filter(
        (finding) =>
          finding.component.root &&
          dialed({ ...finding, confidence: componentConfidenceOf(finding) }, minConfidence),
      )
      .map((finding) => finding.component.id),
  );
  return {
    allows: (code) => {
      const row = KINDS.get(code);
      return row !== undefined && severityOf(input, code, row.defaultSeverity) === "allow";
    },
    withholds: (finding) => dialed(finding, minConfidence) || components.has(finding.component.id),
  };
}

/**
 * The dials over the findings a record could name, each read against the sweep that
 * produced it, so a component one sweep numbers withholds nothing of the other's.
 */
export function dialsOver(
  marked: { readonly input: EmitterInput; readonly found: readonly CompletedFinding[] },
  unmarked: { readonly input: EmitterInput; readonly found: readonly CompletedFinding[] },
): Dials<CompletedFinding> {
  const own = dialsOf(marked.input, marked.found);
  const before = dialsOf(unmarked.input, unmarked.found);
  const fromUnmarked = new Set(unmarked.found);
  return {
    allows: own.allows,
    withholds: (finding) =>
      fromUnmarked.has(finding) ? before.withholds(finding) : own.withholds(finding),
  };
}

/** The findings of one run's completed findings that no dial withholds, in the order given. */
export function reportable(
  input: EmitterInput,
  findings: readonly CompletedFinding[],
): readonly CompletedFinding[] {
  const dials = dialsOf(input, findings);
  return findings.filter((finding) => !dials.withholds(finding));
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
 * The findings the dials withhold only because their confidence is below the minimum, each
 * counted at the confidence this run gives it: the dials at the lowest minimum keep them.
 */
export function withheldOf(input: EmitterInput, candidates: readonly CompletedFinding[]): Withheld {
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
