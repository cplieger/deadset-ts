import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readFixture } from "../../__test-helpers__/fixtures.ts";
import { FIXED_SEVERITY_CODES } from "../kinds.ts";
import type { Report, WireFinding, WireStaleSuppression } from "../report.ts";
import { resolve } from "../resolve.ts";
import { writeBaseline } from "../suppress-file.ts";
import type { RenderOptions } from "./reporter.ts";
import { RENDERINGS } from "./reporters.ts";
import { KINDS } from "../kinds.ts";
import { parseTemplate } from "./template.ts";

/** The text line's defining expression, read from the Contract's page. */
const LINE = new RegExp(
  /## The expression[\s\S]*?```text\n(?<expression>[^\n]+)\n```/u.exec(
    readFixture("contract", "grammar", "text-line.md"),
  )?.groups?.["expression"] ?? "^$",
);

/** One rendered record as every format can name it: its code and where it is. */
interface Located {
  readonly code: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

const PATHS = ["src/a.ts", "src/deep/b.ts", "src/with space.ts", "lib/c.mts"];
const MAX_LINE = 30;

const findingArb: fc.Arbitrary<WireFinding> = fc
  .record({
    code: fc.constantFrom(
      ...[...KINDS.values()]
        .filter((kind) => kind.languages.includes("ts"))
        .map((kind) => kind.code),
    ),
    path: fc.constantFrom(...PATHS),
    line: fc.integer({ min: 1, max: MAX_LINE }),
    column: fc.integer({ min: 1, max: 40 }),
    span: fc.nat({ max: 5 }),
    name: fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,7}$/u),
    severity: fc.constantFrom("warn" as const, "deny" as const),
    message: fc.stringMatching(/^[a-z][a-z (),:]{0,30}[a-z]$/u),
  })
  .map((drawn) => ({
    code: drawn.code,
    kind: "unused-exported",
    language: "ts",
    position: {
      path: drawn.path,
      line: drawn.line,
      column: drawn.column,
      end_line: drawn.line + drawn.span,
    },
    symbol: {
      ref: `ts://@example/app/${drawn.path}#${drawn.name}`,
      kind: "function",
      name: drawn.name,
      size_lines: drawn.span + 1,
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
    severity: drawn.severity,
    message: drawn.message,
    details: {},
  }));

const staleArb: fc.Arbitrary<WireStaleSuppression> = fc
  .record({
    path: fc.constantFrom(...PATHS),
    line: fc.integer({ min: 1, max: MAX_LINE }),
    column: fc.integer({ min: 1, max: 9 }),
  })
  .map((drawn) => ({
    code: "DS1703",
    mechanism: "inline",
    entry: { code: "DS1001", path: drawn.path, reason: "kept" },
    position: { path: drawn.path, line: drawn.line, column: drawn.column },
    symbol: `ts://@example/app/${drawn.path}#gone`,
    message: "inline directive for DS1001 matches no current finding",
  }));

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
    totals: {
      findings: findings.length,
      by_severity: {
        allow: 0,
        warn: findings.filter((one) => one.severity === "warn").length,
        deny: findings.filter((one) => one.severity === "deny").length,
      },
      deletable_lines: 0,
      suppressions_in_effect: 0,
      reasons_recorded: 0,
      stale_suppressions: stale.length,
      pending: 0,
      omitted: 0,
    },
  };
}

/** A template naming every record's code and position, one per line. */
const TEMPLATE = parseTemplate(
  "{{range .findings}}{{.code}}\t{{.position.path}}\t{{.position.line}}\t{{.position.column}}\n{{end}}" +
    "{{range .stale_suppressions}}{{.code}}\t{{.position.path}}\t{{.position.line}}\t{{.position.column}}\n{{end}}",
);

const OPTIONS: RenderOptions = {
  failOn: "deny",
  readSource: () => "x\n".repeat(MAX_LINE + 6),
  template: TEMPLATE,
};

function render(format: "text" | "json" | "github" | "sarif" | "template", of: Report): string {
  const rendering = RENDERINGS.get(format);
  if (rendering === undefined) {
    throw new Error(`no rendering for ${format}`);
  }
  return rendering.render(of, OPTIONS);
}

/** Every record each format names, read back from its own rendering. */
const READ_BACK: Readonly<Record<string, (text: string) => readonly Located[]>> = {
  text: (text) =>
    text.split("\n").flatMap((line) => {
      const groups = LINE.exec(line)?.groups;
      return groups === undefined
        ? []
        : [
            {
              code: groups["code"] ?? "",
              path: groups["path"] ?? "",
              line: Number(groups["line"]),
              column: Number(groups["col"]),
            },
          ];
    }),
  json: (text) => {
    const document = JSON.parse(text) as Report;
    return [...document.findings, ...document.stale_suppressions].map((one) => ({
      code: one.code,
      path: one.position.path,
      line: one.position.line,
      column: one.position.column,
    }));
  },
  github: (text) =>
    text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const groups =
          /^::(?:error|warning) file=(?<path>[^,]*),line=(?<line>\d+),col=(?<col>\d+),endLine=\d+,title=(?<code>DS\d{4}) /u.exec(
            line,
          )?.groups;
        return {
          code: groups?.["code"] ?? "",
          path: groups?.["path"] ?? "",
          line: Number(groups?.["line"]),
          column: Number(groups?.["col"]),
        };
      }),
  sarif: (text) => {
    const [run] = (
      JSON.parse(text) as {
        runs: {
          tool: { driver: { rules: { id: string }[] } };
          results: {
            ruleId: string;
            ruleIndex: number;
            locations: {
              physicalLocation: {
                artifactLocation: { uri: string };
                region: { startLine: number; startColumn: number };
              };
            }[];
          }[];
        }[];
      }
    ).runs;
    return (run?.results ?? []).map((result) => {
      const at = result.locations[0]?.physicalLocation;
      return {
        code: run?.tool.driver.rules[result.ruleIndex]?.id === result.ruleId ? result.ruleId : "",
        path: decodeURIComponent(at?.artifactLocation.uri ?? ""),
        line: at?.region.startLine ?? 0,
        column: at?.region.startColumn ?? 0,
      };
    });
  },
  template: (text) =>
    text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [code = "", path = "", at = "", column = ""] = line.split("\t");
        return { code, path, line: Number(at), column: Number(column) };
      }),
};

describe("every reporter", () => {
  /**
   * dead-code-suite/P18: every reporter renders the same set of findings with the same
   * codes, and the code string is byte-identical across the text line, the ignore entry, the
   * configuration key and the SARIF rule identifier.
   */
  it("renders the same records with the same codes in every format", () => {
    fc.assert(
      fc.property(
        fc.array(findingArb, { maxLength: 8 }),
        fc.array(staleArb, { maxLength: 3 }),
        (findings, stale) => {
          const of = report(findings, stale);
          const expected = [...findings, ...stale].map((one) => ({
            code: one.code,
            path: one.position.path,
            line: one.position.line,
            column: one.position.column,
          }));

          for (const [format, readBack] of Object.entries(READ_BACK)) {
            expect({ format, records: readBack(render(format as "text", of)) }).toEqual({
              format,
              records: expected,
            });
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("spells each code in an ignore entry and a configuration key exactly as the reports do", () => {
    fc.assert(
      fc.property(fc.array(findingArb, { minLength: 1, maxLength: 8 }), (findings) => {
        const rows = (
          JSON.parse(
            writeBaseline(
              findings.map((one) => ({
                code: one.code,
                symbol: one.symbol.ref,
                path: one.position.path,
              })),
              { analyzer: "deadset-ts", version: "0.0.0" },
            ),
          ) as { baseline: { code: string }[] }
        ).baseline;
        expect(rows.map((row) => row.code)).toEqual(findings.map((one) => one.code));

        const settable = findings
          .map((one) => one.code)
          .filter((code) => !FIXED_SEVERITY_CODES.includes(code));
        const { config } = resolve({
          repository: JSON.stringify({
            target: { kind: "application" },
            severity: Object.fromEntries(settable.map((code) => [code, "warn"])),
          }),
          repositoryLabel: "deadset.json",
        });
        expect([...config.severity.keys()].sort()).toEqual([...new Set(settable)].sort());
      }),
      { numRuns: 200 },
    );
  });
});
