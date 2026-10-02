import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitterInputOf } from "../../__test-helpers__/emitter-input.ts";
import { fixture } from "../../__test-helpers__/fixtures.ts";
import type { CompletedFinding } from "../finding.ts";
import { resolve } from "../resolve.ts";
import { findingsOf } from "./emitters.ts";

/** One row of a corpus fixture's expectation file. */
interface ExpectRow {
  readonly symbol: string;
  readonly report: string;
  readonly confidence?: string;
  readonly reachability_class?: string;
  readonly liveness_relation?: string;
  readonly symbol_kind?: string;
  readonly retained_by?: readonly string[];
  readonly details?: Readonly<Record<string, unknown>>;
}

/** One corpus fixture's expectation file. */
interface Expectation {
  readonly target_kind: string;
  readonly consumers?: readonly string[];
  readonly closed_world?: readonly string[];
  readonly expect: readonly ExpectRow[];
}

/** One corpus fixture's TypeScript rendering, answered by every family of the table. */
interface Answered {
  /** Per row, in the file's order: the row's name and code, then what failed, or `pass`. */
  readonly rows: readonly string[];
  /** The findings no row names. */
  readonly unnamed: readonly string[];
}

/** The members a row pins, each against what the finding states. */
function mismatches(row: ExpectRow, found: CompletedFinding): string[] {
  const details = new Map(Object.entries(found.details));
  const wanted: [string, unknown, unknown][] = [
    ["confidence", row.confidence, found.confidence],
    ["reachability_class", row.reachability_class, found.reachabilityClass],
    ["liveness_relation", row.liveness_relation, found.livenessRelation],
    ["symbol_kind", row.symbol_kind, found.symbol.kind],
    ...Object.entries(row.details ?? {}).map(([member, want]): [string, unknown, unknown] => [
      `details.${member}`,
      want,
      details.get(member.replace(/_([a-z])/gu, (_all, letter: string) => letter.toUpperCase())),
    ]),
  ];
  return wanted
    .filter(([, want, got]) => want !== undefined && want !== got)
    .map(([member, , got]) => `${member} ${got === undefined ? "absent" : String(got)}`);
}

/**
 * Answers one corpus fixture's TypeScript rendering over every family: a row naming a
 * code against the findings at the row's line, a row naming `none` against the absence
 * of one and the exemption records it names, and every finding against some row, since
 * a fixture's expectations are exhaustive.
 */
function answer(name: string): Answered {
  const dir = fixture("corpus", name);
  const expected = JSON.parse(readFileSync(join(dir, "expect.json"), "utf8")) as Expectation;
  const manifest = JSON.parse(readFileSync(join(dir, "ts", "fixture.json"), "utf8")) as {
    readonly symbols: Readonly<Record<string, { readonly file: string; readonly line: number }>>;
  };
  const document = {
    target: { kind: expected.target_kind },
    ...((expected.closed_world ?? []).includes("consumers")
      ? { consumers: { complete: true } }
      : {}),
  };
  const { config } = resolve({ repository: JSON.stringify(document), repositoryLabel: name });
  const input = emitterInputOf(join(dir, "ts", "target"), config, {
    consumers: (expected.consumers ?? []).map((consumer) => join(dir, "ts", consumer)),
  });
  const findings = findingsOf(input);
  const union = input.swept.matrix.union;

  const at = (row: ExpectRow): string => {
    const bound = manifest.symbols[row.symbol];
    return `${(bound?.file ?? "").replace(/^target\//u, "")}:${String(bound?.line ?? 0)}`;
  };
  const siteOf = (path: string, line: number): string => `${path}:${String(line)}`;
  const foundAt = (row: ExpectRow): readonly CompletedFinding[] =>
    findings.filter((finding) => siteOf(finding.position.path, finding.position.line) === at(row));

  const rows = expected.expect.map((row) => {
    const label = `${row.symbol} ${row.report}`;
    const found = foundAt(row);
    if (row.report === "none") {
      if (found.length > 0) {
        return `${label}: reported ${found.map((one) => one.code).join(" ")}`;
      }
      const held = input.swept.retained
        .filter((record) => {
          const symbol = union.symbols[union.at(record.id)];
          return (
            symbol !== undefined && siteOf(symbol.position.path, symbol.position.line) === at(row)
          );
        })
        .map((record): string => record.class);
      const missing = (row.retained_by ?? []).filter((one) => !held.includes(one));
      return missing.length === 0
        ? `${label}: pass`
        : `${label}: not retained by ${missing.join(",")}`;
    }
    const same = found.filter((one) => one.code === row.report);
    if (same.length !== 1 || found.length !== 1) {
      return `${label}: reported ${found.map((one) => one.code).join(" ") || "nothing"}`;
    }
    const wrong = mismatches(row, same[0] as CompletedFinding);
    return wrong.length === 0 ? `${label}: pass` : `${label}: ${wrong.join(", ")}`;
  });
  const unnamed = findings
    .filter((finding) => expected.expect.every((row) => !foundAt(row).includes(finding)))
    .map((finding) => `${finding.code} ${finding.symbol.name}`);
  return { rows, unnamed };
}

describe("every corpus fixture with a TypeScript rendering, answered by every family", () => {
  it.each([
    [
      "deprecated-and-unused",
      [
        "Old DS1006: pass",
        "Stale DS1006: pass",
        "StaleToo DS1006: pass",
        "Counter.Old DS1006: pass",
        "Kept none: pass",
        "Fresh none: pass",
        "Counter.Live none: pass",
      ],
    ],
    ["entry-file-declaring-nothing", ["Entry none: pass"]],
    ["unused-exported-consumer", ["DeadExport DS1001: pass", "UsedByConsumer none: pass"]],
    [
      "redundant-export-keyword",
      ["Published none: pass", "LocalOnly DS1104: pass", "Caller none: pass"],
    ],
    [
      "enum-group-conversion",
      ["TierMid none: pass", "TierHigh none: pass", "ModeWrite DS1302: pass"],
    ],
    ["test-only-reference", ["OnlyTested DS1004: pass", "Production none: pass"]],
    [
      "test-of-dead-code",
      [
        "DeadOne DS1004: pass",
        "DeadTwo DS1004: pass",
        "TestDeadOnly DS1005: pass",
        "Live none: pass",
        "TestMixed none: pass",
        "assertSum none: pass",
      ],
    ],
    [
      "unused-declaration-visibility",
      [
        "Resolve DS1001: pass",
        "Recurse DS1001: pass",
        "helper DS1002: pass",
        "Counter.stale DS1003: pass",
        "Used none: pass",
        "usedHelper none: pass",
        "Counter.Live none: pass",
        "Counter.Total none: pass",
      ],
    ],
  ])("answers %s row for row", (name, rows) => {
    expect(answer(name)).toEqual({ rows, unnamed: [] });
  });

  // Each declared gap below is asserted as it stands, so a gap that closes fails here
  // and is removed rather than left declared.
  it("answers private-member-unread with one declared gap", () => {
    expect(answer("private-member-unread")).toEqual({
      rows: [
        "UnreadPrivate DS1301: pass",
        "UnreferencedPrivate DS1003: pass",
        // Declared gap: the reference pass resolves a string-literal element access to
        // the member it names, so the member is live rather than held back by a class.
        "ReachedByStringIndex none: not retained by reflective-lookup",
      ],
      unnamed: [],
    });
  });
});
