/**
 * Which declarations of the run are dead, and under which liveness relation, answered once
 * over the graph of every configuration. Reference counting holds a declaration live when any
 * declaration references it or it is a root that names a caller; reachability holds it live
 * when a path of references reaches it from a root. Reachability is settled by tiers, strongest
 * first: a caller, an exemption or a live component file's markup, a suppression mark, and an
 * unanswered checker question; each Contract rule "live only through" one is a view up to it.
 */

import { exemptionsOf, type Exemption } from "../exemptions/lifecycle.ts";
import type { InventorySymbol } from "../inventory.ts";
import { edgeWithheldBy, type Mode } from "../tests/file-class.ts";
import { componentsOf, type Component, type Positional } from "./components.ts";
import { namesACaller, OUTSIDE, type Counts, type Edge, type Graph, type Rooted } from "./graph.ts";
import type { Matrix } from "./matrix.ts";

/** The liveness relation that decided a declaration, as a finding spells it. */
export type Relation = "reference-counting" | "reachability";

/** The relations in the order a declaration's entry lists them. */
const RELATIONS: readonly Relation[] = ["reference-counting", "reachability"];

/** What one sweep seeds, counts and follows beside the matrix. */
export interface SweepPolicy {
  /**
   * The declarations a matched suppression names. A mark holds its declaration live
   * under both relations and seeds reachability through every reference it makes.
   */
  readonly marked: readonly string[];
  /**
   * Every record the detectors found. An exempt declaration is never a candidate, and it
   * seeds reachability as a mark does; it is live under reference counting only where
   * something references it. A record a component file's markup holds counts only once
   * that file is live.
   */
  readonly exempt: readonly Exemption[];
  /** The declarations a question the checker did not answer could have kept live (program.33). */
  readonly unanswered: readonly string[];
  /**
   * The component files of the run, by path. No finding is reported about a top-level
   * declaration of a live one, since the markup may use it (program.20).
   */
  readonly componentFiles: readonly string[];
  /**
   * Whether programs the analysis does not see may call the published API, the scope
   * declaring no consumer: a published declaration is then a live target of every test that
   * references it (DS1103).
   */
  readonly unseenCallers: boolean;
  /** The declarations the write-only kind would report but for a record's read. */
  readonly writeOnly: ReadonlySet<string>;
  readonly mode: Mode;
}

/** One declaration dead in the run, the relation that found it, and the counts a kind reads. */
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
  /** The configurations that hold the declaration, every one of which judges it dead. */
  readonly configurations: readonly string[];
  /**
   * The declaration of test-support code that test code references, outside the
   * test-of-dead-code rule, that is or contains this one, the outermost where two do.
   * Such a declaration is not dead while test code references it, so neither it nor a
   * declaration it contains is a member of a dead component.
   */
  readonly heldByTests: string | undefined;
  /**
   * Whether a test file declares it, no test of dead code, and the run that counts test
   * references does not reach it: it is reported as a production declaration of its
   * shape nothing references would be.
   */
  readonly unreferencedTest: boolean;
  /**
   * Whether it is dead only because code only tests use is: production code only tests
   * use holds it and the run that counts test references reaches it, or such a
   * declaration reaches it through dead declarations.
   */
  readonly testUsed: boolean;
  /**
   * Whether test code the run that counts test references reaches, and that is no test of
   * dead code, references it: a test that stays keeps it.
   */
  readonly keptByTests: boolean;
}

/** Where a path to a declaration starts. */
export type Origin =
  | { readonly k: "root"; readonly rooted: Rooted }
  | { readonly k: "consumed"; readonly edge: Edge }
  | { readonly k: "exemption"; readonly record: Exemption }
  | { readonly k: "mark"; readonly at: number }
  | { readonly k: "unanswered"; readonly at: number };

/** One step of a path: a reference, or one that reads a module and so reaches an export of it. */
type Hop =
  | { readonly k: "reference"; readonly edge: Edge }
  | { readonly k: "export"; readonly edge: Edge; readonly to: number };

/** How the sweep reaches one live declaration: where its strongest tier's path starts, and each hop. */
interface Path {
  readonly origin: Origin;
  readonly hops: readonly Hop[];
}

/** One sweep's answer. */
export interface Sweep {
  /**
   * Per declaration, the relations that hold it live, reference counting first. A
   * declaration no relation holds live has no entry.
   */
  readonly liveUnder: ReadonlyMap<string, readonly Relation[]>;
  /** The declarations dead in the run, in site order. */
  readonly candidates: readonly Candidate[];
  /** The dead components, each before every component it reaches, each identifier once per run. */
  readonly components: readonly Component[];
  /** The records that hold: every record but one whose component file is not live, each once. */
  readonly exempt: readonly Exemption[];
  /**
   * The records that held back a declaration the run without records, its marks counted,
   * judges dead, or one the write-only kind would report without the record's read, in the
   * declarations' site order.
   */
  readonly retained: readonly Exemption[];
  /**
   * Every declaration an unanswered question could have kept live, every one that makes a
   * use only a name answered, and every one only such a question keeps live or decides
   * otherwise: no candidate, and the run reports none of them (program.33).
   */
  readonly held: readonly string[];
  /** The top-level declarations of the live component files, which no finding may name. */
  readonly bindings: readonly string[];
  /**
   * Per declaration every counted reference to which has carriers (`Reference.carriers`),
   * each distinct chain of them, innermost first: what deleting a write-only subject of
   * each chain with its writes also deletes.
   */
  readonly carried: ReadonlyMap<string, readonly (readonly string[])[]>;
  /** The path the strongest tier reaching a live declaration follows, or none. */
  path(id: string): Path | undefined;
}

/** One step a pass reached a declaration by. */
type Step =
  | { readonly k: "seed"; readonly origin: Origin }
  | { readonly k: "reference"; readonly from: number; readonly edge: Edge }
  | { readonly k: "export"; readonly from: number; readonly edge: Edge };

/** One declaration a held mechanism seeds, and what seeds it. */
interface HeldSeed {
  readonly at: number;
  readonly origin: Origin;
}

/** What one reachability pass seeds and follows. */
interface Seeds {
  /** The held seeds, which reach through every reference, in order. */
  readonly held: readonly HeldSeed[];
  /** Per file position, the held seeds that join once the file is live. */
  readonly gated: ReadonlyMap<number, readonly HeldSeed[]>;
  /** Whether a reference only a name answered is followed. */
  readonly guessed: boolean;
  /** Whether reference counting holds the declaration at a position live, which a gate also asks. */
  readonly counted: (at: number) => boolean;
}

/** What one pass reached, how, and which gates opened. */
interface Reached {
  readonly reached: readonly boolean[];
  readonly by: readonly (Step | undefined)[];
  readonly opened: ReadonlySet<number>;
}

/** The references to one declaration the mode counts: under `production` none test code made but those it classes as production. */
function countedRefs(made: Counts | undefined, mode: Mode): number {
  if (made === undefined) {
    return 0;
  }
  if (!mode.production) {
    return made.production + made.test;
  }
  return made.production + (mode.consumerTestsProduction === true ? made.consumerTest : 0);
}

/** The references to one declaration, split as the mode classes them, whatever it counts. */
function splitRefs(
  made: Counts | undefined,
  mode: Mode,
): { readonly production: number; readonly test: number } {
  const moved = mode.consumerTestsProduction === true ? (made?.consumerTest ?? 0) : 0;
  return { production: (made?.production ?? 0) + moved, test: (made?.test ?? 0) - moved };
}

/**
 * Per declaration, whether one pass reaches it, the step that first reached it, and the gated
 * files that opened. Held seeds reach through every reference, a test file's included; roots
 * and consumed references through those the mode counts, and a held seed met after a caller
 * expands its declaration again. A read of a file reaches its exports; an evaluation, a root or
 * a consumed reference to a file reaches its top level alone. The roots' first hops precede the
 * consumed references, so a path is the shortest from the earliest root.
 */
function reach(graph: Graph, seeds: Seeds, mode: Mode, namespaces = true): Reached {
  const reached = graph.symbols.map(() => false);
  const holding = graph.symbols.map(() => false);
  const expanded = graph.symbols.map(() => [false, false]);
  const by: (Step | undefined)[] = graph.symbols.map(() => undefined);
  const opened = new Set<number>();
  const queue: { readonly at: number; readonly holds: boolean }[] = [];

  const enter = (at: number, holds: boolean, expands: boolean, step: Step): void => {
    if (!reached[at]) {
      reached[at] = true;
      by[at] = step;
      const gate = seeds.gated.get(at);
      if (gate !== undefined && seeds.counted(at)) {
        opened.add(at);
        for (const seed of gate) {
          enter(seed.at, true, false, { k: "seed", origin: seed.origin });
        }
      }
      if (!holds) {
        queue.push({ at, holds });
      }
    }
    if (holds && !holding[at]) {
      holding[at] = true;
      queue.push({ at, holds });
    }
    const mode = expanded[at];
    if (!expands || mode === undefined || mode[holds ? 1 : 0] === true) {
      return;
    }
    mode[holds ? 1 : 0] = true;
    for (const exported of graph.exportsOf[at] ?? []) {
      enter(
        exported,
        holds,
        false,
        step.k === "seed" ? step : { k: "export", from: step.from, edge: step.edge },
      );
    }
  };
  const follows = (edge: Edge, holds: boolean): boolean =>
    (seeds.guessed || !edge.guessed) && (holds || !edgeWithheldBy(mode, edge));

  for (const seed of seeds.held) {
    enter(seed.at, true, false, { k: "seed", origin: seed.origin });
  }
  for (const rooted of graph.rooted) {
    enter(rooted.at, false, false, { k: "seed", origin: { k: "root", rooted } });
  }
  const firstHops = queue.length;
  for (let head = 0; ; head += 1) {
    if (head === firstHops) {
      for (const edge of graph.consumed) {
        if (follows(edge, false)) {
          enter(edge.to, false, namespaces && !edge.evaluation, {
            k: "reference",
            from: OUTSIDE,
            edge,
          });
        }
      }
    }
    const next = queue[head];
    if (next === undefined) {
      break;
    }
    for (const edge of graph.out[next.at] ?? []) {
      if (follows(edge, next.holds)) {
        enter(edge.to, next.holds, namespaces && !edge.evaluation, {
          k: "reference",
          from: next.at,
          edge,
        });
      }
    }
  }
  return { reached, by, opened };
}

/**
 * The directory a test runner reads a manual mock from, whose exports it puts in place of
 * the module's: https://jestjs.io/docs/manual-mocks
 */
const MANUAL_MOCKS = "__mocks__";

/** Whether a test runner calls or reads one export of a test file: a function, or any export of a manual mock. */
export function runnerCalls(symbol: InventorySymbol): boolean {
  return symbol.kind === "function" || symbol.position.path.split("/").includes(MANUAL_MOCKS);
}

/** The held seeds of the flagged declarations, each a suppression mark. */
function markSeeds(flags: readonly boolean[]): readonly HeldSeed[] {
  return flags.flatMap((mark, at) => (mark ? [{ at, origin: { k: "mark", at } as const }] : []));
}

/** Per declaration of the graph, whether one of the identifiers names it. */
function flagged(graph: Graph, ids: Iterable<string>): boolean[] {
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
 * Per declaration of the graph, whether the run that counts test references reaches it.
 * That run's roots are the graph's own and, of each test file, its top level and every
 * function it exports, which a test runner may call, and every export of a manual mock,
 * which the runner reads; any other export of a test file, and test-support code, which
 * runs where a test imports it, are judged as any file's are. `held` seeds it as a mark
 * seeds a sweep; with `namespaces` false a file read reaches none of the file's exports.
 */
export function reachedWithTheTests(
  graph: Graph,
  held: Iterable<string>,
  namespaces = true,
): readonly boolean[] {
  const tests = graph.symbols.flatMap((symbol, at): Rooted[] => {
    const exported = symbol.exported && graph.symbols[graph.parent[at] ?? OUTSIDE]?.kind === "file";
    const called = exported && runnerCalls(symbol);
    return graph.test[at] === true &&
      graph.support[at] !== true &&
      (symbol.kind === "file" || called)
      ? [{ at, kind: "test-runner", source: symbol.position.path }]
      : [];
  });
  return reach(
    { ...graph, rooted: [...graph.rooted, ...tests] },
    {
      held: markSeeds(flagged(graph, held)),
      gated: new Map(),
      guessed: true,
      counted: () => true,
    },
    { production: false },
    namespaces,
  ).reached;
}

/** What one view of the run judges of each declaration. */
interface Judged {
  readonly live: readonly (readonly Relation[])[];
  /** Per declaration, whether it is a candidate, a test of dead code included. */
  readonly dead: readonly boolean[];
  readonly testOfDeadCode: readonly boolean[];
  /** Per declaration, the relation it is dead under where it is a candidate. */
  readonly relation: readonly Relation[];
}

/** The held mechanisms one view counts. */
interface View {
  /** The held seeds that hold their declarations back from the candidates, in order. */
  readonly records: readonly HeldSeed[];
  /** Per file the markup of which holds a record, the held seeds that join once it is live. */
  readonly gated: ReadonlyMap<number, readonly HeldSeed[]>;
  readonly marks: boolean;
  readonly guessed: boolean;
}

/** One sweep's state over the matrix. */
class Sweeping {
  readonly graph: Graph;
  readonly policy: SweepPolicy;
  readonly marked: readonly boolean[];
  readonly called: readonly boolean[];
  readonly unseen: readonly boolean[];

  constructor(graph: Graph, policy: SweepPolicy) {
    this.graph = graph;
    this.policy = policy;
    this.marked = flagged(graph, policy.marked);
    const called = graph.symbols.map(() => false);
    const unseen = graph.symbols.map(() => false);
    for (const root of graph.rooted) {
      if (namesACaller(root.kind)) {
        called[root.at] = true;
      } else if (policy.unseenCallers && root.kind === "published-api") {
        unseen[root.at] = true;
      }
    }
    this.called = called;
    this.unseen = unseen;
  }

  /** The mode's count of one declaration's references, those only a name answered left out unless `guessed`. */
  counted(at: number, guessed: boolean): number {
    const all = countedRefs(this.graph.made[at], this.policy.mode);
    return guessed ? all : all - countedRefs(this.graph.guessedMade[at], this.policy.mode);
  }

  /** Whether reference counting holds one declaration live in a view. */
  countLive(at: number, view: View): boolean {
    return (
      (view.marks && this.marked[at] === true) ||
      this.called[at] === true ||
      this.counted(at, view.guessed) > 0
    );
  }

  /** What one view reaches: its records and marks held, its gates open once their file is live. */
  reachOf(view: View, mode: Mode = this.policy.mode): Reached {
    return reach(
      this.graph,
      {
        held: [...view.records, ...(view.marks ? markSeeds(this.marked) : [])],
        gated: view.gated,
        guessed: view.guessed,
        counted: (at) => this.countLive(at, view),
      },
      mode,
    );
  }

  /**
   * Judges every declaration under one view: the relations, then the candidates, which no
   * record, opened gate or `kept` flag holds back, then the tests of dead code.
   */
  judge(view: View, reached: Reached, kept: readonly boolean[] = []): Judged {
    const { graph } = this;
    const exempt = graph.symbols.map(() => false);
    for (const seed of [
      ...view.records,
      ...[...reached.opened].flatMap((file) => view.gated.get(file) ?? []),
    ]) {
      exempt[seed.at] = true;
    }
    const live = graph.symbols.map((_symbol, at): readonly Relation[] => [
      ...(this.countLive(at, view) ? (["reference-counting"] as const) : []),
      ...(reached.reached[at] === true ? (["reachability"] as const) : []),
    ]);
    const dead = graph.symbols.map(
      (_symbol, at) =>
        graph.subject[at] === true &&
        exempt[at] !== true &&
        kept[at] !== true &&
        (live[at]?.length ?? 0) < RELATIONS.length,
    );
    const held = exempt.map((one, at) => one || (view.marks && this.marked[at] === true));
    const testOfDeadCode = this.admit(dead, held);
    const relation = graph.symbols.map((_symbol, at): Relation =>
      this.counted(at, view.guessed) === 0 ? "reference-counting" : "reachability",
    );
    return { live, dead, testOfDeadCode, relation };
  }

  /**
   * Admits every test declaration whose referenced production declarations, read from every
   * reference the test makes, are non-empty and all dead. An ambient declaration is no
   * production declaration here, and a published one outside programs may call counts as
   * live. A support declaration a test with a live target also references is a live target of
   * every test referencing it. A held test is never admitted.
   */
  admit(dead: boolean[], held: readonly boolean[]): readonly boolean[] {
    const { graph } = this;
    const testCode = (at: number): boolean => graph.test[at] === true || graph.support[at] === true;
    const judged = graph.symbols.map((_symbol, at) => {
      let targets = 0;
      let live = 0;
      if (testCode(at) && graph.subject[at] === true && held[at] !== true) {
        for (const edge of graph.out[at] ?? []) {
          if (
            testCode(edge.to) ||
            graph.subject[edge.to] !== true ||
            graph.ambient[edge.to] === true
          ) {
            continue;
          }
          targets += 1;
          if (dead[edge.to] !== true || this.unseen[edge.to] === true) {
            live += 1;
          }
        }
      }
      return { targets, live };
    });
    const shared = new Set<number>();
    judged.forEach(({ live }, at) => {
      if (live > 0) {
        for (const edge of graph.out[at] ?? []) {
          if (graph.support[edge.to] === true) {
            shared.add(edge.to);
          }
        }
      }
    });
    const admitted = graph.symbols.map(() => false);
    judged.forEach(({ targets, live }, at) => {
      const sharing = (graph.out[at] ?? []).some((edge) => shared.has(edge.to) && edge.to !== at);
      if (targets > 0 && live === 0 && !sharing) {
        dead[at] = true;
        admitted[at] = true;
      }
    });
    return admitted;
  }
}

/** The path one pass reached a declaration by, from the step it recorded back to its origin. */
function pathIn(by: readonly (Step | undefined)[], at: number): Path | undefined {
  const hops: Hop[] = [];
  let cursor = at;
  for (let step = by[cursor]; step !== undefined; step = by[cursor]) {
    if (step.k === "seed") {
      return { origin: step.origin, hops };
    }
    hops.unshift(
      step.k === "reference"
        ? { k: "reference", edge: step.edge }
        : { k: "export", edge: step.edge, to: cursor },
    );
    if (step.from === OUTSIDE) {
      return { origin: { k: "consumed", edge: step.edge }, hops };
    }
    cursor = step.from;
  }
  return undefined;
}

/**
 * Per declaration of the union, whether one of `seeds` is it or reaches it through `dead`
 * declarations.
 */
function testUsedReach(
  graph: Graph,
  seeds: readonly boolean[],
  dead: readonly boolean[],
): readonly boolean[] {
  // A file is no candidate, and its top level is what reaches what it alone calls.
  const reached = seeds.map((seed, at) => seed && dead[at] === true);
  const queue = seeds.flatMap((one, at) => (one ? [at] : []));
  for (let at = queue.pop(); at !== undefined; at = queue.pop()) {
    for (const edge of graph.out[at] ?? []) {
      if (dead[edge.to] === true && reached[edge.to] !== true) {
        reached[edge.to] = true;
        queue.push(edge.to);
      }
    }
  }
  return reached;
}

/** Per declaration, whether test code `reached` holds and `admitted` rejects references it. */
function keptByTests(
  graph: Graph,
  reached: readonly boolean[],
  admitted: readonly boolean[],
): readonly boolean[] {
  const kept = graph.symbols.map(() => false);
  graph.out.forEach((edges, from) => {
    const testCode = graph.test[from] === true || graph.support[from] === true;
    if (!testCode || reached[from] !== true || admitted[from] === true) {
      return;
    }
    for (const edge of edges) {
      if (edge.test) {
        kept[edge.to] = true;
      }
    }
  });
  return kept;
}

/**
 * The dead components of one sweep over the union, with the file declarations at `files`
 * dead as well: a file that is deleted whole takes the declarations it holds and every
 * dead declaration only its top level references with it.
 */
export function deadComponents(
  matrix: Matrix,
  result: Pick<Sweep, "liveUnder" | "candidates">,
  files: ReadonlySet<number>,
): readonly Component[] {
  const union = matrix.union;
  const byId = new Map(result.candidates.map((candidate) => [candidate.id, candidate]));
  const candidateAt = (at: number): Candidate | undefined => byId.get(union.symbols[at]?.id ?? "");
  const positional: Positional = {
    dependents: union.symbols.map((symbol) =>
      (matrix.dependents.get(symbol.id) ?? [])
        .map((id) => union.at(id))
        .filter((at) => at !== OUTSIDE),
    ),
    live: union.symbols.map(
      (symbol) => result.liveUnder.get(symbol.id)?.includes("reachability") === true,
    ),
  };
  return componentsOf(
    union,
    union.symbols.map((_symbol, at) => {
      const candidate = candidateAt(at);
      return files.has(at) || (candidate !== undefined && candidate.heldByTests === undefined);
    }),
    union.symbols.map((_symbol, at) => candidateAt(at)?.testOfDeadCode === true),
    union.symbols.map((_symbol, at) => candidateAt(at)?.unreferencedTest === true),
    positional,
  );
}

/** The held seeds of the policy's records, by how they hold. */
function seedsOf(
  graph: Graph,
  policy: SweepPolicy,
): {
  readonly records: readonly HeldSeed[];
  readonly unanswered: readonly HeldSeed[];
  readonly gated: ReadonlyMap<number, readonly HeldSeed[]>;
} {
  const files = new Map(
    graph.symbols.flatMap((symbol, at) =>
      symbol.kind === "file" ? [[symbol.position.path, at] as const] : [],
    ),
  );
  const records: HeldSeed[] = [];
  const unanswered: HeldSeed[] = [];
  const gated = new Map<number, HeldSeed[]>();
  const gate = (path: string, seed: HeldSeed): void => {
    const file = files.get(path);
    if (file !== undefined) {
      gated.set(file, [...(gated.get(file) ?? []), seed]);
    }
  };
  for (const record of policy.exempt) {
    const at = graph.at(record.id);
    if (at === OUTSIDE) {
      continue;
    }
    const seed = { at, origin: { k: "exemption", record } as const };
    if (record.whileLive !== undefined) {
      gate(record.whileLive, seed);
    } else if (record.unanswered === true) {
      unanswered.push(seed);
    } else {
      records.push(seed);
    }
  }
  for (const id of policy.unanswered) {
    const at = graph.at(id);
    if (at !== OUTSIDE) {
      unanswered.push({ at, origin: { k: "unanswered", at } });
    }
  }
  return { records, unanswered, gated };
}

/**
 * Answers which declarations of the run are dead under the policy, once over the union of
 * every configuration's references and roots, so one configuration's code keeps a declaration
 * live in the run (matrix.4, matrix.5). Where a question went unanswered, the view without the
 * guessed tier decides what the gap holds: what it judges dead and the full view judges live,
 * or dead by another rule or test-of-dead-code answer; those are no candidates. A record held
 * a declaration back where the view without any record judges it dead.
 */
export function sweep(matrix: Matrix, policy: SweepPolicy): Sweep {
  const graph = matrix.union;
  const sweeping = new Sweeping(graph, policy);
  const { records, unanswered, gated } = seedsOf(graph, policy);
  const full: View = { records: [...records, ...unanswered], gated, marks: true, guessed: true };
  const reached = sweeping.reachOf(full);
  const openedSeeds = [...reached.opened].flatMap((file) => gated.get(file) ?? []);

  const held = new Set(policy.unanswered);
  if (held.size > 0) {
    for (const reference of graph.references) {
      if (reference.guessed === true) {
        held.add(reference.from);
      }
    }
    const fullJudged = sweeping.judge(full, reached);
    const bare: View = {
      records: [...records, ...openedSeeds],
      gated: new Map(),
      marks: true,
      guessed: false,
    };
    const bareJudged = sweeping.judge(bare, sweeping.reachOf(bare));
    graph.symbols.forEach((symbol, at) => {
      if (
        bareJudged.dead[at] === true &&
        (fullJudged.dead[at] !== true ||
          fullJudged.testOfDeadCode[at] !== bareJudged.testOfDeadCode[at] ||
          fullJudged.relation[at] !== bareJudged.relation[at])
      ) {
        held.add(symbol.id);
      }
    });
  }
  const judged = sweeping.judge(full, reached, flagged(graph, held));

  const openedPaths = new Set(
    [...reached.opened].flatMap((file) => graph.symbols[file]?.position.path ?? []),
  );
  const exempt = exemptionsOf(
    policy.exempt.flatMap(({ whileLive, ...record }) =>
      whileLive === undefined || openedPaths.has(whileLive) ? [record] : [],
    ),
  );
  // The markup source makes each top-level binding a use of the file's (program.20), so a
  // live file's bindings are live; the sweep answers which they are for the findings.
  const components = new Set(policy.componentFiles);
  const bindings = graph.symbols.flatMap((symbol, at) => {
    const file = graph.parent[at] ?? OUTSIDE;
    const holder = graph.symbols[file];
    return holder?.kind === "file" &&
      components.has(holder.position.path) &&
      (judged.live[file]?.length ?? 0) === RELATIONS.length
      ? [symbol.id]
      : [];
  });
  const heldIds = [
    ...policy.marked,
    ...exempt.map((record) => record.id),
    ...policy.unanswered,
    ...bindings,
  ];
  const testReached = reachedWithTheTests(graph, heldIds);
  // A test uses what it names: a file a test reads through a star re-export or a
  // namespace keeps the exports nothing names at its own class.
  const testNamed = reachedWithTheTests(graph, heldIds, false);
  const kept = keptByTests(graph, testReached, judged.testOfDeadCode);
  const testUsed = testUsedReach(
    graph,
    graph.symbols.map((_symbol, at) => matrix.testUsed[at] === true && testNamed[at] === true),
    judged.dead,
  );
  const heldBy: (string | undefined)[] = graph.symbols.map(() => undefined);
  const candidates: Candidate[] = [];
  graph.symbols.forEach((symbol, at) => {
    if (judged.dead[at] !== true) {
      return;
    }
    const admitted = judged.testOfDeadCode[at] === true;
    const split = splitRefs(graph.made[at], policy.mode);
    const heldByTests =
      heldBy[graph.parent[at] ?? OUTSIDE] ??
      (graph.support[at] === true && split.test > 0 && !admitted ? symbol.id : undefined);
    heldBy[at] = heldByTests;
    const unreferenced = graph.test[at] === true && !admitted && testReached[at] !== true;
    candidates.push({
      id: symbol.id,
      productionRefs: split.production,
      testRefs: split.test,
      // The run that judges a test-file declaration counts its test references.
      relation: unreferenced
        ? split.production + split.test === 0
          ? "reference-counting"
          : "reachability"
        : (judged.relation[at] ?? "reachability"),
      testOfDeadCode: admitted,
      configurations: matrix.heldIn[at] ?? [],
      heldByTests,
      unreferencedTest: unreferenced,
      testUsed: testUsed[at] === true,
      keptByTests: kept[at] === true,
    });
  });
  const liveUnder = new Map(
    graph.symbols.flatMap((symbol, at) => {
      const relations = judged.live[at] ?? [];
      return relations.length === 0 ? [] : [[symbol.id, relations] as const];
    }),
  );

  let retained: readonly Exemption[] = [];
  if (exempt.length > 0) {
    const without: View = { records: [], gated: new Map(), marks: true, guessed: true };
    const bare = sweeping.judge(without, sweeping.reachOf(without));
    const holding = new Map<string, Exemption[]>();
    for (const record of exempt) {
      const at = graph.at(record.id);
      if (bare.dead[at] === true || policy.writeOnly.has(record.id)) {
        holding.set(record.id, [...(holding.get(record.id) ?? []), record]);
      }
    }
    retained = graph.symbols.flatMap((symbol) => holding.get(symbol.id) ?? []);
  }

  const tiers: View[] = [
    { records: [], gated: new Map(), marks: false, guessed: false },
    { records, gated, marks: false, guessed: false },
    { records, gated, marks: true, guessed: false },
    full,
  ];
  const passes: Reached[] = [];
  const path = (id: string): Path | undefined => {
    const at = graph.at(id);
    if (at === OUTSIDE) {
      return undefined;
    }
    for (const [place, view] of tiers.entries()) {
      const pass = (passes[place] ??=
        place === tiers.length - 1 ? reached : sweeping.reachOf(view));
      if (pass.reached[at] === true) {
        return pathIn(pass.by, at);
      }
    }
    // A production run counts no test reference, so what only tests reach is shown by them.
    if (!policy.mode.production) {
      return undefined;
    }
    const counting = (passes[tiers.length] ??= sweeping.reachOf(tiers[0] ?? full, {
      production: false,
    }));
    return counting.reached[at] === true ? pathIn(counting.by, at) : undefined;
  };

  const sweepAnswer = { liveUnder, candidates };
  return {
    ...sweepAnswer,
    components: deadComponents(matrix, sweepAnswer, new Set()),
    exempt,
    retained,
    held: [...held],
    bindings,
    carried: carriedOf(graph, policy.mode),
    path,
  };
}

/** {@link Sweep.carried}: a declaration one counted reference without a carrier names carries nothing. */
function carriedOf(graph: Graph, mode: Mode): ReadonlyMap<string, readonly (readonly string[])[]> {
  const carried = new Map<string, (readonly string[])[]>();
  const free = new Set<number>();
  for (const edge of [...graph.out.flat(), ...graph.consumed]) {
    if (edgeWithheldBy(mode, edge) || free.has(edge.to)) {
      continue;
    }
    const id = graph.symbols[edge.to]?.id ?? "";
    const chain = graph.references[edge.reference]?.carriers ?? [];
    const known = carried.get(id) ?? [];
    if (chain.length === 0) {
      free.add(edge.to);
      carried.delete(id);
    } else if (!known.some((one) => one.join("\u0000") === chain.join("\u0000"))) {
      carried.set(id, [...known, chain]);
    }
  }
  return carried;
}
