import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixture } from "../../__test-helpers__/fixtures.ts";
import type { Report, WireFinding, WireStaleSuppression } from "../report.ts";
import { RenderError, type RenderOptions } from "./reporter.ts";
import { sarif } from "./sarif.ts";

/** The SARIF log one report renders to, as the file holds it. */
function sarifText(of: Report, with_: RenderOptions): string {
  return [...sarif(of, with_)].join("");
}

const WRITE_ONLY: WireFinding = {
  code: "DS1301",
  kind: "write-only-symbol",
  language: "ts",
  position: { path: "src/tabs index.ts", line: 3, column: 11, end_line: 3 },
  symbol: {
    ref: "ts://@example/app/src/tabs index.ts#TabStrip.cachedLayout",
    kind: "class-member",
    name: "TabStrip.cachedLayout",
    size_lines: 1,
  },
  reachability_class: "certain",
  confidence: "certain",
  liveness_relation: "reference-counting",
  test_only: false,
  generated: false,
  component: { id: "deadset-ts/c-0001", root: true, symbol_count: 1, deletable_lines: 1 },
  retained_by: [],
  configurations: ["tsconfig.json"],
  consumers_loaded: [],
  fixability: "deletable",
  severity: "deny",
  message: "private member is written and never read",
  details: {
    write_positions: [
      { path: "src/tabs index.ts", line: 4, column: 9, end_line: 4 },
      { path: "src/tabs index.ts", line: 5, column: 9, end_line: 5 },
    ],
  },
};

const NARROWING: WireFinding = {
  ...WRITE_ONLY,
  code: "DS1104",
  kind: "redundant-export-keyword",
  position: { path: "a:b/x.ts", line: 1, column: 1, end_line: 2 },
  symbol: { ref: "ts://@example/app/a:b/x.ts#x", kind: "function", name: "x", size_lines: 2 },
  severity: "warn",
  message: "exported function is used only inside its own file",
  details: { narrower_visibility: "file" },
};

const STALE: WireStaleSuppression = {
  code: "DS1703",
  mechanism: "inline",
  entry: { code: "DS1001", path: "a:b/x.ts", reason: "kept" },
  position: { path: "a:b/x.ts", line: 2, column: 1 },
  symbol: "ts://@example/app/a:b/x.ts#y",
  message: "inline directive for DS1001 matches no current finding",
};

/** The source files the findings sit in, by target-relative path. */
const SOURCES: Readonly<Record<string, string>> = {
  "src/tabs index.ts":
    "class TabStrip {\n\n  private cachedLayout = 0;\n  a() { this.cachedLayout = 1; }\n  b() { this.cachedLayout = 2; }\n}\n",
  "a:b/x.ts": "function x() {}\n// deadset:ignore DS1001 -- kept\n",
};

function report(findings: readonly WireFinding[], stale: readonly WireStaleSuppression[]): Report {
  return {
    schema_version: "6.0.0",
    contract_version: "3.2.0",
    analyzer: {
      name: "deadset-ts",
      version: "1.2.3",
      languages: ["ts"],
      schema_versions_accepted: ["6.0.0"],
      conformance: { corpus_version: "1.9.0", result: "fail", digest: `sha256:${"0".repeat(64)}` },
    },
    target: { kind: "application", root: ".", identity: "@example/app" },
    configurations: [{ id: "tsconfig.json", project: "tsconfig.json" }],
    configurations_not_built: [],
    consumers: { declared: 0, loaded: [], unavailable: [] },
    findings,
    edge_evaluations: [],
    stale_suppressions: stale,
    declared_gaps: [],
    excluded_by_cgo: [],
    test_file_rules: [],
    type_error_skips: [],
    notes: [],
    unanswered_questions: [],
    conventions_applied: [],
    totals: {
      findings: findings.length,
      by_severity: { allow: 0, warn: 1, deny: 1 },
      deletable_lines: 1,
      suppressions_in_effect: 2,
      reasons_recorded: 2,
      stale_suppressions: stale.length,
      pending: 0,
      omitted: 0,
      withheld: { certain: 0, probable: 0, possible: 0 },
    },
  };
}

function options(
  readSource: (path: string) => string = (path) => SOURCES[path] ?? "",
): RenderOptions {
  return { failOn: "deny", readSource, template: undefined };
}

interface Log {
  readonly runs: readonly {
    readonly tool: { readonly driver: { readonly rules: readonly { readonly id: string }[] } };
    readonly automationDetails: { readonly id: string };
    readonly results: readonly Record<string, unknown>[];
    readonly properties: { readonly totals: unknown };
  }[];
}

function rendered(of: Report): Log {
  return JSON.parse(sarifText(of, options())) as Log;
}

function onlyRun(log: Log): Log["runs"][number] {
  const [run] = log.runs;
  if (run === undefined || log.runs.length !== 1) {
    throw new Error(`a log of ${String(log.runs.length)} runs`);
  }
  return run;
}

describe("the SARIF rendering", () => {
  it("lists one rule per live TypeScript kind in code order, whatever the results name", () => {
    const rules = onlyRun(rendered(report([], []))).tool.driver.rules;

    expect(rules.map((rule) => rule.id)).toHaveLength(28);
    expect(rules.map((rule) => rule.id)).toEqual(rules.map((rule) => rule.id).sort());
    expect(rules.map((rule) => rule.id)).not.toContain("DS1102");
    expect(rules.map((rule) => rule.id)).toContain("DS1706");
    expect(rules[0]).toEqual({
      id: "DS1001",
      name: "unused-exported",
      shortDescription: {
        text: "An exported symbol with no reference in the target and no reference from any loaded consumer.",
      },
      fullDescription: {
        text: expect.stringMatching(/^An exported symbol with no reference/u) as unknown,
      },
      help: { text: expect.stringMatching(/^An exported symbol with no reference/u) as unknown },
      defaultConfiguration: { level: "error" },
      properties: { precision: "very-high", problem: { severity: "error" } },
    });
  });

  it("appends a kind's precondition to its help after a blank line", () => {
    const rule = onlyRun(rendered(report([], []))).tool.driver.rules.find(
      (one) => one.id === "DS1104",
    ) as unknown as {
      help: { text: string };
      fullDescription: { text: string };
      defaultConfiguration: unknown;
    };

    expect(rule.help.text.startsWith(`${rule.fullDescription.text}\n\n`)).toBe(true);
    expect(rule.help.text.length).toBeGreaterThan(rule.fullDescription.text.length + 2);
    expect(rule.defaultConfiguration).toEqual({ level: "warning" });
  });

  it("renders a finding as a result at its rule, its level, its location and both fingerprint keys", () => {
    const run = onlyRun(rendered(report([NARROWING], [])));
    const index = run.tool.driver.rules.findIndex((rule) => rule.id === "DS1104");

    expect(run.results).toEqual([
      {
        ruleId: "DS1104",
        ruleIndex: index,
        level: "warning",
        message: { text: "exported function is used only inside its own file" },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "a%3Ab/x.ts", uriBaseId: "%SRCROOT%" },
              region: { startLine: 1, startColumn: 1, endLine: 2 },
            },
          },
        ],
        partialFingerprints: {
          primaryLocationLineHash: expect.stringMatching(/^[0-9a-f]+:1$/u) as unknown,
          "deadsetSymbolRef/v1": expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown,
        },
        properties: {
          language: "ts",
          symbol: NARROWING.symbol,
          reachability_class: "certain",
          confidence: "certain",
          liveness_relation: "reference-counting",
          test_only: false,
          generated: false,
          component: NARROWING.component,
          retained_by: [],
          configurations: ["tsconfig.json"],
          consumers_loaded: [],
          fixability: "deletable",
          details: { narrower_visibility: "file" },
        },
      },
    ]);
  });

  it("names each write position as a related location the message links to", () => {
    const [result] = onlyRun(rendered(report([WRITE_ONLY], []))).results;

    expect(result?.["message"]).toEqual({
      text: "private member is written and never read (see [write src/tabs index.ts:4:9](1), [write src/tabs index.ts:5:9](2))",
    });
    expect(result?.["relatedLocations"]).toEqual([
      {
        id: 1,
        physicalLocation: {
          artifactLocation: { uri: "src/tabs%20index.ts", uriBaseId: "%SRCROOT%" },
          region: { startLine: 4, startColumn: 9, endLine: 4 },
        },
        message: { text: "write" },
      },
      {
        id: 2,
        physicalLocation: {
          artifactLocation: { uri: "src/tabs%20index.ts", uriBaseId: "%SRCROOT%" },
          region: { startLine: 5, startColumn: 9, endLine: 5 },
        },
        message: { text: "write" },
      },
    ]);
  });

  it("names a component member that shares the finding's reference in another file", () => {
    const own = { ref: NARROWING.symbol.ref, name: "x", position: NARROWING.position };
    const twin = {
      ...own,
      position: { path: "b/x.ts", line: 1, column: 1, end_line: 1 },
    };
    const [result] = onlyRun(
      rendered(
        report(
          [
            {
              ...NARROWING,
              component: { ...NARROWING.component, symbol_count: 2, members: [own, twin] },
            },
          ],
          [],
        ),
      ),
    ).results;

    expect(result?.["relatedLocations"]).toEqual([
      {
        id: 1,
        physicalLocation: {
          artifactLocation: { uri: "b/x.ts", uriBaseId: "%SRCROOT%" },
          region: { startLine: 1, startColumn: 1, endLine: 1 },
        },
        message: { text: "member" },
      },
    ]);
  });

  it("renders a stale suppression after the findings, at error, with no member bag", () => {
    const results = onlyRun(rendered(report([NARROWING], [STALE]))).results;

    expect(results.map((one) => one["ruleId"])).toEqual(["DS1104", "DS1703"]);
    expect(results[1]).toMatchObject({
      level: "error",
      message: { text: STALE.message },
      locations: [{ physicalLocation: { region: { startLine: 2, startColumn: 1, endLine: 2 } } }],
    });
    expect(results[1]).not.toHaveProperty("properties");
  });

  it("carries the report's totals, which count the suppressions the document holds no result for", () => {
    const run = onlyRun(rendered(report([NARROWING], [])));

    expect(run.properties.totals).toMatchObject({ suppressions_in_effect: 2, reasons_recorded: 2 });
    expect(run.automationDetails.id).toBe("deadset/ts/");
  });

  it("joins a baseline on the symbol key, which a line move leaves unchanged while the line key moves", () => {
    const moved: WireFinding = {
      ...NARROWING,
      position: { ...NARROWING.position, line: 2, end_line: 2 },
    };
    const keys = (of: WireFinding): unknown =>
      onlyRun(rendered(report([of], []))).results[0]?.["partialFingerprints"];

    const before = keys(NARROWING) as Record<string, string>;
    const after = keys(moved) as Record<string, string>;
    expect(after["deadsetSymbolRef/v1"]).toBe(before["deadsetSymbolRef/v1"]);
    expect(after["primaryLocationLineHash"]).not.toBe(before["primaryLocationLineHash"]);
  });

  it("refuses to render where it cannot read the file a result is in", () => {
    expect(() =>
      sarifText(
        report([NARROWING], []),
        options(() => {
          throw new Error("no such file");
        }),
      ),
    ).toThrow(new RenderError("read a:b/x.ts for its line fingerprint: no such file"));
  });

  it("refuses to render a result at a line its file does not hold", () => {
    const past: WireFinding = { ...NARROWING, position: { ...NARROWING.position, line: 9 } };

    expect(() => sarifText(report([past], []), options())).toThrow(
      new RenderError("a:b/x.ts holds 3 lines and a record names line 9"),
    );
  });

  it("writes the same bytes for the same report", () => {
    const one = report([WRITE_ONLY, NARROWING], [STALE]);

    expect(sarifText(one, options())).toBe(sarifText(structuredClone(one), options()));
    expect(sarifText(one, options()).endsWith("}\n")).toBe(true);
  });
});

/** The published SARIF vector cases, each by its directory name, in ascending order. */
function sarifCases(): string[] {
  return readdirSync(fixture("vectors", "sarif"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** One file of one SARIF vector case, decoded, or undefined where the case holds none. */
function caseDocument(name: string, file: string): unknown {
  const path = fixture("vectors", "sarif", name, file);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown) : undefined;
}

/** The cases a merged report states: a run per input report, which the orchestrator renders. */
function isMerged(name: string): boolean {
  return existsSync(fixture("vectors", "sarif", name, "inputs"));
}

describe("the published SARIF vectors", () => {
  it("are the case set this suite runs, the merged ones being the orchestrator's", () => {
    expect(sarifCases().filter((name) => !isMerged(name))).toEqual([
      "component-member-sharing-the-finding-reference",
      "findings-and-a-stale-suppression",
      "implementations-and-component-members",
      "line-fingerprints",
      "line-past-the-end",
      "message-with-line-separators",
      "path-segments-encoded",
      "related-locations-capped",
      "withheld-line",
    ]);
  });

  it.each(sarifCases().filter((name) => !isMerged(name)))(
    "renders %s as the case states, compared as decoded values",
    (name) => {
      const report = caseDocument(name, "report.json") as Report;
      const sources = (caseDocument(name, "sources.json") as { files: Record<string, string> })
        .files;
      const render = (): string =>
        sarifText(
          report,
          options((path) => {
            if (!Object.hasOwn(sources, path)) {
              throw new Error(`${path} is not a file of the case`);
            }
            return sources[path] ?? "";
          }),
        );
      const exit = existsSync(fixture("vectors", "sarif", name, "expected_exit"))
        ? readFileSync(fixture("vectors", "sarif", name, "expected_exit"), "utf8").trim()
        : undefined;

      if (exit !== undefined) {
        expect(exit, "the one exit code a failed rendering ends with").toBe("3");
        expect(render).toThrow(RenderError);
        return;
      }
      expect(JSON.parse(render())).toEqual(caseDocument(name, "expected.json"));
    },
  );
});
