import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
} from "./findings-pass.ts";
import { resolve } from "./resolve.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine } from "./session.ts";
import { BASELINE_FILE, writeBaseline } from "./suppress-file.ts";
import { EXIT_CLEAN, EXIT_FINDINGS } from "./verbs/verb.ts";

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
    });
  });

  it("fail the run on a stale suppression", () => {
    expect(exit).toBe(EXIT_FINDINGS);
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
  const written = writeBaseline(recordedFindings(first.result), analyzerProvenance("1.2.3"));
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
