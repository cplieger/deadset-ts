/**
 * The carrier sweep of a facts document (`bindings.11` to `bindings.15`): the run's one walk
 * (`reach.ts`) over the production graph, seeded by no declaration of a generated file, so
 * what it reaches is what hand-written code reaches. It follows no write, test reference or
 * reference an opaque generated declaration makes, follows the schema reads, and follows
 * the references written inside a generated member no inventory symbol is only once that
 * member is read (`bindings.12`).
 */

import { writtenIn, type Member } from "../bindings.ts";
import type { Exemption } from "../exemptions/lifecycle.ts";
import type { MemberRead, SchemaRead } from "../schema-reads.ts";
import { edgeWithheldBy, type Mode } from "../tests/file-class.ts";
import { OUTSIDE, type Edge, type Graph } from "./graph.ts";
import { walk } from "./reach.ts";

/** What the carrier sweep reads beside the graph. */
export interface Carrier {
  /** The path of every generated file, as a declaration's position names it. */
  readonly generated: ReadonlySet<string>;
  /** The generated declarations whose references, and their members', are not followed. */
  readonly opaque: ReadonlySet<string>;
  /** The production sweep's records that hold; one counts where its evidence is hand-written. */
  readonly exempt: readonly Exemption[];
  /** The declarations an unanswered question could have kept live, which the sweep holds. */
  readonly held: readonly string[];
  /** The reads hand-written declarations make beside their references. */
  readonly reads: readonly SchemaRead[];
  /** The generated members no inventory symbol is, and the reads hand code makes of them. */
  readonly members: readonly Member[];
  readonly memberReads: readonly MemberRead[];
  readonly mode: Mode;
}

/** What the carrier sweep reaches: declarations of the graph by identifier, members by key. */
interface Carried {
  readonly declaration: (id: string) => boolean;
  readonly member: (key: string) => boolean;
}

/** The carrier sweep over one graph. */
export function carry(graph: Graph, carrier: Carrier): Carried {
  const mode: Mode = { ...carrier.mode, production: true };
  const testPaths = new Set(
    graph.symbols.flatMap((symbol, at) =>
      graph.test[at] === true || graph.support[at] === true ? [symbol.position.path] : [],
    ),
  );
  const handProduction = (at: number): boolean =>
    !carrier.generated.has(graph.symbols[at]?.position.path ?? "") && graph.test[at] !== true;
  const opaque: (boolean | undefined)[] = graph.symbols.map(() => undefined);
  const isOpaque = (at: number): boolean => {
    const known = opaque[at];
    if (known !== undefined) {
      return known;
    }
    const parent = graph.parent[at] ?? OUTSIDE;
    const found =
      carrier.opaque.has(graph.symbols[at]?.id ?? "") || (parent !== OUTSIDE && isOpaque(parent));
    opaque[at] = found;
    return found;
  };

  // A member's node sits after the graph's declarations, at its place in `members`.
  const members = [...new Map(carrier.members.map((one) => [one.key, one])).values()];
  const memberAt = new Map(members.map((one, at) => [one.key, graph.symbols.length + at]));
  const within = members.map((one) => graph.at(one.within));
  const memberOut: Edge[][] = members.map(() => []);
  const out: (readonly Edge[])[] = [...graph.out, ...memberOut];
  const held = new Map<number, { readonly member: Member; readonly at: number }[]>();
  for (const [at, member] of members.entries()) {
    const holder = within[at] ?? OUTSIDE;
    const inside = held.get(holder) ?? [];
    inside.push({ member, at });
    held.set(holder, inside);
  }
  for (const [holder, inside] of held) {
    if (holder === OUTSIDE) {
      continue;
    }
    // Spans nest, so the member a reference is written in is the one starting last.
    inside.sort(
      (a, b) =>
        b.member.start.line - a.member.start.line || b.member.start.column - a.member.start.column,
    );
    const own: Edge[] = [];
    for (const edge of out[holder] ?? []) {
      const reference = graph.references[edge.reference];
      const owner =
        reference === undefined
          ? undefined
          : inside.find((one) => writtenIn(one.member, reference));
      if (owner === undefined) {
        own.push(edge);
      } else {
        memberOut[owner.at]?.push(edge);
      }
    }
    out[holder] = own;
  }
  // A schema read reaches the field, message or member it reads, and nothing beyond it.
  const reads: Edge[][] = out.map(() => []);
  const read = (from: number, to: number | undefined): void => {
    if (to !== undefined && to !== OUTSIDE) {
      reads[from]?.push({
        to,
        reference: OUTSIDE,
        test: false,
        guessed: false,
        reads: "none",
        consumer: false,
      });
    }
  };
  for (const one of carrier.reads) {
    read(graph.at(one.from), graph.at(one.to));
  }
  for (const one of carrier.memberReads) {
    read(graph.at(one.from), memberAt.get(one.member));
  }
  const sealed = (at: number): boolean => {
    const declaration =
      at < graph.symbols.length ? at : (within[at - graph.symbols.length] ?? OUTSIDE);
    return declaration !== OUTSIDE && isOpaque(declaration);
  };
  const write = (reference: number): boolean => graph.references[reference]?.use === "write";
  const handSeeds = [
    ...graph.rooted.flatMap((rooted) => (handProduction(rooted.at) ? [rooted.at] : [])),
    ...carrier.exempt.flatMap((record) =>
      carrier.generated.has(record.site.path) || testPaths.has(record.site.path)
        ? []
        : [graph.at(record.id)],
    ),
    ...carrier.held.map((id) => graph.at(id)).filter(handProduction),
  ];
  const { reached } = walk(
    {
      out: out.map((edges, at) => [...edges, ...(reads[at] ?? [])]),
      exportsOf: [...graph.exportsOf, ...members.map(() => [])],
      consumed: graph.consumed,
    },
    {
      seeds: handSeeds.map((at) => ({ at, holds: false, used: true, origin: undefined })),
      follows: (edge, from) =>
        !edgeWithheldBy(mode, edge) &&
        !write(edge.reference) &&
        (from === OUTSIDE || !sealed(from)),
    },
  );
  return {
    declaration: (id) => {
      const at = graph.at(id);
      return at !== OUTSIDE && reached[at] === true;
    },
    member: (key) => {
      const at = memberAt.get(key);
      return at !== undefined && reached[at] === true;
    },
  };
}
