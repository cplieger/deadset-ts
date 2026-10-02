/**
 * What every finding carries beyond what its emitter decides, read from the run and from
 * the code's row of the issue-kind vocabulary, and the dials that withhold a finding
 * together with every finding that falls with a root they withhold.
 */

import type { RunSweep } from "../analysis.ts";
import { componentId, type Component } from "../components.ts";
import type { Confidence, Config, Severity } from "../config.ts";
import type { CompletedFinding, Finding, FindingComponent } from "../finding.ts";
import { OUTSIDE } from "../graph.ts";
import { KINDS } from "../kinds.ts";
import { FAMILY_KEY_LENGTH } from "../resolve.ts";
import type { Dials } from "../suppress.ts";
import type { EmitterInput } from "./emitter.ts";

/** The classes ranked by the claim each makes, the strongest highest. */
const RANK: Readonly<Record<Confidence, number>> = { certain: 3, probable: 2, possible: 1 };

/** The weaker of two classes, which is a class capped by a ceiling. */
function capped(found: Confidence, ceiling: Confidence): Confidence {
  return RANK[found] <= RANK[ceiling] ? found : ceiling;
}

/**
 * The severity the configuration gives one code: the key naming the code, else the key
 * naming its family, else the code's default.
 */
function severityOf(config: Config, code: string, fallback: Severity): Severity {
  return (
    config.severity.get(code) ?? config.severity.get(code.slice(0, FAMILY_KEY_LENGTH)) ?? fallback
  );
}

/**
 * The reachability class of one declaration of the run. A declaration of a library's
 * published API has callers outside the target, and the run loads no consumer that
 * would name them, so it is `possible`; every other declaration has every reference
 * in the loaded program, a private member and a `#private` name among them, and is
 * `certain`.
 */
function reachabilityClasses(swept: RunSweep): (id: string) => Confidence {
  const union = swept.matrix.union;
  const published = new Set(
    union.rooted
      .filter((root) => root.kind === "published-api")
      .map((root) => union.symbols[root.at]?.id),
  );
  return (id) => (published.has(id) ? "possible" : "certain");
}

/** The component each dead declaration of the run falls in, and none for a live one. */
function findingComponents(swept: RunSweep): (id: string) => FindingComponent | undefined {
  const held = new Map<string, Component>();
  for (const component of swept.sweep.components) {
    for (const member of component.members) {
      held.set(member, component);
    }
  }
  return (id) => {
    const component = held.get(id);
    return component === undefined
      ? undefined
      : {
          id: component.id,
          root: component.roots.includes(id),
          symbolCount: component.members.length,
          deletableLines: component.deletableLines,
        };
  };
}

/**
 * Every finding of the run completed, in the order given. A dead declaration carries its
 * candidate's relation, counts, configurations and component; a live one carries no
 * relation and holds where it is declared; a file or a manifest row is `certain` and
 * holds in every configuration. A subject in no dead component gets one of its own,
 * numbered past the computed ones in finding order, so no two families mint one.
 */
export function completed(
  input: EmitterInput,
  findings: readonly Finding[],
): readonly CompletedFinding[] {
  const { swept } = input;
  const union = swept.matrix.union;
  const positions = new Map(union.symbols.map((symbol, at) => [symbol.ref, at]));
  const candidates = new Map(swept.sweep.candidates.map((candidate) => [candidate.id, candidate]));
  const classOf = reachabilityClasses(swept);
  const componentOf = findingComponents(swept);
  let minted = swept.sweep.components.length;

  return findings.map((finding): CompletedFinding => {
    const row = KINDS.get(finding.code);
    if (row === undefined) {
      throw new Error(`${finding.code} names no live row of the issue-kind vocabulary`);
    }
    const at = positions.get(finding.symbol.ref) ?? OUTSIDE;
    const symbol = union.symbols[at];
    const judged = union.subject[at] === true ? symbol : undefined;
    const candidate = judged === undefined ? undefined : candidates.get(judged.id);
    const found = symbol === undefined ? undefined : componentOf(symbol.id);
    if (candidate !== undefined && found === undefined) {
      throw new Error(`${candidate.id} is judged dead and falls in no dead component`);
    }
    let component = found;
    if (component === undefined) {
      minted += 1;
      component = {
        id: componentId(minted),
        root: true,
        symbolCount: 1,
        deletableLines: finding.symbol.sizeLines,
      };
    }
    const counts =
      candidate === undefined
        ? union.made[at]
        : { production: candidate.productionRefs, test: candidate.testRefs };
    const reachabilityClass = judged === undefined ? "certain" : classOf(judged.id);
    return {
      code: finding.code,
      kind: row.name,
      language: "ts",
      position: finding.position,
      symbol: finding.symbol,
      reachabilityClass,
      confidence: capped(reachabilityClass, row.maxClass),
      ...(candidate === undefined ? {} : { livenessRelation: candidate.relation }),
      testOnly: judged !== undefined && counts?.production === 0 && counts.test > 0,
      generated: false,
      component,
      retainedBy: [],
      configurations:
        candidate?.configurations ??
        (judged === undefined ? swept.matrix.configurations : (swept.matrix.heldIn[at] ?? [])),
      consumersLoaded: input.boundary.consumers.loaded,
      fixability: row.fixability,
      severity: severityOf(input.config, finding.code, row.defaultSeverity),
      message: finding.message,
      details: finding.details ?? {},
    };
  });
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
 * root withholds itself alone. A code is withheld from a declaration when the finding it
 * would report there, completed, is withheld by its own severity or confidence.
 */
export function dialsOf(
  input: EmitterInput,
  findings: readonly CompletedFinding[],
): Dials<CompletedFinding> {
  const minConfidence = input.config.analysis.minConfidence;
  const classOf = reachabilityClasses(input.swept);
  const components = new Set(
    findings
      .filter((finding) => finding.component.root && dialed(finding, minConfidence))
      .map((finding) => finding.component.id),
  );
  return {
    withholdsCode: (code, id) => {
      const row = KINDS.get(code);
      return (
        row !== undefined &&
        dialed(
          {
            severity: severityOf(input.config, code, row.defaultSeverity),
            confidence: capped(classOf(id), row.maxClass),
          },
          minConfidence,
        )
      );
    },
    withholds: (finding) => dialed(finding, minConfidence) || components.has(finding.component.id),
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
