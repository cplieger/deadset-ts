import { describe, expect, it } from "vitest";
import { OUTSIDE, type Edge, type Reads } from "./graph.ts";
import { walk, type Network, type Seed, type Walk } from "./reach.ts";

/** One edge to `to`, reading what `reads` says beyond it. */
const edge = (to: number, reads: Reads = "whole"): Edge => ({
  to,
  reference: OUTSIDE,
  test: false,
  guessed: false,
  reads,
  consumer: false,
});

/** A seed at `at`, used by unseen callers where `used`. */
const seed = (at: number, used = true, holds = false): Seed<string> => ({
  at,
  holds,
  used,
  origin: `seed ${String(at)}`,
});

/** A root at `at`, whose re-exports pass on what they name. */
const rooted = (at: number): Seed<string> => ({ ...seed(at), passes: true });

/** A network over `size` nodes holding `edges` as `[from, edge]` pairs. */
const network = (
  size: number,
  edges: readonly (readonly [number, Edge])[],
  exportsOf: Readonly<Record<number, readonly number[]>> = {},
  consumed: readonly Edge[] = [],
): Network => {
  const out: Edge[][] = Array.from({ length: size }, () => []);
  for (const [from, one] of edges) {
    out[from]?.push(one);
  }
  return {
    out,
    exportsOf: Array.from({ length: size }, (_one, at) => exportsOf[at] ?? []),
    consumed,
  };
};

/** The nodes one walk reaches and uses, each by position, ascending. */
const walked = (
  over: Network,
  plan: Partial<Walk<string>> & Pick<Walk<string>, "seeds">,
): { readonly reached: readonly number[]; readonly used: readonly number[] } => {
  const result = walk(over, { follows: () => true, ...plan });
  const positions = (flags: readonly boolean[]): number[] =>
    flags.flatMap((flag, at) => (flag ? [at] : []));
  return { reached: positions(result.reached), used: positions(result.used) };
};

// Nodes of the networks below: a root file, a barrel, a generated file and its two exports,
// a holder variable, and a reader.
const ROOT = 0;
const BARREL = 1;
const GEN = 2;
const A = 3;
const B = 4;
const HOLDER = 5;
const READER = 6;
const EXPORTS = { [GEN]: [A, B] };

describe("the one reachability", () => {
  it("passes a re-export on whole from a used seed through every hop, a file reaching its exports", () => {
    expect(
      walked(
        network(
          7,
          [
            [ROOT, edge(BARREL, "passes")],
            [BARREL, edge(GEN, "passes")],
          ],
          EXPORTS,
        ),
        { seeds: [seed(ROOT)] },
      ),
    ).toEqual({ reached: [ROOT, BARREL, GEN, A, B], used: [ROOT, BARREL, GEN, A, B] });
  });

  it("passes a re-export on whole once its source is used, whatever order the edges arrive in", () => {
    const over = network(
      7,
      [
        [HOLDER, edge(GEN, "passes")],
        [READER, edge(HOLDER)],
      ],
      EXPORTS,
    );
    for (const seeds of [
      [seed(HOLDER, false), seed(READER, false)],
      [seed(READER, false), seed(HOLDER, false)],
    ]) {
      expect(walked(over, { seeds })).toEqual({
        reached: [GEN, A, B, HOLDER, READER],
        used: [GEN, A, B, HOLDER],
      });
    }
  });

  it("reaches no export of a used seed file, whose exports the root set roots on their own, and every export a whole read names", () => {
    expect(walked(network(7, [], EXPORTS), { seeds: [seed(GEN)] })).toEqual({
      reached: [GEN],
      used: [GEN],
    });
    expect(
      walked(network(7, [[READER, edge(GEN)]], EXPORTS), { seeds: [seed(READER, false)] }),
    ).toEqual({ reached: [GEN, A, B, READER], used: [GEN, A, B] });
  });

  it("records as passed what a root's or a caller outside's re-export passes on, through every hop and export, and nothing a held seed, a reached one or a whole read reaches", () => {
    const passed = (edges: readonly (readonly [number, Edge])[], seeds: Seed<string>[]): number[] =>
      walk(network(7, edges, EXPORTS), { follows: () => true, seeds }).passed.flatMap((flag, at) =>
        flag ? [at] : [],
      );
    const chain: [number, Edge][] = [
      [ROOT, edge(BARREL, "passes")],
      [BARREL, edge(GEN, "passes")],
    ];
    expect(passed(chain, [rooted(ROOT)]), "from a root").toEqual([BARREL, GEN, A, B]);
    expect(passed(chain, [seed(ROOT)]), "from a held seed").toEqual([]);
    expect(
      walked(network(7, chain, EXPORTS), { seeds: [seed(ROOT)] }),
      "a held seed's re-export reads whole what it names",
    ).toEqual({ reached: [ROOT, BARREL, GEN, A, B], used: [ROOT, BARREL, GEN, A, B] });
    expect(passed(chain, [seed(ROOT), rooted(ROOT)]), "a root beside a held seed").toEqual([
      BARREL,
      GEN,
      A,
      B,
    ]);
    expect(passed(chain, [seed(ROOT, false)]), "from a reached one").toEqual([]);
    expect(passed([[READER, edge(GEN)]], [seed(READER)]), "a whole read").toEqual([]);
    expect(
      walk(network(7, [], EXPORTS, [edge(GEN, "passes")]), { follows: () => true, seeds: [] })
        .passed[A],
      "from a caller outside",
    ).toBe(true);
  });

  it("passes nothing on from a holder only a judged read reaches, and everything from one a read no rule judged names", () => {
    const passes: [number, Edge] = [HOLDER, edge(GEN, "passes")];
    expect(
      walked(network(7, [passes, [READER, edge(HOLDER, "none")]], EXPORTS), {
        seeds: [seed(READER, false)],
      }),
    ).toEqual({ reached: [GEN, HOLDER, READER], used: [] });
    expect(
      walked(network(7, [passes, [READER, edge(HOLDER)]], EXPORTS), {
        seeds: [seed(READER, false)],
      }),
    ).toEqual({ reached: [GEN, A, B, HOLDER, READER], used: [GEN, A, B, HOLDER] });
  });

  it("reaches its target alone through a judged read, and what a caller outside's re-export passes on whole", () => {
    expect(
      walked(network(7, [[READER, edge(GEN, "none")]], EXPORTS), { seeds: [seed(READER)] }),
    ).toEqual({ reached: [GEN, READER], used: [READER] });
    expect(walked(network(7, [], EXPORTS, [edge(GEN, "passes")]), { seeds: [] })).toEqual({
      reached: [GEN, A, B],
      used: [GEN, A, B],
    });
    expect(
      walked(network(7, [], EXPORTS, [edge(GEN, "passes")]), {
        seeds: [],
        follows: (_one, from) => from !== OUTSIDE,
      }),
      "a consumed edge `follows` refuses is not walked",
    ).toEqual({ reached: [], used: [] });
  });

  it("reaches what a whole read of a namespace exports, a holder among them passing its object on (references-ts.4)", () => {
    const SPACE = 1;
    const over = network(
      7,
      [
        [READER, edge(SPACE)],
        [HOLDER, edge(GEN, "passes")],
      ],
      { [SPACE]: [HOLDER], [GEN]: [A, B] },
    );
    expect(walked(over, { seeds: [seed(READER, false)] })).toEqual({
      reached: [SPACE, GEN, A, B, HOLDER, READER],
      used: [SPACE, GEN, A, B, HOLDER],
    });
    expect(
      walked(over, { seeds: [seed(READER, false)], expands: false }),
      "where whole reads do not expand, the read reaches the namespace alone",
    ).toEqual({ reached: [SPACE, READER], used: [SPACE] });
  });

  it("follows in the holding tier the edges `follows` admits there alone, and joins a gate's seeds once its node is reached and opens", () => {
    const over = network(7, [
      [ROOT, edge(BARREL)],
      [BARREL, edge(GEN)],
    ]);
    const follows: Walk<string>["follows"] = (one, _from, holds) => holds || one.to !== GEN;
    expect(walked(over, { seeds: [seed(ROOT)], follows }).reached).toEqual([ROOT, BARREL]);
    expect(walked(over, { seeds: [seed(ROOT, true, true)], follows }).reached).toEqual([
      ROOT,
      BARREL,
      GEN,
    ]);
    const gated = new Map([[BARREL, [seed(READER)]]]);
    expect(walked(over, { seeds: [seed(ROOT)], follows, gated }).reached).toEqual([
      ROOT,
      BARREL,
      READER,
    ]);
    expect(
      walked(over, { seeds: [seed(ROOT)], follows, gated, opens: () => false }).reached,
    ).toEqual([ROOT, BARREL]);
  });

  it("records the step that first reached each node, the seeds' first hops before a consumed edge", () => {
    const result = walk(network(7, [[ROOT, edge(BARREL)]], {}, [edge(BARREL), edge(GEN)]), {
      seeds: [seed(ROOT)],
      follows: () => true,
    });
    expect(result.by[ROOT]).toEqual({ k: "seed", origin: "seed 0" });
    expect(result.by[BARREL]).toMatchObject({ k: "reference", from: ROOT });
    expect(result.by[GEN]).toMatchObject({ k: "reference", from: OUTSIDE });
  });

  it("asks of each edge at most once per tier and level, so its work is linear in the edges", () => {
    // A chain each of whose nodes is entered at every level, in rising order: reached through
    // a judged read, used as a seed later in the list, then whole through a read of the chain's
    // head no rule judged. A walk per arrival would ask of each edge once per arrival.
    const asked = (size: number): number => {
      const edges: [number, Edge][] = [];
      for (let at = 0; at + 1 < size; at += 1) {
        edges.push([at, edge(at + 1, "passes")]);
      }
      edges.push([size, edge(0)]);
      let count = 0;
      walk(network(size + 1, edges), {
        seeds: [
          ...Array.from({ length: size }, (_one, at) => seed(at, false)),
          ...Array.from({ length: size }, (_one, at) => seed(at)),
          seed(size, false),
        ],
        follows: () => {
          count += 1;
          return true;
        },
      });
      return count;
    };
    const [small, large] = [asked(100), asked(200)];
    expect(
      large,
      `asks at 100 and 200 nodes: ${String(small)}, ${String(large)}`,
    ).toBeLessThanOrEqual(2 * small + 2);
    expect(small).toBeLessThanOrEqual(3 * 100);
  });
});
