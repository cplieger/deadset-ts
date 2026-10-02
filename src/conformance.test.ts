import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture, readFixture, ROOT } from "../__test-helpers__/fixtures.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { CONFORMANCE, DECLARED_GAPS, type DeclaredGap } from "./conformance.ts";
import { ANALYZER_NAME } from "./report.ts";
import { run, type Writer } from "./run.ts";

/** The bound on the case that loads a target. */
const LOAD_TIMEOUT = 60_000;

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

interface GapsDocument {
  readonly corpus_version: string;
  readonly product: { readonly name: string };
  readonly gaps: readonly DeclaredGap[];
}

interface Row {
  readonly symbol: string;
  readonly report: string;
  readonly retained_by?: readonly string[];
}

function committed(name: string): string {
  return readFileSync(join(ROOT, name), "utf8");
}

function gapsDocument(): GapsDocument {
  return JSON.parse(committed("conformance.json")) as GapsDocument;
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

describe("the conformance record", () => {
  it("states the digest, the result and the corpus version of the committed results document", () => {
    const results = committed("conformance-results.json");
    const recorded = JSON.parse(results) as { corpus_version: string; result: string };
    const corpus = JSON.parse(readFixture("corpus-document", "corpus.json")) as {
      corpus_version: string;
    };

    expect(CONFORMANCE).toEqual({
      corpusVersion: recorded.corpus_version,
      result: recorded.result,
      digest: sha256(results),
    });
    expect(CONFORMANCE.corpusVersion).toBe(corpus.corpus_version);
  });

  it("declares exactly the gaps conformance.json declares, against the corpus and for this analyzer", () => {
    const document = gapsDocument();
    const corpus = JSON.parse(readFixture("corpus-document", "corpus.json")) as {
      corpus_version: string;
    };

    expect(DECLARED_GAPS).toEqual(document.gaps);
    expect(document.product.name).toBe(ANALYZER_NAME);
    expect(document.corpus_version).toBe(corpus.corpus_version);
  });

  it("declares every gap against a fixture whose expectations exercise its capability", () => {
    const covering = gapsDocument().gaps.map((gap) => {
      const file = JSON.parse(
        readFileSync(fixture("corpus", gap.fixture, "expect.json"), "utf8"),
      ) as {
        readonly expect: readonly Row[];
      };
      const rows = file.expect.filter(
        (row) =>
          (gap.symbol === undefined || gap.symbol === row.symbol) &&
          (row.report === "none" ? (row.retained_by ?? []) : [row.report]).includes(gap.capability),
      );
      return `${gap.fixture} ${gap.capability}: ${String(rows.length)}`;
    });

    expect(covering.filter((line) => line.endsWith(": 0"))).toEqual([]);
  });

  it(
    "is what describe and every report the analyze verb writes state",
    () => {
      const target = writeProject({
        "deadset.json":
          '{ "target": { "kind": "application" }, "ts": { "entry_files": ["main.ts"] } }\n',
        "package.json": '{ "name": "@example/clean", "private": true, "type": "module" }\n',
        "main.ts": "console.log(1);\n",
      });
      const out = mkdtempSync(join(tmpdir(), "deadset-ts-conformance-"));
      onTestFinished(() => {
        rmSync(target, { recursive: true, force: true });
        rmSync(out, { recursive: true, force: true });
      });
      const host = { ...nodeHost(), workingDirectory: () => target };
      const block = {
        corpus_version: CONFORMANCE.corpusVersion,
        result: JSON.parse(committed("conformance-results.json")).result as string,
        digest: sha256(committed("conformance-results.json")),
      };

      const described = new MemoryWriter();
      expect(run(["describe"], described, new MemoryWriter(), host)).toBe(0);
      expect(JSON.parse(described.text)).toMatchObject({ conformance: block });

      const err = new MemoryWriter();
      expect(
        run(
          ["analyze", "--target=.", `--report=${join(out, "report.json")}`],
          new MemoryWriter(),
          err,
          host,
        ),
        err.text,
      ).toBe(0);
      const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as {
        analyzer: { conformance: unknown };
        declared_gaps: unknown;
      };
      expect(report.analyzer.conformance).toEqual(block);
      expect(report.declared_gaps).toEqual(
        [...gapsDocument().gaps].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
      );
    },
    LOAD_TIMEOUT,
  );
});
