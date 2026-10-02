/**
 * The dead components of one graph. A component is a set of dead declarations one
 * deletion removes together: its root members, which are where the deletion starts,
 * and every dead declaration that falls with them, being dead only through them.
 */

import type { Cascade } from "./config.ts";
import { OUTSIDE, type Graph } from "./graph.ts";
import type { InventorySymbol } from "./inventory.ts";

/** The name every component identifier this analyzer mints starts with. */
const ANALYZER = "deadset-ts";

/** The fewest digits a component identifier's number is written with. */
const ID_DIGITS = 4;

/** The identifier of the component at one place of the run's order, counted from one. */
export function componentId(place: number): string {
  return `${ANALYZER}/c-${String(place).padStart(ID_DIGITS, "0")}`;
}

/** The index of a declaration the component walk has not reached. */
const UNVISITED = -1;

/** One dead component. */
export interface Component {
  /** The analyzer's name, a solidus, and `c-` followed by the component's place in the order. */
  readonly id: string;
  /**
   * The component's declarations by site: its root members and every dead declaration
   * that falls with them. A dead member of a dead container is one of them.
   */
  readonly members: readonly string[];
  /**
   * The root members, by site. A root member is a member of a cycle no dead declaration
   * outside the cycle references, whose container is not dead; every member of such a
   * cycle with a live container is one, so a component has at least one.
   */
  readonly roots: readonly string[];
  /** The source lines one deletion of the component removes: the distinct lines its members span. */
  readonly deletableLines: number;
}

/** What a report carries for one dead component under one cascade mode. */
export interface Listing {
  readonly roots: readonly string[];
  /** Every member under the full mode, and nothing under the default one. */
  readonly members: readonly string[];
  readonly symbolCount: number;
  readonly deletableLines: number;
}

/** What a report carries for one component: its roots and counts, and its members in full. */
export function listing(component: Component, cascade: Cascade): Listing {
  return {
    roots: component.roots,
    members: cascade === "full" ? component.members : [],
    symbolCount: component.members.length,
    deletableLines: component.deletableLines,
  };
}

/**
 * Groups the declarations `dead` marks into components, ordered by their first member's
 * site; `dead` and `testOfDeadCode` hold one flag per declaration of the graph. Root
 * members sit on the cycles no other cycle references. A cycle two roots both reach is
 * dead only through both, so a component is a weakly connected part of the dead
 * subgraph: no dead declaration of one references a declaration of another.
 */
export function componentsOf(
  graph: Graph,
  dead: readonly boolean[],
  testOfDeadCode: readonly boolean[],
): readonly Component[] {
  const { at, adjacent } = deadSubgraph(graph, dead, testOfDeadCode);
  if (at.length === 0) {
    return [];
  }
  const { componentOf, members } = connected(adjacent);
  const referenced = referencedCycles(adjacent, componentOf, members.length);
  const groups = joined(adjacent);
  const idOf = (position: number): string => graph.symbols[at[position] ?? 0]?.id ?? "";

  return groups.map((group, place) => {
    const roots = group.filter((position) => {
      // A dead member's dead container is on the member's own cycle, and the container
      // is where the deletion starts.
      const container = graph.parent[at[position] ?? 0] ?? OUTSIDE;
      return referenced[componentOf[position] ?? 0] !== true && dead[container] !== true;
    });
    return {
      id: componentId(place + 1),
      members: group.map(idOf),
      roots: roots.map(idOf),
      deletableLines: linesSpanned(group.map((position) => graph.symbols[at[position] ?? 0])),
    };
  });
}

/**
 * The distinct source lines a set of declarations spans, each declaration at least the
 * line it starts on. A member written inside its container's span adds no line, because
 * deleting the container removes it.
 */
function linesSpanned(symbols: readonly (InventorySymbol | undefined)[]): number {
  const byPath = new Map<string, [number, number][]>();
  for (const symbol of symbols) {
    if (symbol === undefined) {
      continue;
    }
    const span: [number, number] = [
      symbol.position.line,
      Math.max(symbol.position.line, symbol.endLine),
    ];
    const spans = byPath.get(symbol.position.path);
    if (spans === undefined) {
      byPath.set(symbol.position.path, [span]);
    } else {
      spans.push(span);
    }
  }
  let total = 0;
  for (const spans of byPath.values()) {
    spans.sort((a, b) => a[0] - b[0]);
    let end = 0;
    for (const [first, last] of spans) {
      total += Math.max(0, last - Math.max(first - 1, end));
      end = Math.max(end, last);
    }
  }
  return total;
}

/**
 * The dead declarations by their place in the subgraph, and the edges between them: each
 * reference one makes to another, an edge each way between a dead member and its dead
 * container (one direction alone leaves the member a component the container reaches),
 * and an edge back from each production target of an admitted test, which puts the test in
 * the component of the code it exercises because a subject never references its test.
 */
function deadSubgraph(
  graph: Graph,
  dead: readonly boolean[],
  testOfDeadCode: readonly boolean[],
): { readonly at: readonly number[]; readonly adjacent: readonly (readonly number[])[] } {
  const at: number[] = [];
  const position = graph.symbols.map((_symbol, index) => {
    if (dead[index] !== true) {
      return UNVISITED;
    }
    at.push(index);
    return at.length - 1;
  });
  const adjacent: number[][] = at.map(() => []);
  at.forEach((index, from) => {
    for (const edge of graph.out[index] ?? []) {
      const to = position[edge.to] ?? UNVISITED;
      if (to === UNVISITED) {
        continue;
      }
      adjacent[from]?.push(to);
      if (
        testOfDeadCode[index] === true &&
        graph.test[edge.to] !== true &&
        graph.subject[edge.to] === true
      ) {
        adjacent[to]?.push(from);
      }
    }
    const container = position[graph.parent[index] ?? OUTSIDE] ?? UNVISITED;
    if (container !== UNVISITED) {
      adjacent[from]?.push(container);
      adjacent[container]?.push(from);
    }
  });
  return { at, adjacent };
}

/** One frame of the component walk: a declaration, and the next of its edges to follow. */
interface Frame {
  readonly at: number;
  next: number;
}

/**
 * Each declaration's cycle and each cycle's members by site, by Tarjan's
 * algorithm in one pass. The walk keeps its own stack of frames, so a chain of any length
 * is walked without growing the call stack.
 */
function connected(adjacent: readonly (readonly number[])[]): {
  readonly componentOf: readonly number[];
  readonly members: readonly (readonly number[])[];
} {
  const index = adjacent.map(() => UNVISITED);
  const low = adjacent.map(() => UNVISITED);
  const onStack = adjacent.map(() => false);
  const stack: number[] = [];
  const members: number[][] = [];
  let next = 0;

  const open = (at: number, frames: Frame[]): void => {
    index[at] = next;
    low[at] = next;
    next += 1;
    stack.push(at);
    onStack[at] = true;
    frames.push({ at, next: 0 });
  };

  adjacent.forEach((_edges, start) => {
    if (index[start] !== UNVISITED) {
      return;
    }
    const frames: Frame[] = [];
    open(start, frames);
    for (let frame = frames.at(-1); frame !== undefined; frame = frames.at(-1)) {
      const edges = adjacent[frame.at] ?? [];
      const to = edges[frame.next];
      if (to !== undefined) {
        frame.next += 1;
        if (index[to] === UNVISITED) {
          open(to, frames);
        } else if (onStack[to] === true) {
          low[frame.at] = Math.min(low[frame.at] ?? 0, index[to] ?? 0);
        }
        continue;
      }
      frames.pop();
      const parent = frames.at(-1);
      if (parent !== undefined) {
        low[parent.at] = Math.min(low[parent.at] ?? 0, low[frame.at] ?? 0);
      }
      if (low[frame.at] !== index[frame.at]) {
        continue;
      }
      const group: number[] = [];
      for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
        onStack[top] = false;
        group.push(top);
        if (top === frame.at) {
          break;
        }
      }
      members.push(group.sort((a, b) => a - b));
    }
  });

  const componentOf = adjacent.map(() => 0);
  members.forEach((group, component) => {
    for (const at of group) {
      componentOf[at] = component;
    }
  });
  return { componentOf, members };
}

/** Per cycle, whether a dead declaration outside it references one of its members. */
function referencedCycles(
  adjacent: readonly (readonly number[])[],
  componentOf: readonly number[],
  count: number,
): readonly boolean[] {
  const referenced = Array.from({ length: count }, () => false);
  adjacent.forEach((targets, from) => {
    for (const to of targets) {
      const cycle = componentOf[to] ?? 0;
      if (componentOf[from] !== cycle) {
        referenced[cycle] = true;
      }
    }
  });
  return referenced;
}

/**
 * The weakly connected parts of the dead subgraph, each its positions in ascending
 * order, ordered by their first position. Positions follow the graph's declaration
 * order, so a part's first position is its first member's site.
 */
function joined(adjacent: readonly (readonly number[])[]): readonly (readonly number[])[] {
  const leader = adjacent.map((_edges, position) => position);
  const find = (position: number): number => {
    let top = position;
    while ((leader[top] ?? top) !== top) {
      top = leader[top] ?? top;
    }
    // Every position on the walk points at the top afterwards, so a later find is short.
    for (let step = position; step !== top;) {
      const next = leader[step] ?? top;
      leader[step] = top;
      step = next;
    }
    return top;
  };
  adjacent.forEach((targets, from) => {
    for (const to of targets) {
      const a = find(from);
      const b = find(to);
      // The smaller position leads, so a part's leader is its first position.
      leader[Math.max(a, b)] = Math.min(a, b);
    }
  });
  const parts = new Map<number, number[]>();
  adjacent.forEach((_edges, position) => {
    const top = find(position);
    const part = parts.get(top);
    if (part === undefined) {
      parts.set(top, [position]);
    } else {
      part.push(position);
    }
  });
  return [...parts.values()];
}
