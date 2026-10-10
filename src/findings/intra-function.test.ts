import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { emitterInputOf, findingsOf } from "../../__test-helpers__/emitter-input.ts";
import { writeProject } from "../../__test-helpers__/projects.ts";
import type { CompletedFinding } from "../finding.ts";
import { resolve } from "../resolve.ts";

/** The bound on one case, each of which loads a whole target. */
const LOAD_TIMEOUT = 60_000;

/**
 * One application whose entry file runs every function below, so no function is dead and
 * each part is decided inside a declaration the run keeps. The compiler configuration
 * sets none of `noUnusedParameters`, `noUnusedLocals` and `allowUnreachableCode`.
 */
const APPLICATION = {
  "package.json": '{ "name": "@example/parts", "private": true, "type": "module" }\n',
  "src/main.ts": [
    "interface Handler {",
    "  handle(event: string, extra: number): void;",
    "}",
    "",
    "class Quiet {",
    "  handle(event: string, extra: number): void {",
    "    console.log(event);",
    "  }",
    "}",
    "",
    "function partial(read: number, unread: number): number {",
    "  return read * 2;",
    "}",
    "",
    "function onEvent(event: string, ignored: number): void {",
    "  console.log(event);",
    "}",
    "",
    "function register(listener: (event: string, count: number) => void): void {",
    '  listener("start", 1);',
    "}",
    "",
    "function todo(value: number): number {",
    '  throw new Error("not written");',
    "}",
    "",
    "function marked(_value: number, kept: number): number {",
    "  return kept;",
    "}",
    "",
    "function compute(): number {",
    '  console.log("computing");',
    "  return 1;",
    "}",
    "",
    "function counted(): number {",
    "  return 2;",
    "}",
    "",
    "function notify(): void {",
    '  console.log("notified");',
    "}",
    "",
    "function early(): number {",
    "  return 1;",
    '  console.log("never");',
    "}",
    "",
    "function hoisted(): number {",
    "  return inner();",
    "  function inner(): number {",
    "    return 3;",
    "  }",
    "}",
    "",
    "function overwritten(): number {",
    "  let value = 1;",
    "  value = 2;",
    "  return value;",
    "}",
    "",
    "function branched(flag: boolean): number {",
    "  let value = 1;",
    "  if (flag) {",
    "    value = 2;",
    "  }",
    "  return value;",
    "}",
    "",
    "function captured(): () => number {",
    "  let value = 1;",
    "  const read = (): number => value;",
    "  value = 2;",
    "  return read;",
    "}",
    "",
    "function label(kind: string): number {",
    "  switch (kind) {",
    '    case "a":',
    "      return 1;",
    '    case "b":',
    "      return 2;",
    '    case "a":',
    "      return 3;",
    "    default:",
    "      return 0;",
    "  }",
    "}",
    "",
    "const handler: Handler = new Quiet();",
    'handler.handle("event", 1);',
    "register(onEvent);",
    "console.log(partial(1, 2), todo, marked(1, 2), counted());",
    "compute();",
    "compute();",
    "notify();",
    'console.log(early(), hoisted(), overwritten(), branched(true), captured(), label("a"));',
    "",
  ].join("\n"),
};

/** One project's intra-function findings under a configuration document, in line order. */
function partsOf(
  files: Readonly<Record<string, string>>,
  document: Record<string, unknown>,
): { code: string; name: string; line: number; finding: CompletedFinding }[] {
  const root = writeProject(files);
  roots.push(root);
  const { config } = resolve({
    repository: JSON.stringify(document),
    repositoryLabel: "deadset.json",
  });
  return findingsOf(emitterInputOf(root, config))
    .filter((finding) => finding.code.startsWith("DS18"))
    .sort((a, b) => a.position.line - b.position.line)
    .map((finding) => ({
      code: finding.code,
      name: finding.symbol.name,
      line: finding.position.line,
      finding,
    }));
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

const ENTRY = { target: { kind: "application" }, ts: { entry_files: ["src/main.ts"] } };

describe("the intra-function family", () => {
  it(
    "reports one part per kind at its own position and leaves every exempt part alone",
    () => {
      expect(
        partsOf(APPLICATION, ENTRY).map(({ code, name, line }) => ({ code, name, line })),
      ).toEqual([
        { code: "DS1801", name: "unread", line: 11 },
        { code: "DS1801", name: "ignored", line: 15 },
        { code: "DS1801", name: "_value", line: 27 },
        { code: "DS1803", name: "result", line: 31 },
        { code: "DS1805", name: "statement", line: 46 },
        { code: "DS1807", name: "value", line: 57 },
        { code: "DS1809", name: '"a"', line: 83 },
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "names the declaration that holds each part, and the rules that report the kind too",
    () => {
      const found = partsOf(APPLICATION, ENTRY).map(({ finding }) => ({
        code: finding.code,
        kind: finding.symbol.kind,
        ref: finding.symbol.ref,
        message: finding.message,
        overlap: finding.details.overlap,
        relation: finding.livenessRelation,
        writes: finding.details.writePositions?.map((at) => at.line),
      }));

      expect(found).toEqual([
        {
          code: "DS1801",
          kind: "parameter",
          ref: "ts://@example/parts/src/main.ts#partial",
          message:
            "parameter unread is never read in the body; also reported by tsc --noUnusedParameters and @typescript-eslint/no-unused-vars",
          overlap: ["tsc --noUnusedParameters", "@typescript-eslint/no-unused-vars"],
          relation: undefined,
          writes: undefined,
        },
        {
          code: "DS1801",
          kind: "parameter",
          ref: "ts://@example/parts/src/main.ts#onEvent",
          message:
            "parameter ignored is never read in the body; also reported by tsc --noUnusedParameters and @typescript-eslint/no-unused-vars",
          overlap: ["tsc --noUnusedParameters", "@typescript-eslint/no-unused-vars"],
          relation: undefined,
          writes: undefined,
        },
        {
          code: "DS1801",
          kind: "parameter",
          ref: "ts://@example/parts/src/main.ts#marked",
          message:
            "parameter _value is never read in the body; also reported by tsc --noUnusedParameters and @typescript-eslint/no-unused-vars",
          overlap: ["tsc --noUnusedParameters", "@typescript-eslint/no-unused-vars"],
          relation: undefined,
          writes: undefined,
        },
        {
          code: "DS1803",
          kind: "result",
          ref: "ts://@example/parts/src/main.ts#compute",
          message: "result is discarded at every call site; no other rule is known to report it",
          overlap: ["none known"],
          relation: undefined,
          writes: undefined,
        },
        {
          code: "DS1805",
          kind: "statement",
          ref: "ts://@example/parts/src/main.ts#early",
          message:
            "statement is unreachable; also reported by tsc allowUnreachableCode and eslint no-unreachable",
          overlap: ["tsc allowUnreachableCode", "eslint no-unreachable"],
          relation: undefined,
          writes: undefined,
        },
        {
          code: "DS1807",
          kind: "store",
          ref: "ts://@example/parts/src/main.ts#overwritten",
          message:
            "value written to value is never read; also reported by eslint no-useless-assignment and @typescript-eslint/no-unused-vars",
          overlap: ["eslint no-useless-assignment", "@typescript-eslint/no-unused-vars"],
          relation: undefined,
          writes: [57],
        },
        {
          code: "DS1809",
          kind: "case",
          ref: "ts://@example/parts/src/main.ts#label",
          message:
            'case "a" is covered by an earlier case of the same switch; no other rule is known to report it',
          overlap: ["none known"],
          relation: undefined,
          writes: undefined,
        },
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "reports a parameter of a published function whatever the run knows of its consumers, and no result of one",
    () => {
      const found = partsOf(
        {
          "package.json":
            '{ "name": "@example/library", "private": true, "type": "module", "exports": "./src/index.ts" }\n',
          "src/index.ts": [
            "export function format(value: number, unit: string): string {",
            "  return String(value);",
            "}",
            "",
            "export function measure(): number {",
            "  return 1;",
            "}",
            "",
            "export function run(): void {",
            "  measure();",
            "}",
            "",
          ].join("\n"),
        },
        { target: { kind: "library" } },
      );

      expect(found.map(({ code, name, line }) => ({ code, name, line }))).toEqual([
        { code: "DS1801", name: "unit", line: 1 },
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "reports a part of a function nothing calls",
    () => {
      const files = {
        "package.json": '{ "name": "@example/dead", "private": true, "type": "module" }\n',
        "src/main.ts": [
          "function uncalled(chunk: number): number {",
          "  let held = 1;",
          "  held = 2;",
          "  return held;",
          '  console.log("never");',
          "}",
          "",
          'console.log("entry");',
          "",
        ].join("\n"),
      };

      expect(partsOf(files, ENTRY).map(({ code, line }) => ({ code, line }))).toEqual([
        { code: "DS1801", line: 1 },
        { code: "DS1807", line: 2 },
        { code: "DS1805", line: 5 },
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "reports no parameter of a method whose class an interface extends",
    () => {
      const files = {
        "package.json": '{ "name": "@example/widened", "private": true, "type": "module" }\n',
        "src/main.ts": [
          "class Base {",
          "  handle(event: string, extra: number): void {",
          "    console.log(event);",
          "  }",
          "}",
          "",
          "interface Wider extends Base {",
          "  more(): void;",
          "}",
          "",
          "const wide: Wider = { handle: (event) => console.log(event), more: () => undefined };",
          'new Base().handle("event", 1);',
          'wide.handle("event", 1);',
          "wide.more();",
          "",
        ].join("\n"),
      };

      expect(partsOf(files, ENTRY)).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "withholds the one kind a severity key turns off and leaves the other four reported",
    () => {
      expect(
        partsOf(APPLICATION, { ...ENTRY, severity: { DS1805: "allow" } }).map(({ code }) => code),
      ).toEqual(["DS1801", "DS1801", "DS1801", "DS1803", "DS1807", "DS1809"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "withholds the whole family under the range prefix",
    () => {
      expect(partsOf(APPLICATION, { ...ENTRY, severity: { DS18: "allow" } })).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});
