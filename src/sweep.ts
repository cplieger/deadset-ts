/**
 * Which declarations of one graph are dead, and under which liveness relation.
 * Reference counting holds a declaration live when any declaration references it,
 * whatever that one's own liveness, or when it is a root of a kind that names a caller;
 * reachability holds it live when a path of references reaches it from a root. So a
 * declaration only unreachable ones reference is live under the first, dead under the second.
 */

import type { TSExemptionClass } from "./exempt-classes.ts";
import { namesACaller, OUTSIDE, type Edge, type Graph } from "./graph.ts";
import type { Position } from "./position.ts";

/** The liveness relation that decided a declaration, as a finding spells it. */
export type Relation = "reference-counting" | "reachability";

/** One declaration an exemption class holds back, and the evidence it was found by. */
export interface Exemption {
  /** The identifier of the declaration held back. */
  readonly id: string;
  readonly class: TSExemptionClass;
  /** One clause naming the relation, then the thing it relates to: `passed to JSON.stringify`. */
  readonly detail: string;
  /** Where the evidence is written. */
  readonly site: Position;
}

/**
 * The run's reference mode, decided once by the composition and read by every stage
 * that counts references.
 */
export interface Mode {
  /**
   * Counts no reference a test file made, under either relation. Every reference a root
   * in a test file makes is such a reference, so nothing only a test reaches is live.
   */
  readonly production: boolean;
}

/** What one sweep runs over besides the graph. */
export interface SweepInput {
  /**
   * The declarations a matched suppression names. A mark holds its declaration live
   * under both relations and seeds reachability through every reference it makes, so
   * nothing only a marked declaration references is dead.
   */
  readonly marked: readonly string[];
  /**
   * The exemptions the run computed. An exempt declaration is never a candidate, and it
   * seeds reachability as a mark does, so nothing it references is dead; it is live
   * under reference counting only where something references it. Absent, the sweep
   * holds nothing back.
   */
  readonly exempt?: readonly Exemption[];
  /**
   * The declarations a question the checker did not answer could have kept live. Each
   * is held as an exempt declaration is. Absent, the sweep holds nothing back for one.
   */
  readonly unanswered?: readonly string[];
  readonly mode: Mode;
}

/** One dead declaration, the relation that found it, and the counts a kind reads. */
export interface Candidate {
  readonly id: string;
  /** The references a production file made to the declaration, whatever the mode counts. */
  readonly productionRefs: number;
  /** The references a test file made to it. */
  readonly testRefs: number;
  /**
   * Reference counting where the mode counts no reference to the declaration, and
   * reachability otherwise, so a declaration dead under both carries the stronger claim.
   */
  readonly relation: Relation;
  /**
   * Whether the test-of-dead-code rule admitted the declaration: a test declaration whose
   * set of referenced production declarations is non-empty and wholly dead.
   */
  readonly testOfDeadCode: boolean;
}

/** One graph's answer: what each relation holds live, and what is dead. */
export interface Liveness {
  /**
   * Per declaration, the relations that hold it live, reference counting first. A
   * declaration neither holds live has no entry.
   */
  readonly liveUnder: ReadonlyMap<string, readonly Relation[]>;
  /** The dead declarations, in the order the inventory holds them. */
  readonly candidates: readonly Candidate[];
}

/**
 * Answers which declarations of one graph are dead under the input's mode.
 *
 * The order is the order the answers depend on: the callers and the marks are live
 * before either relation runs, the candidate set is every judged declaration at least
 * one relation does not hold live and no exemption holds back, and the tests of dead
 * code join it.
 */
export function sweep(graph: Graph, input: SweepInput): Liveness {
  const marked = flagged(graph, input.marked);
  const exempt = flagged(graph, [
    ...(input.exempt ?? []).map((record) => record.id),
    ...(input.unanswered ?? []),
  ]);
  const held = marked.map((mark, at) => mark || exempt[at] === true);
  // Every root, every mark and every exemption seeds reachability. A root of a kind that
  // names a caller, and a mark, are live under reference counting as well; a root that
  // only supposes a caller is not, and neither is an exemption.
  const called = graph.symbols.map(() => false);
  for (const root of graph.rooted) {
    if (namesACaller(root.kind)) {
      called[root.at] = true;
    }
  }

  const counted = (at: number): number => {
    const made = graph.made[at];
    if (made === undefined) {
      return 0;
    }
    return input.mode.production ? made.production : made.production + made.test;
  };
  const reached = reachable(graph, held, input.mode);
  const liveUnder = graph.symbols.map((_symbol, at): readonly Relation[] => {
    const relations: Relation[] = [];
    if (marked[at] === true || called[at] === true || counted(at) > 0) {
      relations.push("reference-counting");
    }
    if (reached[at] === true) {
      relations.push("reachability");
    }
    return relations;
  });

  const dead = graph.symbols.map(
    (_symbol, at) =>
      graph.subject[at] === true && exempt[at] !== true && (liveUnder[at]?.length ?? 0) < 2,
  );
  const testOfDeadCode = admitTestsOfDeadCode(graph, dead, held);

  const candidates: Candidate[] = [];
  const live = new Map<string, readonly Relation[]>();
  graph.symbols.forEach((symbol, at) => {
    const relations = liveUnder[at] ?? [];
    if (relations.length > 0) {
      live.set(symbol.id, relations);
    }
    if (dead[at] !== true) {
      return;
    }
    candidates.push({
      id: symbol.id,
      productionRefs: graph.made[at]?.production ?? 0,
      testRefs: graph.made[at]?.test ?? 0,
      relation: counted(at) === 0 ? "reference-counting" : "reachability",
      testOfDeadCode: testOfDeadCode[at] === true,
    });
  });

  return { liveUnder: live, candidates };
}

/**
 * The references a loaded consumer makes that the mode counts. A production mode counts
 * none a consumer's test file made, as it counts none of the target's.
 */
function callsOf(graph: Graph, mode: Mode): readonly Edge[] {
  return graph.consumed.filter((edge) => !mode.production || !edge.test);
}

/** Per declaration of the graph, whether one of the identifiers names it. */
function flagged(graph: Graph, ids: readonly string[]): boolean[] {
  const flags = graph.symbols.map(() => false);
  for (const id of ids) {
    const at = graph.at(id);
    if (at !== OUTSIDE) {
      flags[at] = true;
    }
  }
  return flags;
}

/**
 * Per declaration, whether a seed reaches it. The two seeds reach through different
 * reference sets: a held declaration, marked or exempt, is live by a mechanism the
 * analysis cannot see, so no mode withholds a reference it makes, a test declaration's
 * included, while a root reaches through the references the mode counts. The held seed
 * runs first, so what it reaches is expanded under the wider rule.
 */
function reachable(graph: Graph, held: readonly boolean[], mode: Mode): readonly boolean[] {
  const reached = graph.symbols.map(() => false);
  const expanded = graph.symbols.map(() => false);
  const queue: number[] = [];

  // Reaching a file reaches its top level: the references written outside every
  // declaration it holds. A reference that reads a file reads the module's namespace,
  // which reaches what the module exports as well. An evaluation runs the top level
  // and reads no export, and a root does not expand either: a file a runtime runs
  // without reading its exports is a root by itself.
  const enter = (at: number, expands: boolean): void => {
    if (!reached[at]) {
      reached[at] = true;
      queue.push(at);
    }
    if (!expands || expanded[at] === true) {
      return;
    }
    expanded[at] = true;
    for (const exported of graph.exportsOf[at] ?? []) {
      enter(exported, false);
    }
  };
  const walk = (holding: boolean): void => {
    for (let at = queue.pop(); at !== undefined; at = queue.pop()) {
      for (const edge of graph.out[at] ?? []) {
        if (!holding && mode.production && edge.test) {
          continue;
        }
        enter(edge.to, !edge.evaluation);
      }
    }
  };

  held.forEach((hold, at) => {
    if (hold) {
      enter(at, false);
    }
  });
  walk(true);
  for (const root of graph.rooted) {
    enter(root.at, false);
  }
  // A consumer's reference reaches what it names as one of the target's own does.
  for (const edge of callsOf(graph, mode)) {
    enter(edge.to, !edge.evaluation);
  }
  walk(false);
  return reached;
}

/**
 * Admits every test declaration whose set of referenced production declarations is
 * non-empty and wholly dead, and returns which it admitted. The set is read from every
 * reference the test makes, not the ones the mode counts: a production sweep counts none,
 * which is what makes the targets dead. A test referencing one live target is never
 * admitted, and neither is a marked or exempt test.
 */
function admitTestsOfDeadCode(
  graph: Graph,
  dead: boolean[],
  held: readonly boolean[],
): readonly boolean[] {
  const admitted = graph.symbols.map(() => false);
  graph.symbols.forEach((_symbol, at) => {
    const testCode = graph.test[at] === true || graph.support[at] === true;
    if (!testCode || graph.subject[at] !== true || held[at] === true) {
      return;
    }
    let targets = 0;
    let live = 0;
    for (const edge of graph.out[at] ?? []) {
      const target = graph.test[edge.to] === true || graph.support[edge.to] === true;
      if (target || graph.subject[edge.to] !== true) {
        continue;
      }
      targets += 1;
      if (dead[edge.to] !== true) {
        live += 1;
      }
    }
    if (targets > 0 && live === 0) {
      dead[at] = true;
      admitted[at] = true;
    }
  });
  return admitted;
}
