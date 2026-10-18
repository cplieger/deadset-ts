import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { resolve } from "../resolve.ts";
import { scopeForDir, type Scope } from "../scope.ts";
import { openEngine } from "../session.ts";
import { loadRun } from "./load.ts";

/** The bound on one case, which opens the compiler over a written tree. */
const LOAD_TIMEOUT = 60_000;

function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "deadset-ts-specifiers-"));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function unresolvedOf(root: string, scope?: Scope): readonly unknown[] {
  const host = nodeHost();
  const { config } = resolve({
    repository: {
      text: JSON.stringify({ target: { kind: "application" } }),
      label: "deadset.json",
    },
  });
  return loadRun(
    openEngine({ collectTiming: false }),
    host,
    scope ?? scopeForDir(host, root),
    config,
    ({ classified }) => classified.unresolvedSpecifiers,
  ).result;
}

const MANIFEST = '{ "name": "@example/app", "main": "index.cjs" }\n';

describe("the specifiers of JavaScript files no configuration checks", () => {
  it(
    "notes an unresolved relative specifier of a file // @ts-check checks, and no optional one, without ending the run",
    () => {
      const root = tree({
        "package.json": MANIFEST,
        "index.cjs": [
          "// @ts-check",
          'require("./gone.cjs");',
          "try {",
          '  require("./local.cjs");',
          "} catch {}",
          "",
        ].join("\n"),
      });

      expect(unresolvedOf(root)).toEqual([
        { specifier: "./gone.cjs", position: { path: "index.cjs", line: 2, column: 9 } },
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "notes neither an absolute specifier nor a bare one that starts with a dot",
    () => {
      const root = tree({
        "package.json": MANIFEST,
        "index.cjs": 'require("/assets/app.js");\nrequire(".package");\nrequire("./gone.cjs");\n',
      });

      expect(unresolvedOf(root)).toEqual([
        { specifier: "./gone.cjs", position: { path: "index.cjs", line: 3, column: 9 } },
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "reads a parenthesized require an || falls back from as optional",
    () => {
      const root = tree({
        "package.json": MANIFEST,
        "index.cjs":
          'const o = (require("./o.cjs")) || {};\nconst p = ((require("./p.cjs"))) ?? {};\nconsole.log(o, p);\n',
      });

      expect(unresolvedOf(root)).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "keeps two specifiers whose path, position and text join to one text",
    () => {
      const root = tree({
        "package.json": MANIFEST,
        "index.cjs": 'require("./b.cjs:2:9:./z");\n',
        "index.cjs:1:9:./b.cjs": '\nrequire("./z");\n',
      });

      expect(unresolvedOf(root)).toEqual([
        { specifier: "./b.cjs:2:9:./z", position: { path: "index.cjs", line: 1, column: 9 } },
        { specifier: "./z", position: { path: "index.cjs:1:9:./b.cjs", line: 2, column: 9 } },
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "notes no relative specifier naming a path below a declared consumer's output directory",
    () => {
      const root = tree({
        "target/package.json": MANIFEST,
        "target/index.cjs": 'require("../consumer/out/gen.cjs");\nrequire("./gone.cjs");\n',
        "consumer/tsconfig.json": `${JSON.stringify({ compilerOptions: { outDir: "out" }, include: ["src/*.ts"] })}\n`,
        "consumer/src/a.ts": "export const a = 1;\n",
      });
      const scope: Scope = {
        target: { id: "", path: join(root, "target") },
        consumers: [{ id: "", path: join(root, "consumer") }],
      };

      expect(unresolvedOf(root, scope)).toEqual([
        { specifier: "./gone.cjs", position: { path: "index.cjs", line: 2, column: 9 } },
      ]);
    },
    LOAD_TIMEOUT,
  );
});
