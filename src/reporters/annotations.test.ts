import { describe, expect, it } from "vitest";
import type { Severity } from "../config.ts";
import type { Report, TypeErrorSkip, WireFinding, WireStaleSuppression } from "../report.ts";
import { annotations } from "./annotations.ts";
import type { RenderOptions } from "./reporter.ts";

/** The annotations one report renders to, as the file holds them. */
function annotationsOf(of: Report, with_: RenderOptions): string {
  return [...annotations(of, with_)].join("");
}

function finding(severity: Severity, message = "exported function has no reference"): WireFinding {
  return {
    code: "DS1001",
    kind: "unused-exported",
    language: "ts",
    position: { path: "src/catalog.ts", line: 12, column: 17, end_line: 20 },
    symbol: {
      ref: "ts://@example/app/src/catalog.ts#resolveAlias",
      kind: "function",
      name: "resolveAlias",
      size_lines: 9,
    },
    reachability_class: "certain",
    confidence: "certain",
    liveness_relation: "reference-counting",
    test_only: false,
    generated: false,
    component: { id: "deadset-ts/c-0001", root: true, symbol_count: 1, deletable_lines: 9 },
    retained_by: [],
    configurations: ["tsconfig.json"],
    consumers_loaded: [],
    fixability: "deletable",
    severity,
    message,
    details: {},
  };
}

const STALE: WireStaleSuppression = {
  code: "DS1703",
  mechanism: "ignore",
  entry: {
    code: "DS1001",
    symbol: "ts://@example/app/src/gone.ts#gone",
    path: "src/gone.ts",
    reason: "kept",
  },
  position: { path: "deadset-ignore.json", line: 4, column: 5 },
  symbol: "ts://@example/app/src/gone.ts#gone",
  message: "ignore entry for DS1001 matches no current finding",
};

/** A report holding only what an annotation reads: the findings, stale suppressions and skips. */
function report(
  findings: readonly WireFinding[],
  stale: readonly WireStaleSuppression[] = [],
  skips: readonly TypeErrorSkip[] = [],
): Report {
  return { findings, stale_suppressions: stale, type_error_skips: skips } as unknown as Report;
}

function options(failOn: Severity): RenderOptions {
  return {
    failOn,
    readSource: () => {
      throw new Error("an annotation reads no source");
    },
    template: undefined,
  };
}

describe("annotations", () => {
  it("annotates a type-error skip after the findings as a warning at its file and line", () => {
    const skip = { path: "src/broken.ts", line: 7, message: "Property 'cuont' does not exist" };

    expect(annotationsOf(report([finding("deny")], [], [skip]), options("deny"))).toBe(
      "::error file=src/catalog.ts,line=12,col=17,endLine=20,title=DS1001 unused-exported::exported function has no reference\n" +
        "::warning file=src/broken.ts,line=7,title=type error skipped::the analysis did not evaluate the function or statement holding this type error: Property 'cuont' does not exist\n",
    );
  });

  it("annotates a finding at the failing severity as an error naming its span, code and kind", () => {
    expect(annotationsOf(report([finding("deny")]), options("deny"))).toBe(
      "::error file=src/catalog.ts,line=12,col=17,endLine=20,title=DS1001 unused-exported::exported function has no reference\n",
    );
  });

  it.each([
    ["below the failing severity is a warning", "warn", "deny", "warning"],
    ["at a lowered failing severity is an error", "warn", "warn", "error"],
  ] as const)("annotates a finding %s", (_what, severity, failOn, level) => {
    expect(annotationsOf(report([finding(severity)]), options(failOn))).toMatch(
      new RegExp(`^::${level} `, "u"),
    );
  });

  it("annotates a stale suppression after the findings as an error at its own line, whatever the failing severity", () => {
    const lines = annotationsOf(report([finding("warn")], [STALE]), options("deny")).split("\n");

    expect(lines[1]).toBe(
      "::error file=deadset-ignore.json,line=4,col=5,endLine=4,title=DS1703 stale-suppression::ignore entry for DS1001 matches no current finding",
    );
  });

  it("escapes what would end the command or split the property list", () => {
    const odd: WireFinding = {
      ...finding("deny", "100% dead\nsee: a, b"),
      position: { path: "src/a:b,c%.ts", line: 1, column: 1, end_line: 1 },
    };

    expect(annotationsOf(report([odd]), options("deny"))).toBe(
      "::error file=src/a%3Ab%2Cc%25.ts,line=1,col=1,endLine=1,title=DS1001 unused-exported::100%25 dead%0Asee: a, b\n",
    );
  });

  it("writes nothing for a report holding no finding and no stale suppression", () => {
    expect(annotationsOf(report([]), options("deny"))).toBe("");
  });
});
