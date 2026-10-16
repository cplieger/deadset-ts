import { describe, expect, it } from "vitest";
import { contractDocument } from "../__test-helpers__/fixtures.ts";
import { schemaRefusals } from "./report-schema.ts";
import type { CompletedFinding } from "./finding.ts";
import type { PassResult } from "./findings-pass.ts";
import type { StaleSuppression } from "./findings/self-check.ts";
import { buildReport, capFindings, sortFindings, type ReportInput } from "./report.ts";
import type { Report } from "./contract/report.generated.ts";

const validate = schemaRefusals(
  {
    "report.schema.json": contractDocument("report.schema.json"),
    "finding.schema.json": contractDocument("finding.schema.json"),
  },
  "report.schema.json",
);

/** The number of the next component a finding is the root of. */
let nextComponent = 1;

/** One finding at a position, a dead root of its own component unless a case says otherwise. */
function finding(
  path: string,
  line: number,
  column: number,
  overrides: Partial<CompletedFinding> = {},
): CompletedFinding {
  const name = `f${String(line)}x${String(column)}`;
  return {
    code: "DS1002",
    kind: "unused-unexported",
    language: "ts",
    position: { path, line, column, endLine: line },
    symbol: { ref: `ts://@example/app/${path}#${name}`, kind: "function", name, sizeLines: 1 },
    reachabilityClass: "certain",
    confidence: "certain",
    livenessRelation: "reference-counting",
    testOnly: false,
    generated: false,
    component: {
      id: `deadset-ts/c-${String(nextComponent++)}`,
      root: true,
      symbolCount: 1,
      deletableLines: 1,
    },
    retainedBy: [],
    configurations: ["tsconfig.json"],
    consumersLoaded: [],
    fixability: "deletable",
    severity: "deny",
    message: "unexported function has no reference in the target",
    details: {},
    ...overrides,
  };
}

function stale(path: string, line: number, symbol: string): StaleSuppression {
  return {
    code: "DS9003",
    mechanism: "ignore",
    entry: { code: "DS1001", symbol, path, reason: "kept for a caller outside the target" },
    position: { path: "deadset-ignore.json", line, column: 5 },
    symbol,
    message: "ignore entry for DS1001 matches no current finding",
  };
}

function result(
  findings: readonly CompletedFinding[],
  staleSuppressions: readonly StaleSuppression[] = [],
): PassResult {
  return {
    findings,
    staleSuppressions,
    edgeEvaluations: [],
    totals: {
      suppressionsInEffect: 2,
      reasonsRecorded: 3,
      staleSuppressions: staleSuppressions.length,
      pending: 0,
      withheld: { certain: 0, probable: 2, possible: 5 },
    },
    ledger: { verdicts: [], withheld: () => false },
  };
}

function input(pass: PassResult, overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    contractVersion: "3.2.0",
    version: "0.0.0",
    conformance: { corpusVersion: "1.9.0", result: "pass", digest: `sha256:${"a".repeat(64)}` },
    declaredGaps: [],
    target: { kind: "application", root: ".", identity: "@example/app" },
    configurations: [{ id: "tsconfig.json", project: "tsconfig.json" }],
    notBuilt: [],
    loaded: [],
    unavailable: [],
    result: pass,
    testFileRules: [],
    typeErrorSkips: [],
    unanswered: [],
    conventionsApplied: [],
    ...overrides,
  };
}

function positions(report: Report): string[] {
  return report.findings.map(
    (one) =>
      `${one.position.path}:${String(one.position.line)}:${String(one.position.column)} ${one.code}`,
  );
}

describe("the report", () => {
  it("meets the report schema", () => {
    const report = buildReport(
      input(
        result(
          [finding("src/a.ts", 1, 1)],
          [stale("src/a.ts", 3, "ts://@example/app/src/a.ts#gone")],
        ),
      ),
    );

    expect(validate(JSON.parse(JSON.stringify(report)))).toEqual([]);
  });

  it("writes its members in the order the report schema declares them", () => {
    const schema = contractDocument("report.schema.json");
    const declared = Object.keys(schema["properties"] as Record<string, unknown>).filter(
      (member) => member !== "merged_from",
    );

    expect(Object.keys(buildReport({ ...input(result([])), listsComponents: true }))).toEqual(
      declared,
    );
    expect(Object.keys(buildReport(input(result([]))))).toEqual(
      declared.filter((member) => member !== "components"),
    );
  });

  it("orders findings by path, line, column, code and symbol reference whatever order the run answered", () => {
    const findings = [
      finding("src/b.ts", 1, 1),
      finding("src/a.ts", 10, 1),
      finding("src/a.ts", 2, 7),
      finding("src/a.ts", 2, 3, { code: "DS1503" }),
      finding("src/a.ts", 2, 3),
    ];

    expect(positions(buildReport(input(result(findings))))).toEqual([
      "src/a.ts:2:3 DS1002",
      "src/a.ts:2:3 DS1503",
      "src/a.ts:2:7 DS1002",
      "src/a.ts:10:1 DS1002",
      "src/b.ts:1:1 DS1002",
    ]);
  });

  it("orders paths by their UTF-8 bytes, so a character above U+FFFF sorts after U+FF5E", () => {
    const findings = [finding("src/\u{1F600}.ts", 1, 1), finding("src/\uFF5E.ts", 1, 1)];

    expect(positions(buildReport(input(result(findings))))).toEqual([
      "src/\uFF5E.ts:1:1 DS1002",
      "src/\u{1F600}.ts:1:1 DS1002",
    ]);
  });

  it("orders stale suppressions by their own position, then code, then symbol", () => {
    const report = buildReport(
      input(
        result(
          [],
          [
            stale("src/a.ts", 9, "ts://@example/app/src/a.ts#b"),
            stale("src/a.ts", 4, "ts://@example/app/src/a.ts#z"),
            stale("src/a.ts", 4, "ts://@example/app/src/a.ts#a"),
          ],
        ),
      ),
    );

    expect(
      report.stale_suppressions.map((one) => `${String(one.position.line)} ${one.symbol}`),
    ).toEqual([
      "4 ts://@example/app/src/a.ts#a",
      "4 ts://@example/app/src/a.ts#z",
      "9 ts://@example/app/src/a.ts#b",
    ]);
  });

  it("counts each component's deletable lines once, over the root findings alone", () => {
    const shared = { id: "deadset-ts/c-900", root: true, symbolCount: 2, deletableLines: 7 };
    const findings = [
      finding("src/a.ts", 1, 1, { component: shared }),
      finding("src/a.ts", 5, 1, { component: shared }),
      finding("src/b.ts", 1, 1, {
        component: { id: "deadset-ts/c-901", root: true, symbolCount: 1, deletableLines: 4 },
      }),
      finding("src/c.ts", 1, 1, {
        component: { id: "deadset-ts/c-902", root: false, symbolCount: 3, deletableLines: 30 },
      }),
    ];

    expect(buildReport(input(result(findings))).totals.deletable_lines).toBe(11);
  });

  it("counts the findings by severity and carries the suppression counts the run answered", () => {
    const report = buildReport(
      input(result([finding("src/a.ts", 1, 1), finding("src/a.ts", 2, 1, { severity: "warn" })])),
    );

    expect(report.totals).toEqual({
      findings: 2,
      by_severity: { allow: 0, warn: 1, deny: 1 },
      deletable_lines: 2,
      suppressions_in_effect: 2,
      reasons_recorded: 3,
      stale_suppressions: 0,
      pending: 0,
      omitted: 0,
      withheld: { certain: 0, probable: 2, possible: 5 },
    });
  });

  it("names the configurations in identifier order whatever order the run analyzed them in", () => {
    const report = buildReport(
      input(result([]), {
        configurations: [
          { id: "web", project: "web/tsconfig.json" },
          { id: "node", project: "tsconfig.node.json" },
        ],
      }),
    );

    expect(report.configurations).toEqual([
      { id: "node", project: "tsconfig.node.json" },
      { id: "web", project: "web/tsconfig.json" },
    ]);
  });

  it("names a declared consumer it did not load once, in identity order", () => {
    const report = buildReport(
      input(result([]), {
        unavailable: [
          { id: "@example/web", reason: "not loaded" },
          { id: "@example/cli", reason: "not loaded" },
          { id: "@example/web", reason: "not loaded" },
        ],
      }),
    );

    expect(report.consumers).toEqual({
      declared: 2,
      loaded: [],
      unavailable: [
        { id: "@example/cli", role: "consumer", reason: "not loaded" },
        { id: "@example/web", role: "consumer", reason: "not loaded" },
      ],
    });
  });

  it("states the conformance result it records as the analyzer object spells it", () => {
    expect(buildReport(input(result([]))).analyzer.conformance).toEqual({
      corpus_version: "1.9.0",
      result: "pass",
      digest: `sha256:${"a".repeat(64)}`,
    });
  });

  it("carries every declared gap, ordered by its compact encoding, a symbol only where one is declared", () => {
    const report = buildReport(
      input(result([]), {
        declaredGaps: [
          { fixture: "zeta", capability: "DS1001", reason: "Not loaded." },
          { fixture: "alpha", symbol: "Row", capability: "reflective-lookup", reason: "Resolved." },
          { fixture: "alpha", capability: "DS1503", reason: "Not narrowed." },
        ],
      }),
    );

    expect(report.declared_gaps).toEqual([
      { fixture: "alpha", capability: "DS1503", reason: "Not narrowed." },
      { fixture: "alpha", symbol: "Row", capability: "reflective-lookup", reason: "Resolved." },
      { fixture: "zeta", capability: "DS1001", reason: "Not loaded." },
    ]);
    expect(Object.keys(report.declared_gaps[1] ?? {})).toEqual([
      "fixture",
      "symbol",
      "capability",
      "reason",
    ]);
    expect(validate(report)).toEqual([]);
  });
});

function withoutRelation(one: CompletedFinding): CompletedFinding {
  const { livenessRelation: _relation, ...rest } = one;
  return rest;
}

describe("a finding's details and component", () => {
  it("carries each member a code sets, in the schema's order, and no member it leaves unset", () => {
    const report = buildReport({
      listsComponents: true,
      ...input(
        result([
          finding("src/a.ts", 1, 1, {
            details: {
              narrowerVisibility: "file",
              dependencyClass: "dev-dependency",
              mechanism: "ignore",
              entry: { code: "DS1001" },
              overlap: ["no-unused-vars"],
            },
          }),
          withoutRelation(
            finding("src/a.ts", 2, 1, {
              component: {
                id: "deadset-ts/c-700",
                root: true,
                symbolCount: 1,
                deletableLines: 1,
                members: [
                  {
                    ref: "ts://@example/app/src/a.ts#f2x1",
                    name: "f2x1",
                    position: { path: "src/a.ts", line: 2, column: 1, endLine: 4 },
                  },
                ],
              },
            }),
          ),
        ]),
      ),
    });
    const [detailed, listed] = report.findings;

    expect(detailed?.details).toStrictEqual({
      narrower_visibility: "file",
      dependency_class: "dev-dependency",
      mechanism: "ignore",
      entry: { code: "DS1001" },
      overlap: ["no-unused-vars"],
    });
    expect(Object.keys(detailed?.details ?? {})).toEqual([
      "narrower_visibility",
      "dependency_class",
      "mechanism",
      "entry",
      "overlap",
    ]);
    expect(detailed?.liveness_relation).toBe("reference-counting");
    expect(listed?.details).toStrictEqual({});
    expect(Object.keys(listed ?? {})).not.toContain("liveness_relation");
    expect(Object.keys(listed?.component ?? {})).not.toContain("members");
    expect(report.components).toEqual([
      {
        id: "deadset-ts/c-700",
        members: [
          {
            ref: "ts://@example/app/src/a.ts#f2x1",
            name: "f2x1",
            position: { path: "src/a.ts", line: 2, column: 1, end_line: 4 },
          },
        ],
      },
    ]);
  });

  it("names a refused entry's symbol, path and reason only where the entry writes one", () => {
    const report = buildReport(
      input(
        result([
          finding("src/a.ts", 1, 1, {
            details: {
              mechanism: "baseline",
              entry: { code: "DS1001", symbol: "ts://@example/app/src/a.ts#a" },
            },
          }),
          finding("src/a.ts", 2, 1, {
            details: { mechanism: "ignore", entry: { code: "DS1002", path: "src/a.ts" } },
          }),
          finding("src/a.ts", 3, 1, {
            details: { mechanism: "ignore", entry: { code: "DS1003", reason: "kept" } },
          }),
        ]),
      ),
    );

    expect(report.findings.map((one) => one.details.entry)).toStrictEqual([
      { code: "DS1001", symbol: "ts://@example/app/src/a.ts#a" },
      { code: "DS1002", path: "src/a.ts" },
      { code: "DS1003", reason: "kept" },
    ]);
  });

  it("names a stale entry's symbol only where the entry writes one", () => {
    const entry = { code: "DS1001", path: "src/a.ts", reason: "kept for a caller" };
    const report = buildReport(
      input(result([], [{ ...stale("src/a.ts", 3, "ts://@example/app/src/a.ts#gone"), entry }])),
    );

    expect(report.stale_suppressions[0]?.entry).toStrictEqual(entry);
  });
});

describe("the report's other arrays", () => {
  it("orders the loaded consumers by identity, then by path", () => {
    const report = buildReport(
      input(result([]), {
        loaded: [
          { id: "@example/web", path: "a" },
          { id: "@example/cli", path: "z" },
          { id: "@example/cli", path: "b" },
        ],
      }),
    );

    expect(report.consumers.loaded.map((one) => `${one.id} ${one.path}`)).toEqual([
      "@example/cli b",
      "@example/cli z",
      "@example/web a",
    ]);
  });

  it("orders the configurations it could not build by identifier", () => {
    const report = buildReport(
      input(result([]), {
        notBuilt: [
          { id: "web", project: "web/tsconfig.json", error: "no inputs" },
          { id: "node", project: "tsconfig.node.json", error: "no inputs" },
        ],
      }),
    );

    expect(report.configurations_not_built.map((one) => one.id)).toEqual(["node", "web"]);
  });

  it("orders edge evaluations by edge, then side, bytewise and not by their encodings", () => {
    const evaluation = (edge: string, side: "provides" | "used_by") => ({
      edge,
      side,
      symbol: "ts://@example/app/src/a.ts#a",
      state: "live" as const,
    });
    const report = buildReport(
      input({
        ...result([]),
        edgeEvaluations: [
          evaluation("cli tool", "provides"),
          evaluation("cli", "used_by"),
          evaluation("cli", "provides"),
        ],
      }),
    );

    expect(report.edge_evaluations.map((one) => `${one.edge}/${one.side}`)).toEqual([
      "cli/provides",
      "cli/used_by",
      "cli tool/provides",
    ]);
  });

  it("orders the test-file rules by rule, then by the count each matched", () => {
    const report = buildReport(
      input(result([]), {
        testFileRules: [
          { rule: "vitest", matched: 1 },
          { rule: "jest", matched: 9 },
          { rule: "jest", matched: 2 },
          { rule: "jest", matched: 5 },
        ],
      }),
    );

    expect(report.test_file_rules.map((one) => `${one.rule} ${String(one.matched)}`)).toEqual([
      "jest 2",
      "jest 5",
      "jest 9",
      "vitest 1",
    ]);
  });

  it("orders the type-error skips by path, then by line as a number, each skip once", () => {
    const skip = (path: string, line: number) => ({ path, line, message: "Type error." });
    const report = buildReport(
      input(result([]), {
        typeErrorSkips: [
          skip("src/b.ts", 1),
          skip("src/a.ts", 10),
          skip("src/a.ts", 9),
          skip("src/a.ts", 9),
          skip("src/a.ts", 30),
        ],
      }),
    );

    expect(report.type_error_skips.map((one) => `${one.path}:${String(one.line)}`)).toEqual([
      "src/a.ts:9",
      "src/a.ts:10",
      "src/a.ts:30",
      "src/b.ts:1",
    ]);
  });

  it("orders the unanswered counts by configuration, then by their encodings", () => {
    const report = buildReport(
      input(result([]), {
        unanswered: [
          { configuration: "web", questions: 1, declarations: 1 },
          { configuration: "node", questions: 3, declarations: 1 },
          { configuration: "node", questions: 2, declarations: 1 },
        ],
      }),
    );

    expect(
      report.unanswered_questions.map((one) => `${one.configuration} ${String(one.questions)}`),
    ).toEqual(["node 2", "node 3", "web 1"]);
  });
});

describe("the size order", () => {
  it("puts the larger deletion first, then the larger subject, then the canonical key", () => {
    const component = (deletableLines: number) => ({
      id: `deadset-ts/c-${String(800 + deletableLines)}`,
      root: true,
      symbolCount: 1,
      deletableLines,
    });
    const report = buildReport(
      input(
        result([
          finding("src/a.ts", 1, 1, { component: component(2) }),
          finding("src/a.ts", 2, 1, { component: component(9) }),
          finding("src/b.ts", 1, 1, {
            component: component(2),
            symbol: {
              ref: "ts://@example/app/src/b.ts#big",
              kind: "function",
              name: "big",
              sizeLines: 5,
            },
          }),
          finding("src/c.ts", 1, 1, { component: component(2) }),
        ]),
      ),
    );

    expect(positions(sortFindings(report, "size"))).toEqual([
      "src/a.ts:2:1 DS1002",
      "src/b.ts:1:1 DS1002",
      "src/a.ts:1:1 DS1002",
      "src/c.ts:1:1 DS1002",
    ]);
  });

  it("is the canonical key under the position order", () => {
    const report = buildReport(
      input(result([finding("src/b.ts", 1, 1), finding("src/a.ts", 3, 1)])),
    );

    expect(positions(sortFindings(sortFindings(report, "size"), "position"))).toEqual([
      "src/a.ts:3:1 DS1002",
      "src/b.ts:1:1 DS1002",
    ]);
  });
});

describe("the finding cap", () => {
  const report = buildReport(
    input(
      result([
        finding("src/a.ts", 1, 1),
        finding("src/a.ts", 2, 1),
        finding("src/a.ts", 3, 1, { severity: "warn" }),
      ]),
    ),
  );

  it("keeps the first findings of the order and counts the rest omitted, so printed plus omitted is the total", () => {
    const capped = capFindings(report, 2);

    expect(positions(capped)).toEqual(["src/a.ts:1:1 DS1002", "src/a.ts:2:1 DS1002"]);
    expect(capped.findings.length + capped.totals.omitted).toBe(capped.totals.findings);
    expect(capped.totals.omitted).toBe(1);
  });

  it("leaves every other total describing the whole finding set", () => {
    const capped = capFindings(report, 1);

    expect(capped.totals.by_severity).toEqual({ allow: 0, warn: 1, deny: 2 });
    expect(capped.totals.deletable_lines).toBe(3);
  });

  it("keeps every finding at zero and at a cap the set does not reach", () => {
    expect(capFindings(report, 0)).toBe(report);
    expect(capFindings(report, 3)).toBe(report);
  });
});

describe("a run that lists each component in full", () => {
  const members = [
    {
      ref: "ts://@example/app/src/a.ts#f1x1",
      name: "f1x1",
      position: { path: "src/a.ts", line: 1, column: 1, endLine: 1 },
    },
    {
      ref: "ts://@example/app/src/a.ts#f5x1",
      name: "f5x1",
      position: { path: "src/a.ts", line: 5, column: 1, endLine: 1 },
    },
  ];
  const component = (root: boolean): CompletedFinding["component"] => ({
    id: "deadset-ts/c-900",
    root,
    symbolCount: 2,
    deletableLines: 2,
    members,
  });

  it("lists a component's members once, in the order of the first finding naming it, and on no finding", () => {
    const report = buildReport({
      ...input(
        result([
          finding("src/a.ts", 5, 1, { component: component(false) }),
          finding("src/a.ts", 1, 1, { component: component(true) }),
          finding("src/b.ts", 1, 1),
        ]),
      ),
      listsComponents: true,
    });

    expect(report.components).toEqual([
      {
        id: "deadset-ts/c-900",
        members: [
          {
            ref: "ts://@example/app/src/a.ts#f1x1",
            name: "f1x1",
            position: { path: "src/a.ts", line: 1, column: 1, end_line: 1 },
          },
          {
            ref: "ts://@example/app/src/a.ts#f5x1",
            name: "f5x1",
            position: { path: "src/a.ts", line: 5, column: 1, end_line: 1 },
          },
        ],
      },
    ]);
    expect(report.findings.map((one) => Object.keys(one.component))).toEqual([
      ["id", "root", "symbol_count", "deletable_lines"],
      ["id", "root", "symbol_count", "deletable_lines"],
      ["id", "root", "symbol_count", "deletable_lines"],
    ]);
  });
});
