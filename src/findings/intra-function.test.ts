import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { emitterInputOf, findingsOf } from "../../__test-helpers__/emitter-input.ts";
import { writeProject } from "../../__test-helpers__/projects.ts";
import type { CompletedFinding } from "../finding.ts";
import { resolve } from "../resolve.ts";
import type { Mode } from "../sweep.ts";
import type { Boundary } from "./boundary.ts";

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

function partsOf(
  files: Readonly<Record<string, string>>,
  document: Record<string, unknown>,
  consumers?: Boundary["consumers"],
  mode: Mode = { production: true },
): { code: string; name: string; line: number; finding: CompletedFinding }[] {
  const root = writeProject(files);
  roots.push(root);
  const { config } = resolve({
    repository: JSON.stringify(document),
    repositoryLabel: "deadset.json",
  });
  const input = emitterInputOf(root, config, { mode });
  return findingsOf(
    consumers === undefined ? input : { ...input, boundary: { ...input.boundary, consumers } },
  )
    .filter((finding) => finding.code.startsWith("DS14"))
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
        { code: "DS1401", name: "unread", line: 11 },
        { code: "DS1401", name: "ignored", line: 15 },
        { code: "DS1403", name: "result", line: 31 },
        { code: "DS1405", name: "statement", line: 46 },
        { code: "DS1404", name: "value", line: 57 },
        { code: "DS1406", name: '"a"', line: 83 },
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
          code: "DS1401",
          kind: "parameter",
          ref: "ts://@example/parts/src/main.ts#partial(unread)",
          message:
            "parameter unread is never read in the body; also reported by tsc --noUnusedParameters and @typescript-eslint/no-unused-vars",
          overlap: ["tsc --noUnusedParameters", "@typescript-eslint/no-unused-vars"],
          relation: undefined,
          writes: undefined,
        },
        {
          code: "DS1401",
          kind: "parameter",
          ref: "ts://@example/parts/src/main.ts#onEvent(ignored)",
          message:
            "parameter ignored is never read in the body; also reported by tsc --noUnusedParameters and @typescript-eslint/no-unused-vars",
          overlap: ["tsc --noUnusedParameters", "@typescript-eslint/no-unused-vars"],
          relation: undefined,
          writes: undefined,
        },
        {
          code: "DS1403",
          kind: "result",
          ref: "ts://@example/parts/src/main.ts#compute",
          message: "result is discarded at every call site; no other rule is known to report it",
          overlap: ["none known"],
          relation: undefined,
          writes: undefined,
        },
        {
          code: "DS1405",
          kind: "statement",
          ref: "ts://@example/parts/src/main.ts#early",
          message:
            "statement is unreachable; also reported by tsc allowUnreachableCode and eslint no-unreachable",
          overlap: ["tsc allowUnreachableCode", "eslint no-unreachable"],
          relation: undefined,
          writes: undefined,
        },
        {
          code: "DS1404",
          kind: "store",
          ref: "ts://@example/parts/src/main.ts#overwritten",
          message:
            "value written to value is never read; also reported by eslint no-useless-assignment and @typescript-eslint/no-unused-vars",
          overlap: ["eslint no-useless-assignment", "@typescript-eslint/no-unused-vars"],
          relation: undefined,
          writes: [57],
        },
        {
          code: "DS1406",
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
    "gives each parameter its own reference, so two on one line are two subjects, and two functions one holder holds share one for a name both declare",
    () => {
      const found = partsOf(
        {
          "package.json": '{ "name": "@example/pair", "private": true, "type": "module" }\n',
          "src/main.ts": [
            "function pair(kept: number, first: number, second: number): number {",
            "  return kept;",
            "}",
            "console.log(pair(1, 2, 3), [1].map((value, index) => 0));",
            "console.log([2].map((value, index) => 1));",
            "",
          ].join("\n"),
        },
        ENTRY,
      ).map(({ finding }) => `${String(finding.position.line)} ${finding.symbol.ref}`);

      expect(found).toEqual([
        "1 ts://@example/pair/src/main.ts#pair(first)",
        "1 ts://@example/pair/src/main.ts#pair(second)",
        "4 ts://@example/pair/src/main.ts#(value)",
        "4 ts://@example/pair/src/main.ts#(index)",
        "5 ts://@example/pair/src/main.ts#(value)",
        "5 ts://@example/pair/src/main.ts#(index)",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "names the compiler's rule for a parameter only in a file the compiler checks",
    () => {
      const found = partsOf(
        {
          "package.json": '{ "name": "@example/js-parts", "private": true, "type": "module" }\n',
          "tsconfig.json": '{ "compilerOptions": { "allowJs": true, "noEmit": true } }\n',
          "src/main.ts": [
            'import { plain } from "./plain.js";',
            'import { checked } from "./checked.js";',
            "console.log(plain(1, 2), checked(1, 2));",
            "",
          ].join("\n"),
          "src/plain.js": "export function plain(read, unread) {\n  return read;\n}\n",
          "src/checked.js":
            "// @ts-check\n/** @param {number} read @param {number} unread */\nexport function checked(read, unread) {\n  return read;\n}\n",
        },
        ENTRY,
      ).map(({ finding }) => `${finding.position.path}: ${finding.message}`);

      expect(found.sort()).toEqual([
        "src/checked.js: parameter unread is never read in the body; also reported by tsc --noUnusedParameters and @typescript-eslint/no-unused-vars",
        "src/plain.js: parameter unread is never read in the body; also reported by @typescript-eslint/no-unused-vars",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "reads a pragma only where the compiler does, from a line comment that starts with it",
    () => {
      const body = "export function f(read: number, unread: number): number {\n  return read;\n}\n";
      const found = partsOf(
        {
          "package.json": '{ "name": "@example/pragmas", "private": true, "type": "module" }\n',
          "tsconfig.json": '{ "compilerOptions": { "allowJs": true, "noEmit": true } }\n',
          "src/main.ts": [
            'import { f as block } from "./block.js";',
            'import { f as prose } from "./prose.js";',
            'import { f as upper } from "./upper.js";',
            'import { checked } from "./checked.js";',
            "console.log(block(1, 2), prose(1, 2), upper(1, 2), checked(1, 2));",
            "",
          ].join("\n"),
          "src/block.ts": `/* @ts-nocheck */\n${body}`,
          "src/prose.ts": `// see the @ts-nocheck rule\n${body}`,
          "src/upper.ts": `// @TS-NOCHECK\n${body}`,
          "src/checked.js":
            "/* @ts-check */\nexport function checked(read, unread) {\n  return read;\n}\n",
        },
        ENTRY,
      ).map(({ finding }) => `${finding.position.path}: ${finding.message}`);

      expect(found.sort()).toEqual([
        "src/block.ts: parameter unread is never read in the body; also reported by tsc --noUnusedParameters and @typescript-eslint/no-unused-vars",
        "src/checked.js: parameter unread is never read in the body; also reported by @typescript-eslint/no-unused-vars",
        "src/prose.ts: parameter unread is never read in the body; also reported by tsc --noUnusedParameters and @typescript-eslint/no-unused-vars",
        "src/upper.ts: parameter unread is never read in the body; also reported by @typescript-eslint/no-unused-vars",
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
        { code: "DS1401", name: "unit", line: 1 },
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
        { code: "DS1401", line: 1 },
        { code: "DS1404", line: 2 },
        { code: "DS1405", line: 5 },
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
        partsOf(APPLICATION, { ...ENTRY, severity: { DS1405: "allow" } }).map(({ code }) => code),
      ).toEqual(["DS1401", "DS1401", "DS1403", "DS1404", "DS1406"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "withholds the whole family under the range prefix",
    () => {
      expect(partsOf(APPLICATION, { ...ENTRY, severity: { DS14: "allow" } })).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a constructor's parameters", () => {
  it(
    "report an unread plain parameter as a part of the class, unless a value use, a decorator or a stub fixes the constructor, an implements clause being none",
    () => {
      const found = partsOf(
        {
          "package.json": '{ "name": "@example/parts", "private": true, "type": "module" }\n',
          "src/main.ts": [
            "function tag(value: unknown, context: ClassDecoratorContext): void {",
            "  console.log(value, context.name);",
            "}",
            "",
            "class Typed {",
            "  constructor(used: number, unused: string) {",
            "    console.log(used);",
            "  }",
            "}",
            "",
            "class Base {",
            "  constructor(spare: number) {",
            '    console.log("base");',
            "  }",
            "}",
            "",
            "class Derived extends Base {",
            "  constructor() {",
            "    super(1);",
            "  }",
            "}",
            "",
            "class Valued {",
            "  constructor(spare: number) {",
            '    console.log("valued");',
            "  }",
            "}",
            "",
            "@tag",
            "class Decorated {",
            "  constructor(spare: number) {",
            '    console.log("decorated");',
            "  }",
            "}",
            "",
            "class Stub {",
            "  constructor(spare: number) {}",
            "}",
            "",
            "class Held {",
            "  constructor(",
            "    private readonly kept: number,",
            "    spare: number,",
            "  ) {",
            "    console.log(this.kept);",
            "  }",
            "}",
            "",
            'const typed: Typed = new Typed(1, "a");',
            "const make = Valued;",
            "console.log(typed, new Derived(), new make(1), new Decorated(1), new Stub(1));",
            "console.log(new Held(1, 2));",
            "",
            "class Shape {",
            "  constructor(spare: number) {",
            '    console.log("shape");',
            "  }",
            "}",
            "",
            "class Square implements Shape {}",
            "console.log(new Shape(1), new Square());",
            "",
          ].join("\n"),
        },
        ENTRY,
      );

      expect(
        found.map(({ code, name, line, finding }) => ({
          code,
          name,
          line,
          kind: finding.symbol.kind,
          ref: finding.symbol.ref,
        })),
      ).toEqual([
        {
          code: "DS1401",
          name: "unused",
          line: 6,
          kind: "parameter",
          ref: "ts://@example/parts/src/main.ts#Typed(unused)",
        },
        {
          code: "DS1401",
          name: "spare",
          line: 12,
          kind: "parameter",
          ref: "ts://@example/parts/src/main.ts#Base(spare)",
        },
        {
          code: "DS1401",
          name: "spare",
          line: 43,
          kind: "parameter",
          ref: "ts://@example/parts/src/main.ts#Held(spare)",
        },
        {
          code: "DS1401",
          name: "spare",
          line: 55,
          kind: "parameter",
          ref: "ts://@example/parts/src/main.ts#Shape(spare)",
        },
      ]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a result every call site awaits as a statement", () => {
  it(
    "is used where it is a promise, which the caller sequences on, and discarded where it is not",
    () => {
      expect(
        partsOf(
          {
            "package.json": '{ "name": "@example/parts", "private": true, "type": "module" }\n',
            "src/main.ts": [
              "function work(): Promise<number> {",
              "  return Promise.resolve(1);",
              "}",
              "",
              "function step(): Promise<number> {",
              "  return work();",
              "}",
              "",
              "function count(): number {",
              "  return 2;",
              "}",
              "",
              "function fire(): Promise<number> {",
              "  return work();",
              "}",
              "",
              "export async function run(): Promise<void> {",
              "  await step();",
              "  await count();",
              "  fire();",
              "}",
              "",
            ].join("\n"),
          },
          ENTRY,
        ).map(({ code, line }) => `${code} ${String(line)}`),
      ).toEqual(["DS1403 9", "DS1403 13"]);
    },
    LOAD_TIMEOUT,
  );
});

function placed(found: readonly { finding: CompletedFinding }[]): string[] {
  return found.map(
    ({ finding }) =>
      `${finding.code} ${finding.symbol.name} ${finding.position.path}:${String(finding.position.line)}`,
  );
}

describe("a parameter of a function expression a free function holds", () => {
  it(
    "is deleted where no read parameter follows it, since a caller of the value may pass it, and renamed before a read one",
    () => {
      expect(
        placed(
          partsOf(
            {
              "package.json": '{ "name": "@example/values", "private": true, "type": "module" }\n',
              "src/main.ts": [
                "function run(values: number[]): number[] {",
                "  return values.map((unused, index) => index).map((value, position) => value);",
                "}",
                "",
                "console.log(run([1]));",
                "",
              ].join("\n"),
            },
            ENTRY,
          ),
        ),
      ).toEqual(["DS1401 unused src/main.ts:2", "DS1401 position src/main.ts:2"]);
    },
    LOAD_TIMEOUT,
  );
});

describe("an unreachable statement written over several lines", () => {
  it(
    "is one part, as long as the lines it spans",
    () => {
      const found = partsOf(
        {
          "package.json": '{ "name": "@example/spans", "private": true, "type": "module" }\n',
          "src/main.ts": [
            "function early(): number {",
            "  return 1;",
            "  console.log(",
            '    "never",',
            "  );",
            "}",
            "",
            "console.log(early());",
            "",
          ].join("\n"),
        },
        ENTRY,
      );

      expect(
        found.map(({ finding }) => [finding.code, finding.position.line, finding.symbol.sizeLines]),
      ).toEqual([["DS1405", 3, 3]]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a part of test code", () => {
  it(
    "is reported where the run that counts test references reaches its declaration and that is no test of dead code",
    () => {
      expect(
        placed(
          partsOf(
            {
              "package.json": '{ "name": "@example/tested", "private": true, "type": "module" }\n',
              "node_modules/vitest/package.json":
                '{ "name": "vitest", "version": "1.0.0", "types": "./index.d.ts" }\n',
              "node_modules/vitest/index.d.ts": "export {};\n",
              "src/main.ts": 'import { kept } from "./lib.js";\n\nconsole.log(kept());\n',
              "src/lib.ts": [
                "export function kept(): number {",
                "  return 1;",
                "}",
                "",
                "export function retired(value: number): number {",
                "  return value;",
                "}",
                "",
              ].join("\n"),
              "src/fakes/fake.ts": [
                'import "vitest";',
                "export function fake(value: number, ignored: number): number {",
                "  return value;",
                "}",
                "",
                "export function unreached(gone: number): number {",
                "  return 1;",
                "}",
                "",
              ].join("\n"),
              "src/main.test.ts": [
                'import { fake } from "./fakes/fake.js";',
                'import { kept, retired } from "./lib.js";',
                "",
                "function helper(value: number, unused: number): number {",
                "  return value;",
                "}",
                "",
                "function orphan(lost: number): number {",
                "  return 1;",
                "}",
                "",
                "export function checksRetired(skipped: number): void {",
                "  console.log(retired(1));",
                "}",
                "",
                "export function checksKept(dropped: number): void {",
                "  console.log(kept());",
                "}",
                "",
                "console.log(helper(1, 2), fake(1, 2));",
                "",
              ].join("\n"),
            },
            ENTRY,
          ),
        ),
      ).toEqual([
        "DS1401 ignored src/fakes/fake.ts:2",
        "DS1401 unused src/main.test.ts:4",
        "DS1401 dropped src/main.test.ts:16",
      ]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a part of test code", () => {
  it(
    "is reported inside a declaration the test file reaches as it loads, and not inside one nothing reaches",
    () => {
      expect(
        placed(
          partsOf(
            {
              "package.json": '{ "name": "@example/suites", "private": true, "type": "module" }\n',
              "src/main.ts": "console.log(1);\n",
              "src/main.test.ts": [
                "function register(target: unknown, context: ClassDecoratorContext): void {",
                "  console.log(target, context.name);",
                "}",
                "",
                "@register",
                "class Suite {",
                "  static check(value: number, unused: number): number {",
                "    return value;",
                "  }",
                "}",
                "",
                "function helper(value: number, ignored: number): number {",
                "  return Suite.check(value, 1);",
                "}",
                "",
              ].join("\n"),
            },
            ENTRY,
          ),
        ),
      ).toEqual(["DS1401 unused src/main.test.ts:7"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is reported inside a declaration only an exemption record holds, in a run that counts test references",
    () => {
      expect(
        placed(
          partsOf(
            {
              "package.json": '{ "name": "@example/suites", "private": true, "type": "module" }\n',
              "src/main.ts": "console.log(1);\n",
              "src/main.test.ts": [
                "interface Port {",
                "  send(value: number): number;",
                "}",
                "",
                "class Fake implements Port {",
                "  send(value: number): number {",
                "    let kept = value;",
                "    kept = 2;",
                "    return value;",
                "  }",
                "}",
                "",
                "const port: Port = new Fake();",
                "console.log(port.send(1));",
                "",
              ].join("\n"),
            },
            ENTRY,
            undefined,
            { production: false },
          ),
        ),
      ).toEqual(["DS1404 kept src/main.test.ts:7", "DS1404 kept src/main.test.ts:8"]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a result every call discards", () => {
  const LIBRARY = {
    "package.json": '{ "name": "@example/results", "private": true, "type": "module" }\n',
    "src/lib.ts": [
      "export function measure(): number {",
      "  return 1;",
      "}",
      "",
      "export class Meter {",
      "  read(): number {",
      "    return 2;",
      "  }",
      "}",
      "",
      "function helper(): number {",
      "  return 3;",
      "}",
      "",
      "function pending(): number {",
      '  throw new Error("not written");',
      "}",
      "",
      "export function run(): void {",
      "  helper();",
      "  pending();",
      "}",
      "",
    ].join("\n"),
    "src/main.ts": [
      'import { Meter, measure, run } from "./lib.js";',
      "",
      "measure();",
      "new Meter().read();",
      "run();",
      "",
    ].join("\n"),
  };
  const COMPLETE = { ...ENTRY, consumers: { complete: true } };

  it(
    "is reported only of a declaration no module exports, a member of an exported class included, while the consumer set is open",
    () => {
      expect(placed(partsOf(LIBRARY, ENTRY))).toEqual(["DS1403 result src/lib.ts:11"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is reported of an exported declaration too once the consumer set is declared complete and every declared consumer loaded",
    () => {
      const reported = [
        "DS1403 result src/lib.ts:1",
        "DS1403 result src/lib.ts:6",
        "DS1403 result src/lib.ts:11",
      ];

      expect(placed(partsOf(LIBRARY, COMPLETE))).toEqual(reported);
      expect(
        placed(partsOf(LIBRARY, COMPLETE, { declared: ["@example/c"], loaded: ["@example/c"] })),
      ).toEqual(reported);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is not reported of an exported declaration while a declared consumer did not load, the consumer set declared complete",
    () => {
      expect(
        placed(
          partsOf(LIBRARY, COMPLETE, {
            declared: ["@example/c", "@example/d"],
            loaded: ["@example/c"],
          }),
        ),
      ).toEqual(["DS1403 result src/lib.ts:11"]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a name spelled without being a reference", () => {
  it(
    "reads no parameter or local, while a function's own arguments object reads every parameter",
    () => {
      expect(
        partsOf(
          {
            "package.json": '{ "name": "@example/parts", "private": true, "type": "module" }\n',
            "src/main.ts": [
              "function counted(first: number): number {",
              "  return arguments.length;",
              "}",
              "",
              "function inherited(first: number): () => number {",
              "  return () => arguments.length;",
              "}",
              "",
              "function nested(first: number): () => number {",
              "  return function (): number {",
              "    return arguments.length;",
              "  };",
              "}",
              "",
              "function typed(first: number, call: { arguments: number[] }): number[] {",
              "  return call.arguments;",
              "}",
              "",
              "function built(first: number): { arguments: number } {",
              "  return { arguments: 1 };",
              "}",
              "",
              "function membered(first: number): unknown {",
              "  return class {",
              "    arguments = 1;",
              "  };",
              "}",
              "",
              "function labelled(value: number, unused: number): number {",
              "  unused: for (;;) {",
              "    break unused;",
              "  }",
              "  return value;",
              "}",
              "",
              "function relabelled(): number {",
              "  let kept = 1;",
              "  kept: for (;;) {",
              "    break kept;",
              "  }",
              "  kept = 2;",
              "  return kept;",
              "}",
              "",
              "function declaring(first: number): number {",
              "  type arguments = number;",
              "  const value = 1;",
              "  return value;",
              "}",
              "",
              "function classed(first: number): number {",
              "  class arguments {}",
              "  return 1;",
              "}",
              "",
              "console.log(counted(1), inherited(1), nested(1), typed(1, { arguments: [] }));",
              "console.log(built(1), membered(1), labelled(1, 2), relabelled());",
              "console.log(declaring(1), classed(1));",
              "",
            ].join("\n"),
          },
          ENTRY,
        ).map(({ code, name, line }) => `${code} ${name} ${String(line)}`),
      ).toEqual([
        "DS1401 first 9",
        "DS1401 first 15",
        "DS1401 first 19",
        "DS1401 first 23",
        "DS1401 unused 29",
        "DS1404 kept 37",
        "DS1401 first 45",
        "DS1401 first 51",
      ]);
    },
    LOAD_TIMEOUT,
  );
});
