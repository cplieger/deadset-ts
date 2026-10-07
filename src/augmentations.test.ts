import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitterInputOf } from "../__test-helpers__/emitter-input.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { findingsOf } from "./findings/emitters.ts";
import { resolve } from "./resolve.ts";

/**
 * Every finding of the fixture's production sweep, as `code path:line name`, analysed in a
 * copy holding its `installed` tree as `node_modules`, which nothing committed carries.
 */
const FINDINGS = ((): string[] => {
  const root = mkdtempSync(join(tmpdir(), "deadset-ts-global-augmentation-"));
  try {
    cpSync(fixture("projects", "global-augmentation"), root, { recursive: true });
    renameSync(join(root, "installed"), join(root, "node_modules"));
    const document = join(root, "deadset.json");
    const { config } = resolve({
      repository: readFileSync(document, "utf8"),
      repositoryLabel: document,
    });
    return findingsOf(emitterInputOf(root, config)).map(
      (finding) =>
        `${finding.code} ${finding.position.path}:${String(finding.position.line)} ${finding.symbol.name}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})();

describe("a declare global block that augments a library interface", () => {
  it("is judged by the members a use reads, from its own file or another", () => {
    expect(FINDINGS.filter((line) => line.includes(" src/pages.ts:"))).toEqual([
      "DS1003 src/pages.ts:5 global.ImportMeta.unread",
    ]);
  });

  it("is used by a test file that reads a member it declares", () => {
    expect(FINDINGS.filter((line) => line.includes(" src/sheets.test.ts:"))).toEqual([]);
  });

  it("is used through every namespace between the member a use reads and the block", () => {
    expect(FINDINGS.filter((line) => line.includes(" src/env.ts:"))).toEqual([
      "DS1003 src/env.ts:5 global.NodeJS.ProcessEnv.UNREAD",
    ]);
  });

  it("is test-only in test-support code where only a test file reads a member it declares", () => {
    expect(FINDINGS.filter((line) => line.includes(" src/support.ts:"))).toEqual([
      "DS1004 src/support.ts:1 global",
      "DS1004 src/support.ts:7 fixtureDir",
      "DS1201 src/support.ts:2 global.ImportMeta",
    ]);
  });
});

describe("a declare global block no use reaches", () => {
  it("is reported with the interface it declares", () => {
    expect(FINDINGS.filter((line) => line.includes(" src/probe.ts:"))).toEqual([
      "DS1002 src/probe.ts:1 global",
      "DS1201 src/probe.ts:2 global.Probe",
    ]);
  });
});

describe("a module augmentation of a library's interface", () => {
  it("is used through the namespace that holds the interface", () => {
    expect(FINDINGS.filter((line) => line.includes(" src/plugins.ts:"))).toEqual([]);
  });

  it("is used through the member a property access reads", () => {
    const root = writeProject({
      "deadset.json": '{ "target": { "kind": "application" } }\n',
      "package.json": '{ "name": "app", "private": true, "type": "module", "main": "./main.ts" }\n',
      "node_modules/lib/package.json": '{ "name": "lib", "types": "./index.d.ts" }\n',
      "node_modules/lib/index.d.ts":
        "export interface Plugins {}\nexport declare const plugins: Plugins;\n",
      "main.ts": [
        'import { plugins } from "lib";',
        "",
        'declare module "lib" {',
        "  interface Plugins {",
        "    search(): void;",
        "  }",
        "}",
        "",
        "plugins.search();",
        "",
      ].join("\n"),
    });
    try {
      const document = join(root, "deadset.json");
      const { config } = resolve({
        repository: readFileSync(document, "utf8"),
        repositoryLabel: document,
      });
      expect(findingsOf(emitterInputOf(root, config)).map((finding) => finding.code)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
