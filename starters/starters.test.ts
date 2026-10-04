import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { run, type Writer } from "../src/run.ts";
import { generate, STARTERS, versionsFor, type Mode } from "./starters.ts";

/**
 * Each row against its framework's official starter: generated, installed and analyzed,
 * the row must apply and no file the documentation calls an entry may be reported as
 * never imported or as an unused export. `DEADSET_STARTERS=latest` checks each row's
 * latest release instead of the pins; `DEADSET_STARTERS_KEEP` keeps the projects there.
 */

const MODE: Mode = process.env["DEADSET_STARTERS"] === "latest" ? "latest" : "pinned";
const KEEP = process.env["DEADSET_STARTERS_KEEP"];
const ENTRY_CODES = new Set(["DS1502", "DS1001"]);

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

interface Report {
  readonly conventions_applied: readonly { readonly name: string; readonly version: string }[];
  readonly findings: readonly {
    readonly code: string;
    readonly position: { readonly path: string };
  }[];
}

describe(`the convention rows against their starters (${MODE})`, () => {
  STARTERS.forEach((starter, index) => {
    const versions = versionsFor(starter, MODE);
    it(`${starter.row}: ${versions.generator}, ${starter.package} ${versions.framework}`, () => {
      const dir =
        KEEP === undefined
          ? mkdtempSync(join(tmpdir(), "deadset-ts-starter-"))
          : join(KEEP, `${String(index)}-${starter.row}`);
      if (KEEP === undefined) {
        onTestFinished(() => {
          rmSync(dir, { recursive: true, force: true });
        });
      }
      const project = generate(starter, dir, versions);
      writeFileSync(join(dir, "config.json"), '{ "target": { "kind": "application" } }\n');
      const err = new MemoryWriter();
      const host = { ...nodeHost(), workingDirectory: () => dir };
      const code = run(
        ["analyze", "--target=starter-project", "--report=report.json", "--config=config.json"],
        new MemoryWriter(),
        err,
        host,
      );

      expect(
        code,
        `row ${starter.row}: the starter's analysis ended with ${String(code)}: ${err.text}`,
      ).toBeLessThan(2);
      const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as Report;
      const installed = JSON.parse(
        readFileSync(join(project, "node_modules", starter.package, "package.json"), "utf8"),
      ) as { version: string };
      expect(
        report.conventions_applied.map((one) => one.name),
        `row ${starter.row} did not apply to its starter, ${starter.package} ${installed.version} installed`,
      ).toContain(starter.row);
      for (const entry of starter.entries) {
        expect(
          existsSync(join(project, entry)),
          `row ${starter.row}: the starter holds no ${entry}, a file its documentation calls an entry`,
        ).toBe(true);
        const reported = report.findings
          .filter((one) => one.position.path === entry && ENTRY_CODES.has(one.code))
          .map((one) => one.code);
        expect(reported, `row ${starter.row}: ${entry} is reported`).toEqual([]);
      }
    });
  });
});
