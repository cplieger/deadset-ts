import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { TSCONFIG } from "../../__test-helpers__/projects.ts";
import { FAILURE_CLASSES, FAILURE_PREFIXES } from "../contract/contract.generated.ts";
import type { Host } from "../host.ts";
import { run, type Writer } from "../run.ts";

/** The bound on one case, each of which opens the compiler over a written tree. */
const LOAD_TIMEOUT = 60_000;

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

/** A tree written below a fresh directory, removed after the case. */
function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "deadset-ts-run-failure-"));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** One invocation run from `root`: its exit code and its error stream's lines. */
function invoke(
  root: string,
  args: readonly string[],
): { readonly code: number; readonly lines: readonly string[] } {
  const host: Host = { ...nodeHost(), workingDirectory: () => root };
  const out = new MemoryWriter();
  const err = new MemoryWriter();
  const code = run(args, out, err, host);
  return { code, lines: err.text.split("\n").filter((line) => line !== "") };
}

/** A configuration document declaring an application and the matrix `projects` names. */
function declared(projects: readonly (readonly [string, string])[]): string {
  return `${JSON.stringify({
    target: { kind: "application" },
    analysis: { configurations: projects.map(([id, project]) => ({ id, project })) },
  })}\n`;
}

/** A module re-exporting from a file nothing generated. */
function ungenerated(name: string): string {
  return `export { made } from "./${name}.js";\n`;
}

/** A configuration whose options do not parse. */
const UNPARSED = '{ "compilerOptions": { "noSuchOption": true }, "include": ["*.ts"] }\n';

/** The classes the class lines of the error stream name, of either group, in the order printed. */
function classesOf(lines: readonly string[]): readonly string[] {
  return lines.flatMap((line) => {
    const prefix = Object.values(FAILURE_PREFIXES).find((one) => line.startsWith(one));
    if (prefix === undefined) {
      return [];
    }
    const named = line.slice(prefix.length).split(":", 1)[0] ?? "";
    return Object.hasOwn(FAILURE_CLASSES, named) ? [named] : [];
  });
}

describe("the failure lines of a run that cannot be analyzed", () => {
  it(
    "print one class line for the first setup failure, the further ones in configuration order without a prefix, and leave out the load errors beside them",
    () => {
      const root = tree({
        "deadset.json": declared([
          ["a", "a/tsconfig.json"],
          ["b", "b/tsconfig.json"],
          ["c", "c/tsconfig.json"],
        ]),
        "a/tsconfig.json": TSCONFIG,
        "a/a.ts": `${ungenerated("one")}${ungenerated("two")}`,
        "b/tsconfig.json": UNPARSED,
        "b/b.ts": "export const b = 1;\n",
        "c/tsconfig.json": TSCONFIG,
        "c/c.ts": ungenerated("three"),
      });

      const got = invoke(root, ["print-projects", "--target=."]);

      const fix =
        "which names no file of the target: run the generator or the build that writes it";
      expect(got.code).toBe(3);
      expect(got.lines).toEqual([
        `setup failure: missing-module: a/a.ts:1: a/a.ts imports "./one.js", ${fix}`,
        `missing-module: a/a.ts:2: a/a.ts imports "./two.js", ${fix}`,
        `missing-module: c/c.ts:1: c/c.ts imports "./three.js", ${fix}`,
      ]);
    },
    LOAD_TIMEOUT,
  );
});

describe("every run that ends with the failure code", () => {
  it.each<[string, Readonly<Record<string, string>>, readonly string[], string]>([
    [
      "a target holding sources and a manifest but no compiler configuration",
      {
        "package.json": '{ "name": "@example/none" }\n',
        "src/a.ts": "export const a = 1;\n",
        "deadset.json": '{ "target": { "kind": "application" } }\n',
      },
      ["print-projects", "--target=."],
      "no-program",
    ],
    [
      "a declared configuration that does not exist",
      { "deadset.json": declared([["gone", "gone/tsconfig.json"]]) },
      ["print-projects", "--target=."],
      "no-program",
    ],
    [
      "a declared configuration whose options do not parse",
      {
        "deadset.json": declared([["b", "tsconfig.json"]]),
        "tsconfig.json": UNPARSED,
        "b.ts": "export const b = 1;\n",
      },
      ["print-projects", "--target=."],
      "no-program",
    ],
    [
      "a declared configuration referencing one below the root the matrix does not name",
      {
        "deadset.json": declared([["a", "a/tsconfig.json"]]),
        "a/tsconfig.json": '{ "include": ["*.ts"], "references": [{ "path": "../b" }] }\n',
        "a/a.ts": "export const a = 1;\n",
        "b/tsconfig.json": '{ "compilerOptions": { "composite": true }, "include": ["*.ts"] }\n',
        "b/b.ts": "export const b = 1;\n",
      },
      ["print-projects", "--target=."],
      "no-program",
    ],
    [
      "a tree whose every derived configuration names no input",
      {
        "tsconfig.json": '{ "include": ["none/*.ts"] }\n',
        "tools/tsconfig.json": '{ "include": ["none/*.ts"] }\n',
      },
      ["print-projects", "--target=."],
      "no-program",
    ],
    [
      "a workspace declaration whose packages is no sequence of strings",
      {
        "pnpm-workspace.yaml": "packages: packages/*\n",
        "package.json": '{ "name": "@example/root" }\n',
        "packages/a/package.json": '{ "name": "@example/a" }\n',
        "tsconfig.json": TSCONFIG,
        "main.ts": "export const main = 1;\n",
      },
      ["print-projects", "--target=."],
      "no-program",
    ],
    ["a target that does not exist", {}, ["print-projects", "--target=gone"], "no-program"],
    [
      "a target that is a file",
      { "file.ts": "export const a = 1;\n" },
      ["print-projects", "--target=file.ts"],
      "no-program",
    ],
    [
      "a declared consumer that is no directory",
      {
        "target/tsconfig.json": TSCONFIG,
        "target/lib.ts": "export const lib = 1;\n",
        consumer: "a file\n",
        "scope.json": '{ "target": { "path": "target" }, "consumers": [{ "path": "consumer" }] }\n',
      },
      ["print-projects", "--scope=scope.json"],
      "missing-consumer",
    ],
    [
      "a declared consumer holding no compiler configuration",
      {
        "target/tsconfig.json": TSCONFIG,
        "target/lib.ts": "export const lib = 1;\n",
        "consumer/use.ts": "export const use = 1;\n",
        "scope.json": '{ "target": { "path": "target" }, "consumers": [{ "path": "consumer" }] }\n',
      },
      ["print-projects", "--scope=scope.json"],
      "missing-consumer",
    ],
    [
      "a declared consumer whose configuration's options do not parse",
      {
        "target/tsconfig.json": TSCONFIG,
        "target/lib.ts": "export const lib = 1;\n",
        "consumer/tsconfig.json": UNPARSED,
        "consumer/use.ts": "export const use = 1;\n",
        "scope.json": '{ "target": { "path": "target" }, "consumers": [{ "path": "consumer" }] }\n',
      },
      ["print-projects", "--scope=scope.json"],
      "missing-consumer",
    ],
  ])(
    "names a setup class for %s",
    (_case, files, args, failureClass) => {
      const got = invoke(tree(files), args);

      expect(got.code, got.lines.join("\n")).toBe(3);
      expect(classesOf(got.lines), got.lines.join("\n")).toEqual([failureClass]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "prints the located errors of a declared configuration that does not load before its setup failure",
    () => {
      const root = tree({
        "deadset.json": declared([["b", "tsconfig.json"]]),
        "tsconfig.json": UNPARSED,
        "b.ts": "export const b = 1;\n",
      });

      const got = invoke(root, ["print-projects", "--target=."]);

      expect(got.code).toBe(3);
      expect(got.lines).toHaveLength(2);
      expect(got.lines[0]).toMatch(
        /tsconfig\.json(?::\d+:\d+)?: TS5023: Unknown compiler option 'noSuchOption'\./u,
      );
      expect(got.lines[1]).toBe(
        "setup failure: no-program: the configuration tsconfig.json does not load, its errors printed above: correct the configuration, or name the configurations to analyze",
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "names the target root and the files a program is read from for a target holding none",
    () => {
      const root = tree({
        "package.json": '{ "name": "@example/none" }\n',
        "src/a.ts": "export const a = 1;\n",
        "deadset.json": '{ "target": { "kind": "application" } }\n',
      });

      const got = invoke(root, ["print-projects", "--target=."]);

      expect(got.lines).toEqual([
        `setup failure: no-program: ${root} holds no compiler configuration, no file named tsconfig*.json: run from the directory that holds one, or name the languages to analyze`,
      ]);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    ["does not exist", {}, "gone"],
    ["is not a directory", { "file.ts": "export const a = 1;\n" }, "file.ts"],
  ])(
    "names the target and the files a program is read from for a target that %s",
    (says, files, target) => {
      const root = tree(files);

      const got = invoke(root, ["print-projects", `--target=${target}`]);

      expect(got.lines).toEqual([
        `setup failure: no-program: the target ${join(root, target)} ${says}, so it holds no compiler configuration, no file named tsconfig*.json: name the directory that holds one`,
      ]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a scope document the invocation names that is refused", () => {
  it.each([
    ["one that is not JSON", "{ target"],
    ["one naming no target", '{ "consumers": [] }'],
  ])(
    "ends the run with the usage code, for %s",
    (_case, text) => {
      const root = tree({
        "scope.json": text,
        "tsconfig.json": TSCONFIG,
        "a.ts": "export const a = 1;\n",
      });

      const got = invoke(root, ["print-projects", "--scope=scope.json"]);

      expect(got.code).toBe(2);
      expect(got.lines[0]).toMatch(/^deadset-ts: scope: scope\.json: /u);
    },
    LOAD_TIMEOUT,
  );
});
