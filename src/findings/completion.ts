/**
 * What every finding carries beyond what its emitter decides, read from the run and from
 * the code's row of the issue-kind vocabulary, and the dials that withhold a finding
 * together with every finding that falls with a root they withhold.
 */

import type { RunSweep } from "../analysis.ts";
import { componentId, type Component } from "../components.ts";
import type { Cascade, Confidence, Severity } from "../config.ts";
import type { CompletedFinding, Finding, FindingComponent, PositionedSymbol } from "../finding.ts";
import { OUTSIDE, type Graph } from "../graph.ts";
import { KINDS, type KindRow } from "../kinds.ts";
import { byPosition, positionKey } from "../position.ts";
import { declarationKey } from "../ref.ts";
import { FAMILY_KEY_LENGTH } from "../resolve.ts";
import { isPartSubject, isRowSubject, type Dials } from "../suppress.ts";
import type { Boundary } from "./boundary.ts";
import type { EmitterInput } from "./emitter.ts";

/** The classes ranked by the claim each makes, the strongest highest. */
const RANK: Readonly<Record<Confidence, number>> = { certain: 3, probable: 2, possible: 1 };

/** The weaker of two classes, which is a class capped by a ceiling. */
function capped(found: Confidence, ceiling: Confidence): Confidence {
  return RANK[found] <= RANK[ceiling] ? found : ceiling;
}

/** Whether the run loaded every consumer the scope declared, which holds of a scope declaring none. */
function everyDeclaredLoaded(boundary: Boundary): boolean {
  const { declared, loaded } = boundary.consumers;
  return declared.every((id) => loaded.includes(id));
}

/**
 * The severity the configuration gives one code: the key naming the code, else the key
 * naming its family, else the code's default.
 */
function severityOf(input: EmitterInput, code: string, fallback: Severity): Severity {
  const { config } = input;
  return (
    config.severity.get(code) ?? config.severity.get(code.slice(0, FAMILY_KEY_LENGTH)) ?? fallback
  );
}

/**
 * The declarations the roots name as a library's published API, each public member of a
 * published type included.
 */
function publishedIds(union: Graph): ReadonlySet<string> {
  return new Set(
    union.rooted
      .filter((root) => root.kind === "published-api")
      .flatMap((root) => union.symbols[root.at]?.id ?? []),
  );
}

/**
 * The reachability class of one declaration of the run. A declaration of a library's
 * published API, a public member of a published type included, is `certain` where the
 * run loaded every consumer the scope declared and declared one, `probable` where one did
 * not load, and `possible` where it declared none, whatever the configuration says of the
 * consumer set. A declaration of test-support code that test code references, outside the
 * test-of-dead-code rule, is `possible`. Every other declaration is `certain`.
 */
function reachabilityClasses(input: EmitterInput): (id: string) => Confidence {
  const published = publishedIds(input.swept.matrix.union);
  const usedByTests = new Set(
    input.swept.sweep.candidates
      .filter((candidate) => candidate.heldByTests === candidate.id)
      .map((candidate) => candidate.id),
  );
  const { declared } = input.boundary.consumers;
  const outside: Confidence =
    declared.length === 0
      ? "possible"
      : everyDeclaredLoaded(input.boundary)
        ? "certain"
        : "probable";
  return (id) => {
    if (usedByTests.has(id)) {
      return "possible";
    }
    return published.has(id) ? outside : "certain";
  };
}

/**
 * The component each dead declaration of the run falls in, and none for a live one, with
 * its members listed in the canonical order where the run lists a component in full.
 */
function findingComponents(
  swept: RunSweep,
  cascade: Cascade,
): (id: string) => FindingComponent | undefined {
  const held = new Map<string, Component>();
  for (const component of swept.sweep.components) {
    for (const member of component.members) {
      held.set(member, component);
    }
  }
  const symbols = new Map(swept.matrix.union.symbols.map((symbol) => [symbol.id, symbol]));
  const listed = (component: Component): readonly PositionedSymbol[] =>
    component.members
      .flatMap((member) => {
        const symbol = symbols.get(member);
        return symbol === undefined
          ? []
          : [
              {
                ref: symbol.ref,
                name: symbol.name,
                position: {
                  ...symbol.position,
                  endLine: Math.max(symbol.position.line, symbol.endLine),
                },
              },
            ];
      })
      .sort(
        (a, b) =>
          byPosition(a.position, b.position) || (a.ref === b.ref ? 0 : a.ref < b.ref ? -1 : 1),
      );
  return (id) => {
    const component = held.get(id);
    return component === undefined
      ? undefined
      : {
          id: component.id,
          root: component.roots.includes(id),
          symbolCount: component.members.length,
          deletableLines: component.deletableLines,
          ...(cascade === "full" ? { members: listed(component) } : {}),
        };
  };
}

/**
 * Every finding of the run completed, in the order given. A dead declaration carries its
 * candidate's relation, counts, configurations and component; a live one carries no relation and
 * holds where it is declared; a file or a manifest row carries the class its emitter states,
 * `certain` by default, and holds in every configuration. A subject in no dead component gets one
 * of its own, numbered past the computed ones in finding order so no two families mint one, whose
 * deletion removes no line. `kinds` defaults to the shipped vocabulary.
 */
export function completed(
  input: EmitterInput,
  findings: readonly Finding[],
  kinds: ReadonlyMap<string, KindRow> = KINDS,
): readonly CompletedFinding[] {
  const { swept } = input;
  const union = swept.matrix.union;
  const positions = new Map(
    union.symbols.map((symbol, at) => [declarationKey(symbol.ref, symbol.position.path), at]),
  );
  const candidates = new Map(swept.sweep.candidates.map((candidate) => [candidate.id, candidate]));
  const classOf = reachabilityClasses(input);
  const componentOf = findingComponents(swept, input.config.reporters.cascade);
  let minted = swept.sweep.components.length;
  const dead = new Set(swept.sweep.components.map((component) => component.id));
  const fallingWith = new Map<string, number>();
  for (const { heldByTests } of swept.sweep.candidates) {
    if (heldByTests !== undefined) {
      fallingWith.set(heldByTests, (fallingWith.get(heldByTests) ?? 0) + 1);
    }
  }

  const done = findings.map((finding): CompletedFinding => {
    const row = kinds.get(finding.code);
    if (row === undefined) {
      throw new Error(`${finding.code} names no live row of the issue-kind vocabulary`);
    }
    // A row's reference may spell a declaration's, as an ignore entry naming one does, and
    // a row is still never the declaration. Two declarations of one file can share a
    // reference, so the one the finding is positioned at is the subject where there is one.
    const declared = union.at(positionKey(finding.position));
    const at = isRowSubject(finding.symbol.kind)
      ? OUTSIDE
      : union.symbols[declared]?.ref === finding.symbol.ref
        ? declared
        : (positions.get(declarationKey(finding.symbol.ref, finding.position.path)) ?? OUTSIDE);
    // A part names the declaration that holds it, and is decided inside it rather than by
    // the declaration's liveness, so it carries none of the declaration's sweep facts.
    const part = isPartSubject(finding.symbol.kind);
    const symbol = union.symbols[at];
    const judged = !part && union.subject[at] === true ? symbol : undefined;
    const candidate = judged === undefined ? undefined : candidates.get(judged.id);
    const found = symbol === undefined || part ? undefined : componentOf(symbol.id);
    // A test file's declaration is a component member only as a test of dead code, and
    // test code keeps the test-support code it references out of every component.
    if (
      candidate !== undefined &&
      found === undefined &&
      union.test[at] !== true &&
      candidate.heldByTests === undefined
    ) {
      throw new Error(`${candidate.id} is judged dead and falls in no dead component`);
    }
    let component = found;
    if (component === undefined) {
      minted += 1;
      component = {
        id: componentId(minted),
        root: true,
        symbolCount: symbol?.kind === "interface" ? (fallingWith.get(symbol.id) ?? 1) : 1,
        deletableLines: 0,
      };
    }
    const counts =
      candidate === undefined
        ? union.made[at]
        : { production: candidate.productionRefs, test: candidate.testRefs };
    const reachabilityClass =
      judged === undefined ? (finding.reachabilityClass ?? "certain") : classOf(judged.id);
    const generated = input.files.generated?.has(finding.position.path) === true;
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
      generated,
      component,
      retainedBy: [],
      configurations:
        candidate?.configurations ??
        (judged === undefined && !part
          ? swept.matrix.configurations
          : (swept.matrix.heldIn[at] ?? swept.matrix.configurations)),
      consumersLoaded: input.boundary.consumers.loaded,
      fixability: generated ? "none" : row.fixability,
      severity: severityOf(input, finding.code, row.defaultSeverity),
      message: finding.message,
      details: finding.details ?? {},
    };
  });
  return componentCapped(done, dead);
}

/**
 * The findings with every finding of a dead component capped by the lowest confidence
 * among the component's root members, so the minimum confidence reports or withholds a
 * component whole.
 */
function componentCapped(
  findings: readonly CompletedFinding[],
  dead: ReadonlySet<string>,
): readonly CompletedFinding[] {
  const lowest = new Map<string, Confidence>();
  for (const finding of findings) {
    const { id, root } = finding.component;
    if (root && dead.has(id)) {
      const held = lowest.get(id);
      lowest.set(id, held === undefined ? finding.confidence : capped(held, finding.confidence));
    }
  }
  return findings.map((finding) => {
    const cap = lowest.get(finding.component.id);
    return cap === undefined || RANK[cap] >= RANK[finding.confidence]
      ? finding
      : { ...finding, confidence: cap };
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
  const classOf = reachabilityClasses(input);
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
            severity: severityOf(input, code, row.defaultSeverity),
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
