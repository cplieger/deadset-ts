/**
 * What a finding about a declaration carries beyond what its emitter decides, read from
 * the run: the reachability class and the confidence, the relation that decided the
 * subject, the dead component it falls in, the configurations it holds in, and the
 * severity the configuration gives its code. The dials withhold what they name and
 * every finding that falls with a root they withhold.
 */

import type { RunSweep } from "../analysis.ts";
import { componentId, type Component } from "../components.ts";
import type { Confidence, Config, Severity } from "../config.ts";
import type { Finding } from "../finding.ts";
import { FAMILY_KEY_LENGTH } from "../resolve.ts";
import type { Relation } from "../sweep.ts";

/** The dead component a finding names, as the finding schema spells its members. */
export interface FindingComponent {
  readonly id: string;
  /** Whether the subject is a root member of the component. */
  readonly root: boolean;
  /** The number of the component's members. */
  readonly symbolCount: number;
  readonly deletableLines: number;
}

/** One finding with the members the run decides, in this language's case. */
export interface CompletedFinding extends Finding {
  readonly reachabilityClass: Confidence;
  /** The reachability class capped by the code's ceiling. */
  readonly confidence: Confidence;
  /** The relation that decided the subject, absent where none did. */
  readonly livenessRelation?: Relation;
  /** Whether every reference to the subject comes from a test file. */
  readonly testOnly: boolean;
  readonly component: FindingComponent;
  /** The configurations the finding holds in, in the run's order. */
  readonly configurations: readonly string[];
  readonly severity: Severity;
  /** The per-code members of the finding schema's `details`, empty for a code with none. */
  readonly details: Readonly<Record<string, unknown>>;
}

/** The classes ranked by the claim each makes, the strongest highest. */
export const RANK: Readonly<Record<Confidence, number>> = { certain: 3, probable: 2, possible: 1 };

/** The weaker of two classes, which is a class capped by a ceiling. */
export function capped(found: Confidence, ceiling: Confidence): Confidence {
  return RANK[found] <= RANK[ceiling] ? found : ceiling;
}

/**
 * The severity the configuration gives one code: the key naming the code, else the key
 * naming its family, else the code's default.
 */
export function severityOf(config: Config, code: string, fallback: Severity): Severity {
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
export function reachabilityClasses(swept: RunSweep): (id: string) => Confidence {
  const union = swept.matrix.union;
  const published = new Set(
    union.rooted
      .filter((root) => root.kind === "published-api")
      .map((root) => union.symbols[root.at]?.id),
  );
  return (id) => (published.has(id) ? "possible" : "certain");
}

/** The component each dead declaration of the run falls in, and none for a live one. */
export function findingComponents(swept: RunSweep): (id: string) => FindingComponent | undefined {
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

/** One finding with the component it names. */
export type PlacedFinding = Finding & { readonly component: FindingComponent };

/**
 * Every finding of the run, each with its component, in the order given: the dead
 * component its subject falls in. A subject in none, a live declaration, a file no
 * program builds or a manifest row, falls with nothing and is given a component of its
 * own, numbered past the run's computed components in the order the findings come, so
 * no two families mint one identifier.
 */
export function placed(swept: RunSweep, findings: readonly Finding[]): readonly PlacedFinding[] {
  const componentOf = findingComponents(swept);
  const ids = new Map(swept.matrix.union.symbols.map((symbol) => [symbol.ref, symbol.id]));
  let minted = swept.sweep.components.length;
  return findings.map((finding) => {
    const id = ids.get(finding.symbol.ref);
    const component = id === undefined ? undefined : componentOf(id);
    if (component !== undefined) {
      return { ...finding, component };
    }
    minted += 1;
    return {
      ...finding,
      component: {
        id: componentId(minted),
        root: true,
        symbolCount: 1,
        deletableLines: finding.symbol.sizeLines,
      },
    };
  });
}

/**
 * The findings no dial withholds. A finding at `allow` or below the minimum confidence
 * is withheld, and so is every finding of the component of a root the dials withhold,
 * because a symbol that falls with a root is dead only through it and its deletion
 * does not compile while the root stays. A withheld finding that is no root withholds
 * itself alone.
 */
export function reportable(
  findings: readonly CompletedFinding[],
  minConfidence: Confidence,
): readonly CompletedFinding[] {
  const dialed = (finding: CompletedFinding): boolean =>
    finding.severity === "allow" || RANK[finding.confidence] < RANK[minConfidence];
  const components = new Set(
    findings
      .filter((finding) => finding.component.root && dialed(finding))
      .map((finding) => finding.component.id),
  );
  return findings.filter((finding) => !dialed(finding) && !components.has(finding.component.id));
}
