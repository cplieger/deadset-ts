import { describe, expect, it } from "vitest";
import type { Severity } from "../config.ts";
import type {
  Report,
  ReportNote,
  TypeErrorSkip,
  WireFinding,
  WireStaleSuppression,
} from "../report.ts";
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

/** A report holding only what an annotation reads: the findings, stale suppressions, skips and notes. */
function report(
  findings: readonly WireFinding[],
  stale: readonly WireStaleSuppression[] = [],
  skips: readonly TypeErrorSkip[] = [],
  notes: readonly ReportNote[] = [],
): Report {
  return {
    findings,
    stale_suppressions: stale,
    type_error_skips: skips,
    notes,
  } as unknown as Report;
}

const OPTIONS: RenderOptions = {
  readSource: () => {
    throw new Error("an annotation reads no source");
  },
  template: undefined,
};

describe("annotations", () => {
  it("annotates a type-error skip after the findings as a warning at its file and line", () => {
    const skip = { path: "src/broken.ts", line: 7, message: "Property 'cuont' does not exist" };

    expect(annotationsOf(report([finding("deny")], [], [skip]), OPTIONS)).toBe(
      "::error file=src/catalog.ts,line=12,col=17,endLine=20,title=DS1001 unused-exported::exported function has no reference\n" +
        "::warning file=src/broken.ts,line=7,title=type error skipped::the analysis did not evaluate the function or statement holding this type error: Property 'cuont' does not exist\n",
    );
  });

  it("annotates a deny finding as an error naming its span, code and kind", () => {
    expect(annotationsOf(report([finding("deny")]), OPTIONS)).toBe(
      "::error file=src/catalog.ts,line=12,col=17,endLine=20,title=DS1001 unused-exported::exported function has no reference\n",
    );
  });

  it.each([
    ["deny", "error"],
    ["warn", "warning"],
    ["allow", "notice"],
  ] as const)("annotates a finding of severity %s as %s", (severity, level) => {
    expect(annotationsOf(report([finding(severity)]), OPTIONS)).toMatch(
      new RegExp(`^::${level} `, "u"),
    );
  });

  it("annotates a note after the skips as a warning naming its directory and kind", () => {
    const skip = { path: "src/broken.ts", line: 7, message: "Property 'cuont' does not exist" };
    const note: ReportNote = {
      kind: "computed-load",
      path: "src/plugins",
      message: "a load by a computed path, 50% read",
    };

    expect(annotationsOf(report([], [], [skip], [note]), OPTIONS).split("\n")[1]).toBe(
      "::warning file=src/plugins,title=computed-load::a load by a computed path, 50%25 read",
    );
  });

  it("annotates a stale suppression after the findings as an error at its own line, whatever the failing severity", () => {
    const lines = annotationsOf(report([finding("warn")], [STALE]), OPTIONS).split("\n");

    expect(lines[1]).toBe(
      "::error file=deadset-ignore.json,line=4,col=5,endLine=4,title=DS1703 stale-suppression::ignore entry for DS1001 matches no current finding",
    );
  });

  it("escapes what would end the command or split the property list", () => {
    const odd: WireFinding = {
      ...finding("deny", "100% dead\nsee: a, b"),
      position: { path: "src/a:b,c%.ts", line: 1, column: 1, end_line: 1 },
    };

    expect(annotationsOf(report([odd]), OPTIONS)).toBe(
      "::error file=src/a%3Ab%2Cc%25.ts,line=1,col=1,endLine=1,title=DS1001 unused-exported::100%25 dead%0Asee: a, b\n",
    );
  });

  it("writes nothing for a report holding no finding and no stale suppression", () => {
    expect(annotationsOf(report([]), OPTIONS)).toBe("");
  });
});
