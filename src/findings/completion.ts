/**
 * What every finding carries beyond what its emitter decides, read from the run and from
 * the code's row of the issue-kind vocabulary, and the dials that withhold a finding
 * together with every finding that falls with a root they withhold.
 */

import type { RunSweep } from "../analysis.ts";
import { componentId, type Component } from "../components.ts";
import type { Cascade, Confidence, Severity } from "../config.ts";
import type { CompletedFinding, Finding, FindingComponent, PositionedSymbol } from "../finding.ts";
import { OUTSIDE } from "../graph.ts";
import { KINDS, type KindRow } from "../kinds.ts";
import { byPosition } from "../position.ts";
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

/** The kind whose default turns on what the run knows about the target's consumers. */
const UNUSED_EXPORTED = "DS1001";

/** Whether the run loaded every consumer the scope declared, which holds of a scope declaring none. */
function everyDeclaredLoaded(boundary: Boundary): boolean {
  const { declared, loaded } = boundary.consumers;
  return declared.every((id) => loaded.includes(id));
}

/**
 * Whether a library's published API may have a caller the run cannot see: the target is
 * a library, and the run either holds no consumer information or did not load a consumer
 * the scope declared. A configuration declaring the consumer set complete holds consumer
 * information whether or not it declares a consumer, because it says no other exists.
 */
function openWorld(input: EmitterInput): boolean {
  const known = input.config.consumersComplete || input.boundary.consumers.declared.length > 0;
  return input.config.targetKind === "library" && !(known && everyDeclaredLoaded(input.boundary));
}

/**
 * The severity the configuration gives one code: the key naming the code, else the key
 * naming its family, else the code's default. The unused-exported kind defaults to
 * `allow` while a library's published API is open to callers the run cannot see.
 */
function severityOf(input: EmitterInput, code: string, fallback: Severity): Severity {
  const { config } = input;
  const named = config.severity.get(code) ?? config.severity.get(code.slice(0, FAMILY_KEY_LENGTH));
  if (named !== undefined) {
    return named;
  }
  return code === UNUSED_EXPORTED && openWorld(input) ? "allow" : fallback;
}

/**
 * The reachability class of one declaration of the run. A declaration of a library's
 * published API has callers outside the target: it is `certain` where the run loaded
 * every consumer the scope declared and declared at least one, `probable` where it
 * declared consumers and did not load them all, and `possible` where it declared none.
 * Whether the configuration declares the consumer set complete decides nothing here.
 * Every other declaration has every reference in the loaded program, a private member
 * and a `#private` name among them, and is `certain`.
 */
function reachabilityClasses(input: EmitterInput): (id: string) => Confidence {
  const union = input.swept.matrix.union;
  const published = new Set(
    union.rooted
      .filter((root) => root.kind === "published-api")
      .map((root) => union.symbols[root.at]?.id),
  );
  const { declared } = input.boundary.consumers;
  const outside: Confidence =
    declared.length === 0
      ? "possible"
      : everyDeclaredLoaded(input.boundary)
        ? "certain"
        : "probable";
  return (id) => (published.has(id) ? outside : "certain");
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
 * candidate's relation, counts, configurations and component; a live one carries no
 * relation and holds where it is declared; a file or a manifest row is `certain` and
 * holds in every configuration. A subject in no dead component gets one of its own,
 * numbered past the computed ones in finding order, so no two families mint one; nothing
 * falls with it, so its deletion removes no line. `kinds` is the vocabulary each code's
 * row is read from, the shipped one unless a caller supplies its own.
 */
export function completed(
  input: EmitterInput,
  findings: readonly Finding[],
  kinds: ReadonlyMap<string, KindRow> = KINDS,
): readonly CompletedFinding[] {
  const { swept } = input;
  const union = swept.matrix.union;
  const positions = new Map(union.symbols.map((symbol, at) => [symbol.ref, at]));
  const candidates = new Map(swept.sweep.candidates.map((candidate) => [candidate.id, candidate]));
  const classOf = reachabilityClasses(input);
  const componentOf = findingComponents(swept, input.config.reporters.cascade);
  let minted = swept.sweep.components.length;

  return findings.map((finding): CompletedFinding => {
    const row = kinds.get(finding.code);
    if (row === undefined) {
      throw new Error(`${finding.code} names no live row of the issue-kind vocabulary`);
    }
    // A row's reference may spell a declaration's, as an ignore entry naming one does, and
    // a row is still never the declaration.
    const at = isRowSubject(finding.symbol.kind)
      ? OUTSIDE
      : (positions.get(finding.symbol.ref) ?? OUTSIDE);
    // A part names the declaration that holds it, and is decided inside it rather than by
    // the declaration's liveness, so it carries none of the declaration's sweep facts.
    const part = isPartSubject(finding.symbol.kind);
    const symbol = union.symbols[at];
    const judged = !part && union.subject[at] === true ? symbol : undefined;
    const candidate = judged === undefined ? undefined : candidates.get(judged.id);
    const found = symbol === undefined || part ? undefined : componentOf(symbol.id);
    // A test file's declaration is a component member only as a test of dead code.
    if (candidate !== undefined && found === undefined && union.test[at] !== true) {
      throw new Error(`${candidate.id} is judged dead and falls in no dead component`);
    }
    let component = found;
    if (component === undefined) {
      minted += 1;
      component = {
        id: componentId(minted),
        root: true,
        symbolCount: 1,
        deletableLines: 0,
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
        (judged === undefined && !part
          ? swept.matrix.configurations
          : (swept.matrix.heldIn[at] ?? swept.matrix.configurations)),
      consumersLoaded: input.boundary.consumers.loaded,
      fixability: row.fixability,
      severity: severityOf(input, finding.code, row.defaultSeverity),
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
