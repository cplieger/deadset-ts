import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { run, type Writer } from "./run.ts";

const DISCARD: Writer = { write: () => undefined };

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A compiler configuration holding the files below its directory's `src`. */
const SOURCES = `${JSON.stringify({
  compilerOptions: { strict: true, module: "NodeNext", noEmit: true },
  include: ["src"],
})}\n`;

/** A test file that writes a local nothing reads, so its dead store names its configuration. */
const TEST = 'export function testIt(): void {\n  const unread = 1;\n  console.log("x");\n}\n';

/**
 * The configurations each dead store of an `analyze` run over `files` holds in, as
 * `path:line [configurations]`, under the repository document given.
 */
function storesOf(files: Readonly<Record<string, string>>, document: object): string[] {
  const root = writeProject({ ...files, "deadset.json": `${JSON.stringify(document)}\n` });
  roots.push(root);
  const dir = mkdtempSync(join(tmpdir(), "deadset-ts-test-joins-"));
  roots.push(dir);
  const report = join(dir, "report.json");
  run(["analyze", "--target=.", `--report=${report}`], DISCARD, DISCARD, {
    ...nodeHost(),
    workingDirectory: () => root,
  });
  const { findings } = JSON.parse(readFileSync(report, "utf8")) as {
    findings: {
      code: string;
      position: { path: string; line: number };
      configurations: string[];
    }[];
  };
  return findings
    .filter((one) => one.code === "DS1807")
    .map(
      (one) =>
        `${one.position.path}:${String(one.position.line)} [${one.configurations.join(",")}]`,
    );
}

describe("a test file no derived configuration's file list holds", () => {
  it("joins the nearest configuration at or above it, tsconfig.json first in one directory", () => {
    expect(
      storesOf(
        {
          "package.json": '{ "name": "@example/app", "type": "module", "main": "./src/main.ts" }\n',
          "tsconfig.json": SOURCES,
          "tsconfig.build.json": SOURCES,
          "src/main.ts": "console.log(1);\n",
          "test/main.test.ts": TEST,
          "web/tsconfig.json": SOURCES,
          "web/src/page.ts": "console.log(2);\n",
          "web/test/page.test.ts": TEST,
        },
        { target: { kind: "application" } },
      ),
    ).toEqual([
      "test/main.test.ts:2 [tsconfig.json]",
      "web/test/page.test.ts:2 [web/tsconfig.json]",
    ]);
  });

  it("joins no configuration across a package.json below the configuration's directory", () => {
    expect(
      storesOf(
        {
          "package.json": '{ "name": "@example/app", "type": "module", "main": "./src/main.ts" }\n',
          "tsconfig.json": SOURCES,
          "src/main.ts": "console.log(1);\n",
          "test/main.test.ts": TEST,
          "fixtures/named/package.json": '{ "name": "named-fixture" }\n',
          "fixtures/named/src/sum.test.ts": TEST,
          "fixtures/typed/package.json": '{ "type": "commonjs" }\n',
          "fixtures/typed/sum.test.ts": TEST,
        },
        { target: { kind: "application" } },
      ),
    ).toEqual(["test/main.test.ts:2 [tsconfig.json]"]);
  });

  it("joins no configuration of a matrix the configuration document declares", () => {
    expect(
      storesOf(
        {
          "package.json": '{ "name": "@example/app", "type": "module", "main": "./src/main.ts" }\n',
          "tsconfig.json": SOURCES,
          "src/main.ts": "console.log(1);\n",
          "test/main.test.ts": TEST,
        },
        {
          target: { kind: "application" },
          analysis: { configurations: [{ id: "app", project: "tsconfig.json" }] },
        },
      ),
    ).toEqual([]);
  });
});
