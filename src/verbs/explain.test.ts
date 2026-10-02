import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { fixture } from "../../__test-helpers__/fixtures.ts";
import { writeProject } from "../../__test-helpers__/projects.ts";
import { run, type Writer } from "../run.ts";

/** The bound on one case, each of which loads a whole target. */
const LOAD_TIMEOUT = 60_000;

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

function explain(
  target: string,
  ...args: readonly string[]
): { code: number; out: string; err: string } {
  const out = new MemoryWriter();
  const err = new MemoryWriter();
  const host = { ...nodeHost(), workingDirectory: () => tmpdir() };
  const code = run(["explain", `--target=${target}`, ...args], out, err, host);
  return { code, out: out.text, err: err.text };
}

/** A dead root and the helper that falls with it, the helper's code set to allow. */
function withheld(): string {
  const root = writeProject({
    "deadset.json":
      '{ "target": { "kind": "application" }, "severity": { "DS1002": "allow" }, "ts": { "entry_files": ["src/main.ts"] } }\n',
    "package.json": '{ "name": "@example/withheld", "private": true, "type": "module" }\n',
    "src/main.ts": 'import { live } from "./lib.ts";\n\nconsole.log(live());\n',
    "src/lib.ts":
      "export function live(): number {\n  return 1;\n}\n\nexport function deadCaller(): number {\n  return calledOnlyByDead();\n}\n\nfunction calledOnlyByDead(): number {\n  return 2;\n}\n",
    "tsconfig.json":
      '{ "compilerOptions": { "strict": true, "module": "NodeNext", "noEmit": true, "allowImportingTsExtensions": true }, "include": ["src/*.ts"] }\n',
  });
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

const CATALOG = fixture("projects", "unused-declarations");

describe("explain", () => {
  it(
    "answers why a reported symbol is reported: its class, its loaded consumers and its configurations",
    () => {
      expect(explain(CATALOG, "--why=unusedExported")).toEqual({
        code: 0,
        out: [
          "symbol: ts://@example/unused-declarations/src/catalog.ts#unusedExported",
          "declaration: function unusedExported",
          "position: src/catalog.ts:12:17",
          "configurations: tsconfig.json",
          "answer: reported",
          "  code: DS1001 unused-exported",
          "  message: exported function has no reference in the target and none from any loaded consumer",
          "  class: certain",
          "  confidence: certain",
          "  liveness relation: reference-counting",
          "  configurations: tsconfig.json",
          "  loaded consumers: none",
          "",
        ].join("\n"),
        err: "",
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "answers why a live symbol is live with the shortest path of references from a root",
    () => {
      const got = explain(CATALOG, "--why-live=used");

      expect(got.code).toBe(0);
      expect(got.out).toContain(
        [
          "answer: live",
          "  live under: reference-counting reachability",
          "  reached from: root manifest-entry src/main.ts:1:1",
          "  reference: src/main.ts:6:5\tread\tsrc/main.ts:1:1 -> src/catalog.ts:3:17",
          "",
        ].join("\n"),
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "answers why a symbol is not reported with the exemption class that held it back and its site",
    () => {
      const got = explain(fixture("projects", "decorators"), "--why-not=Widget.render");

      expect(got.code).toBe(0);
      expect(got.out).toContain(
        "answer: retained\n  held back by: 1 exemption class\n  class: decorator\tsrc/handlers.ts:16:1\tdecorated by @component\n",
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "answers why a dead symbol no finding names is not reported, naming the references it has and the component it falls with",
    () => {
      const tree = withheld();
      const got = explain(tree, "--why-not=calledOnlyByDead");
      const dir = mkdtempSync(join(tmpdir(), "deadset-ts-explain-"));
      onTestFinished(() => {
        rmSync(dir, { recursive: true, force: true });
      });
      run(
        ["analyze", `--target=${tree}`, `--report=${join(dir, "report.json")}`],
        new MemoryWriter(),
        new MemoryWriter(),
        { ...nodeHost(), workingDirectory: () => tmpdir() },
      );
      const findings = (
        JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as {
          findings: { symbol: { name: string }; component: { id: string } }[];
        }
      ).findings;

      expect(findings.find((one) => one.symbol.name === "deadCaller")?.component.id).toBe(
        "deadset-ts/c-0001",
      );

      expect(got.code).toBe(0);
      expect(got.out).toContain(
        [
          "answer: dead",
          "  live under: reference-counting",
          "  unreachable: no path of references reaches it from a root",
          "  references: 1",
          "  reference: src/lib.ts:6:10\tread\tfrom src/lib.ts:5:17",
          "  component: deadset-ts/c-0001, 2 symbols and 6 deletable lines fall with it, listed at cascade roots",
          "  component root: src/lib.ts:5:17",
          "  candidate: dead under reachability, with 1 production and 0 test references",
          "",
        ].join("\n"),
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "walks a read of a module to what the module exports",
    () => {
      const tree = writeProject({
        "deadset.json":
          '{ "target": { "kind": "application" }, "ts": { "entry_files": ["src/main.ts"] } }\n',
        "package.json": '{ "name": "@example/namespace", "private": true, "type": "module" }\n',
        "src/main.ts": 'import * as lib from "./lib.ts";\n\nconsole.log(lib);\n',
        "src/lib.ts": "export function exported(): number {\n  return 1;\n}\n",
        "src/other.ts":
          'import { exported } from "./lib.ts";\n\nexport function caller(): number {\n  return exported();\n}\n',
        "tsconfig.json":
          '{ "compilerOptions": { "strict": true, "module": "NodeNext", "noEmit": true, "allowImportingTsExtensions": true }, "include": ["src/*.ts"] }\n',
      });
      onTestFinished(() => {
        rmSync(tree, { recursive: true, force: true });
      });

      expect(explain(tree, "--why-live=exported").out).toContain(
        [
          "answer: live",
          "  live under: reference-counting reachability",
          "  reached from: root entry-file src/main.ts:1:1",
          "  reference: src/main.ts:3:13\tread\tsrc/main.ts:1:1 -> src/lib.ts:1:1",
          "  export: src/lib.ts:1:1 -> src/lib.ts:1:17",
          "",
        ].join("\n"),
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "answers from the sweep the suppressions marked, so an adjudicated symbol is live",
    () => {
      const tree = writeProject({
        "deadset.json":
          '{ "target": { "kind": "application" }, "ts": { "entry_files": ["src/main.ts"] } }\n',
        "package.json": '{ "name": "@example/adjudicated", "private": true, "type": "module" }\n',
        "src/main.ts": "console.log(1);\n",
        "src/lib.ts":
          "// deadset:ignore DS1001 -- kept for a plugin that loads it by name\nexport function kept(): number {\n  return 1;\n}\n",
        "tsconfig.json":
          '{ "compilerOptions": { "strict": true, "module": "NodeNext", "noEmit": true }, "include": ["src/*.ts"] }\n',
      });
      onTestFinished(() => {
        rmSync(tree, { recursive: true, force: true });
      });

      expect(explain(tree, "--why-not=kept").out).toContain(
        "answer: live\n  live under: reference-counting reachability\n",
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "accepts the symbol's full reference as well as the part of it after the separator",
    () => {
      const byRef = explain(
        CATALOG,
        "--why=ts://@example/unused-declarations/src/catalog.ts#unusedExported",
      );

      expect(byRef.out).toBe(explain(CATALOG, "--why=unusedExported").out);
    },
    LOAD_TIMEOUT,
  );

  it(
    "exits 2 for a symbol that matches none, naming the declarations that partially match it",
    () => {
      const got = explain(CATALOG, "--why=unusedexp");

      expect(got).toEqual({
        code: 2,
        out: "",
        err: [
          'deadset-ts: "unusedexp" names no one symbol of the target',
          "  ts://@example/unused-declarations/src/catalog.ts#unusedExported\tsrc/catalog.ts:12:17",
          "",
        ].join("\n"),
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "exits 2 for a symbol nothing partially matches, and says so",
    () => {
      expect(explain(CATALOG, "--why=zzzz").err).toBe(
        'deadset-ts: "zzzz" names no one symbol of the target\n  no symbol of the target partially matches it either\n',
      );
    },
    LOAD_TIMEOUT,
  );

  it("exits 2 for a request naming the symbol twice, before any analysis", () => {
    const got = explain(fixture("projects", "does-not-exist"), "--why=a", "--why-not=b");

    expect(got.code).toBe(2);
    expect(got.err).toContain("explain explains one symbol, and --why, --why-not each name one");
  });
});
