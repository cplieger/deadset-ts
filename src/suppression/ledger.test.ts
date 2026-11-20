import { describe, expect, it } from "vitest";
import { contractDocument } from "../../__test-helpers__/fixtures.ts";
import type { Finding } from "../finding.ts";
import type { Host } from "../host.ts";
import { IGNORE_FILE, readIgnoreFile } from "./documents.ts";
import {
  decide,
  staleRecords,
  staleSuppressions,
  type Dials,
  type Holds,
  type Ledger,
  type StaleSuppression,
} from "./ledger.ts";
import { hasRefShape } from "../ref.ts";
import { CODE_FORM, PATH_EXPRESSION, type SuppressionRecord } from "./records.ts";

describe("the forms an entry's values take", () => {
  const schema = contractDocument("finding.schema.json") as {
    $defs: { relative_path: { pattern: string } };
    properties: { code: { pattern: string } };
  };

  it("are the Contract's own: the path and code expressions of the finding schema", () => {
    expect(PATH_EXPRESSION).toBe(schema.$defs.relative_path.pattern);
    expect(CODE_FORM.source).toBe(schema.properties.code.pattern);
  });

  it("hold any scheme's reference to the shape every document checks, and refuse a bare name", () => {
    expect(
      [
        "go://example.com/app#Catalog.ResolveAlias",
        "ts://@example/app/src/lib.ts#helper",
        "proto://acme/v1/backup.proto#BackupRequest",
        "go://example.com/app#Catalog.*",
        "Catalog.ResolveAlias",
        "Go://example.com/app#Catalog",
        "ts://",
      ].map((ref) => hasRefShape(ref)),
    ).toEqual([true, true, true, false, false, false, false]);
  });
});

/** A finding about the declaration at one line of one file. */
function finding(
  code: string,
  name: string,
  line: number,
  kind: Finding["symbol"]["kind"] = "function",
): Finding {
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

/** No hold. */
const NO_HOLDS: Holds = { withholds: () => false, holdsRecord: () => false };

/**
 * The declaration a finding of these cases is about: the one at its position, or for a
 * part the one its holder names, which every case declares at column one of the part's line.
 */
function declarationOf(found: Finding): string {
  if (found.symbol.kind === "dependency" || found.symbol.kind === "file") {
    return "";
  }
  return `${found.position.path}:${String(found.position.line)}:1`;
}

/** The ledger over the records and findings given, under the dials and the holds given. */
function ledgerOf(
  records: readonly SuppressionRecord[],
  would: readonly Finding[],
  dials: Dials,
  holds: Holds = NO_HOLDS,
): Ledger {
  return decide(records, would, { dials, holds, declarationOf });
}

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

  it("finds a bound record a hold touches dormant: one whose declaration a hold keeps live, and one whose every finding a hold withholds", () => {
    const record = recordOf(helper, "inline");
    const holds: Holds = {
      withholds: (one) => one === helper,
      holdsRecord: (one) => one.bound === record.bound,
    };

    expect(ledgerOf([record], [], OPEN, holds).verdicts).toEqual(["dormant"]);
    expect(ledgerOf([record], [helper], OPEN, holds).verdicts).toEqual(["dormant"]);
    expect(ledgerOf([{ ...record, bound: "" }], [], OPEN, holds).verdicts).toEqual(["stale"]);
    expect(ledgerOf([record], [], OPEN).verdicts).toEqual(["stale"]);
    expect(ledgerOf([record], [helper], OPEN).verdicts).toEqual(["in-effect"]);
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
      ...finding("DS1401", "helper", 4, "parameter"),
      position: { path: "src/lib.ts", line: 4, column: 17, endLine: 4 },
    };
    const ledger = ledgerOf([{ ...recordOf(part, "ignore"), bound: "" }], [part], OPEN);

    expect(ledger.verdicts).toEqual(["in-effect"]);
  });

  it("withholds every finding of a part kind about one declaration through one record", () => {
    const at = (column: number): Finding => ({
      ...finding("DS1401", "helper", 4, "parameter"),
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

  it("tells two parameters of one declaration apart by their own references", () => {
    const parameter = (name: string, column: number): Finding => ({
      ...finding("DS1401", "helper", 4, "parameter"),
      position: { path: "src/lib.ts", line: 4, column, endLine: 4 },
      symbol: {
        ref: `ts://@example/app/src/lib.ts#helper(${name})`,
        holder: "ts://@example/app/src/lib.ts#helper",
        kind: "parameter",
        name,
        sizeLines: 1,
      },
    });
    const [first, second] = [parameter("first", 17), parameter("second", 24)];
    const named = ledgerOf([{ ...recordOf(second, "ignore"), bound: "" }], [first, second], OPEN);
    const holder = ledgerOf(
      [{ ...recordOf(first, "ignore"), symbol: "ts://@example/app/src/lib.ts#helper", bound: "" }],
      [first, second],
      OPEN,
    );

    expect([named.withheld(first), named.withheld(second)]).toEqual([false, true]);
    expect([holder.withheld(first), holder.withheld(second)]).toEqual([true, true]);
  });

  it("withholds through one entry the parameters of one name that two functions of one holder declare", () => {
    const callback = (line: number): Finding => ({
      ...finding("DS1401", "", line, "parameter"),
      position: { path: "src/lib.ts", line, column: 20, endLine: line },
      symbol: {
        ref: "ts://@example/app/src/lib.ts#(value)",
        holder: "ts://@example/app/src/lib.ts#",
        kind: "parameter",
        name: "value",
        sizeLines: 1,
      },
    });
    const [first, second] = [callback(4), callback(5)];
    const ledger = ledgerOf([{ ...recordOf(first, "ignore"), bound: "" }], [first, second], OPEN);

    expect([ledger.withheld(first), ledger.withheld(second)]).toEqual([true, true]);
  });

  it("is dormant for a part kind only when the dials withhold every part finding it claims", () => {
    const at = (column: number): Finding => ({
      ...finding("DS1401", "helper", 4, "parameter"),
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
      code: "DS1701",
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

  it("reaches the finding at the declaration a record bound, whatever reference the record names", () => {
    const renamed = {
      ...recordOf(helper, "inline"),
      symbol: "ts://@example/app/src/lib.ts#renamed",
    };

    expect(ledgerOf([renamed], [helper], OPEN).verdicts).toEqual(["in-effect"]);
  });

  it("withholds no finding of its code about another declaration of the file", () => {
    const other = finding("DS1002", "other", 9);

    expect(ledgerOf([recordOf(helper, "inline")], [other], OPEN).verdicts).toEqual(["stale"]);
    expect(
      ledgerOf([{ ...recordOf(helper, "ignore"), bound: "" }], [other], OPEN).verdicts,
    ).toEqual(["stale"]);
  });

  it("withholds no finding through its reference where the record names another file", () => {
    const elsewhere = { ...recordOf(helper, "ignore"), bound: "", path: "src/other.ts" };

    expect(ledgerOf([elsewhere], [helper], OPEN).verdicts).toEqual(["stale"]);
  });

  it("gives a finding about one of the declarations an entry resolved to that declaration's record alone", () => {
    const first = finding("DS1001", "Opt", 1);
    const second = { ...finding("DS1001", "Opt", 2), symbol: first.symbol };
    const entry = { ...recordOf(first, "ignore"), bound: "src/lib.ts:1:1" };
    const records = [entry, { ...entry, bound: "src/lib.ts:2:1" }];
    const dialed: Dials = { allows: () => false, withholds: (one) => one === first };

    expect(ledgerOf(records, [second, first], dialed).verdicts).toEqual(["dormant", "in-effect"]);
  });

  it("claims every finding it names that no earlier record claimed", () => {
    const first = finding("DS1001", "Opt", 1);
    const copy = { ...finding("DS1001", "Opt", 1), message: "the same finding read twice" };
    const ledger = ledgerOf(
      [recordOf(first, "ignore"), recordOf(first, "baseline")],
      [first, copy],
      OPEN,
    );

    expect(ledger.verdicts).toEqual(["in-effect", "stale"]);
  });

  it("withholds no finding about a row of a document, which no record binds", () => {
    const row = finding("DS1601", "file", 1, "file");
    const ledger = ledgerOf([recordOf(row, "ignore")], [row], OPEN);

    expect(ledger.verdicts).toEqual(["stale"]);
    expect(ledger.withheld(row)).toBe(false);
  });
});

describe("the stale suppressions of a run", () => {
  const first = finding("DS1001", "Opt", 1);
  const entry = { ...recordOf(first, "ignore"), bound: "src/lib.ts:1:1" };
  const records = [entry, { ...entry, bound: "src/lib.ts:2:1" }];
  const ledger = (verdicts: Ledger["verdicts"]): Ledger => ({ verdicts, withheld: () => false });

  it("leaves out an entry one of whose records is in effect", () => {
    expect(staleRecords(records, ledger(["in-effect", "stale"]))).toEqual([]);
  });

  it("reports an entry every record of which is stale once, at its first record", () => {
    expect(staleRecords(records, ledger(["stale", "stale"]))).toEqual([entry]);
  });

  it("tells two codes of one directive apart", () => {
    const directive = recordOf(first, "inline", 3);
    const both = [directive, { ...directive, code: "DS1002" }];

    expect(staleRecords(both, ledger(["in-effect", "stale"]))).toEqual([both[1]]);
  });
});

function entry(
  code: string,
  site = { path: "deadset.json", line: 3, column: 5 },
): SuppressionRecord {
  return {
    code,
    symbol: "ts://@example/app/src/main.ts#helper",
    path: "src/main.ts",
    reason: "kept for the plugin API",
    bound: "src/main.ts:1:17",
    site,
    mechanism: "ignore",
  };
}

/** The stale suppressions of records whose declaration would report the codes given beside each. */
function staleOf(
  ...stale: { record: SuppressionRecord; reports: string[] }[]
): readonly StaleSuppression[] {
  const would = stale.flatMap(({ reports }) => reports.map((code) => finding(code, "helper", 1)));
  return staleSuppressions(
    stale.map((one) => one.record),
    would,
    { declarationOf: () => "src/main.ts:1:17" },
    (record) => record.symbol,
  );
}

function messages(...stale: { record: SuppressionRecord; reports: string[] }[]): string[] {
  return staleOf(...stale).map((one) => one.message);
}

describe("a suppression site that matches no current finding", () => {
  it("names its one code, and the one its declaration reports instead", () => {
    expect(messages({ record: entry("DS1001"), reports: ["DS1002"] })).toEqual([
      "ignore entry for DS1001 on ts://@example/app/src/main.ts#helper matches no current finding, and its declaration reports DS1002",
    ]);
  });

  it("names two codes and two reports each joined by and, in code order whatever the order written", () => {
    expect(
      messages(
        { record: entry("DS1003"), reports: ["DS1005"] },
        { record: entry("DS1001"), reports: ["DS1301", "DS1005"] },
      ),
    ).toEqual([
      "ignore entry for DS1001 and DS1003 on ts://@example/app/src/main.ts#helper matches no current finding, and its declaration reports DS1005 and DS1301",
    ]);
  });

  it("names three codes as a list ending in and, and leaves out a report that is one of them", () => {
    expect(
      messages(
        { record: entry("DS1104"), reports: ["DS1102"] },
        { record: entry("DS1002"), reports: ["DS1001", "DS1003"] },
        { record: entry("DS1102"), reports: [] },
      ),
    ).toEqual([
      "ignore entry for DS1002, DS1102 and DS1104 on ts://@example/app/src/main.ts#helper matches no current finding, and its declaration reports DS1001 and DS1003",
    ]);
  });

  it("is one record per site, the first record written naming the entry", () => {
    const records = staleOf(
      { record: entry("DS1002"), reports: [] },
      { record: entry("DS1001", { path: "deadset.json", line: 9, column: 5 }), reports: [] },
      { record: entry("DS1001"), reports: [] },
    );

    expect(records.map((one) => [one.position.line, one.entry.code, one.message])).toEqual([
      [
        3,
        "DS1002",
        "ignore entry for DS1001 and DS1002 on ts://@example/app/src/main.ts#helper matches no current finding",
      ],
      [
        9,
        "DS1001",
        "ignore entry for DS1001 on ts://@example/app/src/main.ts#helper matches no current finding",
      ],
    ]);
  });
});

function ignoreFileHost(document: string): Host {
  const held = (path: string): boolean => path === `/target/${IGNORE_FILE}`;
  return {
    workingDirectory: () => "/target",
    readFile: (path) => (held(path) ? document : ""),
    readDirectory: () => [],
    kindOf: (path) => (held(path) ? "file" : "absent"),
    realPath: (path) => path,
    analyzerVersion: () => "0.0.0-devel",
    temporaryDirectory: () => {
      throw new Error("no temporary directory");
    },
    componentMapperCommand: () => [],
    writeDocument: (path) => {
      throw new Error(`${path}: this host writes nothing`);
    },
  };
}

describe("a suppression document refused as a whole", () => {
  it("is named by its path alone where it is JSON but not one object", () => {
    expect(() => readIgnoreFile(ignoreFileHost("[]"), "/target", [])).toThrow(
      `ignore ${IGNORE_FILE}: ${IGNORE_FILE}: `,
    );
  });

  it("is named at the line and column of the fault where it is not JSON", () => {
    expect(() => readIgnoreFile(ignoreFileHost("{"), "/target", [])).toThrow(
      `ignore ${IGNORE_FILE}:1:2: a member name is expected`,
    );
  });
});
