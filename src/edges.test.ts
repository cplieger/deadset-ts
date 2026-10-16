import { describe, expect, it } from "vitest";
import { negativeDocument, negatives, readFixture } from "../__test-helpers__/fixtures.ts";
import { CONFIG_MAX_BYTES } from "./contract/config.generated.ts";
import { UsageError } from "./usage.ts";
import { EDGES_FILE, evaluateEdges, readEdgeSides } from "./edges.ts";
import type { Finding } from "./finding.ts";
import type { Host } from "./host.ts";
import type { InventorySymbol } from "./inventory.ts";
import { joinPath } from "./paths.ts";

const ROOT = "/target";

/** A target root holding the edges document given, or none. */
function hostWith(document: string | undefined): Host {
  const held = (path: string): boolean =>
    document !== undefined && path === joinPath(ROOT, EDGES_FILE);
  return {
    workingDirectory: () => ROOT,
    readFile: (path) => (held(path) ? (document ?? "") : ""),
    readDirectory: () => [],
    kindOf: (path) => (held(path) ? "file" : "absent"),
    realPath: (path) => path,
    analyzerVersion: () => "0.0.0-devel",
    temporaryDirectory: () => {
      throw new Error("no temporary directory");
    },
    componentMapperCommand: () => [],
    writeDocument: (path) => {
      throw new Error(`${path}: this host writes nothing`);
    },
  };
}

/** One edge, written as the document spells it under its identifier. */
function edge(id: string, provides: string, usedBy: string): string {
  return `${JSON.stringify(id)}: ${JSON.stringify({ provides, used_by: usedBy })}`;
}

/** The message a document refused with, or a note that it was read. */
function refusal(document: string): string {
  try {
    readEdgeSides(hostWith(document), ROOT);
    return "read";
  } catch (error: unknown) {
    return error instanceof UsageError ? error.message : `not a usage refusal: ${String(error)}`;
  }
}

const GO_A = "go://example.com/app#A";
const TS_A = "ts://@example/app/src/a.ts#A";
const SIDES = `"provides": "${GO_A}", "used_by": "${TS_A}"`;

describe("the edges document", () => {
  it("yields every side naming a symbol of this language, in document order, provides before used_by", () => {
    const document = `{"edges": {
      ${edge("b/second", "ts://@example/app/src/b.ts#B", "ts://@example/app/src/c.ts#C")},
      ${edge("a/first", GO_A, TS_A)},
      ${edge("c/other", GO_A, "py://example#Other")}
    }}`;

    expect(readEdgeSides(hostWith(document), ROOT)).toEqual([
      { edge: "b/second", side: "provides", symbol: "ts://@example/app/src/b.ts#B" },
      { edge: "b/second", side: "used_by", symbol: "ts://@example/app/src/c.ts#C" },
      { edge: "a/first", side: "used_by", symbol: TS_A },
    ]);
  });

  it("that is absent declares no edge, and one with an empty object declares none either", () => {
    expect(readEdgeSides(hostWith(undefined), ROOT)).toEqual([]);
    expect(readEdgeSides(hostWith(`{"description": "none yet", "edges": {}}`), ROOT)).toEqual([]);
  });

  it("reads an identifier spelled in digits as the edge's identifier", () => {
    expect(readEdgeSides(hostWith(`{"edges": {${edge("7", GO_A, TS_A)}}}`), ROOT)).toEqual([
      { edge: "7", side: "used_by", symbol: TS_A },
    ]);
  });

  it.each([
    ["no edges member", `{"description": "nothing declared"}`],
    ["an undeclared top-level key", `{"edges": {}, "pairs": []}`],
    ["the edges member twice", `{"edges": {}, "edges": {${edge("a", GO_A, TS_A)}}}`],
    ["one identifier twice", `{"edges": {${edge("a", GO_A, TS_A)}, ${edge("a", GO_A, TS_A)}}}`],
    ["the edges as a list", `{"edges": [{"id": "a", ${SIDES}}]}`],
    ["a member of one edge twice", `{"edges": {"a": {"provides": "${GO_A}", ${SIDES}}}}`],
    ["an undeclared key on an edge", `{"edges": {"a": {"why": "generated", ${SIDES}}}}`],
    ["an id member on an edge", `{"edges": {"a": {"id": "a", ${SIDES}}}}`],
    [
      "a value of the wrong type",
      `{"edges": {"a": {"provides": ["${GO_A}"], "used_by": "${TS_A}"}}}`,
    ],
    ["a because that is not a string", `{"edges": {"a": {"because": 1, ${SIDES}}}}`],
    ["an edge naming no provides side", `{"edges": {"a": {"used_by": "${TS_A}"}}}`],
    ["an edge naming no used_by side", `{"edges": {"a": {"provides": "${GO_A}"}}}`],
    ["an identifier outside its form", `{"edges": {${edge("wire ServerEvent", GO_A, TS_A)}}}`],
    ["an empty identifier segment", `{"edges": {${edge("wire//event", GO_A, TS_A)}}}`],
    ["an empty identifier", `{"edges": {${edge("", GO_A, TS_A)}}}`],
    [
      "a wildcard in the fragment of a side",
      `{"edges": {${edge("a", "go://example.com/app#Server*", TS_A)}}}`,
    ],
    [
      "a wildcard in the scope of a side",
      `{"edges": {${edge("a", "go://example.com/app/internal/*#A", TS_A)}}}`,
    ],
    ["a bare name on a side", `{"edges": {${edge("a", "ServerEvent", TS_A)}}}`],
    [
      "a side with no fragment separator",
      `{"edges": {${edge("a", "go://example.com/app", TS_A)}}}`,
    ],
    ["a scope holding a space", `{"edges": {${edge("a", "go://example.com/a pp#A", TS_A)}}}`],
    ["a scope holding a tab", `{"edges": {${edge("a", "go://example.com/a\tpp#A", TS_A)}}}`],
    ["an edge that is not an object", `{"edges": {"a": "a"}}`],
    ["a second value after the document", `{"edges": {}} {"edges": {}}`],
    ["a document that is not an object", `["edges"]`],
    ["a description that is not a string", `{"description": 1, "edges": {}}`],
    [
      "a wildcard after a quoted component",
      `{"edges": {${edge("a", "ts://@example/app/src/a.ts#Headers.'ab'.*", TS_A)}}}`,
    ],
    [
      "a wildcard after a quoted component holding an escaped quote",
      `{"edges": {${edge("a", "ts://@example/app/src/a.ts#Headers.'a\\'b'.*", TS_A)}}}`,
    ],
    [
      "a wildcard after a computed key",
      `{"edges": {${edge("a", "ts://@example/app/src/a.ts#Sizes.[k].*", TS_A)}}}`,
    ],
  ])("is refused with the usage code when it holds %s", (_name, document) => {
    expect(refusal(document)).toMatch(/^deadset-edges\.json(?::[0-9]+:[0-9]+)?: \S.*$/u);
  });

  it.each([
    [
      "no edges member",
      `{"description": "nothing declared"}`,
      'edges: the member "edges" is absent',
    ],
    [
      "an undeclared top-level key",
      `{"edges": {}, "pairs": []}`,
      'pairs: the member "pairs" is not one the schema declares',
    ],
    ["the edges as a list", `{"edges": []}`, "edges: the value is array, want object"],
    ["an array", `["edges"]`, "the value is array, want object"],
    ["null", "null", "the value is null, want object"],
    ["a string", '"edges"', "the value is string, want object"],
  ])("names what it refuses at the document's level when it holds %s", (_name, document, text) => {
    expect(refusal(document)).toBe(`deadset-edges.json: ${text}`);
  });

  it("is read no further than one byte past the Contract's bound, and refused past it", () => {
    const limits: (number | undefined)[] = [];
    const big = `{"edges": {}, "description": "${"a".repeat(CONFIG_MAX_BYTES)}"}`;
    const host: Host = {
      ...hostWith(big),
      readFile: (_path, limit) => {
        limits.push(limit);
        return big.slice(0, limit);
      },
    };

    expect(() => readEdgeSides(host, ROOT)).toThrow(
      `deadset-edges.json: holds more than ${String(CONFIG_MAX_BYTES)} bytes`,
    );
    expect(limits).toEqual([CONFIG_MAX_BYTES + 1]);
  });

  it.each(negatives("contract/edges.schema.json"))("refuses the Contract's $file", (row) => {
    expect(refusal(negativeDocument(row.file))).toMatch(
      /^deadset-edges\.json(?::[0-9]+:[0-9]+)?: /u,
    );
  });

  it("reads the Contract's accepted edges document", () => {
    expect(
      readEdgeSides(hostWith(readFixture("examples", "edges", "declared.json")), ROOT),
    ).toEqual([
      {
        edge: "wire/ServerEvent",
        side: "used_by",
        symbol: "ts://@example/app/src/wire.ts#ServerEvent",
      },
      {
        edge: "wire/ServerEvent.kind",
        side: "used_by",
        symbol: "ts://@example/app/src/wire.ts#ServerEvent['kind*']",
      },
    ]);
  });

  it("names an identifier outside its form by the edge it names", () => {
    expect(refusal(`{"edges": {${edge("wire event", GO_A, TS_A)}}}`)).toBe(
      'deadset-edges.json:1:26: edges.wire event: the member name "wire event": "wire event" does not match ^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$',
    );
  });

  it("names where and why a document is not JSON", () => {
    expect(refusal(`{"edges": {}} {"edges": {}}`)).toBe(
      "deadset-edges.json:1:15: data follows the document's value",
    );
  });

  it.each([
    [
      "an edge named __proto__ with a side that is not a string",
      `{"edges": {"__proto__": {"provides": 5, "used_by": "${GO_A}"}}}`,
      "deadset-edges.json:1:25: edges.__proto__.provides: the value is integer, want string",
    ],
    [
      "an undeclared top-level key named __proto__",
      `{"edges": {}, "__proto__": 1}`,
      'deadset-edges.json: __proto__: the member "__proto__" is not one the schema declares',
    ],
  ])("refuses %s as any other member", (_name, document, text) => {
    expect(refusal(document)).toBe(text);
  });

  it("reads an edge named __proto__ as the edge it is", () => {
    expect(readEdgeSides(hostWith(`{"edges": {"__proto__": {${SIDES}}}}`), ROOT)).toEqual([
      { edge: "__proto__", side: "used_by", symbol: TS_A },
    ]);
  });

  it("names where an identifier is written twice", () => {
    expect(
      refusal(`{"edges": {\n  ${edge("a", GO_A, TS_A)},\n  ${edge("a", GO_A, TS_A)}\n}}`),
    ).toBe('deadset-edges.json:3:3: the member "a" is written twice, so neither value is chosen');
  });

  it.each([
    ["a string", '"a"', "string"],
    ["null", "null", "null"],
    ["an array", '["a"]', "array"],
  ])("names an edge that is %s at its own place", (_name, value, type) => {
    expect(refusal(`{"edges": {"a": ${value}}}`)).toBe(
      `deadset-edges.json:1:17: edges.a: the value is ${type}, want object`,
    );
  });

  it.each([
    ["a wildcard inside a quoted component", "ts://@example/app/src/a.ts#Headers.'a*b'"],
    ["a wildcard inside a computed key", "ts://@example/app/src/a.ts#Sizes.[k*2]"],
    [
      "a wildcard inside a quoted component past an escaped quote",
      "ts://@example/app/src/a.ts#Headers.'a\\'*b'",
    ],
    ["a question mark in a quoted name", "ts://@example/app/src/a.ts#Flags.'active?'"],
    ["a question mark outside the grammar", "ts://@example/app/src/a.ts#Serve?"],
    ["a form feed in the scope", "ts://@example/a\fpp/src/a.ts#A"],
  ])("carries a side that still names one symbol as written: %s", (_name, side) => {
    const document = `{"edges": {${edge("a", GO_A, side)}}}`;

    expect(readEdgeSides(hostWith(document), ROOT)).toEqual([
      { edge: "a", side: "used_by", symbol: side },
    ]);
  });

  it("names the line and column of the brace that opens the edge at fault, in UTF-16 units", () => {
    const document = `{
  "description": "\u{1F600}",
  "edges": {
    ${edge("first", GO_A, TS_A)},
      ${edge("second", GO_A, "ServerEvent")}
  }
}
`;

    expect(refusal(document)).toMatch(
      /^deadset-edges\.json:5:17: edges\.second\.used_by: "ServerEvent" does not match /u,
    );
  });

  it("names an edge that is not an object by its own line and column, not the next edge's", () => {
    const document = `{"edges": {\n  "z": null,\n  ${edge("a", GO_A, TS_A)}\n}}`;

    expect(refusal(document)).toBe(
      "deadset-edges.json:2:8: edges.z: the value is null, want object",
    );
  });
});

/** A declaration of the run, enumerated under its reference. */
function declaration(name: string, line: number): InventorySymbol {
  return {
    id: `src/a.ts:${String(line)}:1`,
    ref: `ts://@example/app/src/a.ts#${name}`,
    name,
    kind: "class",
    position: { path: "src/a.ts", line, column: 1 },
    endLine: line,
    parent: "",
    exported: true,
    visibility: "public",
    static: false,
  };
}

/** The finding a run holds about one declaration. */
function findingAbout(symbol: InventorySymbol, code: string): Finding {
  return {
    code,
    position: { ...symbol.position, endLine: symbol.endLine },
    symbol: { ref: symbol.ref, kind: symbol.kind, name: symbol.name, sizeLines: 1 },
    message: `${symbol.name} is reported`,
  };
}

describe("the evaluation of declared sides", () => {
  const dead = declaration("Dead", 1);
  const live = declaration("Live", 5);
  const other = declaration("Other", 9);
  const symbols = [dead, live, other];
  const deadFinding = findingAbout(dead, "DS1001");
  const otherFinding = findingAbout(other, "DS1503");
  const findings = [deadFinding, otherFinding];

  it("is the findings unchanged and no evaluation where no side is declared", () => {
    expect(evaluateEdges(findings, [], symbols)).toEqual({ findings, evaluations: [] });
  });

  it("holds the finding about a side's symbol inside the evaluation and nowhere else", () => {
    const evaluated = evaluateEdges(
      findings,
      [
        { edge: "z/live", side: "provides", symbol: live.ref },
        { edge: "m/dead", side: "used_by", symbol: dead.ref },
        { edge: "a/absent", side: "provides", symbol: "ts://@example/app/src/a.ts#Gone" },
        { edge: "m/dead", side: "provides", symbol: dead.ref },
      ],
      symbols,
    );

    expect(evaluated.evaluations).toEqual([
      {
        edge: "a/absent",
        side: "provides",
        symbol: "ts://@example/app/src/a.ts#Gone",
        state: "absent",
      },
      { edge: "m/dead", side: "provides", symbol: dead.ref, state: "dead", finding: deadFinding },
      { edge: "m/dead", side: "used_by", symbol: dead.ref, state: "dead", finding: deadFinding },
      { edge: "z/live", side: "provides", symbol: live.ref, state: "live" },
    ]);
    expect(evaluated.findings).toEqual([otherFinding]);
  });

  it("holds a narrowing finding pending as it holds an unused one", () => {
    const evaluated = evaluateEdges(
      findings,
      [{ edge: "n", side: "used_by", symbol: other.ref }],
      symbols,
    );

    expect(evaluated.evaluations.map((one) => `${one.state} ${one.finding?.code ?? "-"}`)).toEqual([
      "dead DS1503",
    ]);
    expect(evaluated.findings).toEqual([deadFinding]);
  });

  it("holds no part finding pending, though the part sits at its declaration's position", () => {
    const discarded: Finding = {
      ...findingAbout(live, "DS1403"),
      symbol: { ref: live.ref, kind: "result", name: "result", sizeLines: 1 },
    };
    const evaluated = evaluateEdges(
      [discarded],
      [{ edge: "p", side: "provides", symbol: live.ref }],
      symbols,
    );

    expect(evaluated.evaluations).toEqual([
      { edge: "p", side: "provides", symbol: live.ref, state: "live" },
    ]);
    expect(evaluated.findings).toEqual([discarded]);
  });

  it("evaluates a side once for each declaration two packages of one name spell with its reference", () => {
    const twin: InventorySymbol = {
      ...dead,
      id: "examples/b/src/a.ts:1:1",
      position: { path: "examples/b/src/a.ts", line: 1, column: 1 },
    };
    const evaluated = evaluateEdges(
      [deadFinding],
      [{ edge: "t", side: "used_by", symbol: dead.ref }],
      [dead, twin],
    );

    expect(evaluated.evaluations).toEqual([
      { edge: "t", side: "used_by", symbol: dead.ref, state: "dead", finding: deadFinding },
      { edge: "t", side: "used_by", symbol: dead.ref, state: "live" },
    ]);
    expect(evaluated.findings).toEqual([]);
  });

  it("finds a side absent when only a file of the run carries its reference", () => {
    const file: InventorySymbol = {
      ...declaration("", 1),
      kind: "file",
      ref: "ts://@example/app/src/a.ts#",
    };

    expect(
      evaluateEdges([], [{ edge: "f", side: "provides", symbol: file.ref }], [file]).evaluations,
    ).toEqual([{ edge: "f", side: "provides", symbol: file.ref, state: "absent" }]);
  });
});
