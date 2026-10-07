import { describe, expect, it } from "vitest";
import { readFixture } from "../../__test-helpers__/fixtures.ts";
import type { Report, WireFinding, WireStaleSuppression } from "../report.ts";
import { text } from "./text.ts";

/** The text rendering of one report, as the file holds it. */
function textOf(of: Report): string {
  return [...text(of)].join("");
}

/** The text line's defining expression, read from the Contract's page rather than restated. */
function publishedExpression(): RegExp {
  const page = readFixture("contract", "grammar", "text-line.md");
  const section = page.slice(page.indexOf("## The expression"));
  const block = /```text\n(?<expression>[^\n]+)\n```/u.exec(section)?.groups?.["expression"];
  if (block === undefined) {
    throw new Error("text-line.md publishes no expression under its heading");
  }
  return new RegExp(block);
}

const LINE = publishedExpression();

const FINDING: WireFinding = {
  code: "DS1301",
  kind: "write-only",
  language: "ts",
  position: { path: "src/features/tabs/index.ts", line: 1182, column: 11, end_line: 1182 },
  symbol: {
    ref: "ts://@example/app/src/features/tabs/index.ts#TabStrip.cachedLayout",
    kind: "class-member",
    name: "TabStrip.cachedLayout",
    size_lines: 1,
  },
  reachability_class: "certain",
  confidence: "certain",
  liveness_relation: "reference-counting",
  test_only: false,
  generated: false,
  component: { id: "deadset-ts/c-1", root: true, symbol_count: 1, deletable_lines: 1 },
  retained_by: [],
  configurations: ["tsconfig.json"],
  consumers_loaded: [],
  fixability: "deletable",
  severity: "deny",
  message: "private member is written and never read: see (notes) [below]",
  details: {},
};

const STALE: WireStaleSuppression = {
  code: "DS1703",
  mechanism: "inline",
  entry: { code: "DS1001", path: "src/catalog.ts", reason: "reached through a plugin" },
  position: { path: "src/catalog.ts", line: 213, column: 1 },
  symbol: "ts://@example/app/src/catalog.ts#Catalog.resolveAlias",
  message: "inline directive for DS1001 matches no current finding",
};

function report(findings: readonly WireFinding[], stale: readonly WireStaleSuppression[]): Report {
  return {
    schema_version: "6.0.0",
    contract_version: "3.2.0",
    analyzer: {
      name: "deadset-ts",
      version: "0.0.0",
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
      findings: findings.length + 1,
      by_severity: { allow: 0, warn: 0, deny: findings.length + 1 },
      deletable_lines: 1,
      suppressions_in_effect: 1,
      reasons_recorded: 2,
      stale_suppressions: stale.length,
      pending: 0,
      omitted: 1,
      withheld: { certain: 0, probable: 0, possible: 0 },
    },
  };
}

describe("the text reporter", () => {
  it("renders a finding as one line the published expression parses back into its fields", () => {
    const [line] = textOf(report([FINDING], [])).split("\n");

    expect(LINE.exec(line ?? "")?.groups).toEqual({
      path: "src/features/tabs/index.ts",
      line: "1182",
      col: "11",
      kind: "class-member",
      name: "TabStrip.cachedLayout",
      message: "private member is written and never read: see (notes) [below]",
      confidence: "certain",
      code: "DS1301",
    });
  });

  it("renders a stale suppression after the findings, as the suppression kind at certain under DS1703", () => {
    const lines = textOf(report([FINDING], [STALE])).split("\n");

    expect(lines[1]).toBe(
      "src/catalog.ts:213:1: suppression ts://@example/app/src/catalog.ts#Catalog.resolveAlias: inline directive for DS1001 matches no current finding [certain] (DS1703)",
    );
    expect(LINE.test(lines[1] ?? "")).toBe(true);
  });

  it("ends with a summary of the totals that no filter for finding lines selects", () => {
    const rendered = textOf(report([FINDING], [STALE]));
    const summary = rendered.split("\n").at(-2) ?? "";

    expect(summary).toBe(
      "summary: 2 findings (0 allow, 0 warn, 2 deny), 1 deletable line, 1 suppression in effect, 2 reasons recorded, 1 stale suppression, 0 pending, 1 omitted",
    );
    expect(LINE.test(summary)).toBe(false);
  });

  it("writes LF-terminated lines and nothing but the findings, the stale suppressions and the summary", () => {
    const rendered = textOf(report([FINDING, FINDING], [STALE]));

    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.includes("\r")).toBe(false);
    expect(rendered.split("\n").filter((line) => LINE.test(line))).toHaveLength(3);
    expect(rendered.split("\n")).toHaveLength(5);
  });

  it("writes the summary alone when every finding is omitted", () => {
    expect(textOf(report([], []))).toBe(
      "summary: 1 finding (0 allow, 0 warn, 1 deny), 1 deletable line, 1 suppression in effect, 2 reasons recorded, 0 stale suppressions, 0 pending, 1 omitted\n",
    );
  });

  it("names each withheld count and the setting that shows them after the stale suppressions", () => {
    const withheld = { certain: 0, probable: 2, possible: 5 };
    const base = report([FINDING], [STALE]);
    const lines = textOf({ ...base, totals: { ...base.totals, withheld } }).split("\n");

    expect(lines[2]).toBe(
      "withheld by analysis.min_confidence: 2 probable, 5 possible, shown with analysis.min_confidence set to possible",
    );
    expect(LINE.test(lines[2] ?? "")).toBe(false);
  });

  it("names only the confidences whose count is not 0, the setting at the lowest named", () => {
    const withheld = { certain: 0, probable: 3, possible: 0 };
    const base = report([], []);
    const [line] = textOf({ ...base, totals: { ...base.totals, withheld } }).split("\n");

    expect(line).toBe(
      "withheld by analysis.min_confidence: 3 probable, shown with analysis.min_confidence set to probable",
    );
  });

  it("names the probable and possible counts and never the certain one", () => {
    const withheld = { certain: 4, probable: 0, possible: 1 };
    const base = report([], []);
    const [line] = textOf({ ...base, totals: { ...base.totals, withheld } }).split("\n");

    expect(line).toBe(
      "withheld by analysis.min_confidence: 1 possible, shown with analysis.min_confidence set to possible",
    );
  });
});
