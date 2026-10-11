import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { run, type Writer } from "./run.ts";

const TARGET = fixture("projects", "module-declarations");

const DISCARD: Writer = { write: () => undefined };

/**
 * Every finding of one `analyze` run over the fixture, as `code path:line name`. The run
 * reads the fixture's component files, so an import of one resolves to that file.
 */
const FINDINGS = ((): string[] => {
  const dir = mkdtempSync(join(tmpdir(), "deadset-ts-module-declarations-"));
  try {
    const report = join(dir, "report.json");
    run(["analyze", "--target=.", `--report=${report}`], DISCARD, DISCARD, {
      ...nodeHost(),
      workingDirectory: () => TARGET,
    });
    const document = JSON.parse(readFileSync(report, "utf8")) as {
      findings: {
        code: string;
        position: { path: string; line: number };
        symbol: { name: string };
      }[];
    };
    return document.findings.map(
      (one) => `${one.code} ${one.position.path}:${String(one.position.line)} ${one.symbol.name}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

describe("a module declaration an import names by its name or pattern", () => {
  it("lends the import the members it imports, where the specifier resolves to a component file", () => {
    expect(FINDINGS.filter((line) => line.includes(" '*.vue'"))).toEqual([
      "DS1001 src/shims.d.ts:5 '*.vue'.subtitle",
    ]);
  });

  it("is named by no import of a file no configuration holds, by pattern or by exact name", () => {
    expect(FINDINGS.filter((line) => / '(\*\.svg|virtual:config)'/u.test(line))).toEqual([
      "DS1001 src/shims.d.ts:11 '*.svg'.raw",
      "DS1001 src/shims.d.ts:12 '*.svg'.inline",
      "DS1002 src/shims.d.ts:15 'virtual:config'",
    ]);
  });

  it("is named by no specifier's text where its name is relative", () => {
    expect(FINDINGS.filter((line) => line.includes(" src/extend.ts:"))).toEqual([
      "DS1002 src/extend.ts:3 './util.js'",
      "DS1201 src/extend.ts:4 './util.js'.Util",
    ]);
  });

  it("is reported whole where no import names it", () => {
    expect(FINDINGS.filter((line) => line.includes(" '*.png'"))).toEqual([
      "DS1002 src/shims.d.ts:19 '*.png'",
    ]);
  });
});
