import { describe, expect, it } from "vitest";
import { ConfigError } from "./config.ts";
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
    analyzerVersion: () => "0.0.0-devel",
    writeDocument: (path) => {
      throw new Error(`${path}: this host writes nothing`);
    },
  };
}

/** One edge, written as the document spells it. */
function edge(id: string, provides: string, usedBy: string): string {
  return JSON.stringify({ id, provides, used_by: usedBy });
}

/** The message a document refused with, or a note that it was read. */
function refusal(document: string): string {
  try {
    readEdgeSides(hostWith(document), ROOT);
    return "read";
  } catch (error: unknown) {
    return error instanceof ConfigError ? error.message : `not a usage refusal: ${String(error)}`;
  }
}

const GO_A = "go://example.com/app#A";
const TS_A = "ts://@example/app/src/a.ts#A";

describe("the edges document", () => {
  it("yields every side naming a symbol of this language, in document order, provides before used_by", () => {
    const document = `{"edges": [
      ${edge("b/second", "ts://@example/app/src/b.ts#B", "ts://@example/app/src/c.ts#C")},
      ${edge("a/first", GO_A, TS_A)},
      ${edge("c/other", GO_A, "py://example#Other")}
    ]}`;

    expect(readEdgeSides(hostWith(document), ROOT)).toEqual([
      { edge: "b/second", side: "provides", symbol: "ts://@example/app/src/b.ts#B" },
      { edge: "b/second", side: "used_by", symbol: "ts://@example/app/src/c.ts#C" },
      { edge: "a/first", side: "used_by", symbol: TS_A },
    ]);
  });

  it("that is absent declares no edge, and one with an empty array declares none either", () => {
    expect(readEdgeSides(hostWith(undefined), ROOT)).toEqual([]);
    expect(readEdgeSides(hostWith(`{"description": "none yet", "edges": []}`), ROOT)).toEqual([]);
  });

  it.each([
    ["no edges member", `{"description": "nothing declared"}`],
    ["an undeclared top-level key", `{"edges": [], "pairs": []}`],
    ["the edges member twice", `{"edges": [], "edges": [${edge("a", GO_A, TS_A)}]}`],
    [
      "a member of one edge twice",
      `{"edges": [{"id": "a", "id": "b", "provides": "${GO_A}", "used_by": "${TS_A}"}]}`,
    ],
    [
      "an undeclared key on an edge",
      `{"edges": [{"id": "a", "why": "generated", "provides": "${GO_A}", "used_by": "${TS_A}"}]}`,
    ],
    [
      "a value of the wrong type",
      `{"edges": [{"id": ["a"], "provides": "${GO_A}", "used_by": "${TS_A}"}]}`,
    ],
    [
      "a because that is not a string",
      `{"edges": [{"id": "a", "because": 1, "provides": "${GO_A}", "used_by": "${TS_A}"}]}`,
    ],
    ["an edge naming no id", `{"edges": [{"provides": "${GO_A}", "used_by": "${TS_A}"}]}`],
    ["an edge naming no provides side", `{"edges": [{"id": "a", "used_by": "${TS_A}"}]}`],
    ["an edge naming no used_by side", `{"edges": [{"id": "a", "provides": "${GO_A}"}]}`],
    ["an identifier outside its form", `{"edges": [${edge("wire ServerEvent", GO_A, TS_A)}]}`],
    ["an empty identifier segment", `{"edges": [${edge("wire//event", GO_A, TS_A)}]}`],
    [
      "a wildcard in the fragment of a side",
      `{"edges": [${edge("a", "go://example.com/app#Server*", TS_A)}]}`,
    ],
    [
      "a wildcard in the scope of a side",
      `{"edges": [${edge("a", "go://example.com/app/internal/*#A", TS_A)}]}`,
    ],
    ["a bare name on a side", `{"edges": [${edge("a", "ServerEvent", TS_A)}]}`],
    [
      "a side with no fragment separator",
      `{"edges": [${edge("a", "go://example.com/app", TS_A)}]}`,
    ],
    ["a scope holding a space", `{"edges": [${edge("a", "go://example.com/a pp#A", TS_A)}]}`],
    ["a scope holding a tab", `{"edges": [${edge("a", "go://example.com/a\tpp#A", TS_A)}]}`],
    ["an edge that is not an object", `{"edges": ["a"]}`],
    ["a second value after the document", `{"edges": []} {"edges": []}`],
    ["a document that is not an object", `["edges"]`],
  ])("is refused with the usage code when it holds %s", (_name, document) => {
    expect(refusal(document)).toMatch(/^deadset-edges\.json(?::[0-9]+:[0-9]+)?: .+: want .+$/u);
  });

  it.each([
    ["a wildcard inside a quoted component", "ts://@example/app/src/a.ts#Headers.'a*b'"],
    ["a wildcard inside a computed key", "ts://@example/app/src/a.ts#Sizes.[k*2]"],
    ["a question mark in a quoted name", "ts://@example/app/src/a.ts#Flags.'active?'"],
    ["a question mark outside the grammar", "ts://@example/app/src/a.ts#Serve?"],
    ["a form feed in the scope", "ts://@example/a\fpp/src/a.ts#A"],
  ])("carries a side that still names one symbol as written: %s", (_name, side) => {
    const document = `{"edges": [${edge("a", GO_A, side)}]}`;

    expect(readEdgeSides(hostWith(document), ROOT)).toEqual([
      { edge: "a", side: "used_by", symbol: side },
    ]);
  });

  it("names the line and column of the brace that opens the edge at fault, in UTF-16 units", () => {
    const document = `{
  "description": "\u{1F600}",
  "edges": [
    ${edge("first", GO_A, TS_A)},
      ${edge("second", GO_A, "ServerEvent")}
  ]
}
`;

    expect(refusal(document)).toMatch(/^deadset-edges\.json:5:7: "ServerEvent": want /u);
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
  const otherFinding = findingAbout(other, "DS1104");
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
      "dead DS1104",
    ]);
    expect(evaluated.findings).toEqual([deadFinding]);
  });

  it("holds no part finding pending, though the part sits at its declaration's position", () => {
    const discarded: Finding = {
      ...findingAbout(live, "DS1803"),
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
