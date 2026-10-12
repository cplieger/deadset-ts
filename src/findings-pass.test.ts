import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { runAnalysis } from "./analysis.ts";
import { ConfigError } from "./config.ts";
import {
  EXIT_PENDING,
  analyzerProvenance,
  recordedFindings,
  verdictOf,
  type PassResult,
  type RecordableFinding,
} from "./findings-pass.ts";
import { resolve } from "./resolve.ts";
import { scopeForDir } from "./scope.ts";
import { isRowCode, isRowSubject } from "./suppress.ts";
import { openEngine } from "./session.ts";
import { BASELINE_FILE, otherSchemeRows, writeBaseline } from "./suppress-file.ts";
import { EXIT_CLEAN, EXIT_FAILURE, EXIT_FINDINGS } from "./verbs/verb.ts";
import { whole } from "../__test-helpers__/whole.ts";

const SUPPRESSIONS = fixture("projects", "suppressions");
const EDGES = fixture("projects", "edge-evaluation");
const NARROWING = fixture("projects", "visibility-narrowing");
const MALFORMED = fixture("projects", "suppressions-malformed");

/** The pass over one target under its own configuration, or under the one given. */
function passOver(root: string, document?: string): { result: PassResult; exit: number } {
  const host = nodeHost();
  const path = join(root, "deadset.json");
  const { config, provenance } = resolve({
    repository: document ?? readFileSync(path, "utf8"),
    repositoryLabel: path,
  });
  const engine = openEngine({ collectTiming: false });
  const { result } = runAnalysis(engine, host, scopeForDir(host, root), config, provenance, {
    production: true,
  });
  return { result, exit: verdictOf(result, config) };
}

/** Each finding as its code and the name of its subject. */
function named(result: PassResult): string[] {
  return result.findings.map((finding) => `${finding.code} ${finding.symbol.name}`);
}

/** Each stale suppression as its position, its mechanism and its message. */
function stale(result: PassResult): string[] {
  return result.staleSuppressions.map(
    (record) =>
      `${record.position.path}:${String(record.position.line)}:${String(record.position.column)} ${record.mechanism}: ${record.message}`,
  );
}

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A copy of one fixture in a fresh directory, which a test may then edit. */
function copyOf(root: string): string {
  const dir = mkdtempSync(join(tmpdir(), "deadset-ts-"));
  scratch.push(dir);
  cpSync(root, dir, { recursive: true });
  return dir;
}

describe("the suppressions of a target", () => {
  const { result, exit } = passOver(SUPPRESSIONS);

  it("withhold what each record names, keep its dependents live, and report every refusal", () => {
    expect(named(result)).toEqual([
      "DS1702 ts://@example/suppressions/src/lib.ts#inBlock",
      "DS1104 stillUsed",
      "DS1002 separated",
      "DS1701 ts://@example/suppressions/src/lib.ts#",
      "DS1002 reasonless",
      "DS1002 inBlock",
    ]);
  });

  it("report every record that withheld nothing at its own site, naming the code its declaration reports", () => {
    expect(stale(result)).toEqual([
      "src/lib.ts:14:1 inline: inline directive for DS1002 matches no current finding, and its declaration reports DS1104",
      "src/lib.ts:17:1 inline: inline directive for DS1001 matches no current finding, and its declaration reports DS1002",
      "src/lib.ts:20:1 inline: inline directive for DS1002 matches no current finding",
      "deadset-ignore.json:10:5 ignore: ignore entry for DS1002 matches no current finding",
      "deadset-ignore.json:21:5 ignore: ignore entry for DS1002 matches no current finding",
    ]);
  });

  it("count only the records in effect, and every directive and entry that carries a reason", () => {
    expect(result.totals).toEqual({
      suppressionsInEffect: 2,
      reasonsRecorded: 7,
      staleSuppressions: 5,
      pending: 0,
      withheld: { certain: 0, probable: 0, possible: 0 },
    });
  });

  it("fail the run on a stale suppression", () => {
    expect(exit).toBe(EXIT_FINDINGS);
  });
});

describe("a record naming a row of a document", () => {
  const root = copyOf(SUPPRESSIONS);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as object;
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ ...manifest, devDependencies: { "left-pad": "1.0.0", "right-pad": "1.0.0" } }),
  );
  writeFileSync(
    join(root, "deadset-ignore.json"),
    JSON.stringify({
      ignore: [
        {
          code: "DS1601",
          symbol: "ts://@example/suppressions/package.json#left-pad:dev-dependency",
          path: "package.json",
          reason: "loaded by a tool configuration",
        },
        {
          code: "DS1704",
          symbol: "ts://@example/suppressions/src/lib.ts#entryNamed",
          path: "src/lib.ts",
          reason: "a root kept for later",
        },
      ],
    }),
  );
  writeFileSync(
    join(root, "src/lib.ts"),
    `${readFileSync(join(root, "src/lib.ts"), "utf8")}\n// deadset:ignore DS1601,DS1704 -- kept for a tool\nfunction rowsNamed(): void {}\n\n// deadset:ignore DS1001,DS1601 -- kept for a tool\nfunction mixedNamed(): void {}\n`,
  );
  const { result } = passOver(root);

  it("withholds a dependency row an ignore entry names, and only that row", () => {
    expect(
      result.findings.filter((one) => one.code === "DS1601").map((one) => one.symbol.name),
    ).toEqual(["right-pad"]);
    expect(result.ledger.verdicts.filter((one) => one === "in-effect").length).toBeGreaterThan(0);
  });

  it("is stale where the row is no dependency row, and its message names the remedy", () => {
    expect(stale(result).filter((one) => one.includes("ignore:"))).toEqual([
      "deadset-ignore.json:1:169 ignore: ignore entry for DS1704 matches no current finding, because DS1704 reports a row of a document, which no suppression can name; fix what the finding names instead; its declaration reports DS1002",
    ]);
  });

  it("is stale inline, and its message names every row code and what its declaration reports", () => {
    expect(stale(result).filter((one) => /^src\/lib\.ts:3[69]:/u.test(one))).toEqual([
      "src/lib.ts:36:1 inline: inline directive for DS1601 and DS1704 matches no current finding, because DS1704 reports a row of a document, which no suppression can name; fix what the finding names instead; DS1601 reports a dependency row, which only an ignore entry or a baseline row can name; its declaration reports DS1002",
      "src/lib.ts:39:1 inline: inline directive for DS1001 and DS1601 matches no current finding, because DS1601 reports a dependency row, which only an ignore entry or a baseline row can name; its declaration reports DS1002",
    ]);
  });

  it("reports a row code exactly where its subject is a row of a document", () => {
    const codes = result.findings.map(
      (one) => `${one.code} ${String(isRowCode(one.code) === isRowSubject(one.symbol.kind))}`,
    );
    expect(codes).toContain("DS1601 true");
    expect(codes.filter((one) => one.endsWith("false"))).toEqual([]);
  });
});

describe("a suppression whose code the configuration silences", () => {
  const { result } = passOver(
    SUPPRESSIONS,
    JSON.stringify({ target: { kind: "application" }, severity: { DS1002: "allow" } }),
  );

  it("is dormant: neither counted in effect nor stale", () => {
    expect(stale(result)).toEqual([
      "src/lib.ts:17:1 inline: inline directive for DS1001 matches no current finding, and its declaration reports DS1002",
      "src/lib.ts:20:1 inline: inline directive for DS1002 matches no current finding",
      "deadset-ignore.json:10:5 ignore: ignore entry for DS1002 matches no current finding",
    ]);
    expect(result.totals.suppressionsInEffect).toBe(0);
    expect(result.totals.reasonsRecorded).toBe(7);
  });
});

/** A written target whose library is `lib`, adjudicated by the ignore entries given. */
function targetWith(lib: string, ignore: readonly Readonly<Record<string, string>>[]): string {
  const root = writeProject({
    "package.json": JSON.stringify({
      name: "@example/dials",
      private: true,
      type: "module",
      main: "./src/main.ts",
    }),
    "src/main.ts": 'import { used } from "./lib.js";\nused();\n',
    "src/lib.ts": lib,
    "deadset-ignore.json": JSON.stringify({ ignore }),
  });
  scratch.push(root);
  return root;
}

describe("a suppression of a finding that falls with a withheld root", () => {
  const root = targetWith(
    "export function used(): void {}\nexport function unusedRoot(): void {\n  leaf();\n}\nfunction leaf(): void {}\n",
    [
      {
        code: "DS1002",
        symbol: "ts://@example/dials/src/lib.ts#leaf",
        path: "src/lib.ts",
        reason: "Kept for the next release.",
      },
    ],
  );

  it("is in effect while the root is reported", () => {
    const { result } = passOver(root, JSON.stringify({ target: { kind: "application" } }));

    expect(named(result)).toEqual(["DS1001 unusedRoot"]);
    expect(result.totals.suppressionsInEffect).toBe(1);
  });

  it("is dormant once the configuration withholds the root, and neither stale nor counted", () => {
    const { result } = passOver(
      root,
      JSON.stringify({ target: { kind: "application" }, severity: { DS1001: "allow" } }),
    );

    expect(result.staleSuppressions).toEqual([]);
    expect(result.totals.suppressionsInEffect).toBe(0);
    expect(result.totals.reasonsRecorded).toBe(1);
  });
});

describe("a suppression of a finding only the marked sweep reports", () => {
  it("is in effect while the unmarked sweep withholds a component of the same number", () => {
    const root = writeProject({
      "package.json": JSON.stringify({
        name: "@example/two-sweeps",
        private: true,
        type: "module",
        main: "./src/main.ts",
      }),
      "src/main.ts": 'import "./plugin.ts";\n',
      "src/plugin.ts":
        "// deadset:ignore DS1001 -- Called by name from the plugin loader.\nexport function loaded(): void {\n  helper();\n}\n\n// deadset:ignore DS1104 -- Part of the public plugin surface.\nexport function helper(): void {}\n",
    });
    scratch.push(root);
    const { result, exit } = passOver(
      root,
      JSON.stringify({ target: { kind: "application" }, severity: { DS1001: "allow" } }),
    );

    expect(result.ledger.verdicts).toEqual(["dormant", "in-effect"]);
    expect(result.totals.suppressionsInEffect).toBe(1);
    expect(exit).toBe(EXIT_CLEAN);
  });
});

/** A written library whose one published file is `lib`, adjudicated by the entries given. */
function libraryWith(lib: string, ignore: readonly Readonly<Record<string, string>>[]): string {
  const root = writeProject({
    "package.json": JSON.stringify({
      name: "@example/parts",
      type: "module",
      exports: { ".": "./src/lib.ts" },
    }),
    "src/lib.ts": lib,
    "deadset-ignore.json": JSON.stringify({ ignore }),
  });
  scratch.push(root);
  return root;
}

describe("a suppression of a part of a published declaration", () => {
  const lib = [
    "// deadset:ignore DS1801 -- The signature is the published callback shape.",
    "export function above(_a: number, _b: number): number {",
    "  return 1;",
    "}",
    "export class Store {",
    "  note(_committed: number): number { // deadset:ignore DS1801 -- Kept for the next minor.",
    "    return 1;",
    "  }",
    "}",
    "export function wrapped(",
    "  first: number,",
    "  _second: number, // deadset:ignore DS1801 -- Kept for the next minor.",
    "): number {",
    "  return first;",
    "}",
    "export function entry(_x: number): number {",
    "  return 1;",
    "}",
    "// deadset:ignore DS1801 -- Nothing here is unused.",
    "export function read(a: number): number {",
    "  return a;",
    "}",
    "",
  ].join("\n");
  const root = libraryWith(lib, [
    {
      code: "DS1801",
      symbol: "ts://@example/parts/src/lib.ts#entry",
      path: "src/lib.ts",
      reason: "The signature is the published callback shape.",
    },
  ]);
  const { result } = passOver(root, JSON.stringify({ target: { kind: "library" } }));

  it("is in effect at the default minimum confidence, one record holding every part of its code", () => {
    expect(result.findings.filter((one) => one.code === "DS1801")).toEqual([]);
    expect(result.totals.suppressionsInEffect).toBe(4);
  });

  it("is stale where the declaration's parts are all used", () => {
    expect(stale(result).map((one) => one.slice(0, one.indexOf(" ")))).toEqual(["src/lib.ts:19:1"]);
  });
});

describe("a trailing directive", () => {
  const root = targetWith(
    [
      "export function used(): void {",
      "  used.call(null); // deadset:ignore DS1002 -- No declaration begins on this line.",
      "  const local = 1;",
      "  void local;",
      "}",
      "const held = 1; // deadset:ignore DS1002 -- Read by the generator.",
      "const next = 2;",
      "",
    ].join("\n"),
    [],
  );
  const { result } = passOver(root, JSON.stringify({ target: { kind: "application" } }));

  it("binds the declaration that begins on its own line and nothing on the next", () => {
    expect(named(result).filter((one) => one.startsWith("DS1002"))).toEqual(["DS1002 next"]);
    expect(result.totals.suppressionsInEffect).toBe(1);
  });

  it("binds nothing on a line where no declaration begins", () => {
    expect(stale(result).map((one) => one.slice(0, one.indexOf(" ")))).toEqual(["src/lib.ts:2:20"]);
  });
});

describe("JSX text that begins with //", () => {
  const root = writeProject({
    "package.json": JSON.stringify({
      name: "app",
      private: true,
      type: "module",
      main: "./main.tsx",
    }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ESNext",
        module: "NodeNext",
        moduleResolution: "nodenext",
        jsx: "preserve",
        noEmit: true,
      },
      include: ["**/*.tsx"],
    }),
    "main.tsx": [
      "declare global {",
      "  namespace JSX {",
      "    interface IntrinsicElements {",
      "      [name: string]: unknown;",
      "    }",
      "  }",
      "}",
      "",
      "export const page = <p>",
      "  // deadset:ignore DS1001 -- JSX text, not a comment",
      "</p>; function unused(): void {}",
      "export const note = <b>// deadset:ignore junk</b>;",
      "console.log(page, note);",
      "",
    ].join("\n"),
  });
  scratch.push(root);

  it("is rendered text, so it is no directive, binds nothing and refuses nothing", () => {
    const { result } = passOver(root, JSON.stringify({ target: { kind: "application" } }));
    expect(named(result).filter((one) => one.endsWith(" unused"))).toEqual(["DS1002 unused"]);
    expect(stale(result)).toEqual([]);
  });
});

describe("a stale suppression", () => {
  it("has no severity a configuration may set", () => {
    expect(() =>
      resolve({
        repository: JSON.stringify({
          target: { kind: "application" },
          severity: { DS1703: "warn" },
        }),
        repositoryLabel: "deadset.json",
      }),
    ).toThrow(ConfigError);
  });

  it("fails a run that reports nothing else, under a configuration that silences every code it could name", () => {
    const root = targetWith("export function used(): void {}\n", [
      {
        code: "DS1002",
        symbol: "ts://@example/dials/src/lib.ts#removed",
        path: "src/lib.ts",
        reason: "The declaration this named has been deleted.",
      },
    ]);
    const { result, exit } = passOver(
      root,
      JSON.stringify({ target: { kind: "application" }, severity: { DS1002: "allow" } }),
    );

    expect(named(result)).toEqual([]);
    expect(stale(result)).toEqual([
      "deadset-ignore.json:1:12 ignore: ignore entry for DS1002 matches no current finding",
    ]);
    expect(exit).toBe(EXIT_FINDINGS);
  });
});

describe("the findings of a run", () => {
  it("are ordered by path, then line, then column, whatever their subjects' order", () => {
    const root = writeProject({
      "package.json": JSON.stringify({
        name: "@example/order",
        private: true,
        type: "module",
        main: "./src/main.ts",
      }),
      "src/main.ts":
        'import { used as a } from "./a.js";\nimport { used as b } from "./b.js";\na();\nb();\n',
      "src/a.ts": "export function used(): void {}\nconst zeta = 1;\nconst alpha = 2;\n",
      "src/b.ts": "export function used(): void {}\nlet beta = 1;\n",
    });
    scratch.push(root);
    const { result } = passOver(root, JSON.stringify({ target: { kind: "application" } }));

    expect(
      result.findings.map(
        (one) =>
          `${one.position.path}:${String(one.position.line)}:${String(one.position.column)} ${one.code} ${one.symbol.name}`,
      ),
    ).toEqual([
      "src/a.ts:2:7 DS1002 zeta",
      "src/a.ts:3:7 DS1002 alpha",
      "src/b.ts:2:5 DS1002 beta",
    ]);
  });
});

describe("a configured root that names nothing", () => {
  it("is a finding of the self-check family at the first position of the document that declared it", () => {
    const { result } = passOver(fixture("projects", "configured-roots"));

    expect(
      result.findings
        .filter((finding) => finding.code === "DS1704")
        .map(
          (finding) =>
            `${finding.position.path}:${String(finding.position.line)} ${finding.symbol.name}`,
        ),
    ).toEqual([
      "deadset.json:1 ts://@example/configured-roots/*#nothing?",
      "deadset.json:1 ts://@example/configured-roots/a/gone.ts#gone",
    ]);
  });
});

describe("a malformed inline directive", () => {
  it("ends the run with a usage refusal naming the first one written", () => {
    expect(() => passOver(MALFORMED)).toThrow(ConfigError);
    expect(() => passOver(MALFORMED)).toThrow(/^inline src\/main\.ts:3:1: /u);
  });
});

describe("a baseline", () => {
  const root = copyOf(SUPPRESSIONS);
  rmSync(join(root, "deadset-ignore.json"));
  const first = passOver(root);
  const written = whole(
    writeBaseline(recordedFindings(first.result.findings), analyzerProvenance("1.2.3")),
  );
  writeFileSync(join(root, BASELINE_FILE), written);
  const again = passOver(root);

  it("records every finding of the run but the document rows, with the analyzer's provenance as its reason", () => {
    const rows = (JSON.parse(written) as { baseline: { code: string; reason: string }[] }).baseline;

    expect(rows.map((row) => row.code)).toEqual(["DS1104", "DS1002", "DS1002", "DS1002", "DS1002"]);
    expect(new Set(rows.map((row) => row.reason))).toEqual(
      new Set(["recorded by deadset-ts 1.2.3"]),
    );
  });

  it("read back on the unchanged tree suppresses every row and exits 0", () => {
    expect(first.exit).toBe(EXIT_FINDINGS);
    expect(named(again.result)).toEqual(["DS1701 ts://@example/suppressions/src/lib.ts#"]);
    expect(
      again.result.staleSuppressions.filter((record) => record.mechanism === "baseline"),
    ).toEqual([]);
    expect(again.result.totals.suppressionsInEffect).toBe(
      first.result.totals.suppressionsInEffect + 5,
    );
  });

  it("fails the run on a finding it does not record", () => {
    const grown = copyOf(root);
    writeFileSync(join(grown, "src", "added.ts"), "function addedSince(): void {}\n");
    const { result, exit } = passOver(grown);

    expect(named(result).filter((entry) => entry.startsWith("DS100"))).toEqual([
      "DS1002 addedSince",
    ]);
    expect(exit).toBe(EXIT_FINDINGS);
  });
});

describe("a declared edge whose own side has no local reference", () => {
  const { result, exit } = passOver(EDGES);

  it("holds the finding inside the side's evaluation and reports it nowhere else", () => {
    expect(
      result.edgeEvaluations.map(
        (one) => `${one.edge} ${one.side} ${one.state} ${one.finding?.code ?? "-"}`,
      ),
    ).toEqual([
      "wire/live-helper provides live -",
      "wire/renamed provides absent -",
      "wire/server-event used_by dead DS1001",
    ]);
    expect(named(result).filter((entry) => entry.includes("ServerEvent"))).toEqual([]);
  });

  it("exits with the pending code, naming the pending count", () => {
    expect(result.totals.pending).toBe(1);
    expect(exit).toBe(EXIT_PENDING);
  });

  it("never resolves the paired symbol", () => {
    const root = copyOf(EDGES);
    const path = join(root, "deadset-edges.json");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replaceAll(
        "go://example.com/app/wire#",
        "go://example.com/elsewhere#Other",
      ),
    );

    expect(passOver(root).result.edgeEvaluations).toEqual(result.edgeEvaluations);
  });

  it("evaluates the side live when the dials withhold the finding it would hold", () => {
    const { result: dialed, exit: dialedExit } = passOver(
      EDGES,
      JSON.stringify({ target: { kind: "application" }, severity: { DS1001: "allow" } }),
    );

    expect(dialed.edgeEvaluations.map((one) => `${one.edge} ${one.side} ${one.state}`)).toEqual([
      "wire/live-helper provides live",
      "wire/renamed provides absent",
      "wire/server-event used_by live",
    ]);
    expect(dialedExit).toBe(EXIT_CLEAN);
  });
});

describe("a declared edge naming a symbol a narrowing kind reports", () => {
  it("holds the narrowing finding pending as it holds a dead one", () => {
    const { result, exit } = passOver(NARROWING);

    expect(
      result.edgeEvaluations.map(
        (one) => `${one.edge} ${one.side} ${one.state} ${one.finding?.code ?? "-"}`,
      ),
    ).toEqual([
      "wire/provided-to-generated provides dead DS1103",
      "wire/used-by-generated used_by dead DS1104",
    ]);
    expect(exit).toBe(EXIT_PENDING);
  });

  it("completes the pending findings in the step that completes the reported ones", () => {
    const { result } = passOver(NARROWING);
    const reported = new Set(result.findings.map((finding) => finding.component.id));

    expect(
      result.edgeEvaluations.map(
        (one) => `${one.finding?.kind ?? "-"} ${one.finding?.component.id ?? "-"}`,
      ),
    ).toEqual([
      "unreachable-export deadset-ts/c-0003",
      "redundant-export-keyword deadset-ts/c-0012",
    ]);
    expect(reported.has("deadset-ts/c-0012")).toBe(false);
  });
});

describe("a report holding no pending finding, no stale suppression and nothing failing", () => {
  it("is clean", () => {
    const root = copyOf(EDGES);
    rmSync(join(root, "deadset-edges.json"));
    writeFileSync(join(root, "src", "wire.ts"), "export function liveHelper(): void {}\n");

    expect(passOver(root).exit).toBe(EXIT_CLEAN);
  });
});

/** The published baseline vector cases, each by its directory name, in ascending order. */
function baselineCases(): string[] {
  return readdirSync(fixture("vectors", "baseline"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** One file of one baseline vector case, decoded. */
function baselineCase(name: string, file: string): unknown {
  return JSON.parse(readFileSync(fixture("vectors", "baseline", name, file), "utf8")) as unknown;
}

/** Whether one baseline vector case expects its write to be refused. */
function refused(name: string): boolean {
  return existsSync(fixture("vectors", "baseline", name, "expected-error.json"));
}

describe("the published baseline vectors", () => {
  it("are the case set this suite runs", () => {
    expect(baselineCases()).toEqual([
      "backslash-in-a-file-name",
      "declarations-and-parts",
      "document-rows-left-out",
      "existing-document-not-a-baseline",
      "line-separator-written-by-go",
      "line-separator-written-by-typescript",
      "nothing-to-record",
      "one-document-written-by-go",
      "one-document-written-by-typescript",
      "other-scheme-row-unreadable",
      "other-scheme-rows-kept",
      "own-scheme-row-unreadable",
      "typescript-rows",
    ]);
  });

  /** The document one case's round writes over its existing document, or the refusal. */
  const writeOf = (name: string): (() => string) => {
    const report = baselineCase(name, "report.json") as {
      analyzer: { name: string; version: string; languages: readonly string[] };
      findings: RecordableFinding[];
    };
    const path = fixture("vectors", "baseline", name, "existing.json");
    const existing = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    const own = `${String(report.analyzer.languages[0])}://`;
    return () =>
      whole(
        writeBaseline(
          recordedFindings(report.findings),
          { analyzer: report.analyzer.name, version: report.analyzer.version },
          existing === undefined ? [] : otherSchemeRows(existing, own),
        ),
      );
  };

  it.each(baselineCases().filter((name) => !refused(name)))(
    "records the rows %s states from its round's report, in the bytes it states",
    (name) => {
      const expected = baselineCase(name, "expected.json") as { baseline: unknown[] };
      const written = writeOf(name)();

      expect((JSON.parse(written) as { baseline: unknown[] }).baseline).toEqual(expected.baseline);
      expect(written).toBe(
        readFileSync(fixture("vectors", "baseline", name, "expected.json"), "utf8"),
      );
    },
  );

  it.each(baselineCases().filter(refused))(
    "refuses to rewrite the document %s holds, which the verb ends with its exit code",
    (name) => {
      const want = baselineCase(name, "expected-error.json") as { exit_code: number };

      expect(want.exit_code).toBe(EXIT_FAILURE);
      expect(writeOf(name)).toThrow(/cannot be rewritten/u);
    },
  );
});
