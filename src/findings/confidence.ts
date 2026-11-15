/**
 * The one confidence stage: what a finding claims, from the facts the run states about its
 * subject, applied in the order grammar/analysis/confidence.md gives. A finding's own
 * reachability class is capped by its kind's ceiling, then by the roots ceiling, then, for
 * a test of dead code, by the classes of what it tests; code only tests use lowers the
 * finding to `possible` on its own; and every finding of a dead component is then capped
 * by the lowest confidence among the component's root findings.
 */

import type { Confidence } from "../contract/contract.generated.ts";
import type { CompletedFinding } from "../finding.ts";
import type { EmitterInput } from "./emitter.ts";
import { capped } from "./subjects.ts";

/** What the stage reads about one finding. */
interface ConfidenceFacts {
  /** The class the subject's evidence gives it: its reachability class, or its emitter's. */
  readonly own: Confidence;
  /** The ceiling of the finding's kind. */
  readonly kind: Confidence;
  /** The ceiling the roots the run found put on the subject. */
  readonly roots: Confidence;
  /** The ceiling of a test of dead code, `certain` for every other subject. */
  readonly tested: Confidence;
  /** Whether the subject is dead only because production code only tests use is. */
  readonly testUsed: boolean;
  /** Whether the subject is a test of dead code. */
  readonly testOfDeadCode: boolean;
}

/** What the stage answers about one finding before its component is read. */
interface Claimed {
  readonly reachabilityClass: Confidence;
  readonly confidence: Confidence;
  /**
   * Where test-used code alone lowers the confidence, the one the finding would carry
   * otherwise, which its component's cap and the dials read.
   */
  readonly componentConfidence?: Confidence;
}

/** The confidence one finding's facts give it. */
export function claimed(facts: ConfidenceFacts): Claimed {
  const untested = capped(capped(capped(facts.own, facts.kind), facts.roots), facts.tested);
  return {
    reachabilityClass: facts.testUsed && !facts.testOfDeadCode ? "possible" : facts.own,
    confidence: facts.testUsed ? "possible" : untested,
    ...(facts.testUsed ? { componentConfidence: untested } : {}),
  };
}

/**
 * The ceiling the roots the run found put on one dead subject: a subject other declarations
 * reference, found dead only because no root reaches them, is `probable` unless the
 * configuration declares the roots complete and no configuration holding the subject loads
 * a module the analysis cannot resolve, because a root the analysis cannot see would make
 * it live; every other declaration has none below `certain`.
 */
export function rootsCeiling(
  input: EmitterInput,
  reachedOnly: boolean,
  configurations: readonly string[],
): Confidence {
  const unseen = new Set((input.files.unseenLoads ?? []).map((load) => load.configuration));
  const complete = input.config.ts.roots_complete && !configurations.some((one) => unseen.has(one));
  return reachedOnly && !complete ? "probable" : "certain";
}

/** The confidence a finding gives its component's cap and the dials. */
export function componentConfidenceOf(finding: CompletedFinding): Confidence {
  return finding.componentConfidence ?? finding.confidence;
}

/**
 * The findings with every finding of a dead component capped by the lowest confidence
 * among the component's root members, so the minimum confidence reports or withholds a
 * component whole but for the findings test-used code lowers on their own.
 */
export function coherent(
  findings: readonly CompletedFinding[],
  dead: ReadonlySet<string>,
): readonly CompletedFinding[] {
  const lowest = new Map<string, Confidence>();
  for (const finding of findings) {
    const { id, root } = finding.component;
    if (root && dead.has(id)) {
      const held = lowest.get(id);
      const own = componentConfidenceOf(finding);
      lowest.set(id, held === undefined ? own : capped(held, own));
    }
  }
  return findings.map((finding) => {
    const cap = lowest.get(finding.component.id);
    if (cap === undefined) {
      return finding;
    }
    const own = finding.componentConfidence;
    return {
      ...finding,
      confidence: capped(finding.confidence, cap),
      ...(own === undefined ? {} : { componentConfidence: capped(own, cap) }),
    };
  });
}
