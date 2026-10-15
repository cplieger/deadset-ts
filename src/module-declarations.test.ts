import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { emitterInputOf, findingsOf } from "../__test-helpers__/emitter-input.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { analyzeProject, writeProject } from "../__test-helpers__/projects.ts";
import { resolve } from "./resolve.ts";
import { run, type Writer } from "./run.ts";
import { openEngine } from "./session.ts";

const TARGET = fixture("projects", "module-declarations");

const DISCARD: Writer = { write: () => undefined };

/**
 * Every finding of one `analyze` run over the fixture, as `code path:line name`. The run
 * reads the fixture's component files, so an import of one resolves to that file.
 */
function fixtureFindings(): string[] {
  const dir = mkdtempSync(join(tmpdir(), "deadset-ts-module-declarations-"));
  try {
    const report = join(dir, "report.json");
    run(["analyze", "--target=.", `--report=${report}`], DISCARD, DISCARD, {
      ...nodeHost(),
      workingDirectory: () => TARGET,
    });
    const document = JSON.parse(readFileSync(report, "utf8")) as {
      findings: {
        code: string;
        position: { path: string; line: number };
        symbol: { name: string };
      }[];
    };
    return document.findings.map(
      (one) => `${one.code} ${one.position.path}:${String(one.position.line)} ${one.symbol.name}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("a module declaration an import names by its name or pattern", () => {
  it("lends the import the members it imports, where the specifier resolves to a component file", () => {
    expect(fixtureFindings().filter((line) => line.includes(" '*.vue'"))).toEqual([
      "DS1001 src/shims.d.ts:5 '*.vue'.subtitle",
    ]);
  });

  it("is named by no import of a file no configuration holds, by pattern or by exact name", () => {
    expect(fixtureFindings().filter((line) => / '(\*\.svg|virtual:config)'/u.test(line))).toEqual([
      "DS1001 src/shims.d.ts:11 '*.svg'.raw",
      "DS1001 src/shims.d.ts:12 '*.svg'.inline",
      "DS1002 src/shims.d.ts:15 'virtual:config'",
    ]);
  });

  it("is named by no specifier's text where its name is relative", () => {
    expect(fixtureFindings().filter((line) => line.includes(" src/extend.ts:"))).toEqual([
      "DS1002 src/extend.ts:3 './util.js'",
      "DS1201 src/extend.ts:4 './util.js'.Util",
    ]);
  });

  it("is reported whole where no import names it", () => {
    expect(fixtureFindings().filter((line) => line.includes(" '*.png'"))).toEqual([
      "DS1002 src/shims.d.ts:19 '*.png'",
    ]);
  });
});

const PACKAGE = '{ "name": "@example/app", "type": "module", "main": "./src/main.ts" }\n';

const COMPONENT = [
  '<template><h1>{{ title }}</h1></template>\n<script lang="ts">\nexport const title = "app";',
  'export default { name: "App" };\n</script>\n',
].join("\n");

function componentShim(name: string): string {
  return [
    `declare module "${name}" {`,
    "  const component: { name: string };",
    "  export default component;",
    "  export const title: string;",
    "}",
    "",
  ].join("\n");
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function reported(
  files: Readonly<Record<string, string>>,
  paths?: Readonly<Record<string, readonly string[]>>,
): string[] {
  const root = writeProject({
    "package.json": PACKAGE,
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ESNext",
        lib: ["ESNext", "DOM"],
        module: "ESNext",
        moduleResolution: "bundler",
        noEmit: true,
        ...(paths === undefined ? {} : { baseUrl: ".", paths }),
      },
      include: ["src/**/*.ts", "src/**/*.vue"],
    })}\n`,
    ...files,
  });
  roots.push(root);
  const { config } = resolve({
    repository: '{ "target": { "kind": "application" } }',
    repositoryLabel: "deadset.json",
  });
  return findingsOf(emitterInputOf(root, config)).map(
    (one) => `${one.code} ${one.position.path}:${String(one.position.line)} ${one.symbol.name}`,
  );
}

describe("a pattern module declaration an import matches", () => {
  it("lends the import only the export names it imports", () => {
    expect(
      reported({
        "src/App.vue": COMPONENT,
        "src/shims.d.ts": componentShim("*.vue"),
        "src/main.ts": 'import { title } from "./App.vue";\n\nconsole.log(title);\n',
      }),
    ).toEqual([
      "DS1002 src/shims.d.ts:2 '*.vue'.component",
      "DS1001 src/shims.d.ts:3 '*.vue'.default",
    ]);
  });

  it.each([
    ["an import type", 'export type App = typeof import("./App.vue");\n'],
    ["an import assignment nothing reads", 'import App = require("./App.vue");\n'],
    [
      "a dynamic import inside a function whose value nothing reads",
      'export async function load(): Promise<void> {\n  await import("./App.vue");\n}\n',
    ],
  ])("is named, and lends no export, through %s", (_, main) => {
    expect(
      reported({
        "src/App.vue": COMPONENT,
        "src/shims.d.ts": componentShim("*.vue"),
        "src/main.ts": main,
      }),
    ).toEqual([
      "DS1002 src/shims.d.ts:2 '*.vue'.component",
      "DS1001 src/shims.d.ts:3 '*.vue'.default",
      "DS1001 src/shims.d.ts:4 '*.vue'.title",
    ]);
  });

  it("is named past a prefix, a slash after the star or an exact name, through a path mapping", () => {
    expect(
      reported(
        {
          "src/App.vue": COMPONENT,
          "src/Card.vue": COMPONENT,
          "src/shims.d.ts": [
            componentShim("@/App.vue"),
            componentShim("@/*.vue"),
            componentShim("*/Card.vue"),
          ].join("\n"),
          "src/main.ts":
            'import App from "@/App.vue";\nimport Card from "./Card.vue";\n\nconsole.log(App, Card);\n',
        },
        { "@/*": ["./src/*"] },
      ),
    ).toEqual([
      "DS1001 src/shims.d.ts:4 '@/App.vue'.title",
      "DS1001 src/shims.d.ts:10 '@/*.vue'.title",
      "DS1001 src/shims.d.ts:16 '*/Card.vue'.title",
    ]);
  });

  it("is named where its star stands for an empty run, and not where its prefix and suffix overlap", () => {
    expect(
      reported(
        {
          "src/App.vue": COMPONENT,
          "src/shims.d.ts": [
            componentShim("*./App.vue"),
            componentShim("~/*.vue"),
            componentShim("~/App*App.vue"),
          ].join("\n"),
          "src/main.ts":
            'import App from "./App.vue";\nimport Again from "~/App.vue";\n\nconsole.log(App, Again);\n',
        },
        { "~/*": ["./src/*"] },
      ),
    ).toEqual([
      "DS1001 src/shims.d.ts:4 '*./App.vue'.title",
      "DS1001 src/shims.d.ts:10 '~/*.vue'.title",
      "DS1002 src/shims.d.ts:13 '~/App*App.vue'",
    ]);
  });
});

describe("a pattern module declaration an import of a component file matches", () => {
  it("is named where its star stands for an empty run", () => {
    const root = writeProject({
      "package.json": PACKAGE,
      "tsconfig.json": `${JSON.stringify({
        compilerOptions: {
          strict: true,
          module: "ESNext",
          moduleResolution: "bundler",
          noEmit: true,
        },
        include: ["src/**/*.ts", "src/**/*.vue"],
      })}\n`,
      "src/App.vue": COMPONENT,
      "src/shims.d.ts": componentShim("*./App.vue"),
      "src/main.ts": 'import App from "./App.vue";\n\nconsole.log(App);\n',
    });
    roots.push(root);
    const { config } = resolve({
      repository: '{ "target": { "kind": "application" } }',
      repositoryLabel: "deadset.json",
    });
    const engine = openEngine({
      collectTiming: false,
      components: { extensions: [".vue"], host: nodeHost() },
    });

    expect(
      findingsOf(emitterInputOf(root, config, { engine }))
        .filter((one) => one.position.path === "src/shims.d.ts")
        .map((one) => `${one.code} ${one.symbol.name}`),
    ).toEqual(["DS1001 '*./App.vue'.title"]);
  });
});

describe("an ambient module declaration of an exact name", () => {
  const SHIM = 'declare module "config" {\n  export const mode: string;\n}\n';

  it("is named by no import whose specifier is not literal text, and by no other call's literal", () => {
    expect(
      reported({
        "src/shims.d.ts": SHIM,
        "src/main.ts":
          'const config = "config";\nconsole.log("config");\nconsole.log(await import(config));\n',
      }),
    ).toEqual(["DS1002 src/shims.d.ts:1 config"]);
  });

  it("costs the reference pass no request it does not account for where nothing imports", () => {
    const analyzed = analyzeProject(
      {
        "package.json": '{ "name": "@example/app", "type": "module" }\n',
        "shims.d.ts": SHIM,
        "main.ts": "export const x = 1;\n",
      },
      { references: { testFiles: [] } },
    );
    const cost = analyzed.references[0]?.cost;

    expect(cost).toBeDefined();
    expect(analyzed.referenceRequests).toBe(
      (cost?.fileBatches ?? 0) +
        (cost?.residueFallbacks ?? 0) +
        (cost?.shorthandLookups ?? 0) +
        (cost?.aliasSteps ?? 0) +
        (cost?.patternBatches ?? 0) +
        (cost?.patternLookups ?? 0) +
        (cost?.contextualBatches ?? 0) +
        (cost?.contextualLookups ?? 0) +
        (cost?.typedLookups ?? 0),
    );
  });

  it("is named by no specifier that only ends with its name", () => {
    expect(
      reported({
        "src/box.ts": "export const box = 1;\n",
        "src/shims.d.ts": 'declare module "x" {\n  export const value: number;\n}\n',
        "src/main.ts": 'import { box } from "./box";\n\nconsole.log(box);\n',
      }),
    ).toEqual(["DS1002 src/shims.d.ts:1 x"]);
  });
});

describe("a module augmentation whose name is relative", () => {
  it("is named by an import resolving to the module it augments", () => {
    expect(
      reported({
        "src/util.ts": "export interface Util {\n  base: number;\n}\n",
        "src/extend.ts":
          'export {};\n\ndeclare module "./util.js" {\n  interface Util {\n    extra: number;\n  }\n}\n',
        "src/main.ts":
          'import "./extend.js";\nimport type { Util } from "./util.js";\n\nexport const util: Util = { base: 1, extra: 2 };\n',
      }),
    ).toEqual(["DS1301 src/extend.ts:5 './util.js'.Util.extra", "DS1301 src/util.ts:2 Util.base"]);
  });

  it("is named by no import spelled the same that resolves to another module", () => {
    expect(
      reported({
        "src/util.ts": "export interface Util {\n  base: number;\n}\n",
        "src/extend.ts":
          'export {};\n\ndeclare module "./util.js" {\n  interface Util {\n    extra: number;\n  }\n}\n',
        "src/sub/extend.ts":
          'export {};\n\ndeclare module "../util.js" {\n  interface Util {\n    more: number;\n  }\n}\n',
        "src/other/util.ts": "export const other = 1;\n",
        "src/other/use.ts": 'import "./util.js";\n',
        "src/other/deep/use.ts": 'import "../util.js";\n',
        "src/main.ts":
          'import "./extend.js";\nimport "./sub/extend.js";\nimport "./other/use.js";\nimport "./other/deep/use.js";\n',
      }),
    ).toEqual([
      "DS1002 src/extend.ts:3 './util.js'",
      "DS1001 src/other/util.ts:1 other",
      "DS1002 src/sub/extend.ts:3 '../util.js'",
      "DS1201 src/extend.ts:4 './util.js'.Util",
      "DS1201 src/sub/extend.ts:4 '../util.js'.Util",
      "DS1201 src/util.ts:1 Util",
      "DS1602 src/util.ts:1 src/util.ts",
    ]);
  });

  it("is named by no import of its directory's index from another directory", () => {
    expect(
      reported({
        "src/dot/index.ts": "export interface Dot {\n  a: number;\n}\n",
        "src/dot/extend.ts":
          'export {};\n\ndeclare module "." {\n  interface Dot {\n    b: number;\n  }\n}\n',
        "src/other/index.ts": "export const other = 1;\n",
        "src/other/use.ts": 'import ".";\n',
        "src/main.ts": 'import "./dot/extend.js";\nimport "./other/use.js";\n',
      }),
    ).toEqual([
      "DS1002 src/dot/extend.ts:3 '.'",
      "DS1001 src/other/index.ts:1 other",
      "DS1201 src/dot/extend.ts:4 '.'.Dot",
      "DS1201 src/dot/index.ts:1 Dot",
      "DS1602 src/dot/index.ts:1 src/dot/index.ts",
    ]);
  });
});

const CONFIG_MAIN = 'import { mode } from "config";\n\nconsole.log(mode);\n';
const CONFIG_SHIM =
  'declare module "config" {\n  export const mode: string;\n  export const other: string;\n}\n';

function specifierReads(unanswered: readonly string[]): string[] {
  const analyzed = analyzeProject(
    {
      "package.json": '{ "name": "@example/app", "type": "module" }\n',
      "shims.d.ts": CONFIG_SHIM,
      "main.ts": CONFIG_MAIN,
    },
    {
      references: { testFiles: [] },
      panicsOn: (accessor, locations) =>
        accessor === "getSymbolAtLocation" &&
        locations.some((one) => unanswered.some((at) => one.endsWith(at))),
    },
  );
  return [
    ...new Set(
      (analyzed.references[0]?.references ?? [])
        .filter(
          (one) =>
            one.position.line === 1 &&
            one.use === "read" &&
            (one.resolution === "batch" || one.resolution === "syntax"),
        )
        .map((one) => `${one.to} ${one.resolution}`),
    ),
  ];
}

describe("the reads an import of an ambient module makes at its specifier", () => {
  const specifier = `/main.ts:${String(CONFIG_MAIN.indexOf(' "config"'))}`;
  const name = `/shims.d.ts:${String(CONFIG_SHIM.indexOf(' "config"'))}`;

  it("are the declaration the checker resolves the specifier to, and no read by name", () => {
    expect(specifierReads([])).toEqual(["shims.d.ts:1:16 batch"]);
  });

  it("are the declaration and the members imported, by name, where the specifier is unanswered", () => {
    expect(specifierReads([specifier])).toEqual([
      "shims.d.ts:1:16 syntax",
      "shims.d.ts:2:16 syntax",
    ]);
  });

  it("are read by name where both the specifier and the declaration's name are unanswered", () => {
    expect(specifierReads([specifier, name])).toEqual([
      "shims.d.ts:1:16 syntax",
      "shims.d.ts:2:16 syntax",
    ]);
  });
});
