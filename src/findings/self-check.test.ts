import { describe, expect, it } from "vitest";
import type { SuppressionRecord } from "../suppress.ts";
import { staleSuppressions, unmatchedRootFindings } from "./self-check.ts";

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

function messages(...stale: { record: SuppressionRecord; reports: string[] }[]): string[] {
  return staleSuppressions(stale, () => undefined).map((one) => one.message);
}

describe("a suppression site that matches no current finding", () => {
  it("names its one code, and the one its declaration reports instead", () => {
    expect(messages({ record: entry("DS1001"), reports: ["DS1002"] })).toEqual([
      "ignore entry for DS1001 matches no current finding, and its declaration reports DS1002",
    ]);
  });

  it("names two codes and two reports each joined by and, in code order whatever the order written", () => {
    expect(
      messages(
        { record: entry("DS1003"), reports: ["DS1005"] },
        { record: entry("DS1001"), reports: ["DS1301", "DS1005"] },
      ),
    ).toEqual([
      "ignore entry for DS1001 and DS1003 matches no current finding, and its declaration reports DS1005 and DS1301",
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
      "ignore entry for DS1002, DS1102 and DS1104 matches no current finding, and its declaration reports DS1001 and DS1003",
    ]);
  });

  it("is one record per site, the first record written naming the entry", () => {
    const records = staleSuppressions(
      [
        { record: entry("DS1002"), reports: [] },
        { record: entry("DS1001", { path: "deadset.json", line: 9, column: 5 }), reports: [] },
        { record: entry("DS1001"), reports: [] },
      ],
      () => undefined,
    );

    expect(records.map((one) => [one.position.line, one.entry.code, one.message])).toEqual([
      [3, "DS1002", "ignore entry for DS1001 and DS1002 matches no current finding"],
      [9, "DS1001", "ignore entry for DS1001 matches no current finding"],
    ]);
  });
});

describe("a configured root that matches nothing", () => {
  it("is called a pattern where it holds a star or a question mark, and a root otherwise", () => {
    expect(
      unmatchedRootFindings(
        [
          "ts://@example/app/src/main.ts#start",
          "ts://@example/app/src/*.ts#run",
          "ts://@example/app/src/main.ts#run?",
        ],
        "",
      ).map((finding) => `${finding.symbol.name}: ${finding.message}`),
    ).toEqual([
      "ts://@example/app/src/main.ts#start: configured root matches no symbol of the inventory",
      "ts://@example/app/src/*.ts#run: configured root pattern matches no symbol of the inventory",
      "ts://@example/app/src/main.ts#run?: configured root pattern matches no symbol of the inventory",
    ]);
  });
});
