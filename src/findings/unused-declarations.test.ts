import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitterInputOf } from "../../__test-helpers__/emitter-input.ts";
import { contractDocument, fixture } from "../../__test-helpers__/fixtures.ts";
import type { Config } from "../config.ts";
import { resolve } from "../resolve.ts";
import type { CompletedFinding } from "./completion.ts";
import type { EmitterInput } from "./emitter.ts";
import { EMITTERS } from "./emitters.ts";
import { UNUSED_DECLARATION_KINDS, unusedDeclarationFindings } from "./unused-declarations.ts";

/** One configuration document, resolved. */
function configOf(document: string): Config {
  return resolve({ repository: document, repositoryLabel: "deadset.json" }).config;
}

/** What the emitters read of one fixture project under its own configuration document. */
function sweepProject(name: string): EmitterInput {
  const target = fixture("projects", name);
  return emitterInputOf(target, configOf(readFileSync(join(target, "deadset.json"), "utf8")));
}

/** One finding as one line: every member the family decides or completes. */
function line(finding: CompletedFinding): string {
  const { position, symbol, component } = finding;
  return [
    finding.code,
    `${position.path}:${String(position.line)}:${String(position.column)}-${String(position.endLine)}`,
    `${symbol.kind} ${symbol.name} ${String(symbol.sizeLines)}`,
    `${finding.reachabilityClass}/${finding.confidence}`,
    finding.livenessRelation ?? "-",
    finding.testOnly ? "test-only" : "-",
    `${component.id}${component.root ? " root" : ""} ${String(component.symbolCount)} ${String(component.deletableLines)}`,
    finding.severity,
    finding.configurations.join(","),
    JSON.stringify(finding.details),
    finding.message,
  ].join("\t");
}

/** Each finding as its code and its subject's display name. */
function named(findings: readonly CompletedFinding[]): string[] {
  return findings.map((finding) => `${finding.code} ${finding.symbol.name}`);
}

describe("the unused-declarations vocabulary", () => {
  it("states each code of the family as the Contract's issue-kind vocabulary does", () => {
    const rows = (contractDocument("kinds.json")["kinds"] as Record<string, unknown>[])
      .filter((row) => String(row["code"]).startsWith("DS10"))
      .map((row) => [
        String(row["code"]),
        { defaultSeverity: row["default_severity"], maxClass: row["max_class"] },
      ]);

    expect([...UNUSED_DECLARATION_KINDS]).toEqual(rows);
  });
});

describe("the unused-declarations emitter over an application", () => {
  const input = sweepProject("unused-declarations");
  const findings = unusedDeclarationFindings(input);

  it("is the committed golden table, finding for finding", async () => {
    await expect(
      `${findings.map(line).join("\n")}\n`,
      "regenerate with `npx vitest --run src/findings/unused-declarations.test.ts -u` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "unused-declarations.findings.txt"));
  });

  it("is what the emitter table runs for the family", () => {
    expect(EMITTERS.get("unused-declarations")?.(input)).toEqual(findings);
  });

  it("reports an exported and an unexported declaration nothing references, and neither when referenced", () => {
    const reported = named(findings);

    expect(reported).toContain("DS1001 unusedExported");
    expect(reported).toContain("DS1002 unusedUnexported");
    expect(reported).toContain("DS1001 Shapes.unusedArea");
    expect(reported).toContain("DS1002 Shapes.hidden");
    expect(reported).toContain("DS1001 alias");
    expect(reported.filter((one) => /\b(used|usedHelper|Shapes\.area)$/u.test(one))).toEqual([]);
  });

  it("reports a declaration only dead code references by reachability, in its root's component", () => {
    const caller = findings.find((finding) => finding.symbol.name === "deadCaller");
    const callee = findings.find((finding) => finding.symbol.name === "calledOnlyByDead");

    expect(caller?.livenessRelation).toBe("reference-counting");
    expect(callee?.code).toBe("DS1002");
    expect(callee?.livenessRelation).toBe("reachability");
    expect(callee?.component).toEqual({ ...caller?.component, root: false });
    expect(caller?.component.root).toBe(true);
  });

  it("reports a member of a live container, a private name at certain, and no member of a dead one", () => {
    const reported = named(findings);

    expect(reported).toEqual(
      expect.arrayContaining([
        "DS1003 Counter.stale",
        "DS1003 Counter.#origin",
        "DS1003 Counter.guarded",
        "DS1003 Counter.created",
        "DS1003 Counter.unusedMethod",
        "DS1003 Labelled.note",
        "DS1003 Color.Green",
        "DS1001 Obsolete",
      ]),
    );
    expect(reported.filter((one) => one.includes("Obsolete."))).toEqual([]);
    expect(reported.filter((one) => /Counter\.(live|total)$|Labelled\.label$/u.test(one))).toEqual(
      [],
    );
    const origin = findings.find((finding) => finding.symbol.name === "Counter.#origin");
    expect([origin?.reachabilityClass, origin?.confidence]).toEqual(["certain", "certain"]);
  });

  it("leaves an enumerated member nothing names to its own kind", () => {
    expect(named(findings).filter((one) => one.includes("Color.Blue"))).toEqual([]);
  });

  it("reports a declaration only test files reference under the test-only code", () => {
    const tested = findings.find((finding) => finding.symbol.name === "onlyTested");

    expect(tested?.code).toBe("DS1004");
    expect(tested?.testOnly).toBe(true);
    expect(named(findings).filter((one) => one.endsWith(" used"))).toEqual([]);
  });

  it("reports a test whose every target is dead, and not a test that references a live one", () => {
    const reported = named(findings);

    expect(reported).toContain("DS1005 testOfDeadCode");
    expect(reported.filter((one) => one.includes("testOfLiveCode"))).toEqual([]);
    expect(reported.filter((one) => one.endsWith(" check"))).toEqual([]);
  });

  it("reports a deprecated declaration with no production reference under the deprecated code alone", () => {
    const reported = named(findings);

    expect(reported).toEqual(
      expect.arrayContaining([
        "DS1006 deprecatedUnused",
        "DS1006 deprecatedTestedOnly",
        "DS1006 Counter.legacy",
        "DS1006 staleFirst",
        "DS1006 staleSecond",
      ]),
    );
    expect(reported.filter((one) => one.includes("deprecatedButUsed"))).toEqual([]);
    expect(reported.filter((one) => one.endsWith(" deprecatedUnused"))).toEqual([
      "DS1006 deprecatedUnused",
    ]);
  });

  it("reports each declaration once", () => {
    const subjects = findings.map((finding) => finding.symbol.ref);

    expect(new Set(subjects).size).toBe(subjects.length);
  });
});

describe("the dials over the unused-declarations family", () => {
  const input = sweepProject("unused-declarations");
  const under = (document: string): string[] =>
    named(unusedDeclarationFindings({ ...input, config: configOf(document) }));
  const application = (extra: string): string => `{ "target": { "kind": "application" }${extra} }`;
  const everything = under(application(""));

  it("withholds a root at allow and every finding that falls with it", () => {
    const allowed = under(application(`, "severity": { "DS1001": "allow" }`));

    expect(allowed.filter((one) => one.startsWith("DS1001"))).toEqual([]);
    expect(allowed).not.toContain("DS1002 calledOnlyByDead");
    expect(allowed).not.toContain("DS1003 Color.Green");
    expect(allowed).toContain("DS1002 unusedUnexported");
  });

  it("withholds a finding that falls with a root alone", () => {
    const allowed = under(application(`, "severity": { "DS1002": "allow" }`));

    expect(allowed).not.toContain("DS1002 calledOnlyByDead");
    expect(allowed).toContain("DS1001 deadCaller");
    expect(allowed).toEqual(everything.filter((one) => !one.startsWith("DS1002")));
  });

  it("reads a code's key before its family's", () => {
    const findings = unusedDeclarationFindings({
      ...input,
      config: configOf(application(`, "severity": { "DS10": "warn", "DS1003": "allow" }`)),
    });

    expect(new Set(findings.map((finding) => finding.severity))).toEqual(new Set(["warn"]));
    expect(findings.filter((finding) => finding.code === "DS1003")).toEqual([]);
  });

  it("gives every code its default severity where nothing names it", () => {
    const findings = unusedDeclarationFindings({ ...input, config: configOf(application("")) });

    expect(new Set(findings.map((finding) => finding.severity))).toEqual(new Set(["deny"]));
  });
});

describe("the unused-declarations emitter over a library", () => {
  const input = sweepProject("unused-declarations-library");
  const findings = unusedDeclarationFindings(input);

  it("is the committed golden table, finding for finding", async () => {
    await expect(
      `${findings.map(line).join("\n")}\n`,
      "regenerate with `npx vitest --run src/findings/unused-declarations.test.ts -u` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "unused-declarations-library.findings.txt"));
  });

  it("classes the published API possible and a private member certain, with no consumer information", () => {
    const classes = findings.map((finding) => `${finding.symbol.name} ${finding.confidence}`);

    expect(classes).toEqual([
      "Published.visible possible",
      "Published.#secret certain",
      "Published.hidden certain",
      "makePublished possible",
      "internalRetired certain",
    ]);
  });

  it("leaves an unused export no code outside the target can import to the unreachable-export kind", () => {
    const unreachable = EMITTERS.get("visibility-narrowing")?.(input) ?? [];

    expect(named(findings).filter((one) => one.endsWith(" internalUnused"))).toEqual([]);
    expect(unreachable.map((one) => `${one.code} ${one.symbol.name}`)).toContain(
      "DS1103 internalUnused",
    );
  });

  it("keeps a deprecated one, which the deprecated code names alone", () => {
    const unreachable = EMITTERS.get("visibility-narrowing")?.(input) ?? [];

    expect(named(findings)).toContain("DS1006 internalRetired");
    expect(unreachable.map((one) => one.symbol.name)).not.toContain("internalRetired");
  });

  it("withholds below the minimum confidence", () => {
    const certain = unusedDeclarationFindings({
      ...input,
      config: configOf(
        `{ "target": { "kind": "library" }, "analysis": { "min_confidence": "certain" } }`,
      ),
    });

    expect(named(certain)).toEqual([
      "DS1003 Published.#secret",
      "DS1003 Published.hidden",
      "DS1006 internalRetired",
    ]);
  });
});

/** One row of a corpus fixture's expectation file, as far as this family reads it. */
interface ExpectRow {
  readonly symbol: string;
  readonly report: string;
  readonly confidence?: string;
  readonly reachability_class?: string;
  readonly liveness_relation?: string;
  readonly symbol_kind?: string;
  readonly retained_by?: readonly string[];
}

/** One corpus fixture's TypeScript rendering, answered for this family. */
interface Answered {
  /** Per row, in the file's order: the row's name and code, then what failed, or `pass`. */
  readonly rows: readonly string[];
  /** The findings no row names. */
  readonly unnamed: readonly string[];
}

/** The codes of this family. */
const FAMILY = /^DS10[0-9]{2}$/u;

/**
 * Answers one corpus fixture's TypeScript rendering for this family: each row naming a
 * code of the family is matched against the finding at the row's line, each row naming
 * `none` against the absence of one and the exemption records the row names, and each
 * finding the family reports is named by some row.
 */
function answer(name: string): Answered {
  const dir = fixture("corpus", name);
  const expected = JSON.parse(readFileSync(join(dir, "expect.json"), "utf8")) as {
    readonly target_kind: string;
    readonly expect: readonly ExpectRow[];
  };
  const manifest = JSON.parse(readFileSync(join(dir, "ts", "fixture.json"), "utf8")) as {
    readonly symbols: Readonly<Record<string, { readonly file: string; readonly line: number }>>;
  };
  const config = configOf(`{ "target": { "kind": "${expected.target_kind}" } }`);
  const input = emitterInputOf(join(dir, "ts", "target"), config);
  const { swept } = input;
  const findings = unusedDeclarationFindings(input);
  const at = (row: ExpectRow): { readonly path: string; readonly line: number } => {
    const bound = manifest.symbols[row.symbol];
    return { path: (bound?.file ?? "").replace(/^target\//u, ""), line: bound?.line ?? 0 };
  };
  const findingAt = (row: ExpectRow): CompletedFinding | undefined => {
    const { path, line: atLine } = at(row);
    return findings.find(
      (finding) => finding.position.path === path && finding.position.line === atLine,
    );
  };

  const rows = expected.expect.map((row) => {
    const label = `${row.symbol} ${row.report}`;
    const found = findingAt(row);
    if (row.report === "none") {
      if (found !== undefined) {
        return `${label}: reported ${found.code}`;
      }
      const { path, line: atLine } = at(row);
      const held = swept.retained
        .filter((record) => {
          const symbol = swept.matrix.union.symbols[swept.matrix.union.at(record.id)];
          return symbol?.position.path === path && symbol.position.line === atLine;
        })
        .map((record): string => record.class);
      const missing = (row.retained_by ?? []).filter((one) => !held.includes(one));
      return missing.length === 0
        ? `${label}: pass`
        : `${label}: not retained by ${missing.join(",")}`;
    }
    if (!FAMILY.test(row.report)) {
      return `${label}: another family`;
    }
    const wanted: [string, string | undefined, string | undefined][] = [
      ["code", row.report, found?.code],
      ["confidence", row.confidence, found?.confidence],
      ["reachability_class", row.reachability_class, found?.reachabilityClass],
      ["liveness_relation", row.liveness_relation, found?.livenessRelation],
      ["symbol_kind", row.symbol_kind, found?.symbol.kind],
    ];
    const wrong = wanted
      .filter(([, want, got]) => want !== undefined && want !== got)
      .map(([member, , got]) => `${member} ${got ?? "absent"}`);
    return wrong.length === 0 ? `${label}: pass` : `${label}: ${wrong.join(", ")}`;
  });
  const unnamed = findings
    .filter((finding) => expected.expect.every((row) => findingAt(row) !== finding))
    .map((finding) => `${finding.code} ${finding.symbol.name}`);
  return { rows, unnamed };
}

describe("the corpus fixtures naming a code of the family", () => {
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
  it("answers private-member-unread, with the write-only row another family's and one declared gap", () => {
    expect(answer("private-member-unread")).toEqual({
      rows: [
        "UnreadPrivate DS1301: another family",
        "UnreferencedPrivate DS1003: pass",
        // Declared gap: the reference pass resolves a string-literal element access to
        // the member it names, so the member is live rather than held back by a class.
        "ReachedByStringIndex none: not retained by reflective-lookup",
      ],
      unnamed: [],
    });
  });

  it("declares unused-exported-consumer a gap: no consumer is loaded beside the target", () => {
    expect(answer("unused-exported-consumer")).toEqual({
      rows: [
        "DeadExport DS1001: confidence possible, reachability_class possible",
        "UsedByConsumer none: reported DS1001",
      ],
      unnamed: [],
    });
  });
});
