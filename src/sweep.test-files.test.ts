import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { run, type Writer } from "./run.ts";

const DISCARD: Writer = { write: () => undefined };

const LOAD_TIMEOUT = 60_000;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Each finding one `analyze` run over `files` reports, as `code path name`. */
function findings(files: Readonly<Record<string, string>>): string[] {
  const root = writeProject({
    "package.json": JSON.stringify({
      name: "@example/app",
      private: true,
      type: "module",
      main: "./src/main.ts",
    }),
    "deadset.json": JSON.stringify({ target: { kind: "application" } }),
    "src/main.ts": "export const main = 1;\nconsole.log(main);\n",
    ...files,
  });
  roots.push(root);
  const dir = mkdtempSync(join(tmpdir(), "deadset-ts-test-files-"));
  roots.push(dir);
  const report = join(dir, "report.json");
  run(["analyze", "--target=.", `--report=${report}`], DISCARD, DISCARD, {
    ...nodeHost(),
    workingDirectory: () => root,
  });
  const read = JSON.parse(readFileSync(report, "utf8")) as {
    findings: { code: string; position: { path: string }; symbol: { name: string } }[];
  };
  return read.findings.map((one) => `${one.code} ${one.position.path} ${one.symbol.name}`);
}

describe("the exports of a test file", () => {
  it(
    "are judged as any file's are, the runner reading none of them",
    () => {
      expect(
        findings({
          "src/a.test.ts": [
            "declare function test(name: string, run: () => void): void;",
            "export const fixtures = [1];",
            "export const nobody = 2;",
            "export function check(): void {}",
            'test("x", () => console.log(fixtures, check()));',
            "",
          ].join("\n"),
        }),
      ).toEqual(["DS1104 src/a.test.ts fixtures", "DS1001 src/a.test.ts nobody"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "stay live in a manual mock, whose exports the runner puts in place of the module's",
    () => {
      expect(
        findings({
          "src/__mocks__/clock.ts": "export function now(): number {\n  return 0;\n}\n",
        }),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});
