/**
 * Declared cross-language edges: the sides of the target's edges document that name a
 * symbol of this language, and the evaluation the report publishes for each. This analyzer
 * never resolves the paired symbol: the other language's analyzer decides whether the
 * pairing is a use, and the merge reads the two evaluations together.
 */

import { ConfigError } from "./config.ts";
import type { Finding } from "./finding.ts";
import type { EdgeSide, EdgeSideName } from "./findings/boundary.ts";
import type { Host } from "./host.ts";
import type { InventorySymbol } from "./inventory.ts";
import { positionAt, walkDocument } from "./json-document.ts";
import { joinPath } from "./paths.ts";
import { positionKey } from "./position.ts";
import { isPartSubject } from "./suppress.ts";

/** The name and the location the Contract fixes for the edges document. */
export const EDGES_FILE = "deadset-edges.json";

/** The language prefix of every reference this analyzer evaluates. */
const OWN_PREFIX = "ts://";

/** The closed key list of the document and of one edge. */
const DOCUMENT_KEYS: ReadonlySet<string> = new Set(["description", "edges"]);
const EDGE_KEYS: ReadonlySet<string> = new Set(["id", "because", "provides", "used_by"]);

/** An edge identifier: solidus-separated segments of ASCII letters, digits, `_`, `.` and `-`. */
const ID_FORM = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u;

/** A reference naming one symbol of some language: `<language>://<scope>#<fragment>`. */
const REFERENCE_FORM = /^[a-z][a-z0-9]*:\/\/[^ \t\r\n#]+#[^ \t\r\n]*$/u;

const DOCUMENT_WANT = "an object carrying the edges array, and an optional description";
const EDGE_WANT = "an edge naming id, provides and used_by, each a string, and an optional because";
const ID_WANT =
  "one or more solidus-separated segments of ASCII letters, digits, underscore, full stop and hyphen";
const REFERENCE_WANT =
  "a stable symbol reference naming one symbol exactly, <language>://<scope>#<fragment>";

/** An edges document the Contract refuses: a malformed input, answered with the usage code. */
export class EdgesError extends ConfigError {
  constructor(at: string, text: string, want: string) {
    super("malformed", EDGES_FILE, `${at}: ${text}: want ${want}`);
    this.name = "EdgesError";
  }
}

/**
 * Whether a reference carries a wildcard outside a quoted or a computed component, which
 * would name a set of symbols rather than one.
 */
function carriesWildcard(ref: string): boolean {
  let quoted = false;
  let computed = false;
  let escaped = false;
  for (const char of ref) {
    if (escaped) {
      escaped = false;
    } else if (quoted && char === "\\") {
      escaped = true;
    } else if (quoted) {
      quoted = char !== "'";
    } else if (computed) {
      computed = char !== "]";
    } else if (char === "'") {
      quoted = true;
    } else if (char === "[") {
      computed = true;
    } else if (char === "*") {
      return true;
    }
  }
  return false;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One edge, checked: the closed key list, the value types and the value forms. */
function readEdge(value: unknown, at: string): { id: string; provides: string; usedBy: string } {
  const refuse = (text: string, want: string): never => {
    throw new EdgesError(at, text, want);
  };
  if (!isObject(value)) {
    return refuse(JSON.stringify(value), EDGE_WANT);
  }
  for (const [key, held] of Object.entries(value)) {
    if (!EDGE_KEYS.has(key) || typeof held !== "string") {
      refuse(`the member ${JSON.stringify(key)} holding ${JSON.stringify(held)}`, EDGE_WANT);
    }
  }
  const edge = value as Readonly<Record<string, string | undefined>>;
  const id = edge["id"] ?? refuse("an edge naming no id", EDGE_WANT);
  const provides = edge["provides"] ?? refuse("an edge naming no provides side", EDGE_WANT);
  const usedBy = edge["used_by"] ?? refuse("an edge naming no used_by side", EDGE_WANT);
  if (!ID_FORM.test(id)) {
    refuse(JSON.stringify(id), ID_WANT);
  }
  for (const ref of [provides, usedBy]) {
    if (!REFERENCE_FORM.test(ref) || carriesWildcard(ref)) {
      refuse(JSON.stringify(ref), REFERENCE_WANT);
    }
  }
  return { id, provides, usedBy };
}

/**
 * Every side of a declared edge that names a symbol of this language, in document order,
 * `provides` before `used_by` within an edge. An absent document declares no edge. The
 * document is strict JSON with a closed key list at both levels, and a defect in it is an
 * {@link EdgesError}.
 */
export function readEdgeSides(host: Host, targetRoot: string): readonly EdgeSide[] {
  const file = joinPath(targetRoot, EDGES_FILE);
  if (host.kindOf(file) === "absent") {
    return [];
  }
  const text = host.readFile(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    throw new EdgesError(
      EDGES_FILE,
      error instanceof Error ? error.message : String(error),
      DOCUMENT_WANT,
    );
  }
  if (!isObject(parsed)) {
    throw new EdgesError(EDGES_FILE, JSON.stringify(parsed), DOCUMENT_WANT);
  }
  const walk = walkDocument(text, "edges");
  if (walk.twice !== undefined) {
    throw new EdgesError(
      positionKey(positionAt(text, EDGES_FILE, walk.twice.offset)),
      `the member ${JSON.stringify(walk.twice.name)} is written twice, so neither value is chosen`,
      DOCUMENT_WANT,
    );
  }
  const unknown = Object.keys(parsed).find((key) => !DOCUMENT_KEYS.has(key));
  const description = parsed["description"];
  const edges = parsed["edges"];
  if (
    unknown !== undefined ||
    (description !== undefined && typeof description !== "string") ||
    !Array.isArray(edges)
  ) {
    throw new EdgesError(
      EDGES_FILE,
      unknown === undefined ? EDGES_FILE : `the member ${JSON.stringify(unknown)}`,
      DOCUMENT_WANT,
    );
  }

  const sides: EdgeSide[] = [];
  (edges as readonly unknown[]).forEach((value, index) => {
    const offset = walk.opened[index];
    const at =
      offset === undefined ? EDGES_FILE : positionKey(positionAt(text, EDGES_FILE, offset));
    const edge = readEdge(value, at);
    const named: readonly [EdgeSideName, string][] = [
      ["provides", edge.provides],
      ["used_by", edge.usedBy],
    ];
    for (const [side, symbol] of named) {
      if (symbol.startsWith(OWN_PREFIX)) {
        sides.push({ edge: edge.id, side, symbol });
      }
    }
  });
  return sides;
}

/** One side's verdict, as an evaluation names it. */
export type EdgeState = "live" | "dead" | "absent";

/** One edge evaluation: one side of this language, its state, and the finding it holds. */
export interface EdgeEvaluation<F extends Finding = Finding> extends EdgeSide {
  readonly state: EdgeState;
  /** Present exactly when the state is `dead`: the finding a live paired symbol cancels. */
  readonly finding?: F;
}

/** The findings a report publishes, and one evaluation per declared side of this language. */
export interface Evaluated<F extends Finding> {
  readonly findings: readonly F[];
  /** Ordered by edge, then by side, each compared bytewise. */
  readonly evaluations: readonly EdgeEvaluation<F>[];
}

/** Two strings ordered bytewise. */
function compare(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Evaluates every declared side of this language over the run's findings. A side naming a
 * symbol the run enumerates nothing under is `absent`; one naming a symbol the run holds a
 * finding about is `dead` and carries that finding, pending until a merge reads the other
 * side and reported nowhere else, a narrowing finding included; any other is `live`.
 */
export function evaluateEdges<F extends Finding>(
  findings: readonly F[],
  sides: readonly EdgeSide[],
  symbols: readonly InventorySymbol[],
): Evaluated<F> {
  if (sides.length === 0) {
    return { findings, evaluations: [] };
  }
  const byRef = new Map<string, string>();
  for (const symbol of symbols) {
    if (symbol.kind !== "file" && !byRef.has(symbol.ref)) {
      byRef.set(symbol.ref, symbol.id);
    }
  }
  const held = new Map<string, number>();
  findings.forEach((finding, at) => {
    if (!isPartSubject(finding.symbol.kind)) {
      held.set(positionKey(finding.position), at);
    }
  });

  const pending = new Set<number>();
  const evaluations = sides.map((side): EdgeEvaluation<F> => {
    const id = byRef.get(side.symbol);
    if (id === undefined) {
      return { ...side, state: "absent" };
    }
    const at = held.get(id);
    const finding = at === undefined ? undefined : findings[at];
    if (at === undefined || finding === undefined) {
      return { ...side, state: "live" };
    }
    pending.add(at);
    return { ...side, state: "dead", finding };
  });
  evaluations.sort((a, b) => compare(a.edge, b.edge) || compare(a.side, b.side));
  return { findings: findings.filter((_finding, at) => !pending.has(at)), evaluations };
}
