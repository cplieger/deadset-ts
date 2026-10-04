/**
 * One run's projects as one matrix: every declaration any project holds, keyed by its
 * position and carrying the configurations that hold it, swept once per configuration
 * and intersected, with the dead components computed once over every configuration.
 */

import { componentsOf, type Component } from "./components.ts";
import { graphOf, type Graph } from "./graph.ts";
import type { InventorySymbol } from "./inventory.ts";
import { byPosition } from "./position.ts";
import type { Reference } from "./references.ts";
import type { Root } from "./roots.ts";
import { sweep, type Candidate, type Liveness, type Relation, type SweepInput } from "./sweep.ts";

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
  /**
   * The paths of the workspace-package files the configuration holds but does not
   * compile itself. Their declarations count in its graph and its verdict on them is no
   * finding.
   */
  readonly referenceOnly?: readonly string[] | undefined;
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
}

/** One declaration dead in every configuration that holds it. */
export interface MatrixCandidate extends Candidate {
  /** The configurations the declaration is dead in, which are every one that holds it. */
  readonly configurations: readonly string[];
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

/** Two strings ordered bytewise. */
function compare(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
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
  per.forEach((one, index) => {
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
  symbols.sort((a, b) => byPosition(a.position, b.position) || compare(a.ref, b.ref));

  return {
    configurations: per.map((one) => one.configuration),
    graphs: per.map((one) =>
      graphOf(one.symbols, one.references, one.roots, one.testFiles, one.supportFiles),
    ),
    union: graphOf(
      symbols,
      references,
      per.flatMap((one) => one.roots),
      [...new Set(per.flatMap((one) => one.testFiles))],
      [...new Set(per.flatMap((one) => one.supportFiles ?? []))],
    ),
    heldIn: symbols.map((symbol) => holders.get(symbol.id) ?? []),
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
  const dead = union.symbols.map(() => false);
  const testOfDeadCode = union.symbols.map(() => false);
  const candidates: MatrixCandidate[] = [];
  union.symbols.forEach((symbol, at) => {
    const held = matrix.heldIn[at] ?? [];
    const found = held.map((configuration) => byConfiguration.get(configuration)?.get(symbol.id));
    if (held.length === 0 || found.some((candidate) => candidate === undefined)) {
      return;
    }
    const all = found.filter((candidate): candidate is Candidate => candidate !== undefined);
    const admitted = all.every((candidate) => candidate.testOfDeadCode);
    dead[at] = true;
    testOfDeadCode[at] = admitted;
    candidates.push({
      id: symbol.id,
      productionRefs: union.made[at]?.production ?? 0,
      testRefs: union.made[at]?.test ?? 0,
      relation: all.every((candidate) => candidate.relation === "reference-counting")
        ? "reference-counting"
        : "reachability",
      testOfDeadCode: admitted,
      configurations: held,
    });
  });

  return {
    liveUnder: liveAnywhere(union.symbols, per),
    candidates,
    components: componentsOf(union, dead, testOfDeadCode),
  };
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
