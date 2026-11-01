import { rmSync } from "node:fs";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { run, type Writer } from "./run.ts";

const LOAD_TIMEOUT = 60_000;

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

/** The roots `print-roots` names below `src/`, the entry file's own left out. */
function computedRoots(files: Readonly<Record<string, string>>): string[] {
  const root = writeProject({
    "package.json": `${JSON.stringify({ name: "@example/app", private: true, type: "module", main: "./src/app.ts" })}\n`,
    "deadset.json": `${JSON.stringify({ target: { kind: "application" } })}\n`,
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "ESNext",
        moduleResolution: "bundler",
        noEmit: true,
        types: [],
      },
      include: ["src"],
    })}\n`,
    ...files,
  });
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const out = new MemoryWriter();
  const err = new MemoryWriter();
  expect(run(["print-roots", `--target=${root}`], out, err, nodeHost()), err.text).toBe(0);
  return out.text
    .split("\n")
    .map((line) => line.replace("ts://@example/app/", ""))
    .filter((line) => line.startsWith("src/") && !line.startsWith("src/app.ts#"));
}

describe("a file a load with a computed path names", () => {
  it(
    "is every file below the directory the literal start of an import or a require names, with its exports, unless that directory holds the caller",
    () => {
      expect(
        computedRoots({
          "src/env.d.ts": "declare function require(path: string): unknown;\n",
          "src/app.ts": [
            "declare const name: string;",
            "export const a = await import(`./migrations/${name}`);",
            'export const b = require("./fixtures/" + name);',
            "export const c = await import(`./${name}`);",
            "export const d = await import(`lib/${name}`);",
            "export const e = await import(`../${name}`);",
            "",
          ].join("\n"),
          "src/migrations/0001.ts": "export default function up(): void {}\n",
          "src/fixtures/deep/one.ts": "export const one = 1;\n",
          "src/sibling.ts": "export const sibling = 1;\n",
          "src/lib/x.ts": "export const x = 1;\n",
        }).filter((line) => !line.startsWith("src/env.d.ts")),
      ).toEqual([
        "src/fixtures/deep/one.ts#\tcomputed-import\t./fixtures/",
        "src/fixtures/deep/one.ts#one\tcomputed-import\t./fixtures/",
        "src/migrations/0001.ts#\tcomputed-import\t./migrations/",
        "src/migrations/0001.ts#default\tcomputed-import\t./migrations/",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is every file the literal glob of import.meta.glob matches, read against the calling file",
    () => {
      expect(
        computedRoots({
          "src/env.d.ts":
            "interface ImportMeta {\n  glob(pattern: string | string[]): Record<string, unknown>;\n}\n",
          "src/app.ts": 'export const pages = import.meta.glob(["./pages/*.page.ts"]);\n',
          "src/pages/home.page.ts": "export const home = 1;\n",
          "src/pages/helper.ts": "export const helper = 1;\n",
        }).filter((line) => line.startsWith("src/pages/")),
      ).toEqual([
        "src/pages/home.page.ts#\tcomputed-import\t./pages/*.page.ts",
        "src/pages/home.page.ts#home\tcomputed-import\t./pages/*.page.ts",
      ]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a file a Markdown or MDX document imports", () => {
  it(
    "is the file each import line outside a fenced block names, with its exports",
    () => {
      expect(
        computedRoots({
          "src/app.ts": "export {};\n",
          "docs/intro.mdx": [
            'import { Demo } from "../src/demo.ts";',
            "",
            "<Demo />",
            "",
            "```ts",
            'import { sample } from "../src/sample.ts";',
            "```",
            "",
          ].join("\n"),
          "src/demo.ts": "export const Demo = 1;\n",
          "src/sample.ts": "export const sample = 1;\n",
        }),
      ).toEqual([
        "src/demo.ts#\tdocument-import\t../src/demo.ts",
        "src/demo.ts#Demo\tdocument-import\t../src/demo.ts",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is rooted with the exports its import clause reads, every one for a namespace import and none for a bare one",
    () => {
      expect(
        computedRoots({
          "src/app.ts": "export {};\n",
          "docs/intro.mdx": [
            'import Card, { Badge as Tag, "quoted name" as quoted } from "../src/parts.ts";',
            'import * as all from "../src/all.ts";',
            'import "../src/effects.ts";',
            "",
            "<Card />",
            "",
          ].join("\n"),
          "src/parts.ts": [
            "export default function Card(): number {",
            "  return 1;",
            "}",
            "export const Badge = 2;",
            "const named = 3;",
            'export { named as "quoted name" };',
            "export const Unread = 4;",
            "",
          ].join("\n"),
          "src/all.ts": "export const one = 1;\nexport const two = 2;\n",
          "src/effects.ts": "export const effect = 1;\n",
        }),
      ).toEqual([
        "src/all.ts#\tdocument-import\t../src/all.ts",
        "src/all.ts#one\tdocument-import\t../src/all.ts",
        "src/all.ts#two\tdocument-import\t../src/all.ts",
        "src/effects.ts#\tdocument-import\t../src/effects.ts",
        "src/parts.ts#\tdocument-import\t../src/parts.ts",
        "src/parts.ts#default\tdocument-import\t../src/parts.ts",
        "src/parts.ts#Badge\tdocument-import\t../src/parts.ts",
        "src/parts.ts#named\tdocument-import\t../src/parts.ts",
        "src/parts.ts#'quoted name':alias\tdocument-import\t../src/parts.ts",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "reads a quoted export name by its value, escapes decoded, and every export for an escape a module cannot hold",
    () => {
      expect(
        computedRoots({
          "src/app.ts": "export {};\n",
          "docs/intro.mdx": [
            String.raw`import { "foo\u002dbar" as a, '\x41b' as b, "\u{63}\"d" as c } from "../src/escaped.ts";`,
            String.raw`import { "\1" as d } from "../src/octal.ts";`,
            "",
          ].join("\n"),
          "src/escaped.ts": [
            "const a = 1;",
            "const b = 2;",
            "const c = 3;",
            "export const Unread = 4;",
            'export { a as "foo-bar", b as "Ab", c as \'c"d\' };',
            "",
          ].join("\n"),
          "src/octal.ts": "export const one = 1;\nexport const two = 2;\n",
        }),
      ).toEqual([
        "src/escaped.ts#\tdocument-import\t../src/escaped.ts",
        "src/escaped.ts#a\tdocument-import\t../src/escaped.ts",
        "src/escaped.ts#b\tdocument-import\t../src/escaped.ts",
        "src/escaped.ts#c\tdocument-import\t../src/escaped.ts",
        "src/escaped.ts#'foo-bar':alias\tdocument-import\t../src/escaped.ts",
        "src/escaped.ts#Ab:alias\tdocument-import\t../src/escaped.ts",
        "src/escaped.ts#'c\"d':alias\tdocument-import\t../src/escaped.ts",
        "src/octal.ts#\tdocument-import\t../src/octal.ts",
        "src/octal.ts#one\tdocument-import\t../src/octal.ts",
        "src/octal.ts#two\tdocument-import\t../src/octal.ts",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is none a fence holds until a run of its own marker at least as long closes it",
    () => {
      expect(
        computedRoots({
          "src/app.ts": "export {};\n",
          "docs/intro.mdx": [
            "````md",
            "```",
            "~~~",
            'import { sample } from "../src/sample.ts";',
            "```",
            'import { other } from "../src/other.ts";',
            "````",
            'import { Demo } from "../src/demo.ts";',
            "",
          ].join("\n"),
          "src/demo.ts": "export const Demo = 1;\n",
          "src/sample.ts": "export const sample = 1;\n",
          "src/other.ts": "export const other = 1;\n",
        }),
      ).toEqual([
        "src/demo.ts#\tdocument-import\t../src/demo.ts",
        "src/demo.ts#Demo\tdocument-import\t../src/demo.ts",
      ]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a file a makefile's recipe names", () => {
  it(
    "is the file a recipe token names against the directory a cd of its line moved to",
    () => {
      expect(
        computedRoots({
          "src/app.ts": "export {};\n",
          Makefile: [
            "# src/ignored.ts",
            "build:",
            "\tcd src/web; npx esbuild --bundle main.tsx \\",
            "\t  --outdir=../out",
            "\tnode src/tool.ts # src/commented.ts",
            "stray: src/rule.ts",
            "",
          ].join("\n"),
          "src/web/main.tsx": "export const main = 1;\n",
          "src/tool.ts": "export const tool = 1;\n",
          "src/ignored.ts": "export const ignored = 1;\n",
          "src/commented.ts": "export const commented = 1;\n",
          "src/rule.ts": "export const rule = 1;\n",
        }),
      ).toEqual([
        "src/tool.ts#\tworkflow-step\tsrc/tool.ts",
        "src/tool.ts#tool\tworkflow-step\tsrc/tool.ts",
        "src/web/main.tsx#\tworkflow-step\tmain.tsx",
        "src/web/main.tsx#main\tworkflow-step\tmain.tsx",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is every file below the directory a computed path names through a non-null assertion",
    () => {
      expect(
        computedRoots({
          "src/app.ts": [
            "declare const name: string;",
            "export const a = await import(`./migrations/${name}`!);",
            "",
          ].join("\n"),
          "src/migrations/one.ts": "export const up = 1;\n",
        }),
      ).toEqual([
        "src/migrations/one.ts#\tcomputed-import\t./migrations/",
        "src/migrations/one.ts#up\tcomputed-import\t./migrations/",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "matches a configured entry pattern whose brace member holds a wildcard",
    () => {
      expect(
        computedRoots({
          "deadset.json": `${JSON.stringify({
            target: { kind: "application" },
            ts: { entry_files: ["src/{*.job,main}.ts"] },
          })}\n`,
          "src/app.ts": "export {};\n",
          "src/nightly.job.ts": "export const nightly = 1;\n",
        }),
      ).toEqual([
        "src/nightly.job.ts#\tentry-file\tsrc/{*.job,main}.ts",
        "src/nightly.job.ts#nightly\tentry-file\tsrc/{*.job,main}.ts",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "ends a command at a single &, as it ends one at ;, and a cd before the & moves no later command",
    () => {
      expect(
        computedRoots({
          "src/app.ts": "export {};\n",
          Makefile: [
            "jobs:",
            "\tcd src/jobs; node nightly.ts & echo started",
            "\tcd src & node jobs/late.ts",
            "",
          ].join("\n"),
          "src/jobs/nightly.ts": "export const nightly = 1;\n",
          "src/jobs/late.ts": "export const late = 1;\n",
        }),
      ).toEqual([
        "src/jobs/nightly.ts#\tworkflow-step\tnightly.ts",
        "src/jobs/nightly.ts#nightly\tworkflow-step\tnightly.ts",
      ]);
    },
    LOAD_TIMEOUT,
  );
});
