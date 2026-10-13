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

/** The report one `analyze` run over `files` writes, every finding at `possible` shown. */
function analyzed(files: Readonly<Record<string, string>>): {
  findings: { code: string; symbol: { name: string }; confidence: string }[];
  unanswered_questions: unknown[];
  notes: unknown[];
} {
  const root = writeProject(files);
  roots.push(root);
  const dir = mkdtempSync(join(tmpdir(), "deadset-ts-published-reach-"));
  roots.push(dir);
  const report = join(dir, "report.json");
  run(
    ["analyze", "--target=.", "--min-confidence=possible", `--report=${report}`],
    DISCARD,
    DISCARD,
    {
      ...nodeHost(),
      workingDirectory: () => root,
    },
  );
  return JSON.parse(readFileSync(report, "utf8")) as ReturnType<typeof analyzed>;
}

/** Each finding as `code name confidence`. */
function lines(report: ReturnType<typeof analyzed>): string[] {
  return report.findings.map((one) => `${one.code} ${one.symbol.name} ${one.confidence}`);
}

describe("the types a library's published API reaches without writing them", () => {
  it("reaches the type the compiler infers for a published function's result and a published variable", () => {
    const report = analyzed({
      "package.json": JSON.stringify({
        name: "@example/lib",
        type: "module",
        exports: "./src/index.ts",
      }),
      "deadset.json": JSON.stringify({ target: { kind: "library" } }),
      "src/index.ts": [
        "class Made {",
        "  spare = 1;",
        "}",
        "class Held {",
        "  idle = 2;",
        "}",
        "export function make() {",
        "  return [new Made()];",
        "}",
        "export const held = new Held();",
        "",
      ].join("\n"),
    });

    expect(lines(report)).toEqual([
      "DS1003 Made.spare possible",
      "DS1003 Held.idle possible",
      "DS1001 make possible",
      "DS1001 held possible",
    ]);
  });

  it("reaches the types of both accessors of a published pair, whichever comes first", () => {
    const report = analyzed({
      "package.json": JSON.stringify({
        name: "@example/lib",
        type: "module",
        exports: "./src/index.ts",
      }),
      "deadset.json": JSON.stringify({ target: { kind: "library" } }),
      "src/index.ts": [
        "interface Reading {",
        "  level: number;",
        "}",
        "interface Settings {",
        "  level: number;",
        "  label: string;",
        "}",
        "export class Panel {",
        "  #level = 0;",
        "  get settings(): Reading {",
        "    return { level: this.#level };",
        "  }",
        "  set settings(next: Settings) {",
        "    this.#level = next.level;",
        "  }",
        "}",
        "",
      ].join("\n"),
    });

    expect(lines(report)).toEqual([
      "DS1301 Reading.level possible",
      "DS1003 Settings.label possible",
      "DS1001 Panel possible",
    ]);
  });

  it("reaches the exports of a module whose namespace a published value holds", () => {
    const report = analyzed({
      "package.json": JSON.stringify({
        name: "@example/lib",
        type: "module",
        exports: "./src/index.ts",
      }),
      "deadset.json": JSON.stringify({ target: { kind: "library" } }),
      "src/helpers.ts":
        "export function format(value: number): string {\n  return String(value);\n}\n",
      "src/index.ts": 'import * as helpers from "./helpers.js";\n\nexport const api = helpers;\n',
    });

    expect(lines(report)).toEqual(["DS1001 format possible", "DS1001 api possible"]);
  });
});

describe("the default a dynamic import of a module that assigns its export carries", () => {
  it("is resolved through the alias the checker synthesizes, leaving no question unanswered", () => {
    const report = analyzed({
      "package.json": JSON.stringify({
        name: "@example/app",
        type: "module",
        main: "./src/main.ts",
        dependencies: { prompts: "1.0.0" },
      }),
      "deadset.json": JSON.stringify({ target: { kind: "application" } }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          module: "ESNext",
          moduleResolution: "Bundler",
          esModuleInterop: true,
          noEmit: true,
        },
        include: ["src"],
      }),
      "node_modules/prompts/package.json": JSON.stringify({ name: "prompts", types: "index.d.ts" }),
      "node_modules/prompts/index.d.ts": [
        "declare function prompts(question: string): Promise<string>;",
        "declare namespace prompts {",
        "  const version: string;",
        "}",
        "export = prompts;",
        "",
      ].join("\n"),
      "src/main.ts":
        'const prompts = await import("prompts");\n\nawait prompts.default("name?");\n',
    });

    expect(report.unanswered_questions).toEqual([]);
    expect(lines(report)).toEqual([]);
  });
});

/** Each root `print-roots` names over `files`, as its tab-separated line below the package. */
function rootLines(files: Readonly<Record<string, string>>): string[] {
  const root = writeProject(files);
  roots.push(root);
  const lines: string[] = [];
  run(["print-roots", "--target=."], { write: (text) => lines.push(text) }, DISCARD, {
    ...nodeHost(),
    workingDirectory: () => root,
  });
  return lines
    .join("")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.replace(/^ts:\/\//u, ""));
}

describe("a manifest entry no source file is written at", () => {
  it("reads back to the configuration's root directory where the manifest's directory is the output", () => {
    const report = analyzed({
      "package.json": JSON.stringify({
        name: "@example/lib",
        type: "module",
        exports: { ".": "./index.js" },
      }),
      "deadset.json": JSON.stringify({ target: { kind: "library" } }),
      "tsconfig.json": JSON.stringify({ files: [] }),
      "src/tsconfig.json": JSON.stringify({
        compilerOptions: {
          rootDir: ".",
          outDir: "../.ts",
          strict: true,
          module: "NodeNext",
          types: [],
          allowImportingTsExtensions: true,
          noEmit: true,
        },
        include: ["./**/*.ts"],
      }),
      "src/index.ts": 'export { add } from "./add/index.ts";\n',
      "src/add/index.ts":
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    });

    expect(lines(report)).toEqual(["DS1001 add possible"]);
  });

  it("reads back by name to no rooted file of another package", () => {
    const got = rootLines({
      "package.json": JSON.stringify({
        name: "@example/app",
        private: true,
        type: "module",
        main: "./lib/index.js",
      }),
      "deadset.json": JSON.stringify({ target: { kind: "application" } }),
      "app.config.ts": 'export default { entry: "./examples/demo/index.ts" };\n',
      "examples/demo/package.json": JSON.stringify({ name: "demo", private: true }),
      "examples/demo/index.ts": "export const demo = 1;\n",
    });

    expect(got.filter((line) => line.includes("\tmanifest-entry\t"))).toEqual([]);
    expect(got).toContain("demo/index.ts#\tconfiguration-string\t./examples/demo/index.ts");
  });

  it("is noted with the key that names the file it is built from", () => {
    const report = analyzed({
      "package.json": JSON.stringify({
        name: "@example/app",
        private: true,
        type: "module",
        main: "./lib/index.js",
      }),
      "deadset.json": JSON.stringify({ target: { kind: "application" } }),
      "src/index.ts": "export const one = 1;\n",
    });

    expect(report.notes).toEqual([
      {
        kind: "unmapped-entry",
        path: ".",
        key: "ts.entry_files",
        message:
          "the manifest's main names lib/index.js, which reads back to no source file of the target: name the file it is built from in ts.entry_files",
      },
    ]);
  });

  it("is not noted where ts.entry_files or another entry of the manifest roots the file it names", () => {
    const report = analyzed({
      "package.json": JSON.stringify({
        name: "@example/app",
        private: true,
        type: "module",
        bin: { app: "./dist/bin/app.js" },
        exports: { ".": { types: "./src/index.ts", default: "./dist/src/index.js" } },
      }),
      "deadset.json": JSON.stringify({
        target: { kind: "application" },
        ts: { entry_files: ["bin/app.ts"] },
      }),
      "bin/app.ts": 'import { one } from "../src/index.ts";\n\nconsole.log(one);\n',
      "src/index.ts": "export const one = 1;\n",
    });

    expect(report.notes ?? []).toEqual([]);
  });

  it("reaches the program files a command's shim outside the program loads", () => {
    const report = analyzed({
      "package.json": JSON.stringify({
        name: "@example/app",
        private: true,
        type: "commonjs",
        bin: { app: "bin/app.js" },
      }),
      "deadset.json": JSON.stringify({ target: { kind: "application" } }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          rootDir: "src",
          outDir: "lib",
          strict: true,
          module: "commonjs",
          types: [],
        },
        include: ["src"],
      }),
      "bin/app.js": '#!/usr/bin/env node\nrequire("../lib/cli.js").main();\n',
      "src/cli.ts": "export function main(): void {\n  helper();\n}\nfunction helper(): void {}\n",
    });

    expect(lines(report)).toEqual([]);
    expect(report.notes ?? []).toEqual([]);
  });
});
