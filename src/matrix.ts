/**
 * One run's projects as one matrix: every declaration any project holds, keyed by its
 * position and carrying the configurations that hold it, swept once per configuration
 * and intersected, with the dead components computed once over every configuration.
 */

import { componentsOf, type Component, type Positional } from "./components.ts";
import { graphOf, OUTSIDE, type Graph } from "./graph.ts";
import type { InventorySymbol } from "./inventory.ts";
import { byPosition } from "./position.ts";
import type { Reference } from "./references.ts";
import type { Root } from "./roots.ts";
import {
  reachedWithTheTests,
  sweep,
  type Candidate,
  type Liveness,
  type Relation,
  type SweepInput,
} from "./sweep.ts";

/** What the passes answered for one configuration of the run. */
export interface Configured {
  /** The name discovery gives the configuration's project. */
  readonly configuration: string;
  readonly symbols: readonly InventorySymbol[];
  readonly references: readonly Reference[];
  readonly roots: readonly Root[];
  /** The paths the reference pass classified as test files. */
  readonly testFiles: readonly string[];
  /** The paths of the test-support files, which only test code imports. */
  readonly supportFiles?: readonly string[] | undefined;
  /** The paths of the files only tests reach that are no test-support file. */
  readonly testUsedFiles?: readonly string[] | undefined;
  /** The ids of the ambient declarations, which describe code the target does not implement. */
  readonly ambient?: ReadonlySet<string> | undefined;
  /**
   * The paths of the workspace-package files the configuration holds but does not
   * compile itself. Their declarations count in its graph and its verdict on them is no
   * finding.
   */
  readonly referenceOnly?: readonly string[] | undefined;
  /** Each declaration's dependents, by id, as the configuration's inventory states them. */
  readonly dependents?: ReadonlyMap<string, readonly string[]> | undefined;
}

/** The run's configurations, indexed for the sweep. */
export interface Matrix {
  /** The configurations, in the run's order. */
  readonly configurations: readonly string[];
  /** Per configuration, in the same order, the graph of what that configuration holds. */
  readonly graphs: readonly Graph[];
  /**
   * The graph over every configuration at once: every declaration a configuration
   * holds in a file it does not hold only for its references, once per position and in
   * site order, and every reference any configuration makes, a reference several
   * configurations make at one position counted once.
   */
  readonly union: Graph;
  /**
   * Per declaration of {@link Matrix.union}, at its position there, the configurations
   * whose project holds it, in the run's order.
   */
  readonly heldIn: readonly (readonly string[])[];
  /**
   * Per declaration of {@link Matrix.union}, whether a file only tests reach that is no
   * test-support file holds it in some configuration: production code only tests use.
   */
  readonly testUsed: readonly boolean[];
  /** Each declaration's dependents, by id, as the first configuration holding it states them. */
  readonly dependents: ReadonlyMap<string, readonly string[]>;
}

/** One declaration dead in every configuration that holds it. */
export interface MatrixCandidate extends Candidate {
  /** The configurations the declaration is dead in, which are every one that holds it. */
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

/** One run's sweep. */
export interface SweepResult {
  /**
   * Per declaration, the relations that hold it live in at least one configuration,
   * reference counting first. A declaration no relation holds live anywhere has no entry.
   */
  readonly liveUnder: ReadonlyMap<string, readonly Relation[]>;
  /** The declarations dead in every configuration that holds them, in site order. */
  readonly candidates: readonly MatrixCandidate[];
  /** The dead components, each before every component it reaches, each identifier once per run. */
  readonly components: readonly Component[];
}

/**
 * What makes one reference one reference, whichever configuration made it. A consumer's
 * position is rendered against its own root, so the consumer is part of what it names.
 */
export function referenceKey(reference: Reference): string {
  const { path, line, column } = reference.position;
  return [
    reference.consumer ?? "",
    reference.from,
    reference.to,
    path,
    String(line),
    String(column),
    reference.use,
  ].join("\u0000");
}

/**
 * Indexes what the passes answered for each configuration of one run, in the run's order.
 * A declaration is keyed by its rendered position, with the fields of the first
 * configuration that judges it; one in a file every holder holds only for its references
 * is judged by none and is not in the union. One reference at one position of a file
 * several configurations compile is one reference; two one configuration makes are two.
 */
export function matrixOf(per: readonly Configured[]): Matrix {
  const symbols: InventorySymbol[] = [];
  const holders = new Map<string, string[]>();
  const references: Reference[] = [];
  const firstSeen = new Map<string, number>();
  const judged = new Set<string>();
  const dependents = new Map<string, readonly string[]>();
  per.forEach((one, index) => {
    for (const [id, after] of one.dependents ?? []) {
      if (!dependents.has(id)) {
        dependents.set(id, after);
      }
    }
    const referenceOnly = new Set(one.referenceOnly);
    for (const symbol of one.symbols) {
      const held = holders.get(symbol.id);
      if (held === undefined) {
        holders.set(symbol.id, [one.configuration]);
      } else if (!held.includes(one.configuration)) {
        held.push(one.configuration);
      }
      if (!referenceOnly.has(symbol.position.path) && !judged.has(symbol.id)) {
        judged.add(symbol.id);
        symbols.push(symbol);
      }
    }
    for (const reference of one.references) {
      const key = referenceKey(reference);
      const seen = firstSeen.get(key);
      if (seen === undefined) {
        firstSeen.set(key, index);
      } else if (seen !== index) {
        continue;
      }
      references.push(reference);
    }
  });
  symbols.sort((a, b) => byPosition(a.position, b.position));
  const testUsed = new Set(per.flatMap((one) => one.testUsedFiles ?? []));

  return {
    configurations: per.map((one) => one.configuration),
    graphs: per.map((one) =>
      graphOf(one.symbols, one.references, one.roots, one.testFiles, one.supportFiles, one.ambient),
    ),
    union: graphOf(
      symbols,
      references,
      per.flatMap((one) => one.roots),
      [...new Set(per.flatMap((one) => one.testFiles))],
      [...new Set(per.flatMap((one) => one.supportFiles ?? []))],
      new Set(per.flatMap((one) => [...(one.ambient ?? [])])),
    ),
    heldIn: symbols.map((symbol) => holders.get(symbol.id) ?? []),
    testUsed: symbols.map((symbol) => testUsed.has(symbol.position.path)),
    dependents,
  };
}

/**
 * Answers which declarations of the run are dead in every configuration that holds them.
 *
 * Liveness is a question about one configuration, because a file another configuration
 * does not compile makes no reference there and a root it does not hold seeds nothing
 * there, so each configuration is swept on its own graph under the run's input. A
 * declaration is a candidate when every configuration holding it judged it one: a
 * reference under one configuration is a reference, so what one project uses is never
 * reported, and a configuration that does not hold a declaration says nothing about it.
 * The candidate's relation is reference counting where every configuration found it so,
 * and reachability otherwise; its counts are the union's, one per reference.
 *
 * The components are computed once, over the union and the intersected dead set, so one
 * dead component is one entry of the run with one identifier.
 */
export function sweepMatrix(matrix: Matrix, input: SweepInput): SweepResult {
  const per = matrix.graphs.map((graph) => sweep(graph, input));
  const byConfiguration = new Map<string, ReadonlyMap<string, Candidate>>(
    matrix.configurations.map((configuration, index) => [
      configuration,
      new Map((per[index]?.candidates ?? []).map((candidate) => [candidate.id, candidate])),
    ]),
  );

  const union = matrix.union;
  const heldBy: (string | undefined)[] = union.symbols.map(() => undefined);
  const testReached = reachedWithTheTests(union, [
    ...input.marked,
    ...(input.exempt ?? []).map((record) => record.id),
    ...(input.unanswered ?? []),
  ]);
  const judged = union.symbols.map((symbol, at): readonly Candidate[] | undefined => {
    const held = matrix.heldIn[at] ?? [];
    const found = held.map((configuration) => byConfiguration.get(configuration)?.get(symbol.id));
    return held.length === 0 || found.some((candidate) => candidate === undefined)
      ? undefined
      : found.filter((candidate): candidate is Candidate => candidate !== undefined);
  });
  // A configuration that does not hold a test's subject's caller finds the subject dead,
  // so a test is of dead code only where every production subject it names is dead in
  // every configuration that holds it.
  const subjectsDead = (at: number): boolean =>
    (union.out[at] ?? []).every(
      (edge) =>
        union.test[edge.to] === true ||
        union.support[edge.to] === true ||
        union.ambient[edge.to] === true ||
        union.subject[edge.to] !== true ||
        judged[edge.to] !== undefined,
    );
  const admittedAt = (at: number): boolean =>
    judged[at]?.every((candidate) => candidate.testOfDeadCode) === true && subjectsDead(at);
  const kept = keptByTests(union, testReached, admittedAt);
  const testUsed = testUsedReach(
    union,
    union.symbols.map((_symbol, at) => matrix.testUsed[at] === true && testReached[at] === true),
    judged.map((one) => one !== undefined),
  );
  const candidates: MatrixCandidate[] = [];
  union.symbols.forEach((symbol, at) => {
    const all = judged[at];
    if (all === undefined) {
      return;
    }
    const held = matrix.heldIn[at] ?? [];
    const admitted = admittedAt(at);
    const testRefs = union.made[at]?.test ?? 0;
    const heldByTests =
      heldBy[union.parent[at] ?? OUTSIDE] ??
      (union.support[at] === true && testRefs > 0 && !admitted ? symbol.id : undefined);
    const unreferenced = union.test[at] === true && !admitted && testReached[at] !== true;
    heldBy[at] = heldByTests;
    const productionRefs = union.made[at]?.production ?? 0;
    const counted = all.every((candidate) => candidate.relation === "reference-counting");
    candidates.push({
      id: symbol.id,
      productionRefs,
      testRefs,
      // The run that judges a test-file declaration counts its test references.
      relation: (unreferenced ? productionRefs + testRefs === 0 : counted)
        ? "reference-counting"
        : "reachability",
      testOfDeadCode: admitted,
      configurations: held,
      heldByTests,
      unreferencedTest: unreferenced,
      testUsed: testUsed[at] === true,
      keptByTests: kept[at] === true,
    });
  });

  const liveUnder = liveAnywhere(union.symbols, per);
  return {
    liveUnder,
    candidates,
    components: deadComponents(matrix, { liveUnder, candidates }, new Set()),
  };
}

/** Per declaration of the union, whether one of `seeds` is it or reaches it through `dead` declarations. */
function testUsedReach(
  union: Graph,
  seeds: readonly boolean[],
  dead: readonly boolean[],
): readonly boolean[] {
  // A file is no candidate, and its top level is what reaches what it alone calls.
  const reached = seeds.map((seed, at) => seed && dead[at] === true);
  const queue = seeds.flatMap((one, at) => (one ? [at] : []));
  for (let at = queue.pop(); at !== undefined; at = queue.pop()) {
    for (const edge of union.out[at] ?? []) {
      if (dead[edge.to] === true && reached[edge.to] !== true) {
        reached[edge.to] = true;
        queue.push(edge.to);
      }
    }
  }
  return reached;
}

/** Per declaration of the union, whether test code `reached` holds and `admitted` rejects references it. */
function keptByTests(
  union: Graph,
  reached: readonly boolean[],
  admitted: (at: number) => boolean,
): readonly boolean[] {
  const kept = union.symbols.map(() => false);
  union.out.forEach((edges, from) => {
    const testCode = union.test[from] === true || union.support[from] === true;
    if (!testCode || reached[from] !== true || admitted(from)) {
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
  result: Pick<SweepResult, "liveUnder" | "candidates">,
  files: ReadonlySet<number>,
): readonly Component[] {
  const union = matrix.union;
  const byId = new Map(result.candidates.map((candidate) => [candidate.id, candidate]));
  const candidateAt = (at: number): MatrixCandidate | undefined =>
    byId.get(union.symbols[at]?.id ?? "");
  return componentsOf(
    union,
    union.symbols.map((_symbol, at) => {
      const candidate = candidateAt(at);
      return files.has(at) || (candidate !== undefined && candidate.heldByTests === undefined);
    }),
    union.symbols.map((_symbol, at) => candidateAt(at)?.testOfDeadCode === true),
    union.symbols.map((_symbol, at) => candidateAt(at)?.unreferencedTest === true),
    positionsOf(union, matrix.dependents, result.liveUnder),
  );
}

/**
 * The file declarations at `paths`, below the target root, that one sweep holds live
 * under both relations, the rule a judged declaration is live by.
 */
export function liveFilesAt(
  matrix: Matrix,
  result: SweepResult,
  paths: ReadonlySet<string>,
): readonly InventorySymbol[] {
  return matrix.union.symbols.filter(
    (symbol) =>
      symbol.kind === "file" &&
      paths.has(symbol.position.path) &&
      (result.liveUnder.get(symbol.id)?.length ?? 0) === RELATIONS.length,
  );
}

/**
 * Each declaration's dependents by its place in the union, and per place whether the
 * declaration is live under reachability in some configuration.
 */
function positionsOf(
  union: Graph,
  dependents: ReadonlyMap<string, readonly string[]>,
  liveUnder: ReadonlyMap<string, readonly Relation[]>,
): Positional {
  return {
    dependents: union.symbols.map((symbol) =>
      (dependents.get(symbol.id) ?? []).map((id) => union.at(id)).filter((at) => at !== OUTSIDE),
    ),
    live: union.symbols.map(
      (symbol) => liveUnder.get(symbol.id)?.includes("reachability") === true,
    ),
  };
}

/** The relations in the order a declaration's entry lists them. */
const RELATIONS: readonly Relation[] = ["reference-counting", "reachability"];

/**
 * Per declaration, in site order, every relation that holds it live in at least one
 * configuration.
 */
function liveAnywhere(
  symbols: readonly InventorySymbol[],
  per: readonly Liveness[],
): ReadonlyMap<string, readonly Relation[]> {
  const live = new Map<string, readonly Relation[]>();
  for (const symbol of symbols) {
    const relations = RELATIONS.filter((relation) =>
      per.some((liveness) => (liveness.liveUnder.get(symbol.id) ?? []).includes(relation)),
    );
    if (relations.length > 0) {
      live.set(symbol.id, relations);
    }
  }
  return live;
}
