import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitterInputOf, sweepOnly } from "../../__test-helpers__/emitter-input.ts";
import { fixture } from "../../__test-helpers__/fixtures.ts";
import type { Finding } from "../finding.ts";
import type { InventorySymbol } from "../inventory.ts";
import { matrixOf, sweepMatrix } from "../matrix.ts";
import type { Reference } from "../references.ts";
import { resolve } from "../resolve.ts";
import { evaluateEdges, type EdgeEvaluation } from "../edges.ts";
import type { Boundary, EdgeSide } from "./boundary.ts";
import type { EmitterInput } from "./emitter.ts";
import { EMITTERS, findingsOf } from "./emitters.ts";
import { narrowings } from "./visibility-narrowing.ts";

const NARROWING = fixture("projects", "visibility-narrowing");
const REDUNDANT_KEYWORD = fixture("corpus", "redundant-export-keyword", "ts", "target");

/** The consumer the corpus case declares, as a scope would name it once loaded. */
const CORPUS_CONSUMER = "@example/consumer";

/**
 * The sides of the edges document at the root that name a TypeScript symbol, read as
 * the document writes them; a root with no document declares no edge.
 */
function edgeSidesAt(root: string): EdgeSide[] {
  let text: string;
  try {
    text = readFileSync(join(root, "deadset-edges.json"), "utf8");
  } catch {
    return [];
  }
  const document = JSON.parse(text) as {
    edges: { id: string; provides: string; used_by: string }[];
  };
  return document.edges.flatMap((edge) =>
    (["provides", "used_by"] as const)
      .filter((side) => edge[side].startsWith("ts://"))
      .map((side) => ({ edge: edge.id, side, symbol: edge[side] })),
  );
}

interface Case {
  /** The repository configuration, where it is not the fixture's own. */
  readonly document?: string;
  readonly consumerSet?: Boundary["consumers"];
  /** Whether the run reads the root's edges document. */
  readonly edges?: boolean;
  /** Whether the run reads `exports` from the root's manifest. */
  readonly encapsulation?: boolean;
}

/** The input every emitter reads over one fixture, swept for production. */
function inputOf(root: string, given: Case = {}): EmitterInput {
  const path = join(root, "deadset.json");
  const { config } = resolve({
    repository: given.document ?? readFileSync(path, "utf8"),
    repositoryLabel: path,
  });
  const input = emitterInputOf(root, config);
  return {
    ...input,
    boundary: {
      consumers: given.consumerSet ?? input.boundary.consumers,
      encapsulated: (given.encapsulation ?? true) && input.boundary.encapsulated,
      edges: (given.edges ?? true) ? edgeSidesAt(root) : [],
    },
  };
}

/** The family's findings over one input, each side of a declared edge evaluated over them. */
function evaluated(input: EmitterInput): ReturnType<typeof evaluateEdges> {
  return evaluateEdges(narrowings(input), input.boundary.edges, input.swept.matrix.union.symbols);
}

/** The findings the family reports over one input, those a declared edge holds left out. */
function emitted(input: EmitterInput): readonly Finding[] {
  return evaluated(input).findings;
}

/** The table's visibility-narrowing emitter. */
function tableEmitter(): (input: EmitterInput) => readonly Finding[] {
  const emitter = EMITTERS.get("visibility-narrowing");
  if (emitter === undefined) {
    throw new Error("the emitter table holds no visibility-narrowing family");
  }
  return emitter;
}

/** One finding as a text line renders it, without the dials a report adds. */
function line(finding: Finding): string {
  const { path, line: at, column } = finding.position;
  return `${path}:${String(at)}:${String(column)}: ${finding.symbol.kind} ${finding.symbol.name}: ${finding.message} (${finding.code})`;
}

/** Each finding as its code and the name of its subject. */
function named(findings: readonly Finding[]): string[] {
  return findings.map((finding) => `${finding.code} ${finding.symbol.name}`);
}

/** Each evaluation holding a finding, as the edge side, its code and its subject. */
function held(evaluations: readonly EdgeEvaluation[]): string[] {
  return evaluations.flatMap((one) =>
    one.finding === undefined
      ? []
      : [`${one.edge} ${one.side} ${one.finding.code} ${one.finding.symbol.name}`],
  );
}

/** The fixture's own configuration with the consumer set declared complete. */
const COMPLETE = JSON.stringify({
  ...(JSON.parse(readFileSync(join(NARROWING, "deadset.json"), "utf8")) as object),
  consumers: { complete: true },
});

describe("the visibility-narrowing family with the consumer set not declared complete", () => {
  const findings = emitted(inputOf(NARROWING));

  it("reports an export used only inside its own file that no manifest export reaches, and nothing in a published or an entry file", () => {
    expect(named(findings).filter((entry) => entry.startsWith("DS1104"))).toEqual([
      "DS1104 Labels",
      "DS1104 helperLocal",
    ]);
  });

  it.each([
    ["declared in a file the configuration names as an entry file", "routeLocal"],
    ["declared in a file a worker runs", "workerLocal"],
    ["a root the configuration names", "configuredLocal"],
    ["a member of a namespace", "Labels.label"],
  ])("reports nothing about an export used only in its own file that is %s", (_what, name) => {
    expect(findings.filter((finding) => finding.symbol.name === name)).toEqual([]);
  });

  it("reports no unnecessary export, because no published declaration is in a closed world", () => {
    expect(named(findings).filter((entry) => entry.startsWith("DS1101"))).toEqual([]);
  });

  it("reports each unused export of a file outside code cannot import, by the relation that found it", async () => {
    expect(named(findings).filter((entry) => entry.startsWith("DS1103"))).toEqual([
      "DS1103 forgotten",
      "DS1103 behindForgotten",
      "DS1103 deadCaller",
    ]);
    await expect(
      `${findings.map(line).join("\n")}\n`,
      "regenerate with `npx vitest --run -u src/findings/visibility-narrowing.test.ts` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "visibility-narrowing.open.findings.txt"));
  });
});

describe("an unused export the family leaves to another kind", () => {
  const findings = emitted(inputOf(NARROWING));

  it.each([
    ["an interface", "Unused"],
    ["a declaration only a test file references", "testedOnly"],
    ["a declaration a published re-export carries", "surfacedUnused"],
    ["a test whose every subject is dead", "checksTestedOnly"],
  ])("is not reported when it is %s", (_what, name) => {
    expect(findings.filter((finding) => finding.symbol.name === name)).toEqual([]);
  });
});

describe("the visibility-narrowing family with the consumer set declared complete", () => {
  it("reports the published export used only in its own file and the one used only inside the package", async () => {
    const findings = emitted(inputOf(NARROWING, { document: COMPLETE }));

    expect(named(findings).filter((entry) => !entry.startsWith("DS1103"))).toEqual([
      "DS1104 Labels",
      "DS1104 helperLocal",
      "DS1104 publishedLocal",
      "DS1101 publishedShared",
    ]);
    await expect(
      `${findings.map(line).join("\n")}\n`,
      "regenerate with `npx vitest --run -u src/findings/visibility-narrowing.test.ts` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "visibility-narrowing.closed.findings.txt"));
  });

  it("reports nothing on the published API while a declared consumer is not loaded", () => {
    const findings = emitted(
      inputOf(NARROWING, {
        document: COMPLETE,
        consumerSet: { declared: [CORPUS_CONSUMER], loaded: [] },
      }),
    );

    expect(named(findings).filter((entry) => !entry.startsWith("DS1103"))).toEqual([
      "DS1104 Labels",
      "DS1104 helperLocal",
    ]);
  });

  it("counts a re-export the manifest reaches as a use from outside, so what it publishes is never narrowed", () => {
    const findings = emitted(inputOf(NARROWING, { document: COMPLETE }));

    expect(named(findings).filter((entry) => entry.includes("surfaced"))).toEqual([]);
  });

  it("does not narrow a published re-export the package alone imports, which only a deletion removes", () => {
    const findings = emitted(inputOf(NARROWING, { document: COMPLETE }));

    expect(named(findings).filter((entry) => entry.includes("relayed"))).toEqual([]);
  });
});

describe("the references a narrowing reads", () => {
  const file: InventorySymbol = {
    id: "a.ts:1:1",
    ref: "ts://@example/app/a.ts#",
    name: "a.ts",
    kind: "file",
    position: { path: "a.ts", line: 1, column: 1 },
    endLine: 9,
    parent: "",
    exported: false,
    visibility: "public",
    static: false,
  };
  const declared = (name: string, line: number): InventorySymbol => ({
    ...file,
    id: `a.ts:${String(line)}:17`,
    ref: `ts://@example/app/a.ts#${name}`,
    name,
    kind: "function",
    position: { path: "a.ts", line, column: 17 },
    endLine: line + 2,
    parent: file.id,
    exported: true,
  });
  const target = declared("target", 1);
  const caller = declared("caller", 5);
  const use = (from: string, path: string): Reference => ({
    from,
    to: target.id,
    position: { path, line: 6, column: 10 },
    use: "read",
    resolution: "batch",
    test: false,
  });

  /** The family over one configuration holding the two declarations and these references. */
  const over = (references: readonly Reference[], marked: readonly string[] = []): string[] => {
    const matrix = matrixOf([
      {
        configuration: "tsconfig.json",
        symbols: [file, target, caller],
        references,
        roots: [{ id: caller.id, kind: "configured", source: caller.ref }],
        testFiles: [],
      },
    ]);
    const sweep = sweepMatrix(matrix, { marked, mode: { production: true } });
    const { config } = resolve({
      repository: JSON.stringify({ target: { kind: "application" } }),
      repositoryLabel: "deadset.json",
    });
    return named(emitted(sweepOnly(config, { matrix, sweep, retained: [] })));
  };

  it("make an export its own file alone references a redundant export keyword", () => {
    expect(over([use(caller.id, "a.ts")])).toEqual(["DS1104 target"]);
  });

  it("are what a narrowing needs, so an export a suppression holds live with none is not narrowed", () => {
    expect(over([], [target.id])).toEqual([]);
  });

  it("reach outside the package from a declaration the target does not hold, so what a consumer references is not narrowed", () => {
    expect(over([use(caller.id, "a.ts"), use("consumer/main.ts:1:1", "consumer/main.ts")])).toEqual(
      [],
    );
  });
});

describe("a declared cross-language edge", () => {
  it("holds a finding about the symbol one side names pending in that side, in edge order, and reports it nowhere else", () => {
    const found = evaluated(inputOf(NARROWING));

    expect(held(found.evaluations)).toEqual([
      "wire/provided-to-generated provides DS1103 wiredUnused",
      "wire/used-by-generated used_by DS1104 wired",
    ]);
    expect(named(found.findings).filter((entry) => entry.includes("wired"))).toEqual([]);
  });

  it("is what holds those findings back: without the edges document both are reported", () => {
    const findings = emitted(inputOf(NARROWING, { edges: false }));

    expect(named(findings).filter((entry) => / wired/u.test(entry))).toEqual([
      "DS1104 wired",
      "DS1103 wiredUnused",
    ]);
  });
});

describe("an export the write-only kind reports", () => {
  it("is left to that kind, which reports it once", () => {
    const { config } = resolve({
      repository: JSON.stringify({ target: { kind: "application" } }),
      repositoryLabel: "deadset.json",
    });
    const findings = findingsOf(emitterInputOf(fixture("projects", "every-reference"), config));

    expect(named(findings).filter((entry) => / (counter|loose)$/u.test(entry))).toEqual([
      "DS1301 counter",
      "DS1301 loose",
    ]);
  });
});

describe("the table's visibility-narrowing emitter", () => {
  it("reports what the family reports over a run no declared edge holds a finding of", () => {
    const input = inputOf(NARROWING, { edges: false });

    expect(tableEmitter()(input)).toEqual(narrowings(input));
  });

  it("reports a finding a declared edge names, which the edge's evaluation then holds", () => {
    const input = inputOf(NARROWING);

    expect(named(tableEmitter()(input)).filter((entry) => / wired/u.test(entry))).toEqual([
      "DS1104 wired",
      "DS1103 wiredUnused",
    ]);
  });
});

describe("a manifest that declares no `exports`", () => {
  it("leaves every file importable from outside, so no unused export is unreachable", () => {
    const findings = emitted(inputOf(NARROWING, { encapsulation: false, edges: false }));

    expect(named(findings).filter((entry) => entry.startsWith("DS1103"))).toEqual([]);
  });
});

describe("the TypeScript rendering of the corpus case redundant-export-keyword", () => {
  const library = (consumers: object): string =>
    JSON.stringify({ target: { kind: "library" }, consumers });

  it("reports the export the module alone references, with the consumer set declared complete", () => {
    const findings = emitted(
      inputOf(REDUNDANT_KEYWORD, {
        document: library({ complete: true }),
        consumerSet: { declared: [CORPUS_CONSUMER], loaded: [CORPUS_CONSUMER] },
      }),
    );

    expect(findings.map(line)).toEqual([
      "lib.ts:9:17: function local: exported function is referenced only inside the file that declares it (DS1104)",
    ]);
  });

  it("reports nothing in the file the manifest names with the consumer set not declared complete", () => {
    expect(emitted(inputOf(REDUNDANT_KEYWORD, { document: library({}) }))).toEqual([]);
  });
});
