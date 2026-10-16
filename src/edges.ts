/**
 * Declared cross-language edges: the sides of the target's edges document that name a
 * symbol of this language, and the evaluation the report publishes for each. This analyzer
 * never resolves the paired symbol: the other language's analyzer decides whether the
 * pairing is a use, and the merge reads the two evaluations together.
 */

import { EDGES_SCHEMA } from "./contract/config.generated.ts";
import type { Finding } from "./finding.ts";
import type { EdgeSide, EdgeSideName } from "./findings/boundary.ts";
import { readTargetDocument } from "./fs/document.ts";
import type { Host } from "./host.ts";
import type { InventorySymbol } from "./inventory.ts";
import { dotted, placeIn, positionAt, readStrict, StrictJSONError } from "./json-document.ts";
import { positionKey } from "./position.ts";
import { firstRefusal } from "./schema.ts";
import { isPartSubject } from "./suppress.ts";
import { bytewise } from "./text/compare.ts";
import { UsageError } from "./usage.ts";

/** The name and the location the Contract fixes for the edges document. */
export const EDGES_FILE = "deadset-edges.json";

/** The language prefix of every reference this analyzer evaluates. */
const OWN_PREFIX = "ts://";

/** An edges document the Contract refuses: a malformed input, answered with the usage code. */
class EdgesError extends UsageError {
  constructor(at: string, reason: string) {
    super(`${at}: ${reason}`);
    this.name = "EdgesError";
  }
}

/** The sides of one edge, in the order a reader yields them. */
const SIDE_NAMES: readonly EdgeSideName[] = ["provides", "used_by"];

/**
 * Every side of a declared edge that names a symbol of this language, in document order,
 * `provides` before `used_by` within an edge. An absent document declares no edge. The
 * document is strict JSON held to the Contract's edges schema, and a defect in it is an
 * {@link EdgesError} at the line and column of the edge it is in, where it is in one.
 */
export function readEdgeSides(host: Host, targetRoot: string): readonly EdgeSide[] {
  const text = readTargetDocument(host, targetRoot, EDGES_FILE);
  if (text === undefined) {
    return [];
  }
  let read;
  try {
    read = readStrict(text, "edges");
  } catch (error: unknown) {
    if (!(error instanceof StrictJSONError)) {
      throw error;
    }
    throw new EdgesError(positionKey(positionAt(text, EDGES_FILE, error.offset)), error.message);
  }
  const value = read.value;
  const refused = firstRefusal(EDGES_SCHEMA, value);
  if (refused !== undefined) {
    const place = placeIn(value, refused.pointer, refused.member);
    const offset = place.length > 1 ? read.starts.get(place[1] ?? "") : undefined;
    const at =
      offset === undefined ? EDGES_FILE : positionKey(positionAt(text, EDGES_FILE, offset));
    const where = dotted(place);
    throw new EdgesError(at, where === "" ? refused.reason : `${where}: ${refused.reason}`);
  }
  const edges = (
    value as { readonly edges: Readonly<Record<string, Record<EdgeSideName, string>>> }
  ).edges;

  const sides: EdgeSide[] = [];
  for (const id of read.starts.keys()) {
    const edge = String(id);
    for (const side of SIDE_NAMES) {
      const symbol = edges[edge]?.[side];
      if (symbol?.startsWith(OWN_PREFIX) === true) {
        sides.push({ edge, side, symbol });
      }
    }
  }
  return sides;
}

/** One side's verdict, as an evaluation names it. */
type EdgeState = "live" | "dead" | "absent";

/** One edge evaluation: one side of this language, its state, and the finding it holds. */
export interface EdgeEvaluation<F extends Finding = Finding> extends EdgeSide {
  readonly state: EdgeState;
  /** Present exactly when the state is `dead`: the finding a live paired symbol cancels. */
  readonly finding?: F;
}

/** The findings a report publishes, and one evaluation per declared side of this language. */
interface Evaluated<F extends Finding> {
  readonly findings: readonly F[];
  /** Ordered by edge, then by side, each compared bytewise. */
  readonly evaluations: readonly EdgeEvaluation<F>[];
}

/**
 * Evaluates every declared side of this language over the run's findings. A side naming a
 * symbol the run enumerates nothing under is `absent`; otherwise it is evaluated once per
 * declaration its reference spells. A declaration the run holds a finding about is `dead`
 * and carries that finding, pending until a merge reads the other side and reported
 * nowhere else, a narrowing finding included; any other is `live`.
 */
export function evaluateEdges<F extends Finding>(
  findings: readonly F[],
  sides: readonly EdgeSide[],
  symbols: readonly InventorySymbol[],
): Evaluated<F> {
  if (sides.length === 0) {
    return { findings, evaluations: [] };
  }
  const byRef = new Map<string, string[]>();
  for (const symbol of symbols) {
    if (symbol.kind !== "file") {
      byRef.set(symbol.ref, [...(byRef.get(symbol.ref) ?? []), symbol.id]);
    }
  }
  const held = new Map<string, number>();
  findings.forEach((finding, at) => {
    if (!isPartSubject(finding.symbol.kind)) {
      held.set(positionKey(finding.position), at);
    }
  });

  const pending = new Set<number>();
  const evaluations = sides.flatMap((side): EdgeEvaluation<F>[] => {
    const ids = byRef.get(side.symbol);
    if (ids === undefined) {
      return [{ ...side, state: "absent" }];
    }
    return ids.map((id) => {
      const at = held.get(id);
      const finding = at === undefined ? undefined : findings[at];
      if (at === undefined || finding === undefined) {
        return { ...side, state: "live" };
      }
      pending.add(at);
      return { ...side, state: "dead", finding };
    });
  });
  evaluations.sort((a, b) => bytewise(a.edge, b.edge) || bytewise(a.side, b.side));
  return { findings: findings.filter((_finding, at) => !pending.has(at)), evaluations };
}
