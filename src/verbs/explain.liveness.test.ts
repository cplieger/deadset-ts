import { rmSync } from "node:fs";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { TSCONFIG, writeProject } from "../../__test-helpers__/projects.ts";
import { run, type Writer } from "../run.ts";

const LOAD_TIMEOUT = 60_000;

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

function explain(
  files: Readonly<Record<string, string>>,
  ...args: readonly string[]
): { code: number; out: string } {
  const root = writeProject(files);
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const out = new MemoryWriter();
  const code = run(["explain", ...args], out, new MemoryWriter(), {
    ...nodeHost(),
    workingDirectory: () => root,
  });
  return { code, out: out.text };
}

const APP_TSCONFIG =
  '{ "compilerOptions": { "strict": true, "target": "ESNext", "module": "NodeNext", "moduleResolution": "nodenext", "noEmit": true, "allowImportingTsExtensions": true }, "include": ["src/*.ts"] }\n';

const APPLICATION = {
  "tsconfig.json": APP_TSCONFIG,
  "package.json": '{ "name": "@example/app", "private": true, "type": "module" }\n',
  "deadset.json":
    '{ "target": { "kind": "application" }, "severity": { "DS1001": "allow", "DS1002": "allow", "DS1004": "allow" }, "ts": { "entry_files": ["src/main.ts"] } }\n',
  "src/main.ts":
    'import { far, parity } from "./chain.ts";\n\nexport function start(): number {\n  return far();\n}\n\nfunction scaled(value: number, factor: number): number {\n  return value * 2;\n}\n\nconsole.log(start(), scaled(1, 2), parity(2));\n',
  "src/chain.ts":
    "export function far(): number {\n  return middle();\n}\n\nfunction middle(): number {\n  return shared();\n}\n\nexport function shared(): number {\n  return 1;\n}\n\nexport function onlyTested(): number {\n  return 2;\n}\n\nfunction isEven(n: number): boolean {\n  return n === 0 ? true : isOdd(n - 1);\n}\n\nfunction isOdd(n: number): boolean {\n  return n === 0 ? false : isEven(n - 1);\n}\n\nexport function parity(n: number): boolean {\n  return isEven(n);\n}\n\nfunction untouched(): number {\n  return 3;\n}\n\nexport function deadOne(): number {\n  return deadTwo();\n}\n\nfunction deadTwo(): number {\n  return 4;\n}\n",
  "src/chain.test.ts":
    'import { onlyTested, shared } from "./chain.ts";\n\nconsole.log(onlyTested(), shared());\n',
  "src/orphan.ts": "export const orphaned = 1;\n",
};

const LIBRARY = {
  "tsconfig.json": TSCONFIG,
  "tsconfig.test.json": TSCONFIG,
  "package.json":
    '{ "name": "@example/lib", "private": true, "type": "module", "main": "./lib.ts" }\n',
  "deadset.json":
    '{ "target": { "kind": "library" }, "severity": { "DS1002": "allow" }, "ts": { "entry_files": ["lib.ts"] } }\n',
  "lib.ts":
    "export const version = 1;\n\nfunction deadOne(): number {\n  return deadTwo();\n}\n\nfunction deadTwo(): number {\n  return 2;\n}\n",
};

function withConsumer(files: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return {
    "target/tsconfig.json": TSCONFIG,
    "target/package.json":
      '{ "name": "@example/target", "private": true, "type": "module", "main": "./lib.ts" }\n',
    "target/deadset.json": '{ "target": { "kind": "library" } }\n',
    "consumer/tsconfig.json": TSCONFIG,
    "consumer/package.json": '{ "name": "@example/consumer", "private": true, "type": "module" }\n',
    "scope.json": '{ "target": { "path": "target" }, "consumers": [{ "path": "consumer" }] }\n',
    ...files,
  };
}

describe("explain's answer for a declaration no finding names", () => {
  it(
    "follows production references where they reach it, though a test reaches it sooner",
    () => {
      expect(explain(APPLICATION, "--target=.", "--why-live=shared").out).toContain(
        [
          "answer: live",
          "  live under: reference-counting reachability",
          "  reached from: root entry-file src/main.ts:3:17",
          "  reference: src/main.ts:4:10\tread\tsrc/main.ts:3:17 -> src/chain.ts:1:17",
          "  reference: src/chain.ts:2:10\tread\tsrc/chain.ts:1:17 -> src/chain.ts:5:10",
          "  reference: src/chain.ts:6:10\tread\tsrc/chain.ts:5:10 -> src/chain.ts:9:17",
          "",
        ].join("\n"),
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "follows a test file's references where nothing else reaches it",
    () => {
      expect(explain(APPLICATION, "--target=.", "--why-not=onlyTested").out).toContain(
        [
          "answer: dead",
          "  live under: none",
          "  reached from: root test-runner src/chain.test.ts:1:1",
          "  reference: src/chain.test.ts:3:13\tread\tsrc/chain.test.ts:1:1 -> src/chain.ts:13:17\tfrom a test file",
          "",
        ].join("\n"),
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "finds no path to a declaration nothing references, whatever cycle the live code holds",
    () => {
      expect(explain(APPLICATION, "--target=.", "--why-not=untouched").out).toContain(
        [
          "answer: dead",
          "  live under: none",
          "  unreachable: no path of references reaches it from a root or a loaded consumer",
          "  references: 0",
          "",
        ].join("\n"),
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "lists every member of its component at the full cascade",
    () => {
      expect(
        explain(APPLICATION, "--target=.", "--why-not=deadTwo", "--cascade=full").out,
      ).toContain(
        [
          "  component: deadset-ts/c-0003, 2 symbols and 6 deletable lines fall with it, listed at cascade full",
          "  component root: src/chain.ts:33:17",
          "  component member: src/chain.ts:33:17",
          "  component member: src/chain.ts:37:10",
          "",
        ].join("\n"),
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "answers a file no finding names as unjudged",
    () => {
      expect(explain(APPLICATION, "--target=.", "--why=ts://@example/app/src/main.ts#").out).toBe(
        [
          "symbol: ts://@example/app/src/main.ts#",
          "declaration: file src/main.ts",
          "position: src/main.ts:1:1",
          "configurations: tsconfig.json",
          "answer: unjudged",
          "  unjudged: neither liveness relation judges a file",
          "",
        ].join("\n"),
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "names a root's every reason once, and no path, however many configurations hold it",
    () => {
      expect(explain(LIBRARY, "--target=.", "--why=version").out).toBe(
        [
          "symbol: ts://@example/lib/lib.ts#version",
          "declaration: variable version",
          "position: lib.ts:1:14",
          "configurations: tsconfig.json tsconfig.test.json",
          "answer: live",
          "  live under: reference-counting reachability",
          "  root: entry-file\tnamed by lib.ts",
          "  root: published-api",
          "",
        ].join("\n"),
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "counts a reference two configurations make once",
    () => {
      expect(explain(LIBRARY, "--target=.", "--why-not=deadTwo").out).toContain(
        "  references: 1\n  reference: lib.ts:4:10\tread\tfrom lib.ts:3:10\n  component:",
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "takes a root's path over a loaded consumer's of the same length",
    () => {
      const got = explain(
        withConsumer({
          "target/lib.ts":
            'import { helper } from "./helper.ts";\n\nexport const value = helper();\n',
          "target/helper.ts": "export function helper(): number {\n  return 1;\n}\n",
          "consumer/main.ts": 'import { helper } from "../target/helper.js";\n\nhelper();\n',
        }),
        "--target=target",
        "--scope=scope.json",
        "--why-live=helper",
      );

      expect(got.out).toContain(
        "  reached from: root published-api lib.ts:3:14\n  reference: lib.ts:3:22\tread\tlib.ts:3:14 -> helper.ts:1:17\n",
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "starts a loaded consumer's path at its own reference where the target has one root",
    () => {
      const got = explain(
        withConsumer({
          "target/lib.ts": "const local = 1;\n\nvoid local;\n",
          "target/extra.ts":
            "export function entry(): number {\n  return helper();\n}\n\nfunction helper(): number {\n  return 1;\n}\n",
          "consumer/main.ts": 'import { entry } from "../target/extra.js";\n\nentry();\n',
        }),
        "--target=target",
        "--scope=scope.json",
        "--why-live=helper",
      );

      expect(got.out).toContain(
        [
          "  live under: reference-counting reachability",
          "  reached from: consumer @example/consumer",
          "  reference: main.ts:3:1\tread\tconsumer @example/consumer -> extra.ts:1:17",
          "  reference: extra.ts:2:10\tread\textra.ts:1:17 -> extra.ts:5:10",
          "",
        ].join("\n"),
      );
    },
    LOAD_TIMEOUT,
  );
});

describe("explain's answer for a reported declaration", () => {
  it(
    "names no liveness relation for a finding that carries none",
    () => {
      expect(
        explain(APPLICATION, "--target=.", "--why=ts://@example/app/src/orphan.ts#").out,
      ).toContain(
        [
          "answer: reported",
          "  code: DS1502 file-never-imported",
          "  message: no import reaches this file and no root names it or a declaration in it",
          "  class: certain",
          "  confidence: certain",
          "  configurations: tsconfig.json",
          "  loaded consumers: none",
          "",
        ].join("\n"),
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "names each finding about a part of the declaration at its own position",
    () => {
      expect(explain(APPLICATION, "--target=.", "--why-live=scaled").out).toMatch(
        /\n {2}reference: [^\n]+\nalso reported: DS1801 unused-parameter\tsrc\/main\.ts:7:32\tparameter factor\n$/u,
      );
    },
    LOAD_TIMEOUT,
  );
});
