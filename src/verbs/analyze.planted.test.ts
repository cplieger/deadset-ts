import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { fixture, ROOT } from "../../__test-helpers__/fixtures.ts";
import { run } from "../run.ts";

vi.mock("../report-schema.ts", () => ({
  reportRefusals: () => [
    { pointer: "/findings/0", keyword: "required", reason: "planted", member: "findings" },
  ],
}));

it("is 3 with the run failure product-fault for a report its own schema refuses, and writes none", () => {
  const dir = mkdtempSync(join(tmpdir(), "deadset-ts-analyze-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  let err = "";
  const code = run(
    [
      "analyze",
      `--target=${fixture("projects", "unused-declarations")}`,
      `--report=${join(dir, "report.json")}`,
    ],
    { write: () => undefined },
    { write: (text) => (err += text) },
    { ...nodeHost(), workingDirectory: () => ROOT, analyzerVersion: () => "0.0.0" },
  );

  expect({ code, err, written: readdirSync(dir) }).toEqual({
    code: 3,
    err: "run failure: product-fault: deadset-ts built a report that breaks the report schema at /findings/0: required: planted: reinstall deadset-ts, and report the fault to its maintainers if a reinstalled deadset-ts fails the same way\n",
    written: [],
  });
}, 120_000);
