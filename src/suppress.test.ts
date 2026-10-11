import { describe, expect, it } from "vitest";
import { contractDocument, readFixture } from "../__test-helpers__/fixtures.ts";
import type { Finding } from "./finding.ts";
import {
  CODE_FORM,
  GO_REF_EXPRESSIONS,
  PATH_EXPRESSION,
  isSymbolRef,
  ledgerOf,
  type Dials,
  type SuppressionRecord,
} from "./suppress.ts";

/** The expressions the symbol-reference page publishes for one language. */
function publishedExpressions(language: string): string[] {
  const lines = readFixture("contract", "grammar", "symbol-ref.md").split("\n");
  return lines.flatMap((line, index) => {
    const head = /^(?<language>go|ts) (?<forms>[a-z-]+(?:, [a-z-]+)*)$/u.exec(line);
    const expression = lines[index + 1] ?? "";
    return head?.groups?.["language"] === language && expression.startsWith("^")
      ? [expression]
      : [];
  });
}

describe("the forms an entry's values take", () => {
  const schema = contractDocument("finding.schema.json") as {
    $defs: { relative_path: { pattern: string } };
    properties: { code: { pattern: string } };
  };

  it("are the Contract's own: the path and code expressions of the finding schema", () => {
    expect(PATH_EXPRESSION).toBe(schema.$defs.relative_path.pattern);
    expect(CODE_FORM.source).toBe(schema.properties.code.pattern);
  });

  it("admit a reference of the Go analyzer's grammar exactly as the grammar page publishes it", () => {
    expect([...GO_REF_EXPRESSIONS].sort()).toEqual(publishedExpressions("go").sort());
  });

  it("accept either language's reference and refuse a bare name or a pattern", () => {
    expect(
      [
        "go://example.com/app#Catalog.ResolveAlias",
        "ts://@example/app/src/lib.ts#helper",
        "Catalog.ResolveAlias",
        "go://example.com/app#Catalog.*",
      ].map(isSymbolRef),
    ).toEqual([true, true, false, false]);
  });
});

/** A finding about the declaration at one line of one file. */
function finding(code: string, name: string, line: number, kind = "function"): Finding {
  return {
    code,
    position: { path: "src/lib.ts", line, column: 1, endLine: line },
    symbol: { ref: `ts://@example/app/src/lib.ts#${name}`, kind, name, sizeLines: 1 },
    message: "has no reference in the target",
  };
}

/** A record of one mechanism naming the finding given, bound where it names a declaration. */
function recordOf(
  found: Finding,
  mechanism: SuppressionRecord["mechanism"],
  line = 1,
): SuppressionRecord {
  return {
    code: found.code,
    symbol: found.symbol.ref,
    path: found.position.path,
    reason: "Kept for the next release.",
    bound: `src/lib.ts:${String(found.position.line)}:1`,
    site: { path: mechanism === "inline" ? "src/lib.ts" : "deadset-ignore.json", line, column: 1 },
    mechanism,
  };
}

const OPEN: Dials = { allows: () => false, withholds: () => false };

describe("the ledger over a run's records", () => {
  const helper = finding("DS1002", "helper", 4);

  it("gives a finding to the first record naming it, and the second is stale", () => {
    const ledger = ledgerOf(
      [recordOf(helper, "inline"), recordOf(helper, "ignore")],
      [helper],
      OPEN,
    );

    expect(ledger.verdicts).toEqual(["in-effect", "stale"]);
    expect(ledger.withheld(helper)).toBe(true);
  });

  it("finds a record naming another code than its declaration reports stale, and withholds nothing", () => {
    const ledger = ledgerOf([{ ...recordOf(helper, "inline"), code: "DS1001" }], [helper], OPEN);

    expect(ledger.verdicts).toEqual(["stale"]);
    expect(ledger.withheld(helper)).toBe(false);
  });

  it("finds a bound record that matches nothing dormant only where its own code is at allow", () => {
    const silenced: Dials = { allows: (code) => code === "DS1002", withholds: () => false };

    expect(ledgerOf([recordOf(helper, "baseline")], [], silenced).verdicts).toEqual(["dormant"]);
    expect(ledgerOf([recordOf(helper, "baseline")], [], OPEN).verdicts).toEqual(["stale"]);
    expect(
      ledgerOf([{ ...recordOf(helper, "baseline"), bound: "" }], [], silenced).verdicts,
    ).toEqual(["stale"]);
  });

  it("finds a record whose finding a dial withholds dormant", () => {
    const dialed: Dials = { allows: () => false, withholds: (one) => one === helper };

    expect(ledgerOf([recordOf(helper, "ignore")], [helper], dialed).verdicts).toEqual(["dormant"]);
  });

  it("decides a record that matches a finding by the finding, whatever its code's severity", () => {
    const silenced: Dials = { allows: (code) => code === "DS1002", withholds: () => false };

    expect(ledgerOf([recordOf(helper, "ignore")], [helper], silenced).verdicts).toEqual([
      "in-effect",
    ]);
  });

  it("reaches a finding about a part of a declaration through the reference and the file", () => {
    const part = {
      ...finding("DS1801", "helper", 4, "parameter"),
      position: { path: "src/lib.ts", line: 4, column: 17, endLine: 4 },
    };
    const ledger = ledgerOf([{ ...recordOf(part, "ignore"), bound: "" }], [part], OPEN);

    expect(ledger.verdicts).toEqual(["in-effect"]);
  });

  it("withholds every finding of a part kind about one declaration through one record", () => {
    const at = (column: number): Finding => ({
      ...finding("DS1801", "helper", 4, "parameter"),
      position: { path: "src/lib.ts", line: 4, column, endLine: 4 },
    });
    const [first, second] = [at(17), at(24)];
    const ledger = ledgerOf(
      [recordOf(first, "inline", 3), recordOf(first, "ignore")],
      [first, second],
      OPEN,
    );

    expect(ledger.verdicts).toEqual(["in-effect", "stale"]);
    expect([ledger.withheld(first), ledger.withheld(second)]).toEqual([true, true]);
  });

  it("is dormant for a part kind only when the dials withhold every part finding it claims", () => {
    const at = (column: number): Finding => ({
      ...finding("DS1801", "helper", 4, "parameter"),
      position: { path: "src/lib.ts", line: 4, column, endLine: 4 },
    });
    const [first, second] = [at(17), at(24)];
    const one: Dials = { allows: () => false, withholds: (found) => found === first };
    const both: Dials = { allows: () => false, withholds: () => true };

    expect(ledgerOf([recordOf(first, "inline", 3)], [first, second], one).verdicts).toEqual([
      "in-effect",
    ]);
    expect(ledgerOf([recordOf(first, "inline", 3)], [first, second], both).verdicts).toEqual([
      "dormant",
    ]);
  });

  it("withholds a dependency row through an entry or a row naming it, never a directive", () => {
    const row: Finding = {
      code: "DS1601",
      position: { path: "package.json", line: 7, column: 5, endLine: 7 },
      symbol: {
        ref: "ts://@example/app/package.json#left-pad:dependency",
        kind: "dependency",
        name: "left-pad",
        sizeLines: 1,
      },
      message: "is declared and never needed",
    };
    const entry = { ...recordOf(row, "ignore"), bound: "" };

    expect(ledgerOf([entry], [row], OPEN).verdicts).toEqual(["in-effect"]);
    expect(ledgerOf([{ ...entry, mechanism: "baseline" }], [row], OPEN).verdicts).toEqual([
      "in-effect",
    ]);
    expect(ledgerOf([{ ...entry, path: "web/package.json" }], [row], OPEN).verdicts).toEqual([
      "stale",
    ]);
    const directive = ledgerOf([{ ...entry, mechanism: "inline" }], [row], OPEN);
    expect(directive.verdicts).toEqual(["stale"]);
    expect(directive.withheld(row)).toBe(false);
  });

  it("withholds no finding about a row of a document, which no record binds", () => {
    const row = finding("DS1501", "file", 1, "file");
    const ledger = ledgerOf([recordOf(row, "ignore")], [row], OPEN);

    expect(ledger.verdicts).toEqual(["stale"]);
    expect(ledger.withheld(row)).toBe(false);
  });
});
