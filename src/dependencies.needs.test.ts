import { describe, expect, it } from "vitest";
import {
  LOAD_TIMEOUT,
  needsOf as projectNeedsOf,
  type Needs,
} from "../__test-helpers__/project-needs.ts";
import { openEngine, type Engine } from "./session.ts";

/** Installed packages, each exporting `pad` and `join` and, as its default, `pad`. */
const INSTALLED = Object.fromEntries(
  ["polyfill", "left-pad", "pathy", "@types/globals"].flatMap((name) => [
    [`node_modules/${name}/package.json`, JSON.stringify({ name, types: "index.d.ts" })],
    [
      `node_modules/${name}/index.d.ts`,
      "export declare function pad(text: string): string;\nexport declare function join(text: string): string;\nexport default pad;\n",
    ],
  ]),
);

/**
 * The full start of the first `token` in `text`, leading whitespace included, which is
 * where the checker locates the node the token begins.
 */
function startOf(text: string, token: string): number {
  let at = text.indexOf(token);
  while (at > 0 && /\s/u.test(text.charAt(at - 1))) {
    at -= 1;
  }
  return at;
}

/**
 * An engine whose checker panics on the symbol at each offset of `src/main.ts` in
 * `panics` while `armed()` holds, and answers everything else.
 */
function panicking(panics: readonly number[], armed: () => boolean): Engine {
  const opened = openEngine({ collectTiming: false });
  const suffixes = panics.map((offset) => `/src/main.ts:${String(offset)}`);
  return {
    ...opened,
    ask: (accessor, locations, question) => {
      if (
        armed() &&
        accessor === "getSymbolAtLocation" &&
        locations().some((location) => suffixes.some((suffix) => location.endsWith(suffix)))
      ) {
        throw new Error(`panic: ${accessor}`);
      }
      return opened.ask(accessor, locations, question);
    },
  };
}

/**
 * The needs of the one project `main` (written as `src/main.ts`) and `files` make, beside
 * the installed packages, with the checker panicking on the symbols at `panics` while the
 * needs are read.
 */
function needsOf(
  main: string,
  panics: readonly string[] = [],
  files: Readonly<Record<string, string>> = {},
): Needs {
  const offsets = panics.map((token) => startOf(main, token));
  return projectNeedsOf({ ...INSTALLED, ...files, "src/main.ts": main }, (armed) =>
    panicking(offsets, armed),
  );
}

const IMPORTS = [
  'import "polyfill";',
  'import { pad } from "left-pad";',
  'import * as path from "pathy";',
  "",
];

describe("what one project's files need", () => {
  it(
    "holds an import binding's package by each declaration using the binding, and a bare import's where it stands",
    () => {
      const main = [
        ...IMPORTS,
        'export function joined(): string { return path.join("a"); }',
        'export function padded(): string { return pad("a"); }',
        "",
      ].join("\n");

      expect(needsOf(main)).toEqual({
        uses: {
          "src/main.ts:1:1": ["polyfill"],
          "src/main.ts:5:17": ["pathy"],
          "src/main.ts:6:17": ["left-pad"],
        },
        at: { "src/main.ts": ["left-pad", "pathy", "polyfill"] },
        unanswered: [],
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds a binding written as a destructuring default by the declaration writing it",
    () => {
      const main = [
        ...IMPORTS,
        "export function defaulted(): unknown {",
        "  let value: unknown;",
        "  ({ value = path } = {} as { value?: unknown });",
        "  return value;",
        "}",
        "",
      ].join("\n");

      expect(needsOf(main).uses).toEqual({
        "src/main.ts:1:1": ["polyfill"],
        "src/main.ts:5:17": ["pathy"],
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds nothing by a name spelled as a binding that the checker resolves to nothing",
    () => {
      const main = [
        ...IMPORTS,
        "declare const loose: any;",
        "export function spelled(): unknown { return loose.pad; }",
        "",
      ].join("\n");

      expect(needsOf(main).uses).toEqual({ "src/main.ts:1:1": ["polyfill"] });
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds a binding the checker leaves unanswered by every declaration spelling its name, and the file's specifiers answered",
    () => {
      const main = [
        ...IMPORTS,
        "declare const loose: any;",
        'export function padded(): string { return pad("a"); }',
        "export function spelled(): unknown { return loose.pad; }",
        "",
      ].join("\n");

      expect(needsOf(main, [" pad }"])).toEqual({
        uses: {
          "src/main.ts:1:1": ["polyfill"],
          "src/main.ts:6:17": ["left-pad"],
          "src/main.ts:7:17": ["left-pad"],
        },
        at: { "src/main.ts": ["left-pad", "pathy", "polyfill"] },
        unanswered: [],
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds a use the checker leaves unanswered by its declaration, and the file's specifiers answered",
    () => {
      const main = [...IMPORTS, 'export function padded(): string { return pad("a"); }', ""].join(
        "\n",
      );

      expect(needsOf(main, ['pad("a")'])).toEqual({
        uses: { "src/main.ts:1:1": ["polyfill"], "src/main.ts:5:17": ["left-pad"] },
        at: { "src/main.ts": ["left-pad", "pathy", "polyfill"] },
        unanswered: [],
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds the package a types reference directive reads by the file",
    () => {
      const main = ['/// <reference types="globals" />', "export const one = 1;", ""].join("\n");

      expect(needsOf(main)).toEqual({
        uses: { "src/main.ts:1:1": ["@types/globals"] },
        at: { "src/main.ts": ["@types/globals"] },
        unanswered: [],
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds both packages a types reference directive may read where no file of the program is of either, and a type package named as such alone",
    () => {
      const main = [
        '/// <reference types="missing" />',
        '/// <reference types="@types/absent" />',
        "export const one = 1;",
        "",
      ].join("\n");

      expect(needsOf(main)).toEqual({
        uses: { "src/main.ts:1:1": ["@types/absent", "@types/missing", "missing"] },
        at: { "src/main.ts": ["@types/absent", "@types/missing", "missing"] },
        unanswered: [],
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds an import-equals or default import binding's package by the declaration using it",
    () => {
      const main = [
        'import padded = require("left-pad");',
        'import joinDefault from "pathy";',
        "",
        'export function viaRequire(): string { return padded.pad("a"); }',
        'export function viaDefault(): string { return joinDefault("a"); }',
        "",
      ].join("\n");

      expect(needsOf(main)).toEqual({
        uses: { "src/main.ts:4:17": ["left-pad"], "src/main.ts:5:17": ["pathy"] },
        at: { "src/main.ts": ["left-pad", "pathy"] },
        unanswered: [],
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds no package for a relative import or a global augmentation",
    () => {
      const main = [
        'import { local } from "./local.js";',
        "declare global {",
        "  interface Shown {",
        "    readonly one: 1;",
        "  }",
        "}",
        "export function used(): string { return local; }",
        "",
      ].join("\n");

      expect(needsOf(main, [], { "src/local.ts": 'export const local = "a";\n' })).toEqual({
        uses: {},
        at: {},
        unanswered: [],
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds a re-export's package by each name it declares, and one declaring none by the file",
    () => {
      const main = [
        'export { pad, join as joined } from "left-pad";',
        'export * as paths from "pathy";',
        'export {} from "polyfill";',
        "",
      ].join("\n");

      expect(needsOf(main)).toEqual({
        uses: {
          "src/main.ts:1:1": ["polyfill"],
          "src/main.ts:1:10": ["left-pad"],
          "src/main.ts:1:23": ["left-pad"],
          "src/main.ts:2:13": ["pathy"],
        },
        at: { "src/main.ts": ["left-pad", "pathy", "polyfill"] },
        unanswered: [],
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds a binding written as a shorthand property by the declaration writing it",
    () => {
      const main = [...IMPORTS, "export function wrapped(): object { return { pad }; }", ""].join(
        "\n",
      );

      expect(needsOf(main).uses).toEqual({
        "src/main.ts:1:1": ["polyfill"],
        "src/main.ts:5:17": ["left-pad"],
      });
    },
    LOAD_TIMEOUT,
  );
});

/** A type package declaring globals, an ambient module, and in a module file one more global. */
const AUTOMATIC = {
  "node_modules/@types/runner/package.json": '{ "name": "@types/runner", "types": "main.d.ts" }',
  "node_modules/@types/runner/main.d.ts": '/// <reference path="more.d.ts" />\n',
  "node_modules/@types/runner/more.d.ts": [
    "declare function suite(name: string): void;",
    "declare namespace Runner { interface Options {} }",
    'declare module "runner:io" { export const io: number; }',
    "",
  ].join("\n"),
  "node_modules/@types/augment/index.d.ts":
    "export {};\ndeclare global { var augmented: number; }\n",
  "node_modules/@types/modular/index.d.ts": "export declare const modular: number;\n",
};

describe("what the type packages a compiler includes automatically declare", () => {
  it(
    "holds a type package by each use of its globals and ambient modules that resolves to nothing",
    () => {
      const main = [
        'import { io } from "runner:io";',
        "export function tested(options: Runner.Options): number {",
        '  suite("a");',
        "  return io + augmented + Number(options);",
        "}",
        "declare const loose: any;",
        "export const named = loose.suite + { suite: 1 }.suite;",
        "",
      ].join("\n");

      expect(needsOf(main, [], AUTOMATIC)).toEqual({
        uses: { "src/main.ts:2:17": ["@types/augment", "@types/runner"] },
        at: { "src/main.ts": ["@types/augment", "@types/runner"] },
        unanswered: [],
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds none where the configuration lists its types",
    () => {
      const main = 'export function tested(): void { suite("a"); }\n';
      const tsconfig = {
        compilerOptions: { strict: true, module: "NodeNext", noEmit: true, types: [] },
        include: ["src"],
      };

      expect(
        needsOf(main, [], { ...AUTOMATIC, "tsconfig.json": JSON.stringify(tsconfig) }),
      ).toEqual({ uses: {}, at: {}, unanswered: [] });
    },
    LOAD_TIMEOUT,
  );
});

describe("what a script runs outside the program needs", () => {
  it(
    "reads the JavaScript file a script or a workflow step runs, and each file it loads, against the manifest",
    () => {
      const files = {
        "package.json": JSON.stringify({
          name: "app",
          private: true,
          scripts: { build: "node ./scripts/build.mjs --fast", glob: "node scripts/*.js" },
          devDependencies: { bundler: "1", ci: "1", unused: "1" },
        }),
        "scripts/build.mjs": 'import { make } from "./base.cjs";\nmake();\n',
        "scripts/base.cjs": 'module.exports = { make: () => require("bundler") };\n',
        "scripts/ci.js": 'require("ci");\n',
        ".github/workflows/ci.yml": "jobs:\n  a:\n    steps:\n      - run: node scripts/ci.js\n",
      };

      expect(needsOf("export const one = 1;\n", [], files).at).toEqual({
        "package.json": ["bundler", "ci"],
      });
    },
    LOAD_TIMEOUT,
  );
});
