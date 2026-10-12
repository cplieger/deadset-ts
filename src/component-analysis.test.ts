import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import type { Host } from "./host.ts";
import { run, type Writer } from "./run.ts";

const TARGET = fixture("projects", "component-files");

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

interface Finding {
  readonly code: string;
  readonly position: { path: string; line: number; column: number; end_line: number };
  readonly symbol: { name: string };
}

interface Analyzed {
  readonly code: number;
  readonly err: string;
  readonly findings: readonly string[];
  readonly skips: readonly unknown[];
  /** The temporary directories the run made, each checked after it ended. */
  readonly made: readonly string[];
}

let dir: string;

/**
 * One `analyze` run from a target, the fixture by default, its report written into `into`
 * and read back as one line per finding.
 */
function analyze(configText?: string, target = TARGET, into = dir): Analyzed {
  const made: string[] = [];
  const base = nodeHost();
  const host: Host = {
    ...base,
    workingDirectory: () => target,
    temporaryDirectory: () => {
      const one = base.temporaryDirectory();
      made.push(one.path);
      return one;
    },
  };
  const report = join(into, `report-${String(made.length)}-${String(Date.now())}.json`);
  const config = join(into, "deadset.json");
  if (configText !== undefined) {
    writeFileSync(config, configText);
  }
  const err = new MemoryWriter();
  const code = run(
    [
      "analyze",
      "--target=.",
      `--report=${report}`,
      ...(configText === undefined ? [] : [`--config=${config}`]),
    ],
    new MemoryWriter(),
    err,
    host,
  );
  // A run that ends before its findings exist writes no report.
  const document = (
    existsSync(report)
      ? JSON.parse(readFileSync(report, "utf8"))
      : { findings: [], type_error_skips: [] }
  ) as {
    findings: Finding[];
    type_error_skips: unknown[];
  };
  return {
    code,
    err: err.text,
    findings: document.findings.map(
      (one) =>
        `${one.code} ${one.position.path}:${String(one.position.line)}:${String(one.position.column)}-${String(one.position.end_line)} ${one.symbol.name}`,
    ),
    skips: document.type_error_skips,
    made,
  };
}

describe("component files, read through the compiler's content mapper", () => {
  let answered: Analyzed;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "deadset-ts-component-analysis-"));
    answered = analyze();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports only what no block, no live markup and no retained binding keeps, at the file's own positions", () => {
    expect(answered.findings).toEqual([
      "DS1301 src/Crlf.vue:7:3-7 Row.unread",
      "DS1301 src/Crlf.vue:8:3-8 Row.note",
      "DS1502 src/Orphan.vue:1:1-4 src/Orphan.vue",
      "DS1002 src/Orphan.vue:3:7-3 lonely",
      "DS1301 src/Wide.vue:2:56-2 Shape.side",
      "DS1001 src/helpers.ts:9:17-9 unusedHelper",
      "DS1302 src/level.ts:5:3-5 Level.Unused",
      "DS1302 src/level.ts:6:3-6 Level.HalfOnly",
      "DS1502 src/unreached.ts:1:1-3 src/unreached.ts",
      "DS1001 src/unreached.ts:3:14-3 half",
    ]);
    expect(answered.skips).toEqual([]);
    expect(answered.code).toBe(1);
  });

  it("warns on standard error for a line-start script tag it reads no block for", () => {
    expect(answered.err).toContain(
      "deadset-ts: src/Warned.vue:3: a <script> start tag that begins a line is not read as a block: it is inside an element\n",
    );
  });

  it("retains a member, an enum member among them, that a live component's markup names, in one record however many name it", () => {
    const out = new MemoryWriter();
    run(["print-retained", "--target=."], out, new MemoryWriter(), {
      ...nodeHost(),
      workingDirectory: () => TARGET,
    });
    expect(out.text.split("\n")).toEqual([
      "ts://@example/app/src/Crlf.vue#Row.label\ttemplate-field\tsrc/Crlf.vue:2:13\tnamed by {{ row.label }}",
      "ts://@example/app/src/level.ts#Level.Low\ttemplate-field\tsrc/Status.vue:1:51\tnamed by {{ Level.Low }}",
      'ts://@example/app/src/level.ts#Level.High\ttemplate-field\tsrc/Status.vue:1:36\tnamed by v-if="state === Level.High"',
      'ts://@example/app/src/level.ts#Level.Templated\ttemplate-field\tsrc/Status.vue:2:27\tnamed by :title="`level ${Level.Templated}`"',
      "",
    ]);
  });

  it("places the import a src attribute names at the attribute", () => {
    const out = new MemoryWriter();
    run(["explain", "--target=.", "--why=external"], out, new MemoryWriter(), {
      ...nodeHost(),
      workingDirectory: () => TARGET,
    });
    expect(out.text).toContain(
      "reference: src/External.vue:2:9\tread\tsrc/External.vue:1:1 -> src/external.ts:1:1\n",
    );
  });

  it("holds no declaration the module appends past the file's end", () => {
    const out = new MemoryWriter();
    run(["explain", "--target=.", "--why=default"], out, new MemoryWriter(), {
      ...nodeHost(),
      workingDirectory: () => TARGET,
    });
    expect(out.text.split("\n").slice(0, 3)).toEqual([
      "symbol: ts://@example/app/src/Legacy.vue#default:alias",
      "declaration: export-alias default",
      "position: src/Legacy.vue:4:8",
    ]);
  });

  it("removes the mapper's package directory when the run ends", () => {
    expect(answered.made).toHaveLength(1);
    expect(answered.made.filter((path) => existsSync(path))).toEqual([]);
  });

  it("reads no component file, and makes no directory, where the extension list is empty", () => {
    const none = analyze('{"target":{"kind":"application"},"ts":{"component_extensions":[]}}\n');
    expect(none.made).toEqual([]);
    expect(none.skips).toHaveLength(10);
    expect(none.findings).not.toContain("DS1502 src/Orphan.vue:1:1-4 src/Orphan.vue");
  });
});

describe("a component file's import binding of a module namespace", () => {
  it.each([
    ["a namespace import", 'import * as ns from "./inner.js";'],
    ["a named import of a namespace re-export", 'import { ns } from "./barrel.js";'],
    ["a default import of a namespace re-exported as the default", 'import ns from "./whole.js";'],
  ])(
    "keeps every export of the module through %s, because the markup is not parsed",
    (_label, binding) => {
      const root = writeProject({
        "package.json": '{ "name": "@example/ns", "private": true, "type": "module" }\n',
        "src/main.ts": 'import Widget from "./Widget.vue";\nconsole.log(Widget);\n',
        "src/Widget.vue": `<template>\n  <p>{{ ns.shown }}</p>\n</template>\n\n<script setup lang="ts">\n${binding}\n</script>\n`,
        "src/barrel.ts": 'export * as ns from "./inner.js";\n',
        "src/whole.ts": 'export * as default from "./inner.js";\n',
        "src/inner.ts": "export const shown = 1;\nexport const hidden = 2;\n",
      });
      const into = mkdtempSync(join(tmpdir(), "deadset-ts-component-namespace-"));
      const got = analyze(
        '{"target":{"kind":"application"},"ts":{"entry_files":["src/main.ts"]}}\n',
        root,
        into,
      );
      rmSync(root, { recursive: true, force: true });
      rmSync(into, { recursive: true, force: true });

      expect(got.findings.filter((line) => line.includes(" src/inner.ts:"))).toEqual([]);
    },
    60_000,
  );

  it("keeps every export of a module a declare module declaration holds, and not every member of a namespace", () => {
    const root = writeProject({
      "package.json": '{ "name": "@example/ns", "private": true, "type": "module" }\n',
      "src/main.ts": 'import Widget from "./Widget.vue";\nconsole.log(Widget);\n',
      "src/Widget.vue":
        '<template>\n  <p>{{ amb.shown }} {{ N.shown }}</p>\n</template>\n\n<script setup lang="ts">\nimport * as amb from "ambient";\nimport { N } from "./n.js";\n</script>\n',
      "src/ambient.ts":
        'declare module "ambient" {\n  export const shown: number;\n  export const hidden: number;\n}\n',
      "src/n.ts":
        "export namespace N {\n  export const shown = 1;\n  export const hidden = 2;\n}\n",
    });
    const into = mkdtempSync(join(tmpdir(), "deadset-ts-component-namespace-"));
    const got = analyze(
      '{"target":{"kind":"application"},"ts":{"entry_files":["src/main.ts"]}}\n',
      root,
      into,
    );
    rmSync(root, { recursive: true, force: true });
    rmSync(into, { recursive: true, force: true });

    expect(got.findings.filter((line) => line.includes(" src/ambient.ts:"))).toEqual([]);
    expect(got.findings).toContain("DS1001 src/n.ts:3:16-3 N.hidden");
  }, 60_000);
});

describe("content mappers a configuration declares", () => {
  let root: string;
  let reports: string;

  /** A package whose mapper, were the compiler to run it, writes a marker into the root. */
  const mapperPackage = (name: string): string =>
    JSON.stringify({
      name,
      version: "0.0.0",
      typescript: {
        contentMapper: { exec: ["/bin/sh", "-c", `touch ${join(root, `ran-${name}`)}; exit 1`] },
      },
    });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "deadset-ts-own-mappers-"));
    reports = mkdtempSync(join(tmpdir(), "deadset-ts-own-mappers-reports-"));
    const files: Record<string, string> = {
      "deadset.json": JSON.stringify({ target: { kind: "application" } }),
      "package.json": JSON.stringify({
        name: "@example/own",
        version: "0.0.0",
        private: true,
        type: "module",
        main: "./src/main.ts",
      }),
      "base.json": JSON.stringify({
        contentMappers: [{ package: "own-base", extensions: [".vue"] }],
        compilerOptions: {
          strict: true,
          module: "NodeNext",
          moduleResolution: "nodenext",
          noEmit: true,
        },
      }),
      "tsconfig.json": JSON.stringify({
        extends: "./base.json",
        contentMappers: [{ package: "own", extensions: [".vue"] }],
        include: ["src"],
        references: [{ path: "./sub" }],
      }),
      "src/main.ts":
        'import A from "./A.vue";\nimport { fromSub } from "../sub/lib.js";\nexport const all = [A, fromSub];\n',
      "src/A.vue":
        '<template><p>{{ x }}</p></template>\n<script lang="ts">\nconst x = 1;\n</script>\n',
      "sub/tsconfig.json": JSON.stringify({
        contentMappers: [{ package: "own-ref", extensions: [".vue"] }],
        compilerOptions: {
          composite: true,
          module: "NodeNext",
          moduleResolution: "nodenext",
          outDir: "out",
        },
        include: ["*.ts", "*.vue"],
      }),
      "sub/lib.ts": "export const fromSub = 1;\n",
      "sub/B.vue":
        '<template><p>{{ y }}</p></template>\n<script lang="ts">\nconst y = 1;\n</script>\n',
      "node_modules/own/package.json": mapperPackage("own"),
      "node_modules/own-base/package.json": mapperPackage("own-base"),
      "sub/node_modules/own-ref/package.json": mapperPackage("own-ref"),
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(reports, { recursive: true, force: true });
  });

  /** The markers a mapper the project declares left in the root. */
  const ran = (): string[] => readdirSync(root).filter((name) => name.startsWith("ran-"));

  it("never run, and the project is read with this analyzer's mapper in their place", () => {
    const analyzed = analyze(undefined, root, reports);
    expect(ran()).toEqual([]);
    expect(analyzed.code).toBe(1);
    expect(analyzed.findings).toEqual([
      "DS1502 sub/B.vue:1:1-4 sub/B.vue",
      "DS1002 sub/B.vue:3:7-3 y",
    ]);
  });

  it("never run, and the project is read with no mapper where the extension list is empty", () => {
    const analyzed = analyze(
      '{"target":{"kind":"application"},"ts":{"component_extensions":[]}}\n',
      root,
      reports,
    );
    expect(ran()).toEqual([]);
    expect(analyzed.code).toBe(0);
    expect(analyzed.findings).toEqual([]);
    expect(analyzed.skips).toHaveLength(1);
  });
});

describe("component files read by their own framework's parser", () => {
  let written: string;
  let into: string;
  let got: Analyzed;
  let retained: string[];

  beforeAll(() => {
    written = writeProject({
      "package.json": '{ "name": "app", "private": true, "type": "module" }\n',
      "src/main.ts":
        'import View from "./View.vue";\nimport Card from "./Card.svelte";\nexport const all = [View, Card];\n',
      "src/View.vue":
        '<template><p :title="`${row.note"></p><p :alt="`${row.not"></p></template>\n<script lang="ts">\ninterface Row {\n  note: string;\n  not: string;\n}\nconst row: Row = { note: "", not: "" };\n</script>\n',
      "src/Card.svelte":
        '<script lang="ts">\ninterface Item {\n  shown: string;\n  hidden: string;\n}\nconst item: Item = { shown: "", hidden: "" };\n</script>\n<!-->{item.hidden}\n<div>\n<script>const inside = 1;</script>\n</div>\n<!-- -->\n<p>{item.shown}</p>\n',
    });
    into = mkdtempSync(join(tmpdir(), "deadset-ts-component-dialect-"));
    const config = '{"target":{"kind":"application"},"ts":{"entry_files":["src/main.ts"]}}\n';
    got = analyze(config, written, into);
    const out = new MemoryWriter();
    run(
      ["print-retained", "--target=.", `--config=${join(into, "deadset.json")}`],
      out,
      new MemoryWriter(),
      {
        ...nodeHost(),
        workingDirectory: () => written,
      },
    );
    retained = out.text.split("\n").filter((line) => line.includes("template-field"));
  }, 60_000);

  afterAll(() => {
    rmSync(written, { recursive: true, force: true });
    rmSync(into, { recursive: true, force: true });
  });

  it("reads a markup substitution left open to the end of its value", () => {
    expect(retained.filter((line) => line.includes("View.vue"))).toEqual([
      'ts://app/src/View.vue#Row.note\ttemplate-field\tsrc/View.vue:1:29\tnamed by :title="`${row.note"',
      'ts://app/src/View.vue#Row.not\ttemplate-field\tsrc/View.vue:1:55\tnamed by :alt="`${row.not"',
    ]);
  });

  it("reads a .svelte comment as Svelte does, holding back nothing it hides and warning on no script in it", () => {
    expect(retained.filter((line) => line.includes("Card.svelte"))).toEqual([
      "ts://app/src/Card.svelte#Item.shown\ttemplate-field\tsrc/Card.svelte:13:10\tnamed by {item.shown}",
    ]);
    expect(got.findings.filter((line) => line.includes("Card.svelte"))).toEqual([
      "DS1301 src/Card.svelte:4:3-4 Item.hidden",
    ]);
    expect(got.err).not.toContain("Card.svelte");
  });
});
