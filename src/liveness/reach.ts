/**
 * The one reachability over a graph of declarations. The sweep's liveness relation, the binding
 * states' carrier sweep and the descriptor-exposure cap each walk it from their own seeds through
 * their own edge filter. A node is entered at a level: reached; used, by code the analysis does
 * not see (references-ts.4); whole, read in a way no rule judged, which reaches everything it
 * exports (references-ts.5); or passed, whole because a re-export passes it on from a root, from a
 * caller outside or from another node passed (references-ts.4), which reference counting reads as a
 * use too.
 */

import { OUTSIDE, type Edge } from "./graph.ts";

/** The nodes one walk visits, by position, and the edges between them. */
export interface Network {
  /** Per node, the edges out of it. */
  readonly out: readonly (readonly Edge[])[];
  /** Per node, what a whole read of it reaches (`Graph.exportsOf`). */
  readonly exportsOf: readonly (readonly number[])[];
  /** The edges callers the analysis read but does not hold make, each a caller outside. */
  readonly consumed: readonly Edge[];
}

/** The step a walk first reached one node by. */
export type Step<Origin> =
  | { readonly k: "seed"; readonly origin: Origin }
  | { readonly k: "reference"; readonly from: number; readonly edge: Edge }
  | { readonly k: "export"; readonly from: number; readonly edge: Edge };

/** One node a walk starts from. */
export interface Seed<Origin> {
  readonly at: number;
  /** Whether it walks the holding tier, which `follows` may admit more edges in. */
  readonly holds: boolean;
  /** Whether code the analysis does not see uses it, which reads whole what it re-exports. */
  readonly used: boolean;
  /** Whether it is a root, whose re-exports pass on what they name (references-ts.4). */
  readonly passes?: boolean;
  readonly origin: Origin;
}

/** What one walk starts from and follows. */
export interface Walk<Origin> {
  /** In order: a path is the shortest from the earliest seed. */
  readonly seeds: readonly Seed<Origin>[];
  /** Whether one edge is followed out of `from`, {@link OUTSIDE} for a consumed one, in a tier. */
  readonly follows: (edge: Edge, from: number, holds: boolean) => boolean;
  /** Per node, the seeds that join once it is reached and `opens` says it opens. */
  readonly gated?: ReadonlyMap<number, readonly Seed<Origin>[]>;
  readonly opens?: (at: number) => boolean;
  /** False where a whole read reaches its target alone. */
  readonly expands?: boolean;
}

/** What one walk reached, how, and which gates opened. */
export interface Walked<Origin> {
  readonly reached: readonly boolean[];
  /** Per node, whether code the analysis does not see may use it, in either tier. */
  readonly used: readonly boolean[];
  /** Per node, whether a re-export {@link Seed.passes} or passed passes it on, or what holds it. */
  readonly passed: readonly boolean[];
  readonly by: readonly (Step<Origin> | undefined)[];
  readonly opened: ReadonlySet<number>;
}

const REACHED = 1;
const USED = 2;
const WHOLE = 3;
const PASSED = 4;

/**
 * Walks one network. An edge that reads `whole` enters its target whole; one that `passes` enters
 * it passed where its source passes on (a seed that {@link Seed.passes}, a node passed, or a caller
 * outside), whole where its source is otherwise used, and reached elsewhere; any other edge enters
 * it reached. A node entered whole or passed enters each export at its own level. A node entered
 * at a higher level, or passing where it was not, is walked again, so the order the edges arrive
 * in decides nothing, and each node is walked at most once per tier, level and passing.
 * The seeds' first hops precede the consumed edges.
 */
export function walk<Origin>(network: Network, plan: Walk<Origin>): Walked<Origin> {
  const size = network.out.length;
  const reached = Array.from({ length: size }, () => false);
  const levels = [new Uint8Array(size), new Uint8Array(size)] as const;
  const passing = [new Uint8Array(size), new Uint8Array(size)] as const;
  const by: (Step<Origin> | undefined)[] = Array.from({ length: size }, () => undefined);
  const opened = new Set<number>();
  const queue: {
    readonly at: number;
    readonly holds: boolean;
    readonly level: number;
    readonly passes: boolean;
  }[] = [];
  const expands = plan.expands ?? true;

  const enter = (
    at: number,
    holds: boolean,
    level: number,
    step: Step<Origin>,
    seeded = false,
  ): void => {
    if (at === OUTSIDE) {
      return;
    }
    if (!reached[at]) {
      reached[at] = true;
      by[at] = step;
      const gate = plan.gated?.get(at);
      if (gate !== undefined && plan.opens?.(at) !== false) {
        opened.add(at);
        for (const seed of gate) {
          enter(
            seed.at,
            seed.holds,
            seed.used ? USED : REACHED,
            { k: "seed", origin: seed.origin },
            seed.passes === true,
          );
        }
      }
    }
    const passes = seeded || level === PASSED;
    // The holding tier follows every edge the other does, so its state stands for both.
    const walked = (tier: 0 | 1): boolean =>
      (levels[tier][at] ?? 0) >= level && (!passes || passing[tier][at] === 1);
    if (walked(1) || (!holds && walked(0))) {
      return;
    }
    const tier = holds ? 1 : 0;
    levels[tier][at] = Math.max(levels[tier][at] ?? 0, level);
    passing[tier][at] = passes || passing[tier][at] === 1 ? 1 : 0;
    queue.push({ at, holds, level: levels[tier][at] ?? level, passes: passing[tier][at] === 1 });
    if (level >= WHOLE && expands) {
      const exported: Step<Origin> =
        step.k === "seed" ? step : { k: "export", from: step.from, edge: step.edge };
      for (const one of network.exportsOf[at] ?? []) {
        enter(one, holds, level, exported);
      }
    }
  };
  const over = (edge: Edge, level: number, passes: boolean): number => {
    if (edge.reads === "passes") {
      return passes ? PASSED : level >= USED ? WHOLE : REACHED;
    }
    return edge.reads === "whole" ? WHOLE : REACHED;
  };

  for (const seed of plan.seeds) {
    enter(
      seed.at,
      seed.holds,
      seed.used ? USED : REACHED,
      { k: "seed", origin: seed.origin },
      seed.passes === true,
    );
  }
  const firstHops = queue.length;
  for (let head = 0; ; head += 1) {
    if (head === firstHops) {
      for (const edge of network.consumed) {
        if (plan.follows(edge, OUTSIDE, false)) {
          enter(edge.to, false, over(edge, USED, true), { k: "reference", from: OUTSIDE, edge });
        }
      }
    }
    const next = queue[head];
    if (next === undefined) {
      break;
    }
    for (const edge of network.out[next.at] ?? []) {
      if (plan.follows(edge, next.at, next.holds)) {
        enter(edge.to, next.holds, over(edge, next.level, next.passes), {
          k: "reference",
          from: next.at,
          edge,
        });
      }
    }
  }
  const level = (at: number): number => Math.max(levels[0][at] ?? 0, levels[1][at] ?? 0);
  return {
    reached,
    used: reached.map((_one, at) => level(at) >= USED),
    passed: reached.map((_one, at) => level(at) === PASSED),
    by,
    opened,
  };
}
