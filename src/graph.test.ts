import { describe, expect, it } from "vitest";
import { contractDocument } from "../__test-helpers__/fixtures.ts";
import { graphOf, OUTSIDE, swept } from "./graph.ts";
import type { InventorySymbol, SymbolKind } from "./inventory.ts";
import type { Reference } from "./references.ts";
import type { Root } from "./roots.ts";

/**
 * Every kind of declaration the inventory enumerates. The record's type makes the list
 * whole: a kind the inventory gains fails the type check here until it is listed.
 */
const KINDS: Readonly<Record<SymbolKind, true>> = {
  file: true,
  function: true,
  class: true,
  interface: true,
  type: true,
  enum: true,
  namespace: true,
  variable: true,
  "export-alias": true,
  method: true,
  "class-member": true,
  "interface-method": true,
  "type-member": true,
  "enum-member": true,
  "type-parameter": true,
};

/** The subject kinds the finding schema gives no liveness relation. */
function relationless(): ReadonlySet<string> {
  const schema = contractDocument("finding.schema.json") as {
    allOf: {
      if?: {
        anyOf?: { properties?: { symbol?: { properties?: { kind?: { enum?: string[] } } } } }[];
      };
      then?: { not?: { required?: string[] } };
    }[];
  };
  const branch = schema.allOf.find((rule) => rule.then?.not?.required?.[0] === "liveness_relation");
  return new Set(branch?.if?.anyOf?.[0]?.properties?.symbol?.properties?.kind?.enum ?? []);
}

describe("the kinds the sweep judges", () => {
  it("are every kind but the ones the finding schema gives no liveness relation", () => {
    const absent = relationless();
    const kinds = Object.keys(KINDS) as SymbolKind[];

    expect(absent.size, "the schema's list is read, not assumed empty").toBeGreaterThan(0);
    expect(
      kinds.filter((kind) => swept(kind) === absent.has(kind)),
      "a kind is judged exactly when a finding about it carries the relation that judged it",
    ).toEqual([]);
  });
});

/** One declaration of `src/a.ts` at its own line, inside the container given. */
function declared(
  name: string,
  kind: SymbolKind,
  line: number,
  parent: string,
  exported = false,
): InventorySymbol {
  return {
    id: `src/a.ts:${String(line)}:1`,
    ref: `ts://@example/memory/src/a.ts#${name}`,
    name,
    kind,
    position: { path: "src/a.ts", line, column: 1 },
    endLine: line,
    parent,
    exported,
    visibility: "public",
    static: false,
  };
}

const FILE = declared("src/a.ts", "file", 1, "");
const USED = declared("used", "function", 2, FILE.id, true);
const HELPER = declared("helper", "function", 3, FILE.id);
const SPACE = declared("Space", "namespace", 4, FILE.id, true);
const INNER = declared("inner", "function", 5, SPACE.id, true);
const SYMBOLS = [FILE, USED, HELPER, SPACE, INNER];

/** A declaration of another file, which the inventory does not hold. */
const UNHELD = "src/b.ts:2:1";

/** One read from one declaration's id to another's. */
function reference(from: string, to: string, extra: Partial<Reference> = {}): Reference {
  return {
    from,
    to,
    position: { path: "src/a.ts", line: 1, column: 1 },
    use: "read",
    resolution: "batch",
    test: false,
    ...extra,
  };
}

describe("the graph of one project", () => {
  it("drops a reference to a declaration it does not hold, and counts one made from such a declaration", () => {
    const graph = graphOf(
      SYMBOLS,
      [reference(USED.id, UNHELD), reference(UNHELD, HELPER.id), reference(USED.id, HELPER.id)],
      [],
      [],
    );

    expect(graph.out).toEqual([[], [{ to: 2, test: false, evaluation: false }], [], [], []]);
    expect(graph.made.map((counts) => counts.production)).toEqual([0, 0, 2, 0, 0]);
    expect(graph.consumed).toEqual([]);
  });

  it("holds the references a consumer or an unheld file makes apart from every declaration's own", () => {
    const graph = graphOf(
      SYMBOLS,
      [
        reference(USED.id, HELPER.id, { consumer: "@example/consumer" }),
        reference(UNHELD, INNER.id, { unheld: true, test: true }),
      ],
      [],
      [],
    );

    expect(graph.out).toEqual([[], [], [], [], []]);
    expect(graph.consumed).toEqual([
      { to: 2, test: false, evaluation: false },
      { to: 4, test: true, evaluation: false },
    ]);
    expect(graph.made[4]).toEqual({ production: 0, test: 1 });
  });

  it("lists under a file only the declarations its export table names, and under no other container", () => {
    const graph = graphOf(SYMBOLS, [], [], []);

    expect(graph.parent).toEqual([OUTSIDE, 0, 0, 0, 3]);
    expect(graph.exportsOf).toEqual([[1, 3], [], [], [], []]);
  });

  it("roots only a declaration it holds", () => {
    const roots: Root[] = [
      { id: UNHELD, kind: "entry-file", source: "src/b.ts" },
      { id: USED.id, kind: "published-api", source: "" },
    ];

    expect(graphOf(SYMBOLS, [], roots, []).rooted).toEqual([{ at: 1, kind: "published-api" }]);
  });
});
