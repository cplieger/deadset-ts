import { describe, expect, it } from "vitest";
import type { Exemption } from "../exemptions/lifecycle.ts";
import type { InventorySymbol, SymbolKind } from "../inventory.ts";
import type { Reference } from "../references.ts";
import type { Root } from "../roots/root-set.ts";
import type { Member } from "../bindings.ts";
import { carry, type Carrier } from "./carrier.ts";
import { graphOf } from "./graph.ts";

/** One declaration of the file at `path`, at its own line, inside the container given. */
function declared(
  path: string,
  name: string,
  kind: SymbolKind,
  line: number,
  parent: string,
  exported = false,
): InventorySymbol {
  return {
    id: `${path}:${String(line)}:1`,
    ref: `ts://@example/memory/${path}#${kind === "file" ? "" : name}`,
    name,
    kind,
    position: { path, line, column: 1 },
    endLine: line,
    parent,
    exported,
    visibility: "public",
    static: false,
  };
}

const HAND = "src/main.ts";
const GEN = "src/gen/a_pb.ts";
const TEST = "src/main.test.ts";

const MAIN = declared(HAND, HAND, "file", 1, "");
const ENTRY = declared(HAND, "entry", "function", 2, MAIN.id, true);
const GEN_FILE = declared(GEN, GEN, "file", 1, "");
const SCHEMA = declared(GEN, "PingSchema", "variable", 2, GEN_FILE.id, true);
const MESSAGE = declared(GEN, "Ping", "type", 3, GEN_FILE.id, true);
const FIELD = declared(GEN, "Ping.text", "type-member", 4, MESSAGE.id);
const OTHER = declared(GEN, "Ping.number", "type-member", 5, MESSAGE.id);
const FNS = declared(GEN, "PingFns", "variable", 6, GEN_FILE.id, true);
const FNS_MEMBER = declared(GEN, "PingFns.encode", "method", 7, FNS.id);
const TEST_FILE = declared(TEST, TEST, "file", 1, "");
const HELPER = declared(HAND, "helper", "function", 3, MAIN.id);
const BARREL = "src/barrel.ts";
const BARREL_FILE = declared(BARREL, BARREL, "file", 1, "");
const SPACE = declared(BARREL, "space", "export-alias", 2, BARREL_FILE.id, true);
const RELAY = declared(BARREL, "relay", "export-alias", 3, BARREL_FILE.id, true);
const SYMBOLS = [
  MAIN,
  ENTRY,
  GEN_FILE,
  SCHEMA,
  MESSAGE,
  FIELD,
  OTHER,
  FNS,
  FNS_MEMBER,
  TEST_FILE,
  HELPER,
  BARREL_FILE,
  SPACE,
  RELAY,
];

function reference(from: string, to: string, extra: Partial<Reference> = {}): Reference {
  return {
    from,
    to,
    position: { path: HAND, line: 1, column: 1 },
    use: "read",
    resolution: "batch",
    test: false,
    ...extra,
  };
}

function root(id: string): Root {
  return { id, kind: "manifest-entry", source: "package.json" } as Root;
}

function exemption(id: string, path: string): Exemption {
  return {
    id,
    class: "serialization-contract",
    detail: "passed to JSON.stringify",
    site: { path, line: 1, column: 1 },
  };
}

/** The names of the declarations the carrier sweep reaches over the graph given. */
function reached(
  references: readonly Reference[],
  roots: readonly Root[],
  given: Partial<Carrier> = {},
): readonly string[] {
  const graph = graphOf(SYMBOLS, references, roots, [TEST]);
  const holds = carry(graph, {
    generated: new Set([GEN]),
    opaque: new Set(),
    exempt: [],
    held: [],
    reads: [],
    members: [],
    memberReads: [],
    mode: { production: false },
    ...given,
  });
  return [
    ...SYMBOLS.filter((one) => holds.declaration(one.id)).map((one) => one.name),
    ...(given.members ?? []).filter((one) => holds.member(one.key)).map((one) => one.key),
  ];
}

/** A member of the service constant, its span lines `from` to `to` of the generated file. */
function member(key: string, from: number, to: number): Member {
  return {
    key,
    within: SCHEMA.id,
    path: GEN,
    start: { line: from, column: 3 },
    end: { line: to, column: 4 },
  };
}

/** A reference the service constant writes at one line of the generated file. */
function written(to: string, line: number): Reference {
  return reference(SCHEMA.id, to, { position: { path: GEN, line, column: 5 } });
}

describe("the carrier sweep", () => {
  it("seeds nothing from a generated file, and follows a generated reference only from what hand code reaches", () => {
    expect(
      reached(
        [reference(SCHEMA.id, MESSAGE.id), reference(MESSAGE.id, FIELD.id)],
        [root(SCHEMA.id)],
      ),
    ).toEqual([]);
    expect(
      reached([reference(ENTRY.id, SCHEMA.id), reference(SCHEMA.id, MESSAGE.id)], [root(ENTRY.id)]),
    ).toEqual(["entry", "PingSchema", "Ping"]);
  });

  it("reaches every export of a file a read of it names, and none through a namespace object's read, which names its exports by itself", () => {
    expect(reached([reference(ENTRY.id, GEN_FILE.id)], [root(ENTRY.id)])).toEqual([
      "entry",
      GEN,
      "PingSchema",
      "Ping",
      "PingFns",
    ]);
    expect(
      reached(
        [reference(ENTRY.id, GEN_FILE.id, { namespace: true }), reference(ENTRY.id, SCHEMA.id)],
        [root(ENTRY.id)],
      ),
    ).toEqual(["entry", GEN, "PingSchema"]);
  });

  it("reads every export through a re-export of a namespace object only where the re-export is reached other than through a namespace object's judged uses", () => {
    // `space` re-exports the generated module's namespace object, `relay` re-exports `space`.
    const passed = { namespace: true, reexport: true } as const;
    const links = [reference(SPACE.id, GEN_FILE.id, passed), reference(RELAY.id, SPACE.id, passed)];
    const named = ["entry", GEN, "PingSchema", "space"];
    expect(
      reached(
        [
          ...links,
          reference(ENTRY.id, SPACE.id, { namespace: true }),
          reference(ENTRY.id, SCHEMA.id),
        ],
        [root(ENTRY.id)],
      ),
    ).toEqual(named);
    expect(
      reached(
        [
          ...links,
          reference(ENTRY.id, RELAY.id, { namespace: true }),
          reference(ENTRY.id, SCHEMA.id),
        ],
        [root(ENTRY.id)],
      ),
    ).toEqual([...named, "relay"]);
    const every = ["entry", GEN, "PingSchema", "Ping", "PingFns", "space"];
    expect(reached([...links, reference(ENTRY.id, SPACE.id)], [root(ENTRY.id)])).toEqual(every);
    expect(reached(links, [root(ENTRY.id), root(SPACE.id)])).toEqual(every);
    expect(
      reached(
        [
          ...links,
          reference(ENTRY.id, SPACE.id, { namespace: true }),
          reference(ENTRY.id, HELPER.id),
          reference(HELPER.id, SPACE.id),
        ],
        [root(ENTRY.id)],
      ),
      "a re-export reached whole after its namespace uses",
    ).toEqual([...every.slice(0, 5), "helper", "space"]);
    expect(
      reached(
        [
          reference(SPACE.id, GEN_FILE.id),
          reference(SPACE.id, MESSAGE.id),
          reference(ENTRY.id, SPACE.id, { namespace: true }),
        ],
        [root(ENTRY.id)],
      ),
      "a re-export's other reads, a whole use of the object among them",
    ).toEqual(["entry", GEN, "PingSchema", "Ping", "PingFns", "space"]);
  });

  it("makes no file whole through a read no rule judged that only a declaration it never reaches makes", () => {
    const links = [
      reference(SPACE.id, GEN_FILE.id, { namespace: true, reexport: true }),
      reference(ENTRY.id, GEN_FILE.id, { namespace: true }),
      reference(ENTRY.id, SCHEMA.id),
    ];
    const named = ["entry", GEN, "PingSchema"];
    expect(reached([...links, reference(HELPER.id, SPACE.id)], [root(ENTRY.id)])).toEqual(named);
    expect(
      reached(
        [...links, reference(ENTRY.id, HELPER.id), reference(HELPER.id, SPACE.id)],
        [root(ENTRY.id)],
      ),
      "and every export once the declaration making it is reached, the file reached before",
    ).toEqual([...named, "Ping", "PingFns", "helper", "space"]);
  });

  it("reads no export through a star re-export of a file an import only evaluates, and every export where the file is a root", () => {
    const links = [
      reference(BARREL_FILE.id, GEN_FILE.id, { namespace: true, reexport: true }),
      reference(ENTRY.id, BARREL_FILE.id, { use: "evaluation" }),
      reference(ENTRY.id, SCHEMA.id),
    ];
    expect(reached(links, [root(ENTRY.id)])).toEqual(["entry", GEN, "PingSchema", BARREL]);
    expect(reached(links, [root(ENTRY.id), root(BARREL_FILE.id)])).toEqual([
      "entry",
      GEN,
      "PingSchema",
      "Ping",
      "PingFns",
      BARREL,
    ]);
  });

  it("follows no write and no test reference, whatever the run's mode", () => {
    expect(
      reached(
        [
          reference(ENTRY.id, FIELD.id, { use: "write" }),
          reference(TEST_FILE.id, OTHER.id, { test: true }),
        ],
        [root(ENTRY.id), root(TEST_FILE.id)],
      ),
    ).toEqual(["entry"]);
  });

  it("follows no reference an opaque declaration or a member of it makes, though it reaches them", () => {
    expect(
      reached(
        [
          reference(ENTRY.id, FNS.id),
          reference(ENTRY.id, FNS_MEMBER.id),
          reference(FNS.id, FIELD.id),
          reference(FNS_MEMBER.id, OTHER.id),
        ],
        [root(ENTRY.id)],
        { opaque: new Set([FNS.id]) },
      ),
    ).toEqual(["entry", "PingFns", "PingFns.encode"]);
  });

  it("is seeded by a record only where its evidence is hand-written production code, and by a held declaration only outside generated and test files", () => {
    expect(
      reached([], [], {
        exempt: [exemption(FIELD.id, HAND), exemption(OTHER.id, GEN), exemption(MESSAGE.id, TEST)],
      }),
    ).toEqual(["Ping.text"]);
    const references = [reference(ENTRY.id, MESSAGE.id), reference(SCHEMA.id, FIELD.id)];
    expect(reached(references, [], { held: [SCHEMA.id, TEST_FILE.id] })).toEqual([]);
    expect(reached(references, [], { held: [ENTRY.id] })).toEqual(["entry", "Ping"]);
  });

  it("follows the reads the schema reads add from what it reaches", () => {
    expect(
      reached([], [root(ENTRY.id)], {
        reads: [
          { from: ENTRY.id, to: FIELD.id },
          { from: SCHEMA.id, to: OTHER.id },
        ],
      }),
    ).toEqual(["entry", "Ping.text"]);
  });

  it("follows a reference written inside a member only once hand code reads the member, the innermost holding it", () => {
    const outer = member("outer", 10, 20);
    const inner = member("inner", 12, 14);
    const references = [
      reference(ENTRY.id, SCHEMA.id),
      written(MESSAGE.id, 2),
      written(FIELD.id, 11),
      written(OTHER.id, 13),
    ];
    expect(reached(references, [root(ENTRY.id)], { members: [outer, inner] })).toEqual([
      "entry",
      "PingSchema",
      "Ping",
    ]);
    expect(
      reached(references, [root(ENTRY.id)], {
        members: [outer, inner],
        memberReads: [{ from: ENTRY.id, member: "outer" }],
      }),
    ).toEqual(["entry", "PingSchema", "Ping", "Ping.text", "outer"]);
    expect(
      reached([written(OTHER.id, 13)], [root(ENTRY.id)], {
        members: [outer, inner],
        memberReads: [
          { from: ENTRY.id, member: "inner" },
          { from: SCHEMA.id, member: "outer" },
        ],
      }),
    ).toEqual(["entry", "Ping.number", "inner"]);
  });

  it("follows no reference a member of an opaque declaration makes, though a read reaches it", () => {
    expect(
      reached([written(FIELD.id, 11)], [root(ENTRY.id)], {
        opaque: new Set([SCHEMA.id]),
        members: [member("outer", 10, 20)],
        memberReads: [{ from: ENTRY.id, member: "outer" }],
      }),
    ).toEqual(["entry", "outer"]);
  });

  it("reaches a file's exports through a read of it, and its top level alone through an evaluation", () => {
    expect(reached([reference(MAIN.id, GEN_FILE.id)], [root(MAIN.id)])).toEqual([
      HAND,
      GEN,
      "PingSchema",
      "Ping",
      "PingFns",
    ]);
    expect(
      reached([reference(MAIN.id, GEN_FILE.id, { use: "evaluation" })], [root(MAIN.id)]),
    ).toEqual([HAND, GEN]);
  });

  it("is seeded by what a loaded consumer reads, and not by what it writes", () => {
    expect(
      reached(
        [
          reference(ENTRY.id, SCHEMA.id, { consumer: "@example/consumer" }),
          reference(ENTRY.id, FIELD.id, { consumer: "@example/consumer", use: "write" }),
        ],
        [],
      ),
    ).toEqual(["PingSchema"]);
  });
});
