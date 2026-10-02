import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { format, resolveConfig } from "prettier";
import { beforeAll, describe, expect, it } from "vitest";
import {
  committedGaps,
  corpusFixtures,
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

  // A row waiting on a consumer the run cannot load reports nothing and names no class,
  // so it exercises no capability and no declared gap can cover it: these rows fail the
  // corpus until a consumer is loaded beside the target, and the list goes when they pass.
  it("fails only the expectations that need a consumer loaded beside the target", () => {
    expect(failures(results).map((line) => line.replace(/:.*$/su, ""))).toEqual([
      "redundant-export-keyword Caller",
      "redundant-export-keyword Published",
      "unused-exported-consumer UsedByConsumer",
    ]);
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
  it("names every finding and record at no expected site, and every unmatched root it did not configure", () => {
    const at = (path: string, line: number) => ({ path, line, column: 1 });
    const report = {
      findings: [
        {
          code: "DS1001",
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
      ],
      stale_suppressions: [{ code: "DS1703", position: at("a.ts", 1) }],
    } as unknown as Report;

    expect(
      unexpectedOf(
        report,
        new Map([["kept", "target/a.ts:3"]]),
        new Set(["ts://@example/target#configured"]),
      ),
    ).toEqual([
      { file: "target/a.ts", line: 1, report: "DS1703" },
      { file: "target/b.ts", line: 9, report: "DS1002" },
      { file: "target/deadset.json", line: 1, report: "DS1704" },
    ]);
  });
});
