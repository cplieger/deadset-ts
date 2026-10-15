import { describe, expect, it } from "vitest";
import type { Finding, Report } from "../contract/report.generated.ts";
import type { RenderOptions } from "./reporter.ts";
import { sarif } from "./sarif.ts";

function finding(path: string, line: number): Finding {
  return {
    code: "DS1503",
    kind: "redundant-export-keyword",
    language: "ts",
    position: { path, line, column: 1, end_line: line },
    symbol: {
      ref: `ts://@example/app/${path}#x${String(line)}`,
      kind: "function",
      name: `x${String(line)}`,
      size_lines: 1,
    },
    reachability_class: "certain",
    confidence: "certain",
    test_only: false,
    generated: false,
    component: { id: "deadset-ts/c-0001", root: true, symbol_count: 1, deletable_lines: 1 },
    retained_by: [],
    configurations: ["tsconfig.json"],
    consumers_loaded: [],
    fixability: "deletable",
    severity: "warn",
    message: "exported function is used only inside its own file",
    details: { narrower_visibility: "file" },
  };
}

function report(findings: readonly Finding[], languages: Report["analyzer"]["languages"]): Report {
  return {
    schema_version: "6.0.0",
    contract_version: "3.2.0",
    analyzer: {
      name: "deadset-ts",
      version: "1.2.3",
      languages,
      schema_versions_accepted: ["6.0.0"],
      conformance: { corpus_version: "1.9.0", result: "fail", digest: `sha256:${"0".repeat(64)}` },
    },
    target: { kind: "application", root: ".", identity: "@example/app" },
    configurations: [{ id: "tsconfig.json", project: "tsconfig.json" }],
    configurations_not_built: [],
    consumers: { declared: 0, loaded: [], unavailable: [] },
    findings,
    edge_evaluations: [],
    stale_suppressions: [],
    declared_gaps: [],
    excluded_by_cgo: [],
    test_file_rules: [],
    type_error_skips: [],
    notes: [],
    unanswered_questions: [],
    conventions_applied: [],
    totals: {
      findings: findings.length,
      by_severity: { allow: 0, warn: findings.length, deny: 0 },
      deletable_lines: findings.length,
      suppressions_in_effect: 0,
      reasons_recorded: 0,
      stale_suppressions: 0,
      pending: 0,
      omitted: 0,
      withheld: { certain: 0, probable: 0, possible: 0 },
    },
  };
}

interface Run {
  readonly automationDetails: { readonly id: string };
  readonly results: readonly {
    readonly locations: readonly {
      readonly physicalLocation: { readonly artifactLocation: { readonly uri: string } };
    }[];
  }[];
}

function runOf(of: Report, readSource: RenderOptions["readSource"]): Run {
  const log = JSON.parse([...sarif(of, { readSource, template: undefined })].join(""));
  return (log as { runs: readonly Run[] }).runs[0] as Run;
}

describe("the SARIF rendering", () => {
  it("leaves every letter and digit of a path unencoded", () => {
    const path = "AZaz09/Q9z.ts";
    const run = runOf(report([finding(path, 1)], ["ts"]), () => "x\n");

    expect(run.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri).toBe(path);
  });

  it("reads each source file once, however many results sit in it", () => {
    const reads: string[] = [];
    runOf(report([finding("a.ts", 1), finding("a.ts", 2), finding("b.ts", 1)], ["ts"]), (path) => {
      reads.push(path);
      return "one\ntwo\n";
    });

    expect(reads).toEqual(["a.ts", "b.ts"]);
  });

  it("names the run's automation by its languages in ascending order", () => {
    expect(runOf(report([], ["ts", "go"]), () => "").automationDetails.id).toBe("deadset/go+ts/");
  });
});
