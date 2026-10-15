import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { format, resolveConfig } from "prettier";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { corpusLock, ROOT } from "../__test-helpers__/fixtures.ts";
import type { DeclaredGap } from "./conformance.ts";

/** The bound on the whole run, which analyzes every rendering up to three times. */
const CORPUS_TIMEOUT = 600_000;

/** The declared gaps and results document this analyzer commits, and the module stating them. */
const GAPS_FILE = "conformance.json";
const RESULTS_FILE = "conformance-results.json";
const RECORD_FILE = "src/conformance-record.ts";

/** The gate that rewrites the results document and the record, and the command a failure names. */
const UPDATE = process.env["UPDATE_GOLDEN"] === "1";
const REGENERATE = "UPDATE_GOLDEN=1 npx vitest --run src/conformance.corpus.test.ts";

/** The message the corpus runner gives a gap whose expectation the analyzer answers as written. */
const STALE_GAP = "the analyzer answers this expectation as written, and a declared gap covers it";

/**
 * The corpus runner of the pinned Contract release, `deadset-corpus`: the binary
 * `DEADSET_CORPUS` names, which is how an unpublished release is run, and otherwise
 * the release `corpus.lock.json` pins, run through the Go toolchain.
 */
function runner(): readonly string[] {
  const built = process.env["DEADSET_CORPUS"];
  if (built !== undefined && built !== "") {
    return [built];
  }
  return [
    "go",
    "run",
    `github.com/cplieger/deadset-spec/v8/cmd/deadset-corpus@${corpusLock().tag}`,
  ];
}

interface Results {
  readonly corpus_version: string;
  readonly result: string;
  readonly totals: { readonly fixtures: number };
  readonly fixtures: readonly {
    readonly fixture: string;
    readonly result: string;
    readonly message?: string;
    readonly expectations: readonly {
      readonly symbol: string;
      readonly result: string;
      readonly message?: string;
    }[];
    readonly unexpected: readonly { file: string; line: number; report: string }[];
  }[];
}

/** One document formatted as the repository formats every file it commits. */
async function formatted(text: string, path: string): Promise<string> {
  const options = (await resolveConfig(join(ROOT, path))) ?? {};
  return format(text, { ...options, filepath: join(ROOT, path) });
}

/** The record module stated from the results document's bytes and the declared gaps. */
function recordSource(results: string, document: Results): string {
  const gaps = (
    JSON.parse(readFileSync(join(ROOT, GAPS_FILE), "utf8")) as {
      readonly gaps: readonly DeclaredGap[];
    }
  ).gaps;
  const record = {
    conformance: {
      corpusVersion: document.corpus_version,
      result: document.result,
      digest: `sha256:${createHash("sha256").update(results).digest("hex")}`,
    },
    gaps,
  };
  return [
    "// Written by the conformance run from conformance.json and conformance-results.json.",
    `// Regenerate it with \`${REGENERATE}\`.`,
    `export const RECORD = ${JSON.stringify(record)} as const;`,
    "",
  ].join("\n");
}

/** Every failed expectation, failed fixture and finding no row names, one line each. */
function failures(results: Results): string[] {
  return results.fixtures
    .filter((row) => row.result !== "pending")
    .flatMap((row) => [
      ...(row.result === "fail" && row.message !== undefined
        ? [`${row.fixture}: ${row.message}`]
        : []),
      ...row.expectations
        .filter((one) => one.result === "fail")
        .map((one) => `${row.fixture} ${one.symbol}: ${one.message ?? ""}`),
      ...row.unexpected.map(
        (one) =>
          `${row.fixture}: ${one.report} at ${one.file}:${String(one.line)}, which no expectation names`,
      ),
    ]);
}

describe("the conformance corpus, answered through the analyzer's command line", () => {
  const scratch = mkdtempSync(join(tmpdir(), "deadset-ts-corpus-"));
  let results: Results;
  let documents: { readonly results: string; readonly record: string };

  beforeAll(async () => {
    const [command = "", ...args] = runner();
    const out = join(scratch, RESULTS_FILE);
    try {
      execFileSync(
        command,
        [
          ...args,
          "run",
          "--language=ts",
          `--gaps=${join(ROOT, GAPS_FILE)}`,
          `--jobs=${String(availableParallelism())}`,
          `--out=${out}`,
          "--",
          process.execPath,
          join(ROOT, "bin", "deadset-ts.ts"),
        ],
        { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch (error) {
      if ((error as { status?: number }).status !== 1) {
        throw error;
      }
    }
    const written = readFileSync(out, "utf8");
    results = JSON.parse(written) as Results;
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

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("fails no expectation and no fixture outside the pending ones, so the corpus passes", () => {
    expect(failures(results)).toEqual([]);
    expect(results.result).toBe("pass");
  });

  it("declares no gap over an expectation the analyzer answers as written", () => {
    const stale = results.fixtures.flatMap((row) =>
      row.expectations
        .filter((one) => one.message === STALE_GAP)
        .map((one) => `${row.fixture} ${one.symbol}`),
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

describe("the command-line vectors naming this analyzer", () => {
  it(
    "fail in none, a pending case reporting what it awaits",
    () => {
      const [command = "", ...args] = runner();
      const out = execFileSync(
        command,
        [
          ...args,
          "cases",
          "--product=deadset-ts",
          "--",
          process.execPath,
          join(ROOT, "bin", "deadset-ts.ts"),
        ],
        { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      const failed = out.split("\n").filter((line) => line.startsWith("fail\t"));

      expect(out).not.toBe("");
      expect(failed).toEqual([]);
    },
    CORPUS_TIMEOUT,
  );
});
