/**
 * Which declarations of one graph are dead, under which liveness relation, and which
 * dead component each belongs to. Reference counting holds a declaration live when any
 * declaration references it, whatever that one's own liveness, and no root plays a part;
 * reachability holds it live when a path of references reaches it from a root. So a
 * declaration only unreachable ones reference is live under the first, dead under the second.
 */

import { componentsOf, type Component } from "./components.ts";
import { namesACaller, OUTSIDE, type Graph } from "./graph.ts";

/** The liveness relation that decided a declaration, as a finding spells it. */
export type Relation = "reference-counting" | "reachability";

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

/** One sweep's answer. */
export interface SweepResult {
  /**
   * Per declaration, the relations that hold it live, reference counting first. A
   * declaration neither holds live has no entry.
   */
  readonly liveUnder: ReadonlyMap<string, readonly Relation[]>;
  /** The dead declarations, in the order the inventory holds them. */
  readonly candidates: readonly Candidate[];
  /** The dead components, each before every component it reaches. */
  readonly components: readonly Component[];
}

/**
 * Answers which declarations of one graph are dead under the input's mode.
 *
 * The order is the order the answers depend on: the callers and the marks are live
 * before either relation runs, the candidate set is every judged declaration at least
 * one relation does not hold live, the tests of dead code join it, and the components
 * are computed over the set that results.
 */
export function sweep(graph: Graph, input: SweepInput): SweepResult {
  const marked = graph.symbols.map(() => false);
  for (const id of input.marked) {
    const at = graph.at(id);
    if (at !== OUTSIDE) {
      marked[at] = true;
    }
  }
  // Every root and every mark seeds reachability. A root of a kind that names a caller,
  // and a mark, are live under reference counting as well; a root that only supposes a
  // caller is not.
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
  const reached = reachable(graph, marked, input.mode);
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
    (_symbol, at) => graph.subject[at] === true && (liveUnder[at]?.length ?? 0) < 2,
  );
  const testOfDeadCode = admitTestsOfDeadCode(graph, dead, marked);

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

  return {
    liveUnder: live,
    candidates,
    components: componentsOf(graph, dead, testOfDeadCode),
  };
}

/**
 * Per declaration, whether a seed reaches it. The two seeds reach through different
 * reference sets: a marked declaration is live by a mechanism the analysis cannot see, so
 * no mode withholds a reference it makes, while a root reaches through the references the
 * mode counts. The marks run first, so what they reach is expanded under the wider rule.
 */
function reachable(graph: Graph, marked: readonly boolean[], mode: Mode): readonly boolean[] {
  const reached = graph.symbols.map(() => false);
  const expanded = graph.symbols.map(() => false);
  const queue: number[] = [];

  // A reference to a file is a reference to the module's namespace, which reaches what
  // the module exports as well as its top level. A root does not expand: a file a
  // runtime runs without reading its exports is a root by itself.
  const enter = (at: number, viaReference: boolean): void => {
    if (!reached[at]) {
      reached[at] = true;
      queue.push(at);
    }
    if (!viaReference || expanded[at] === true) {
      return;
    }
    expanded[at] = true;
    for (const exported of graph.exportsOf[at] ?? []) {
      enter(exported, false);
    }
  };
  const walk = (held: boolean): void => {
    for (let at = queue.pop(); at !== undefined; at = queue.pop()) {
      for (const edge of graph.out[at] ?? []) {
        if (!held && mode.production && edge.test) {
          continue;
        }
        enter(edge.to, true);
      }
    }
  };

  marked.forEach((mark, at) => {
    if (mark) {
      enter(at, false);
    }
  });
  walk(true);
  for (const root of graph.rooted) {
    enter(root.at, false);
  }
  walk(false);
  return reached;
}

/**
 * Admits every test declaration whose set of referenced production declarations is
 * non-empty and wholly dead, and returns which it admitted. The set is read from every
 * reference the test makes, not the ones the mode counts: a production sweep counts none,
 * which is what makes the targets dead. A test referencing one live target is never admitted.
 */
function admitTestsOfDeadCode(
  graph: Graph,
  dead: boolean[],
  marked: readonly boolean[],
): readonly boolean[] {
  const admitted = graph.symbols.map(() => false);
  graph.symbols.forEach((_symbol, at) => {
    if (graph.test[at] !== true || graph.subject[at] !== true || marked[at] === true) {
      return;
    }
    let targets = 0;
    let live = 0;
    for (const edge of graph.out[at] ?? []) {
      if (graph.test[edge.to] === true || graph.subject[edge.to] !== true) {
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
