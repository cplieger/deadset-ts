import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { nodeHost } from "../../bin/node-host.ts";
import { describe, expect, it } from "vitest";
import { emitterInputOf, sweepOnly, findingsOf } from "../../__test-helpers__/emitter-input.ts";
import { fixture } from "../../__test-helpers__/fixtures.ts";
import { writeProject } from "../../__test-helpers__/projects.ts";
import type { Finding } from "../finding.ts";
import type { InventorySymbol } from "../inventory.ts";
import { matrixOf, sweepMatrix } from "../matrix.ts";
import type { Reference } from "../references.ts";
import { resolve } from "../resolve.ts";
import { evaluateEdges, readEdgeSides, type EdgeEvaluation } from "../edges.ts";
import type { Boundary, EdgeSide } from "./boundary.ts";
import type { EmitterInput } from "./emitter.ts";
import { EMITTERS } from "./emitters.ts";
import { narrowings } from "./visibility-narrowing.ts";

const NARROWING = fixture("projects", "visibility-narrowing");
const REDUNDANT_KEYWORD = fixture("corpus", "redundant-export-keyword", "ts", "target");

/** The consumer the corpus case declares, as a scope would name it once loaded. */
const CORPUS_CONSUMER = "@example/consumer";

/** The sides of the edges document at the root that name a TypeScript symbol. */
function edgeSidesAt(root: string): readonly EdgeSide[] {
  return readEdgeSides(nodeHost(), root);
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
    repository: { text: given.document ?? readFileSync(path, "utf8"), label: path },
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
  it("reports an export used only inside its own file that no manifest export reaches, and nothing in a published or an entry file", () => {
    expect(
      named(emitted(inputOf(NARROWING))).filter((entry) => entry.startsWith("DS1503")),
    ).toEqual(["DS1503 Labels", "DS1503 helperLocal"]);
  });

  it.each([
    ["declared in a file the configuration names as an entry file", "routeLocal"],
    ["declared in a file a worker runs", "workerLocal"],
    ["a root the configuration names", "configuredLocal"],
    ["a member of a namespace", "Labels.label"],
  ])("reports nothing about an export used only in its own file that is %s", (_what, name) => {
    expect(emitted(inputOf(NARROWING)).filter((finding) => finding.symbol.name === name)).toEqual(
      [],
    );
  });

  it("reports no unnecessary export, because no published declaration is in a closed world", () => {
    expect(
      named(emitted(inputOf(NARROWING))).filter((entry) => entry.startsWith("DS1501")),
    ).toEqual([]);
  });

  it("reports each unused export of a file outside code cannot import, by the relation that found it", async () => {
    const findings = emitted(inputOf(NARROWING));

    expect(named(findings).filter((entry) => entry.startsWith("DS1101"))).toEqual([
      "DS1101 forgotten",
      "DS1101 behindForgotten",
      "DS1101 deadCaller",
    ]);
    await expect(
      `${findings.map(line).join("\n")}\n`,
      "regenerate with `npx vitest --run -u src/findings/visibility-narrowing.test.ts` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "visibility-narrowing.open.findings.txt"));
  });
});

describe("an unused export the family leaves to another kind", () => {
  it.each([
    ["an interface", "Unused"],
    ["a declaration only a test file references", "testedOnly"],
    ["a declaration a published re-export carries", "surfacedUnused"],
    ["a test whose every subject is dead", "checksTestedOnly"],
  ])("is not reported when it is %s", (_what, name) => {
    expect(emitted(inputOf(NARROWING)).filter((finding) => finding.symbol.name === name)).toEqual(
      [],
    );
  });
});

describe("the visibility-narrowing family with the consumer set declared complete", () => {
  it("reports the published export used only in its own file and the one used only inside the package", async () => {
    const findings = emitted(inputOf(NARROWING, { document: COMPLETE }));

    expect(named(findings).filter((entry) => !entry.startsWith("DS1101"))).toEqual([
      "DS1503 Labels",
      "DS1503 helperLocal",
      "DS1503 publishedLocal",
      "DS1501 publishedShared",
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

    expect(named(findings).filter((entry) => !entry.startsWith("DS1101"))).toEqual([
      "DS1503 Labels",
      "DS1503 helperLocal",
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
      repository: {
        text: JSON.stringify({ target: { kind: "application" } }),
        label: "deadset.json",
      },
    });
    return named(
      emitted(
        sweepOnly(config, {
          matrix,
          sweep,
          exempt: [],
          retained: [],
          notBuilt: [],
          unanswered: [],
          heldByUnanswered: [],
          skipped: [],
          componentFiles: [],
        }),
      ),
    );
  };

  it("make an export its own file alone references a redundant export keyword", () => {
    expect(over([use(caller.id, "a.ts")])).toEqual(["DS1503 target"]);
  });

  it("are what a narrowing needs, so an export a suppression holds live with none is not narrowed", () => {
    expect(over([], [target.id])).toEqual([]);
  });

  it("reach outside the package from a declaration the target does not hold, so what a consumer references is not narrowed", () => {
    expect(over([use(caller.id, "a.ts"), use("consumer/main.ts:1:1", "consumer/main.ts")])).toEqual(
      [],
    );
  });

  it("reach outside the package from a declaration the target does not hold beside a test's, every one counted", () => {
    expect(
      over([
        use(caller.id, "a.ts"),
        { ...use("a.test.ts:1:1", "a.test.ts"), test: true },
        use("consumer/main.ts:1:1", "consumer/main.ts"),
      ]),
    ).toEqual([]);
  });
});

describe("a declared cross-language edge", () => {
  it("holds a finding about the symbol one side names pending in that side, in edge order, and reports it nowhere else", () => {
    const found = evaluated(inputOf(NARROWING));

    expect(held(found.evaluations)).toEqual([
      "wire/provided-to-generated provides DS1101 wiredUnused",
      "wire/used-by-generated used_by DS1503 wired",
    ]);
    expect(named(found.findings).filter((entry) => entry.includes("wired"))).toEqual([]);
  });

  it("is what holds those findings back: without the edges document both are reported", () => {
    const findings = emitted(inputOf(NARROWING, { edges: false }));

    expect(named(findings).filter((entry) => / wired/u.test(entry))).toEqual([
      "DS1503 wired",
      "DS1101 wiredUnused",
    ]);
  });
});

describe("an export the write-only kind reports", () => {
  it("is left to that kind, which reports it once", () => {
    const { config } = resolve({
      repository: {
        text: JSON.stringify({ target: { kind: "application" } }),
        label: "deadset.json",
      },
    });
    const findings = findingsOf(emitterInputOf(fixture("projects", "every-reference"), config));

    expect(named(findings).filter((entry) => / (counter|loose)$/u.test(entry))).toEqual([
      "DS1301 counter",
      "DS1301 loose",
    ]);
  });

  it("leaves to that kind only its own subject, not a declaration another package of one name spells alike", () => {
    const findings = findingsOf(inputOf(fixture("projects", "shared-package-name")));

    expect(
      findings
        .filter((finding) => finding.symbol.name === "hits")
        .map((finding) => `${finding.code} ${finding.position.path}`),
    ).toEqual(["DS1503 a/state.ts", "DS1301 b/state.ts"]);
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
      "DS1503 wired",
      "DS1101 wiredUnused",
    ]);
  });
});

describe("a manifest that declares no `exports`", () => {
  it("leaves every file importable from outside, so no unused export is unreachable", () => {
    const findings = emitted(inputOf(NARROWING, { encapsulation: false, edges: false }));

    expect(named(findings).filter((entry) => entry.startsWith("DS1101"))).toEqual([]);
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
      "lib.ts:9:17: function local: exported function is referenced only inside the file that declares it (DS1503)",
    ]);
  });

  it("reports nothing in the file the manifest names with the consumer set not declared complete", () => {
    expect(emitted(inputOf(REDUNDANT_KEYWORD, { document: library({}) }))).toEqual([]);
  });
});

describe("an export of a project written for the case", () => {
  function reported(files: Readonly<Record<string, string>>, document: object): string[] {
    const root = writeProject(files);
    try {
      return named(emitted(inputOf(root, { document: JSON.stringify(document) })));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("is not narrowed where a test file references it beside its own file", () => {
    expect(
      reported(
        {
          "package.json": '{ "name": "@example/app", "type": "module", "main": "./src/main.ts" }\n',
          "src/main.ts": 'import { local } from "./lib.js";\n\nconsole.log(local());\n',
          "src/lib.ts":
            "export function shared(): number {\n  return 1;\n}\n\nexport function local(): number {\n  return shared() + shared();\n}\n",
          "src/lib.test.ts": 'import { shared } from "./lib.js";\n\nconsole.log(shared());\n',
        },
        { target: { kind: "application" } },
      ),
    ).toEqual([]);
  });

  it("is unreachable where only dead code references it, deprecated, and no test that stays keeps it", () => {
    expect(
      reported(
        {
          "package.json":
            '{ "name": "@example/lib", "type": "module", "exports": { ".": "./src/index.ts" } }\n',
          "src/index.ts":
            'import { live } from "./internal.js";\n\nexport function api(): number {\n  return live();\n}\n',
          "src/internal.ts": [
            "export function live(): number {",
            "  return 1;",
            "}",
            "",
            "export function helper(): number {",
            "  return 2;",
            "}",
            "",
            "/** @deprecated */",
            "export function retired(): number {",
            "  return 3;",
            "}",
            "",
            "export function deadCaller(): number {",
            "  return helper() + retired();",
            "}",
            "",
          ].join("\n"),
          "src/internal.test.ts":
            'import { helper } from "./internal.js";\n\nconsole.log(helper());\n',
        },
        { target: { kind: "library" } },
      ),
    ).toEqual(["DS1101 retired", "DS1101 deadCaller"]);
  });
});

describe("an export used only in a file a script token or a configuration string names", () => {
  it("is a redundant export keyword, as in a file nothing names, while an entry file's export is not", () => {
    const root = writeProject({
      "package.json": JSON.stringify({
        name: "@example/scripts",
        private: true,
        type: "module",
        scripts: { start: "node src/run.ts" },
      }),
      "src/main.ts": "export const label = 1;\nconsole.log(label);\n",
      "src/run.ts": "export function step(): number { return 1; }\nconsole.log(step());\n",
    });
    try {
      const { config } = resolve({
        repository: {
          text: JSON.stringify({
            target: { kind: "application" },
            ts: { entry_files: ["src/main.ts"] },
          }),
          label: "deadset.json",
        },
      });
      expect(
        findingsOf(emitterInputOf(root, config))
          .filter((finding) => finding.code === "DS1503")
          .map((finding) => `${finding.symbol.name} ${finding.position.path}`),
      ).toEqual(["step src/run.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("an export of a file a document imports", () => {
  it("is a redundant export keyword where the document does not import it and only its own file references it", () => {
    const root = writeProject({
      "package.json": '{ "name": "@example/site", "private": true, "type": "module" }\n',
      "docs/intro.mdx": 'import { Demo } from "../src/demo.ts";\n\n<Demo label="intro" />\n',
      "src/main.ts": "console.log(1);\n",
      "src/demo.ts":
        "export type DemoProps = {\n  readonly label: string;\n};\n\nexport function Demo(props: DemoProps): string {\n  return props.label;\n}\n",
    });
    try {
      const { config } = resolve({
        repository: {
          text: JSON.stringify({
            target: { kind: "application" },
            ts: { entry_files: ["src/main.ts"] },
          }),
          label: "deadset.json",
        },
      });
      expect(
        findingsOf(emitterInputOf(root, config)).map(
          (finding) => `${finding.code} ${finding.symbol.name}`,
        ),
      ).toEqual(["DS1503 DemoProps"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
