/**
 * The dead components of one graph: the strongly connected components of the subgraph
 * the dead declarations induce, ordered so a report is worked from the top down, each
 * with the root members a deletion starts at and what falls with it.
 */

import type { Cascade } from "./config.ts";
import { OUTSIDE, type Graph } from "./graph.ts";
import type { InventorySymbol } from "./inventory.ts";

/** The name every component identifier this analyzer mints starts with. */
const ANALYZER = "deadset-ts";

/** The fewest digits a component identifier's number is written with. */
const ID_DIGITS = 4;

/** The index of a declaration the component walk has not reached. */
const UNVISITED = -1;

/** One dead component and its place in the acyclic graph over the components. */
export interface Component {
  /** The analyzer's name, a solidus, and `c-` followed by the component's place in the order. */
  readonly id: string;
  /** The component's declarations, by site. A dead member of a dead container is one of them. */
  readonly members: readonly string[];
  /**
   * The members no other dead component references and whose container is not dead,
   * which are where a deletion starts. A cycle has as many as it has members no dead
   * component outside it references.
   */
  readonly roots: readonly string[];
  /**
   * What one deletion of the component removes: its members, and every dead declaration
   * only this component reaches. A dead declaration two components both reach falls with
   * neither and is counted by its own component.
   */
  readonly falls: readonly string[];
  /** The source lines the deletion removes: the distinct lines {@link Component.falls} spans. */
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

/** What a report carries for one component: its roots and what falls, and its members in full. */
export function listing(component: Component, cascade: Cascade): Listing {
  return {
    roots: component.roots,
    members: cascade === "full" ? component.members : [],
    symbolCount: component.falls.length,
    deletableLines: component.deletableLines,
  };
}

/**
 * Groups the declarations `dead` marks into components and orders them so each precedes
 * every component it reaches, two that neither reaches ordered by their first member's
 * site. `dead` and `testOfDeadCode` hold one flag per declaration of the graph; the dead
 * set arrives rather than being read from a sweep, so a set several sweeps intersect is
 * grouped over this graph's edges the same way.
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
  const { edges, into } = condense(adjacent, componentOf, members.length);
  const falls = fallSets(edges, members, into);
  const outsideReference = externallyReferenced(adjacent, componentOf);
  const idOf = (position: number): string => graph.symbols[at[position] ?? 0]?.id ?? "";

  return order(edges, members).map((group, place) => {
    const own = members[group] ?? [];
    const roots = own.filter((position) => {
      // A dead member of a dead container is never a root: the container is where the
      // deletion starts and the member falls with it.
      const container = graph.parent[at[position] ?? 0] ?? OUTSIDE;
      return outsideReference[position] !== true && dead[container] !== true;
    });
    const fallen = falls[group] ?? [];
    return {
      id: `${ANALYZER}/c-${String(place + 1).padStart(ID_DIGITS, "0")}`,
      members: own.map(idOf),
      roots: roots.map(idOf),
      falls: fallen.map(idOf),
      deletableLines: linesSpanned(fallen.map((position) => graph.symbols[at[position] ?? 0])),
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
 * Each declaration's component and each component's members by site, by Tarjan's
 * algorithm in one pass. The walk keeps its own stack of frames, so a chain of any length
 * is walked without growing the call stack. Components are closed in an order in which
 * each follows every component it reaches.
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

/**
 * Per component, the components it reaches in one step, and how many components reach
 * it, each pair counted once. An edge inside a component is not an edge between two, so
 * the result is acyclic.
 */
function condense(
  adjacent: readonly (readonly number[])[],
  componentOf: readonly number[],
  count: number,
): { readonly edges: readonly (readonly number[])[]; readonly into: readonly number[] } {
  const edges: number[][] = Array.from({ length: count }, () => []);
  const into = Array.from({ length: count }, () => 0);
  const seen = new Set<string>();
  adjacent.forEach((targets, from) => {
    for (const to of targets) {
      const a = componentOf[from] ?? 0;
      const b = componentOf[to] ?? 0;
      const pair = `${String(a)}>${String(b)}`;
      if (a === b || seen.has(pair)) {
        continue;
      }
      seen.add(pair);
      edges[a]?.push(b);
      into[b] = (into[b] ?? 0) + 1;
    }
  });
  return { edges, into };
}

/** Per dead declaration, whether a dead component other than its own references it. */
function externallyReferenced(
  adjacent: readonly (readonly number[])[],
  componentOf: readonly number[],
): readonly boolean[] {
  const referenced = adjacent.map(() => false);
  adjacent.forEach((targets, from) => {
    for (const to of targets) {
      if (componentOf[from] !== componentOf[to]) {
        referenced[to] = true;
      }
    }
  });
  return referenced;
}

/**
 * The components in the order a report is worked in. Tarjan closes each component after
 * every one it reaches, so reading the closing order backwards is a topological order,
 * and one pass over it gives each component its depth below the roots.
 */
function order(
  edges: readonly (readonly number[])[],
  members: readonly (readonly number[])[],
): readonly number[] {
  const sequence = edges.map((_targets, component) => component).reverse();
  const depth = edges.map(() => 0);
  for (const from of sequence) {
    for (const to of edges[from] ?? []) {
      depth[to] = Math.max(depth[to] ?? 0, (depth[from] ?? 0) + 1);
    }
  }
  return sequence.sort(
    (a, b) => (depth[a] ?? 0) - (depth[b] ?? 0) || (members[a]?.[0] ?? 0) - (members[b]?.[0] ?? 0),
  );
}

/**
 * Per component, the dead declarations one deletion of it removes. A root of the
 * condensation carries its members and every component only it reaches; any other
 * component carries its own members alone, because what it reaches is reached through a
 * root above it as well.
 */
function fallSets(
  edges: readonly (readonly number[])[],
  members: readonly (readonly number[])[],
  into: readonly number[],
): readonly (readonly number[])[] {
  // Each root's walk stamps what it reaches with the root's own number, so the walks
  // share one array rather than allocating one per root.
  const stamp = edges.map(() => UNVISITED);
  const reach = new Map<number, readonly number[]>();
  const owners = edges.map(() => 0);
  edges.forEach((_targets, root) => {
    if (into[root] !== 0) {
      return;
    }
    const reached = [root];
    stamp[root] = root;
    // An array's iterator reads its length at every step, so what a step pushes is
    // walked in the same loop.
    for (const at of reached) {
      for (const to of edges[at] ?? []) {
        if (stamp[to] !== root) {
          stamp[to] = root;
          reached.push(to);
        }
      }
    }
    reach.set(root, reached);
    for (const component of reached) {
      owners[component] = (owners[component] ?? 0) + 1;
    }
  });
  return members.map((own, component) => {
    const set = [...own];
    for (const other of reach.get(component) ?? []) {
      if (other !== component && owners[other] === 1) {
        set.push(...(members[other] ?? []));
      }
    }
    return set.sort((a, b) => a - b);
  });
}
