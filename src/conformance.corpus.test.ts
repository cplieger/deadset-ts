import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { format, resolveConfig } from "prettier";
import { beforeAll, describe, expect, it } from "vitest";
import {
  committedGaps,
  corpusFixtures,
  declarationRef,
  edgeDifferences,
  runCorpus,
  STALE_GAP,
  unexpectedOf,
  type Results,
} from "../__test-helpers__/corpus-runner.ts";
import { ROOT } from "../__test-helpers__/fixtures.ts";
import type { Report } from "./report.ts";

/** The bound on the whole run, which loads every rendering three times. */
const CORPUS_TIMEOUT = 600_000;

/** The results document this analyzer commits, and the module it states the record from. */
const RESULTS_FILE = "conformance-results.json";
const RECORD_FILE = "src/conformance-record.ts";

/** The gate that rewrites the results document and the record, and the command a failure names. */
const UPDATE = process.env["UPDATE_GOLDEN"] === "1";
const REGENERATE = "UPDATE_GOLDEN=1 npx vitest --run src/conformance.corpus.test.ts";

/** One document formatted as the repository formats every file it commits. */
async function formatted(text: string, path: string): Promise<string> {
  const options = (await resolveConfig(join(ROOT, path))) ?? {};
  return format(text, { ...options, filepath: join(ROOT, path) });
}

/** The record module stated from the results document's bytes and the declared gaps. */
function recordSource(results: string, document: Results): string {
  const record = {
    conformance: {
      corpusVersion: document.corpus_version,
      result: document.result,
      digest: `sha256:${createHash("sha256").update(results).digest("hex")}`,
    },
    gaps: committedGaps(),
  };
  return [
    "// Written by the conformance run from conformance.json and conformance-results.json.",
    `// Regenerate it with \`${REGENERATE}\`.`,
    `export const RECORD = ${JSON.stringify(record)} as const;`,
    "",
  ].join("\n");
}

/**
 * Every failure line of the fixtures of the analysis rules this analyzer does not
 * implement, which no declared gap can cover: configuration files and the strings they
 * hold, script entries, and type-query aliases.
 */
const UNIMPLEMENTED = [
  "configuration-files-and-strings UsedByJSON: want no finding at target/package.json:9, got DS1601",
  "configuration-files-and-strings UsedByModule: want no finding at target/package.json:8, got DS1601",
  "configuration-files-and-strings prepare: want no finding at target/setup/prepare.ts:2, got DS1001",
  "configuration-files-and-strings: DS1502 at target/build.config.ts:1, which no expectation names",
  "configuration-files-and-strings: DS1601 at target/package.json:8, which no expectation names",
  "configuration-files-and-strings: DS1601 at target/package.json:9, which no expectation names",
  "configuration-files-and-strings: DS1502 at target/setup/prepare.ts:1, which no expectation names",
  "configuration-files-and-strings: DS1001 at target/setup/prepare.ts:2, which no expectation names",
  "test-and-script-defaults seed: want no finding at target/scripts/seed.ts:2, got DS1001",
  "test-and-script-defaults: DS1502 at target/scripts/seed.ts:1, which no expectation names",
  "test-and-script-defaults: DS1001 at target/scripts/seed.ts:2, which no expectation names",
  "type-query-alias useCounter: want no finding at target/counter.ts:2, got DS1001",
  "type-query-alias: DS1502 at target/counter.ts:1, which no expectation names",
  "type-query-alias: DS1001 at target/counter.ts:2, which no expectation names",
  "type-query-alias: DS1002 at target/globals.d.ts:3, which no expectation names",
];

/** Every expectation and fixture that does not pass or gap, one line each. */
function failures(results: Results): string[] {
  return results.fixtures.flatMap((row) => [
    ...(row.message === undefined ? [] : [`${row.fixture}: ${row.message}`]),
    ...row.expectations
      .filter((one) => one.result === "fail")
      .map((one) => `${row.fixture} ${one.symbol}: ${one.message ?? ""}`),
    ...row.unexpected.map(
      (one) =>
        `${row.fixture}: ${one.report} at ${one.file}:${String(one.line)}, which no expectation names`,
    ),
  ]);
}

describe("the conformance corpus, answered through the analyze verb", () => {
  let results: Results;
  let documents: { readonly results: string; readonly record: string };

  beforeAll(async () => {
    results = runCorpus();
    const text = await formatted(JSON.stringify(results), RESULTS_FILE);
    documents = {
      results: text,
      record: await formatted(recordSource(text, results), RECORD_FILE),
    };
    if (UPDATE) {
      writeFileSync(join(ROOT, RESULTS_FILE), documents.results);
      writeFileSync(join(ROOT, RECORD_FILE), documents.record);
    }
  }, CORPUS_TIMEOUT);

  it("answers every fixture with a TypeScript rendering, in name order", () => {
    expect(results.fixtures.map((one) => one.fixture)).toEqual(corpusFixtures());
    expect(results.totals.fixtures).toBe(results.fixtures.length);
  });

  it("fails exactly the expectations of the rules this analyzer does not implement, and no other", () => {
    expect(failures(results)).toEqual(UNIMPLEMENTED);
    expect(results.result).toBe("fail");
  });

  it("declares no gap over an expectation the analyzer answers as written", () => {
    const stale = results.fixtures.flatMap((row) =>
      row.expectations
        .filter(
          (one) =>
            one.capability !== undefined && (one.result === "pass" || one.message === STALE_GAP),
        )
        .map((one) => `${row.fixture} ${one.symbol} ${one.capability ?? ""}`),
    );

    expect(stale).toEqual([]);
  });

  it("records the run as the committed results document", () => {
    const committed = readFileSync(join(ROOT, RESULTS_FILE), "utf8");

    expect(
      documents.results === committed,
      `${RESULTS_FILE} differs from this run (regenerate with ${REGENERATE})`,
    ).toBe(true);
  });

  it("states the committed results document in the record every report names", () => {
    const committed = readFileSync(join(ROOT, RECORD_FILE), "utf8");

    expect(
      documents.record === committed,
      `${RECORD_FILE} differs from this run (regenerate with ${REGENERATE})`,
    ).toBe(true);
  });
});

describe("the closed world of a fixture", () => {
  it("names every finding and record no row names by position and code, and every configured entry no row names", () => {
    const at = (path: string, line: number) => ({ path, line, column: 1 });
    const report = {
      findings: [
        {
          code: "DS1001",
          symbol: { ref: "ts://@example/target/a.ts#kept" },
          position: at("a.ts", 3),
        },
        {
          code: "DS1104",
          symbol: { ref: "ts://@example/target/a.ts#kept" },
          position: at("a.ts", 3),
        },
        {
          code: "DS1002",
          symbol: { ref: "ts://@example/target/b.ts#extra" },
          position: at("b.ts", 9),
        },
        {
          code: "DS1704",
          symbol: { ref: "ts://@example/target#configured" },
          position: at("deadset.json", 1),
        },
        {
          code: "DS1704",
          symbol: { ref: "ts://@example/target#other" },
          position: at("deadset.json", 1),
        },
        {
          code: "DS1706",
          symbol: { ref: "@example/absent#encode" },
          position: at("deadset.json", 1),
        },
        {
          code: "DS1706",
          symbol: { ref: "#JSON.parse" },
          position: at("deadset.json", 1),
        },
      ],
      stale_suppressions: [{ code: "DS1703", position: at("a.ts", 1) }],
    } as unknown as Report;

    expect(
      unexpectedOf(
        report,
        new Set(["target/a.ts:3 DS1001"]),
        new Set(["DS1704 ts://@example/target#configured", "DS1706 @example/absent#encode"]),
      ),
    ).toEqual([
      { file: "target/a.ts", line: 1, report: "DS1703" },
      { file: "target/a.ts", line: 3, report: "DS1104" },
      { file: "target/b.ts", line: 9, report: "DS1002" },
      { file: "target/deadset.json", line: 1, report: "DS1704" },
      { file: "target/deadset.json", line: 1, report: "DS1706" },
    ]);
  });

  it("spells a configured declaration's reference in each of the entry's three shapes", () => {
    expect(declarationRef({ symbol: "ts://@example/target/codec.ts#encode" })).toBe(
      "ts://@example/target/codec.ts#encode",
    );
    expect(declarationRef({ module: "@example/absent", name: "encode" })).toBe(
      "@example/absent#encode",
    );
    expect(declarationRef({ global: "JSON.parse" })).toBe("#JSON.parse");
  });
});

describe("the edge evaluations of a fixture", () => {
  const manifest = { symbols: { Handler: { file: "target/a.ts", line: 4 } } };
  const finding = { code: "DS1001", position: { path: "a.ts", line: 4 } };

  it("agrees with a report holding exactly the records the entries name", () => {
    expect(
      edgeDifferences(
        {
          edge_evaluations: [
            {
              edge: "wire/one",
              side: "provides",
              state: "dead",
              symbol: "Handler",
              report: "DS1001",
            },
            { edge: "wire/two", side: "used_by", state: "live" },
          ],
        },
        manifest,
        {
          edge_evaluations: [
            { edge: "wire/one", side: "provides", symbol: "s", state: "dead", finding },
            { edge: "wire/two", side: "used_by", symbol: "t", state: "live" },
          ],
        } as unknown as Report,
      ),
    ).toBe("");
  });

  it("names a missing record, a state that differs, a pending finding elsewhere and a record no entry names", () => {
    expect(
      edgeDifferences(
        {
          edge_evaluations: [
            {
              edge: "wire/one",
              side: "provides",
              state: "dead",
              symbol: "Handler",
              report: "DS1002",
            },
            { edge: "wire/two", side: "used_by", state: "live" },
            { edge: "wire/three", side: "provides", state: "absent" },
          ],
        },
        manifest,
        {
          edge_evaluations: [
            { edge: "wire/one", side: "provides", symbol: "s", state: "dead", finding },
            { edge: "wire/two", side: "used_by", symbol: "t", state: "absent" },
            { edge: "wire/four", side: "used_by", symbol: "u", state: "live" },
          ],
        } as unknown as Report,
      ),
    ).toBe(
      "wire/one provides want DS1002 at target/a.ts:4, got DS1001 at target/a.ts:4; " +
        "wire/two used_by state want live got absent; " +
        "want exactly one evaluation of wire/three provides, got 0; " +
        "evaluation of wire/four used_by, which no entry names",
    );
  });

  it("expects no record where the fixture names no evaluation", () => {
    expect(
      edgeDifferences({}, manifest, {
        edge_evaluations: [{ edge: "wire/one", side: "provides", symbol: "s", state: "live" }],
      } as unknown as Report),
    ).toBe("evaluation of wire/one provides, which no entry names");
  });
});
