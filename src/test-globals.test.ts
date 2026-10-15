import { cpSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { run, type Writer } from "./run.ts";

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

interface Answer {
  readonly findings: readonly string[];
  readonly skips: readonly string[];
}

/**
 * The analysis of one fixture of `fixtures/projects/test-globals`, copied with its
 * `installed` tree as `node_modules`: `code path symbol` per finding, and each skip's path.
 */
function analyzed(name: string): Answer {
  const root = mkdtempSync(join(tmpdir(), "deadset-ts-test-globals-"));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const target = join(root, name);
  cpSync(fixture("projects", "test-globals", name), target, { recursive: true });
  renameSync(join(target, "installed"), join(target, "node_modules"));
  const host = { ...nodeHost(), workingDirectory: () => root };
  const err = new MemoryWriter();
  run(["analyze", `--target=${name}`, "--report=report.json"], new MemoryWriter(), err, host);
  const parsed = JSON.parse(host.readFile(join(root, "report.json"))) as {
    findings: { code: string; position: { path: string }; symbol: { name: string } }[];
    type_error_skips: { path: string }[];
  };
  return {
    findings: parsed.findings
      .map((one) => `${one.code} ${one.position.path} ${one.symbol.name}`)
      .sort(),
    skips: parsed.type_error_skips.map((one) => one.path).sort(),
  };
}

describe("a test runner's injected globals", () => {
  it("are declared to a configuration whose runner injects them, so its tests are judged, and a file calling one is written for the runner while a parameter of the same name is no global", () => {
    const answer = analyzed("injected");

    expect(answer.skips).toEqual([]);
    expect(answer.findings).toEqual([
      "DS1102 tests/callbacks.ts each",
      "DS1404 tests/a.test.ts unread",
    ]);
  });

  it("are no declaration where the runner injects none, so each use is a type error", () => {
    const answer = analyzed("unset");

    expect(answer.skips).toEqual(["tests/a.test.ts", "tests/helper.ts"]);
    expect(answer.findings).toEqual(["DS1701 package.json vitest"]);
  });
});
