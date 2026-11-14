import { describe, expect, it } from "vitest";
import { contractDocument } from "../../__test-helpers__/fixtures.ts";
import { graphOf, OUTSIDE, swept } from "./graph.ts";
import type { InventorySymbol, SymbolKind } from "../inventory.ts";
import type { Reference } from "../references.ts";
import type { Root } from "../roots/root-set.ts";

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

describe("the graph of a run", () => {
  it("drops a reference to a declaration it does not hold, and counts one made from such a declaration", () => {
    const graph = graphOf(
      SYMBOLS,
      [reference(USED.id, UNHELD), reference(UNHELD, HELPER.id), reference(USED.id, HELPER.id)],
      [],
      [],
    );

    expect(graph.out).toEqual([
      [],
      [{ to: 2, reference: 2, test: false, guessed: false, reads: "whole", consumer: false }],
      [],
      [],
      [],
    ]);
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
      { to: 2, reference: 0, test: false, guessed: false, reads: "whole", consumer: true },
      { to: 4, reference: 1, test: true, guessed: false, reads: "whole", consumer: false },
    ]);
    expect(graph.made[4]).toEqual({ production: 0, test: 1, consumerTest: 0 });
  });

  it("counts a consumer's test reference as a test one, apart from the target's", () => {
    const graph = graphOf(
      SYMBOLS,
      [
        reference(USED.id, HELPER.id, { consumer: "@example/consumer", test: true }),
        reference(USED.id, HELPER.id, { test: true }),
      ],
      [],
      [],
    );

    expect(graph.made[2]).toEqual({ production: 0, test: 2, consumerTest: 1 });
  });

  it("counts a reference a test-support file makes as test code's", () => {
    const graph = graphOf(SYMBOLS, [reference(USED.id, HELPER.id)], [], [], [USED.position.path]);

    expect(graph.made[2]).toEqual({ production: 0, test: 1, consumerTest: 0 });
    expect(graph.out[1]).toEqual([
      { to: 2, reference: 0, test: true, guessed: false, reads: "whole", consumer: false },
    ]);
  });

  it("lists under a module or a namespace every export, whatever its reads, and under no other container", () => {
    const CLASS = declared("Box", "class", 6, FILE.id, true);
    const MEMBER = declared("field", "class-member", 7, CLASS.id, true);
    const HELD = declared("Space.held", "variable", 8, SPACE.id, true);
    const NESTED = declared("Space.Nested", "namespace", 9, SPACE.id, true);
    // A `declare module` renders its name unquoted where the name is an identifier ("config").
    const CONFIG = { ...declared("config", "namespace", 10, FILE.id), block: "module" as const };
    const SHIM = declared("config.title", "variable", 11, CONFIG.id, true);
    const AUGMENT = { ...declared("global", "namespace", 12, FILE.id), block: "global" as const };
    const AUGMENTED = declared("global.tally", "variable", 13, AUGMENT.id, true);
    // A value `namespace global` is a namespace like any other.
    const VALUE = declared("global", "namespace", 14, FILE.id);
    const VALUE_HELD = declared("global.space", "variable", 15, VALUE.id, true);
    const SHIM_HELD = declared("config.space", "variable", 16, CONFIG.id, true);
    const graph = graphOf(
      [
        ...SYMBOLS,
        CLASS,
        MEMBER,
        HELD,
        NESTED,
        CONFIG,
        SHIM,
        AUGMENT,
        AUGMENTED,
        VALUE,
        VALUE_HELD,
        SHIM_HELD,
      ],
      [
        reference(HELD.id, FILE.id, { namespace: true, reexport: true }),
        reference(VALUE_HELD.id, FILE.id, { namespace: true, reexport: true }),
        reference(SHIM_HELD.id, FILE.id, { namespace: true, reexport: true }),
      ],
      [],
      [],
    );

    expect(graph.parent).toEqual([OUTSIDE, 0, 0, 0, 3, 0, 5, 3, 3, 0, 9, 0, 11, 0, 13, 9]);
    expect(
      graph.exportsOf,
      "a whole read of a namespace reads every export (references-ts.5), a `declare module` " +
        "lists its exports as a file does, whatever its name spells, and a global augmentation nothing",
    ).toEqual([
      [1, 3, 5],
      [],
      [],
      [4, 7, 8],
      [],
      [],
      [],
      [],
      [],
      [10, 15],
      [],
      [],
      [],
      [14],
      [],
      [],
    ]);
  });

  it("lists under a function merged with a namespace the namespace's exports", () => {
    const FN = declared("F", "function", 2, FILE.id, true);
    const FN_NS = declared("F", "namespace", 3, FILE.id, true);
    const HELPER = declared("F.helper", "function", 4, FN_NS.id, true);
    expect(graphOf([FILE, FN, FN_NS, HELPER], [], [], []).exportsOf).toEqual([
      [1, 2],
      [3],
      [3],
      [],
    ]);
  });

  it("lists under each declaration of a namespace merged with a class or an enum every merged body's exports, the statics and the enum's members", () => {
    const one = (symbol: InventorySymbol, ref: string, isStatic = false): InventorySymbol => ({
      ...symbol,
      ref: `ts://@example/memory/src/a.ts#${ref}`,
      static: isStatic,
    });
    const CLASS = declared("C", "class", 2, FILE.id, true);
    const STATIC = one(declared("C.s", "method", 3, CLASS.id), "C.s", true);
    const FIELD = declared("C.n", "class-member", 4, CLASS.id);
    const CLASS_NS = declared("C", "namespace", 5, FILE.id, true);
    const X = declared("C.x", "variable", 6, CLASS_NS.id, true);
    const ENUM = declared("E", "enum", 7, FILE.id, true);
    const A = declared("E.A", "enum-member", 8, ENUM.id);
    const ENUM_NS = declared("E", "namespace", 9, FILE.id, true);
    const F = declared("E.f", "function", 10, ENUM_NS.id, true);
    const PLAIN = declared("P", "class", 11, FILE.id, true);
    const PLAIN_STATIC = one(declared("P.s", "method", 12, PLAIN.id), "P.s", true);
    const N1 = declared("N", "namespace", 13, FILE.id, true);
    const N1_A = declared("N.a", "variable", 14, N1.id, true);
    const N2 = declared("N", "namespace", 15, FILE.id, true);
    const N2_B = declared("N.b", "variable", 16, N2.id, true);
    const graph = graphOf(
      [
        FILE,
        CLASS,
        STATIC,
        FIELD,
        CLASS_NS,
        X,
        ENUM,
        A,
        ENUM_NS,
        F,
        PLAIN,
        PLAIN_STATIC,
        N1,
        N1_A,
        N2,
        N2_B,
      ],
      [],
      [],
      [],
    );

    expect(
      graph.exportsOf,
      "P-J14-11 point 1: a whole read takes in merged statics and enum members",
    ).toEqual([
      [1, 4, 6, 8, 10, 12, 14],
      [2, 5],
      [],
      [],
      [2, 5],
      [],
      [7, 9],
      [],
      [7, 9],
      [],
      [],
      [],
      [13, 15],
      [],
      [13, 15],
      [],
    ]);
  });

  it("marks what each reference reads beyond the declaration it names (references-ts.3 to .5)", () => {
    const graph = graphOf(
      SYMBOLS,
      [
        reference(USED.id, FILE.id),
        reference(USED.id, FILE.id, { namespace: true }),
        reference(USED.id, FILE.id, { namespace: true, reexport: true }),
        reference(USED.id, FILE.id, { reexport: true }),
        reference(USED.id, FILE.id, { use: "evaluation" }),
        reference(USED.id, SPACE.id, { use: "write" }),
      ],
      [],
      [],
    );

    expect(graph.out[1]?.map((edge) => edge.reads)).toEqual([
      "whole",
      "none",
      "passes",
      "whole",
      "none",
      "none",
    ]);
  });

  it("roots only a declaration it holds", () => {
    const roots: Root[] = [
      { id: UNHELD, kind: "entry-file", source: "src/b.ts" },
      { id: USED.id, kind: "published-api", source: "" },
    ];

    expect(graphOf(SYMBOLS, [], roots, []).rooted).toEqual([
      { at: 1, kind: "published-api", source: "" },
    ]);
  });
});
