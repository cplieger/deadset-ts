import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { run, type Writer } from "./run.ts";

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The findings one `analyze` run over a CommonJS library publishing `src/main.cjs` reports, as
 * `<code> <ref>`, every finding at `possible` shown.
 */
function reported(main: string): readonly string[] {
  const root = writeProject({
    "deadset.json": JSON.stringify({ target: { kind: "library" } }),
    "package.json": JSON.stringify({ name: "@example/wi", private: true, main: "./src/main.cjs" }),
    "src/main.cjs": main,
  });
  roots.push(root);
  const dir = mkdtempSync(join(tmpdir(), "deadset-ts-held-names-"));
  roots.push(dir);
  const report = join(dir, "report.json");
  const err = new MemoryWriter();
  expect(
    run(
      ["analyze", "--target=.", "--min-confidence=possible", `--report=${report}`],
      new MemoryWriter(),
      err,
      { ...nodeHost(), workingDirectory: () => root },
    ),
    err.text,
  ).toBeLessThan(2);
  const read = JSON.parse(readFileSync(report, "utf8")) as {
    readonly findings: readonly {
      readonly code: string;
      readonly symbol: { readonly ref: string };
    }[];
  };
  return read.findings.map((one) => `${one.code} ${one.symbol.ref}`);
}

describe("a use the checker leaves unanswered", () => {
  it("names the declaration its name is, whichever side spells it with an escape", () => {
    for (const [label, declared, used] of [
      ["both escaped", String.raw`\u0061b`, String.raw`\u0061b`],
      ["the use escaped", "ab", String.raw`\u0061b`],
      ["the declaration escaped", String.raw`\u0061b`, "ab"],
    ] as const) {
      const main = [
        `function ${declared}() { return 1; }`,
        "function cd() { return 2; }",
        "var o = {};",
        `with (o) { module.exports.x = ${used}() + cd(); }`,
        "",
      ].join("\n");

      expect(reported(main), label).toEqual([]);
    }
  });
});
