import { describe, expect, it } from "vitest";
import { analyzeProject, type AnalyzeOptions } from "../__test-helpers__/projects.ts";
import { positionKey } from "./position.ts";
import type { Reference } from "./references.ts";

const ESM = '{ "name": "@example/modules", "type": "module" }\n';

const CJS = '{ "name": "@example/modules" }\n';

function modules(...names: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    names.map((name) => [`${name}.ts`, `export const ${name}Value = 1;\n`]),
  );
}

function analyzed(
  files: Readonly<Record<string, string>>,
  options: Omit<AnalyzeOptions, "references">,
): { references: readonly Reference[]; label: (id: string) => string } {
  const result = analyzeProject(files, { ...options, references: { testFiles: [] } });
  const labels = new Map(
    (result.inventories[0]?.symbols ?? []).map((symbol) => [
      symbol.id,
      symbol.kind === "file" ? symbol.position.path : symbol.name,
    ]),
  );
  return {
    references: result.references[0]?.references ?? [],
    label: (id) => labels.get(id) ?? "",
  };
}

function referencesOf(
  files: Readonly<Record<string, string>>,
  pick: (reference: Reference) => boolean,
  options: Omit<AnalyzeOptions, "references"> = {},
): string[] {
  const { references, label } = analyzed(files, options);
  return references
    .filter(pick)
    .map((reference) => `${positionKey(reference.position)} ${label(reference.to)}`);
}

function resolutionsOf(
  files: Readonly<Record<string, string>>,
  pick: (reference: Reference) => boolean,
  options: Omit<AnalyzeOptions, "references"> = {},
): string[] {
  const { references, label } = analyzed(files, options);
  return references
    .filter(pick)
    .map(
      (reference) =>
        `${positionKey(reference.position)} ${label(reference.to)} ${reference.resolution}`,
    );
}

const evaluation = (reference: Reference): boolean => reference.use === "evaluation";
const byName = (reference: Reference): boolean => reference.resolution === "by-name";
const read = (reference: Reference): boolean => reference.use === "read";

function askingAt(
  path: string,
  ...offsets: readonly number[]
): (accessor: string, locations: readonly string[]) => boolean {
  const at = offsets.map((offset) => `/${path}:${String(offset)}`);
  return (_accessor, locations) =>
    locations.some((location) => at.some((one) => location.endsWith(one)));
}

function asking(
  text: string,
  ...needles: readonly string[]
): (accessor: string, locations: readonly string[]) => boolean {
  return askingAt("main.ts", ...needles.map((needle) => text.indexOf(needle) - 1));
}

describe("a module's evaluation", () => {
  it("is the file the compiler resolves a specifier to where that file is a script, which declares no module", () => {
    const script = "const stamp = String(Date.now());\nconsole.log(stamp);\n";
    expect(
      referencesOf(
        {
          "package.json": JSON.stringify({
            name: "@example/modules",
            type: "module",
            imports: { "#imported": "./imported.ts" },
          }),
          "tsconfig.json": JSON.stringify({
            compilerOptions: {
              module: "esnext",
              moduleResolution: "bundler",
              target: "es2023",
              paths: { "@/*": ["./*"] },
            },
          }),
          "polyfill.ts": script,
          "aliased.ts": script,
          "imported.ts": script,
          "missing.ts": "export const missing = 1;\n",
          "main.ts": [
            'import "./polyfill.js";',
            'import "./absent.js";',
            'await import("./polyfill.ts");',
            'import "@/aliased";',
            'import "#imported";',
            'import "@/absent";',
            "",
          ].join("\n"),
        },
        evaluation,
      ),
    ).toEqual([
      "main.ts:1:8 polyfill.ts",
      "main.ts:3:14 polyfill.ts",
      "main.ts:4:8 aliased.ts",
      "main.ts:5:8 imported.ts",
    ]);
  });

  it("is the file a literal require names, read whole only where the call's value is used and no import binds it", () => {
    const script = "const stamp = String(Date.now());\nvoid stamp;\n";
    const { references, label } = analyzed(
      {
        "package.json": CJS,
        "tsconfig.json": JSON.stringify({
          compilerOptions: { module: "commonjs", moduleResolution: "node10", target: "es2023" },
        }),
        "env.d.ts": "declare function require(id: string): any;\n",
        "polyfill.ts": script,
        "voided.ts": script,
        "helpers.ts": "export function used(): void {}\nexport function other(): void {}\n",
        "own.ts": "export const ownValue = 1;\n",
        "main.ts": [
          'require("./polyfill");',
          'void require("./voided");',
          'const helpers = require("./helpers");',
          "helpers.used();",
          "function load(path: string): void {",
          "  console.log(path);",
          "}",
          'load("./own");',
          'require("./absent");',
          "export {};",
          "",
        ].join("\n"),
      },
      {},
    );

    expect(
      references
        .filter((reference) => evaluation(reference) || read(reference))
        .filter((reference) => reference.position.path === "main.ts")
        .map(
          (reference) =>
            `${positionKey(reference.position)} ${label(reference.to)} ${reference.use}`,
        )
        .filter((line) => !/ (?:load|helpers|require) /u.test(line)),
    ).toEqual([
      "main.ts:1:9 polyfill.ts evaluation",
      "main.ts:2:14 voided.ts evaluation",
      "main.ts:3:25 helpers.ts evaluation",
      "main.ts:3:25 used read",
      "main.ts:3:25 other read",
    ]);
  });

  it("is the file a literal module.require names where nothing declares module, and the one a require a destructured createRequire returns names", () => {
    const script = "const stamp = String(Date.now());\nvoid stamp;\n";
    const { references, label } = analyzed(
      {
        "package.json": CJS,
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            module: "commonjs",
            moduleResolution: "node10",
            target: "es2023",
            allowJs: true,
          },
        }),
        "polyfill.js": script,
        "own.js": script,
        "main.js": [
          'module.require("./polyfill");',
          'const { createRequire: make } = require("node:module");',
          "const load = make(__filename);",
          'load("./own");',
          "",
        ].join("\n"),
      },
      {},
    );

    expect(
      references
        .filter((reference) => evaluation(reference) && reference.position.path === "main.js")
        .map((reference) => `${positionKey(reference.position)} ${label(reference.to)}`),
    ).toEqual(["main.js:1:16 polyfill.js", "main.js:4:6 own.js"]);
  });

  it("is what a value import, a re-export and a literal dynamic import write, and no type-only import", () => {
    expect(
      referencesOf(
        {
          "package.json": ESM,
          ...modules("typed", "reexported", "dynamic", "templated", "queried"),
          "main.ts": [
            'import type { typedValue } from "./typed.js";',
            'export { reexportedValue } from "./reexported.js";',
            'export const loaded = await import("./dynamic.js");',
            "export const templated = await import(`./templated.js`);",
            "declare function label(path: string): typeof typedValue;",
            'export const labelled = label("./queried.ts?url");',
            "",
          ].join("\n"),
        },
        evaluation,
      ),
      "a call that is no import names no module, however its argument reads",
    ).toEqual([
      "main.ts:2:33 reexported.ts",
      "main.ts:3:36 dynamic.ts",
      "main.ts:4:39 templated.ts",
    ]);
  });

  it("is what an import assignment writes, and not a type-only one", () => {
    expect(
      referencesOf(
        {
          "package.json": CJS,
          ...modules("required", "typed"),
          "main.ts": [
            'import required = require("./required");',
            'import type typed = require("./typed");',
            "export const both: [typeof required, typeof typed] = [required, {} as typeof typed];",
            "",
          ].join("\n"),
        },
        evaluation,
      ),
    ).toEqual(["main.ts:1:27 required.ts"]);
  });

  it("is the module's file alone where an augmentation declares the module as well", () => {
    expect(
      referencesOf(
        {
          "package.json": ESM,
          "lib.ts": "export interface Shape {\n  a: number;\n}\n",
          "augment.ts":
            'declare module "./lib.js" {\n  interface Shape {\n    b: number;\n  }\n}\nexport {};\n',
          "main.ts": 'import "./lib.js";\n',
        },
        evaluation,
      ),
    ).toEqual(["main.ts:1:8 lib.ts"]);
  });

  it("is every file of the target, by name, where the checker leaves the module unanswered", () => {
    const main = 'import "./lib.js";\n';

    expect(
      resolutionsOf(
        { "package.json": ESM, ...modules("lib", "other"), "main.ts": main },
        evaluation,
        {
          panicsOn: asking(main, '"./lib.js"'),
        },
      ),
    ).toEqual([
      "main.ts:1:8 lib.ts by-name",
      "main.ts:1:8 main.ts by-name",
      "main.ts:1:8 other.ts by-name",
    ]);
  });
});

describe("a re-export of a whole module", () => {
  it("reads the module a star re-export and a namespace re-export carry forward", () => {
    expect(
      referencesOf(
        {
          "package.json": ESM,
          ...modules("starred", "spaced"),
          "main.ts": 'export * from "./starred.js";\nexport * as space from "./spaced.js";\n',
        },
        (reference) => reference.use === "read",
      ),
      "the star from the file, and the namespace from the name it declares",
    ).toEqual(["main.ts:1:15 starred.ts", "main.ts:2:24 spaced.ts"]);
  });

  it("reads the module a star re-export names as the checker answered it", () => {
    expect(
      resolutionsOf(
        {
          "package.json": ESM,
          ...modules("starred"),
          "main.ts": 'export * from "./starred.js";\n',
        },
        read,
      ),
    ).toEqual(["main.ts:1:15 starred.ts batch"]);
  });

  it("is a re-export named by name where the checker leaves the name unanswered", () => {
    const main = 'export { value } from "./lib.js";\n';

    expect(
      resolutionsOf(
        { "package.json": ESM, "lib.ts": "export const value = 1;\n", "main.ts": main },
        read,
        { panicsOn: asking(main, "value }") },
      ),
      "the re-export's own link and the declaration behind it bear the name",
    ).toEqual(["main.ts:1:10 value by-name", "main.ts:1:10 value by-name"]);
  });
});

describe("a namespace handed on whole", () => {
  const LIB = "export const shown = 1;\nconst hidden = 2;\nconsole.log(hidden);\n";
  const MAIN = 'import * as space from "./lib.js";\nconsole.log(space);\n';

  it("reads every export of every file, by name, where the checker leaves its module unanswered", () => {
    expect(
      resolutionsOf(
        {
          "package.json": ESM,
          "lib.ts": LIB,
          "other.ts": "export const elsewhere = 1;\nconst kept = 2;\nconsole.log(kept);\n",
          "main.ts": MAIN,
        },
        (reference) => read(reference) && byName(reference),
        { panicsOn: asking(MAIN, '"./lib.js"') },
      ),
    ).toEqual(["main.ts:2:13 shown by-name", "main.ts:2:13 elsewhere by-name"]);
  });

  it("reads the exports its module declares, by name, where the checker leaves its exports unanswered", () => {
    expect(
      resolutionsOf(
        { "package.json": ESM, "lib.ts": LIB, ...modules("other"), "main.ts": MAIN },
        (reference) => read(reference) && byName(reference),
        { panicsOn: (accessor) => accessor === "getExportsOfModule" },
      ),
    ).toEqual(["main.ts:2:13 shown by-name"]);
  });

  it("asks for its module's exports once however many files hand it on", () => {
    const asked: string[] = [];
    analyzed(
      { "package.json": ESM, "lib.ts": LIB, "main.ts": MAIN, "second.ts": MAIN },
      {
        panicsOn: (accessor) => {
          asked.push(accessor);
          return false;
        },
      },
    );

    expect(asked.filter((accessor) => accessor === "getExportsOfModule")).toHaveLength(1);
  });
});

const GLOB =
  "interface ImportMeta {\n  glob(pattern: string | string[], options?: object): Record<string, unknown>;\n}\n";

/**
 * The references a computed load makes, at the position of an evaluation it writes on a
 * line that calls `import()`, `require()` or `import.meta.glob()`, as
 * `<position> <from> <to> <use>`, each a file's path or a declaration's name, with `test`
 * where a test file makes one.
 */
function computedLoadsOf(files: Readonly<Record<string, string>>): string[] {
  const loading = new Set(
    Object.entries(files).flatMap(([path, text]) =>
      text
        .split("\n")
        .flatMap((line, at) =>
          /\b(?:import|require|import\.meta\.glob)\(/u.test(line)
            ? [`${path}:${String(at + 1)}`]
            : [],
        ),
    ),
  );
  const result = analyzeProject(files, { references: { testFiles: ["**/*.test.ts"] } });
  const symbols = result.inventories[0]?.symbols ?? [];
  const labels = new Map(
    symbols.map((symbol) => [
      symbol.id,
      symbol.kind === "file" ? symbol.position.path : symbol.name,
    ]),
  );
  const made = (result.references[0]?.references ?? []).filter((reference) =>
    loading.has(`${reference.position.path}:${String(reference.position.line)}`),
  );
  const loads = new Set(
    made
      .filter((reference) => reference.use === "evaluation")
      .map((reference) => positionKey(reference.position)),
  );
  return made
    .filter((reference) => loads.has(positionKey(reference.position)))
    .map(
      (reference) =>
        `${positionKey(reference.position)} ${labels.get(reference.from) ?? ""} ${labels.get(reference.to) ?? ""} ${reference.use}${reference.test ? " test" : ""}`,
    );
}

describe("a load by a computed path", () => {
  it("imports every file below the directory a literal start names, reading its exports, unless that directory holds the caller", () => {
    expect(
      computedLoadsOf({
        "package.json": ESM,
        "env.d.ts": "declare function require(path: string): unknown;\n",
        "app.ts": [
          "declare const name: string;",
          "export const a = await import(`./migrations/${name}`);",
          'export const b = require("./fixtures/" + name);',
          "export const c = await import(`./${name}`);",
          "export const d = await import(`lib/${name}`);",
          "export const e = await import(`./migrations/${name}`!);",
          "",
        ].join("\n"),
        "migrations/0001.ts": "export default function up(): void {}\n",
        "fixtures/deep/one.ts": "export const one = 1;\n",
        "lib/x.ts": "export const x = 1;\n",
        "sibling.ts": "export const sibling = 1;\n",
        "sub/loader.ts": [
          "declare const name: string;",
          "export const up = await import(`../plugins/${name}`);",
          "export const all = await import(`../${name}`);",
          "",
        ].join("\n"),
        "sub/neighbour.ts": "export const neighbour = 1;\n",
        "plugins/p.ts": "export const p = 1;\n",
      }),
      "a require the target declares only in a declaration file is no function of its own",
    ).toEqual([
      "app.ts:2:24 a migrations/0001.ts evaluation",
      "app.ts:2:24 a up read",
      "app.ts:3:18 b require read",
      "app.ts:3:18 b fixtures/deep/one.ts evaluation",
      "app.ts:3:18 b one read",
      "app.ts:6:24 e migrations/0001.ts evaluation",
      "app.ts:6:24 e up read",
      "sub/loader.ts:2:25 up plugins/p.ts evaluation",
      "sub/loader.ts:2:25 up p read",
    ]);
  });

  // Each row: how the calling file binds `require`, and whether Node loads by the call.
  const NODE_TYPES = [
    "declare namespace NodeJS {",
    "  interface Require {",
    "    (id: string): unknown;",
    "  }",
    "}",
    'declare module "node:module" {',
    "  export function createRequire(path: string): NodeJS.Require;",
    "}",
    'declare module "loader" {',
    "  export function require(id: string): unknown;",
    "}",
    "",
  ].join("\n");
  const LOAD = 'export const b = require("./fixtures/" + name);\n';
  it.each<[string, Readonly<Record<string, string>>, boolean]>([
    ["an undeclared require loads", { "app.ts": LOAD }, true],
    [
      "a require a declaration file declares as a function loads",
      { "env.d.ts": "declare function require(path: string): unknown;\n", "app.ts": LOAD },
      true,
    ],
    [
      "a require a declaration file declares as a constant loads",
      { "env.d.ts": "declare const require: (path: string) => unknown;\n", "app.ts": LOAD },
      true,
    ],
    [
      "a require the calling file declares under declare loads",
      { "app.ts": `declare var require: (path: string) => unknown;\n${LOAD}` },
      true,
    ],
    [
      "a require createRequire returns loads",
      {
        "node.d.ts": NODE_TYPES,
        "app.ts": `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\n${LOAD}`,
      },
      true,
    ],
    [
      "a require an AMD callback receives as its parameter loads",
      {
        "app.ts": [
          "declare function define(deps: string[], body: (require: (id: string) => unknown) => void): void;",
          'define(["require"], (require) => {',
          '  console.log(require("./fixtures/" + name));',
          "});",
          "",
        ].join("\n"),
      },
      true,
    ],
    [
      "a require imported from a module only a declaration file declares loads",
      { "node.d.ts": NODE_TYPES, "app.ts": `import { require } from "loader";\n${LOAD}` },
      true,
    ],
    [
      "a require createRequire returns under another name loads",
      {
        "node.d.ts": NODE_TYPES,
        "app.ts": `import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\n${LOAD.replace("require(", "load(")}`,
      },
      true,
    ],
    [
      "a require a createRequire imported under another name returns loads",
      {
        "node.d.ts": NODE_TYPES,
        "app.ts": `import { createRequire as make } from "node:module";\nconst load = make(import.meta.url);\n${LOAD.replace("require(", "load(")}`,
      },
      true,
    ],
    [
      "a require a createRequire imported under another name from a module the program does not resolve returns loads",
      {
        "app.ts": `import { createRequire as make } from "node:module";\nconst load = make(import.meta.url);\n${LOAD.replace("require(", "load(")}`,
      },
      true,
    ],
    [
      "a require imported under another name from a module the program does not resolve loads",
      {
        "app.ts": `import { require as load } from "loader";\n${LOAD.replace("require(", "load(")}`,
      },
      true,
    ],
    [
      "a require another file creates loads",
      {
        "node.d.ts": NODE_TYPES,
        "req.ts": `import { createRequire } from "node:module";\nexport const load = createRequire(import.meta.url);\n`,
        "app.ts": `import { load } from "./req.js";\n${LOAD.replace("require(", "load(")}`,
      },
      true,
    ],
    [
      "a require a createRequire re-exported under another name from a module the program does not resolve returns loads",
      {
        "re.ts": 'export { createRequire as make } from "node:module";\n',
        "app.ts": `import { make } from "./re.js";\nconst load = make(import.meta.url);\n${LOAD.replace("require(", "load(")}`,
      },
      true,
    ],
    [
      "a require a variable holding createRequire returns loads",
      {
        "app.ts": `import { createRequire as make } from "node:module";\nconst build = make;\nconst load = build(import.meta.url);\n${LOAD.replace("require(", "load(")}`,
      },
      true,
    ],
    [
      "a require a createRequire destructured under another name returns loads",
      {
        "env.d.ts": "declare function require(path: string): any;\n",
        "app.ts": `const { createRequire: make } = require("node:module");\nconst load = make(import.meta.url);\n${LOAD.replace("require(", "load(")}`,
      },
      true,
    ],
    [
      "a require another file creates, read as a member of its namespace, loads",
      {
        "node.d.ts": NODE_TYPES,
        "req.ts": `import { createRequire } from "node:module";\nexport const load = createRequire(import.meta.url);\n`,
        "app.ts": `import * as req from "./req.js";\n${LOAD.replace("require(", "req.load(")}`,
      },
      true,
    ],
    [
      "a require a createRequire the target writes and imports under another name returns loads nothing",
      {
        "own.ts": `export function createRequire(path: string): (id: string) => unknown {\n  return (id) => id + path;\n}\n`,
        "app.ts": `import { createRequire as make } from "./own.js";\nconst load = make(import.meta.url);\n${LOAD.replace("require(", "load(")}`,
      },
      false,
    ],
    [
      "a require a createRequire the calling file writes returns loads nothing",
      {
        "app.ts": `function createRequire(path: string): (id: string) => unknown {\n  return (id) => id + path;\n}\nconst load = createRequire(import.meta.url);\n${LOAD.replace("require(", "load(")}`,
      },
      false,
    ],
    [
      "a require method the target writes loads nothing",
      {
        "app.ts": `const loader = {\n  require(path: string): unknown {\n    return path;\n  },\n};\n${LOAD.replace("require(", "loader.require(")}`,
      },
      false,
    ],
    [
      "a require written in parentheses loads",
      { "app.ts": LOAD.replace("require(", "(require)(") },
      true,
    ],
    [
      "a binding of the platform's require under another name loads",
      {
        "env.d.ts": "declare function require(path: string): unknown;\n",
        "app.ts": `const plain = require;\nconst again = plain;\n${LOAD.replace("require(", "again(")}`,
      },
      true,
    ],
    [
      "the require a declaration file gives module loads",
      {
        "env.d.ts": "declare const module: { require(id: string): unknown };\n",
        "app.ts": LOAD.replace("require(", "module.require("),
      },
      true,
    ],
    [
      "the require of a module nothing declares loads",
      { "app.ts": LOAD.replace("require(", "module.require(") },
      true,
    ],
    [
      "a function of another name the target writes loads nothing",
      {
        "app.ts": `function load(path: string): unknown {\n  return path;\n}\n${LOAD.replace("require(", "load(")}`,
      },
      false,
    ],
    [
      "a function require the target writes loads nothing",
      {
        "app.ts": `function require(path: string): unknown {\n  return path;\n}\n${LOAD}`,
      },
      false,
    ],
    [
      "a require constant the target initialises with an arrow function loads nothing",
      { "app.ts": `const require = (path: string): unknown => path;\n${LOAD}` },
      false,
    ],
    [
      "a require function the target writes and imports loads nothing",
      {
        "loader.ts": "export function require(path: string): unknown {\n  return path;\n}\n",
        "app.ts": `import { require } from "./loader.js";\n${LOAD}`,
      },
      false,
    ],
  ])("%s", (_, files, loads) => {
    const { references, label } = analyzed(
      {
        "package.json": ESM,
        "fixtures/one.ts": "export const one = 1;\n",
        ...files,
        "names.d.ts": "declare const name: string;\n",
      },
      {},
    );

    expect(
      references.some(
        (reference) => evaluation(reference) && label(reference.to) === "fixtures/one.ts",
      ),
    ).toBe(loads);
  });

  it("imports every file an import.meta.glob matches, reading its exports unless its query reads the file as text or a URL", () => {
    expect(
      computedLoadsOf({
        "package.json": ESM,
        "env.d.ts": GLOB,
        "app.ts": [
          'export const code = import.meta.glob(["./code/*.ts"]);',
          'export const raw = import.meta.glob("./raw/*.ts", { query: "?raw", import: "default" });',
          'export const bare = import.meta.glob("./bare/*.ts", { query: "url" });',
          'export const url = import.meta.glob("./url/*.ts", { as: "url" });',
          'export const inline = import.meta.glob("./inline/*.ts", { query: "?inline&x" });',
          'export const valued = import.meta.glob("./valued/*.ts", { query: "?raw=1" });',
          'export const object = import.meta.glob("./object/*.ts", { query: { raw: true } });',
          "export const template = import.meta.glob(`./template/*.ts`, { query: `?raw` });",
          "",
        ].join("\n"),
        ...Object.fromEntries(
          ["code", "raw", "bare", "url", "inline", "valued", "object", "template"].map((dir) => [
            `${dir}/one.ts`,
            `export const ${dir}One = 1;\n`,
          ]),
        ),
      }),
    ).toEqual([
      "app.ts:1:21 code code/one.ts evaluation",
      "app.ts:1:21 code codeOne read",
      "app.ts:2:20 raw raw/one.ts evaluation",
      "app.ts:3:21 bare bare/one.ts evaluation",
      "app.ts:4:20 url url/one.ts evaluation",
      "app.ts:5:23 inline inline/one.ts evaluation",
      "app.ts:6:23 valued valued/one.ts evaluation",
      "app.ts:6:23 valued valuedOne read",
      "app.ts:7:23 object object/one.ts evaluation",
      "app.ts:7:23 object objectOne read",
      "app.ts:8:25 template template/one.ts evaluation",
    ]);
  });

  it("reads a glob as Vite does: / against the project root, ./ against the base, ** as written, ! removing", () => {
    expect(
      computedLoadsOf({
        "package.json": ESM,
        "env.d.ts": GLOB,
        "web/vite.config.ts": 'export default { root: "app" };\n',
        "web/app/main.ts": [
          'export const rooted = import.meta.glob("/plugins/*.ts");',
          'export const based = import.meta.glob("./*.ts", { base: "./pages" });',
          'export const top = import.meta.glob("./*.ts", { base: "/routes" });',
          'export const deep = import.meta.glob(["**/deep/*.ts", "!**/deep/skip.ts"]);',
          "",
        ].join("\n"),
        ...Object.fromEntries(
          [
            "web/app/plugins/p",
            "web/plugins/outside",
            "web/app/pages/page",
            "web/app/routes/route",
            "web/app/deep/kept",
            "web/app/deep/skip",
          ].map((stem) => [
            `${stem}.ts`,
            `export const ${stem.slice(stem.lastIndexOf("/") + 1)}Value = 1;\n`,
          ]),
        ),
      }).filter((line) => line.endsWith("evaluation")),
    ).toEqual([
      "web/app/main.ts:1:23 rooted web/app/plugins/p.ts evaluation",
      "web/app/main.ts:2:22 based web/app/pages/page.ts evaluation",
      "web/app/main.ts:3:20 top web/app/routes/route.ts evaluation",
      "web/app/main.ts:4:21 deep web/app/deep/kept.ts evaluation",
    ]);
  });

  it("leaves unresolved a glob through an alias, a computed base, a root the configuration hides, and a require under another name", () => {
    const result = analyzeProject(
      {
        "package.json": ESM,
        "env.d.ts": `${GLOB}declare module "node:module" {\n  export function createRequire(path: string): (id: string) => unknown;\n}\n`,
        "hidden/vite.config.ts": "const root = process.cwd();\nexport default { root };\n",
        "hidden/main.ts": 'export const hidden = import.meta.glob("/plugins/*.ts");\n',
        "main.ts": [
          'import { createRequire } from "node:module";',
          "declare const base: string;",
          "declare const name: string;",
          "function own(value: number | string): number {",
          "  return Number(value);",
          "}",
          "const load = createRequire(import.meta.url);",
          'export const aliased = import.meta.glob("@/plugins/*.ts");',
          'export const based = import.meta.glob("./*.ts", { base });',
          "export const loaded = load(name);",
          "export const counted = own(2) + own(name);",
          "export const pushed = [name].push(name);",
          "",
        ].join("\n"),
      },
      { references: { testFiles: [] } },
    );

    expect(
      (result.references[0]?.unseenLoads ?? []).map(positionKey).sort(),
      "a call of the target's own function and a method of another name load nothing",
    ).toEqual(["hidden/main.ts:1:23", "main.ts:10:23", "main.ts:8:24", "main.ts:9:22"]);
  });

  it("is made by the declaration holding the call, but an eager glob evaluates its files from the file", () => {
    expect(
      computedLoadsOf({
        "package.json": ESM,
        "env.d.ts": GLOB,
        "app.ts": [
          "export function load(name: string): Promise<unknown> {",
          "  return import(`./plugins/${name}`);",
          "}",
          "export function lazy(): Record<string, unknown> {",
          '  return import.meta.glob("./lazy/*.ts");',
          "}",
          "export function eager(): Record<string, unknown> {",
          '  return import.meta.glob("./eager/*.ts", { eager: true });',
          "}",
          "",
        ].join("\n"),
        ...Object.fromEntries(
          ["plugins", "lazy", "eager"].map((dir) => [
            `${dir}/one.ts`,
            `export const ${dir}One = 1;\n`,
          ]),
        ),
      }),
    ).toEqual([
      "app.ts:2:10 load plugins/one.ts evaluation",
      "app.ts:2:10 load pluginsOne read",
      "app.ts:5:10 lazy lazy/one.ts evaluation",
      "app.ts:5:10 lazy lazyOne read",
      "app.ts:8:10 app.ts eager/one.ts evaluation",
      "app.ts:8:10 eager eagerOne read",
    ]);
  });

  it("is a test reference where a test file writes it", () => {
    expect(
      computedLoadsOf({
        "package.json": ESM,
        "env.d.ts": GLOB,
        "main.ts": 'import { run } from "./lib.ts";\nrun();\n',
        "lib.ts": "export function run(): void {}\n",
        "plugins/one.ts": "export const plugin = 1;\n",
        "loads.test.ts": [
          'const code = import.meta.glob("./lib.ts", { eager: true });',
          'const text = import.meta.glob(["./*.ts"], { query: "?raw", import: "default", eager: true });',
          "declare const name: string;",
          "const loaded = await import(`./plugins/${name}`);",
          "console.log(code, text, loaded);",
          "",
        ].join("\n"),
      }),
    ).toEqual([
      "loads.test.ts:1:14 loads.test.ts lib.ts evaluation test",
      "loads.test.ts:1:14 code run read test",
      "loads.test.ts:2:14 loads.test.ts env.d.ts evaluation test",
      "loads.test.ts:2:14 loads.test.ts lib.ts evaluation test",
      "loads.test.ts:2:14 loads.test.ts main.ts evaluation test",
      "loads.test.ts:4:22 loaded plugins/one.ts evaluation test",
      "loads.test.ts:4:22 loaded plugin read test",
    ]);
  });
});

describe("a module URL", () => {
  it("loads the file it names relative to import.meta.url, or through import.meta.resolve", () => {
    expect(
      referencesOf(
        {
          "package.json": ESM,
          ...modules("worker", "resolved", "templated"),
          "main.ts": [
            'export const worker = new URL("./worker.ts", import.meta.url);',
            'export const resolved = import.meta.resolve("./resolved.ts");',
            "export const templated = new URL(`./templated.ts`, import.meta.url);",
            "",
          ].join("\n"),
        },
        evaluation,
      ),
    ).toEqual(["main.ts:1:23 worker.ts", "main.ts:2:25 resolved.ts", "main.ts:3:26 templated.ts"]);
  });

  it("loads the source file a specifier names by its output's extension", () => {
    expect(
      referencesOf(
        {
          "package.json": ESM,
          ...modules("worker"),
          "main.ts": 'export const worker = new URL("./worker.js", import.meta.url);\n',
        },
        evaluation,
      ),
    ).toEqual(["main.ts:1:23 worker.ts"]);
  });

  it("is made by the declaration holding the expression", () => {
    const { references, label } = analyzed(
      {
        "package.json": ESM,
        ...modules("worker"),
        "main.ts": [
          "export function start(): URL {",
          '  return new URL("./worker.ts", import.meta.url);',
          "}",
          "",
        ].join("\n"),
      },
      {},
    );

    expect(
      references
        .filter(evaluation)
        .map((reference) => `${label(reference.from)} ${label(reference.to)}`),
    ).toEqual(["start worker.ts"]);
  });

  it("loads the file where the target declares URL only ambiently, as the platform's", () => {
    expect(
      referencesOf(
        {
          "package.json": ESM,
          "tsconfig.json": JSON.stringify({
            compilerOptions: { module: "esnext", target: "es2023", lib: ["es2023"], types: [] },
          }),
          ...modules("worker"),
          "globals.d.ts":
            "declare var URL: { new (url: string, base?: string): { readonly href: string } };\n",
          "main.ts": 'export const worker = new URL("./worker.ts", import.meta.url);\n',
        },
        evaluation,
      ),
    ).toEqual(["main.ts:1:23 worker.ts"]);
  });

  // Each row: how the file binds `URL`, and whether a runtime starts the file it names.
  const URL_MODULES = [
    'declare module "url" {',
    "  export class URL {",
    "    constructor(input: string, base?: string);",
    "    readonly href: string;",
    "  }",
    "}",
    'declare module "node:url" {',
    '  export * from "url";',
    "}",
    "",
  ].join("\n");
  const URL_CLASS =
    "class URL {\n  constructor(\n    readonly path: string,\n    readonly base: string,\n  ) {}\n}\n";
  const WORKER = 'export const worker = new URL("./worker.ts", import.meta.url);\n';
  it.each<[string, Readonly<Record<string, string>>, boolean]>([
    ["the global URL loads", { "main.ts": WORKER }, true],
    [
      "the URL node:url exports loads",
      { "url.d.ts": URL_MODULES, "main.ts": `import { URL } from "node:url";\n${WORKER}` },
      true,
    ],
    [
      "a renamed import of the URL node:url exports loads",
      {
        "url.d.ts": URL_MODULES,
        "main.ts": `import { URL as NodeURL } from "node:url";\n${WORKER.replace("new URL", "new NodeURL")}`,
      },
      true,
    ],
    [
      "a renamed import of URL from a module the program does not resolve loads",
      {
        "main.ts": `import { URL as NodeURL } from "node:url";\n${WORKER.replace("new URL", "new NodeURL")}`,
      },
      true,
    ],
    [
      "a URL re-exported under another name from a module the program does not resolve loads",
      {
        "re.ts": 'export { URL as Address } from "node:url";\n',
        "main.ts": `import { Address } from "./re.js";\n${WORKER.replace("new URL", "new Address")}`,
      },
      true,
    ],
    [
      "the URL of a namespace import of node:url loads",
      {
        "url.d.ts": URL_MODULES,
        "main.ts": `import * as url from "node:url";\n${WORKER.replace("new URL", "new url.URL")}`,
      },
      true,
    ],
    ["globalThis.URL loads", { "main.ts": WORKER.replace("new URL", "new globalThis.URL") }, true],
    [
      "a URL written in parentheses loads",
      { "main.ts": WORKER.replace("new URL", "new (URL)") },
      true,
    ],
    [
      "a binding of the global URL under another name loads",
      { "main.ts": `const Address = URL;\n${WORKER.replace("new URL", "new Address")}` },
      true,
    ],
    ["a URL class the target writes loads nothing", { "main.ts": `${URL_CLASS}${WORKER}` }, false],
    [
      "a URL class the target writes and imports loads nothing",
      { "url.ts": `export ${URL_CLASS}`, "main.ts": `import { URL } from "./url.js";\n${WORKER}` },
      false,
    ],
    [
      "a URL constant the target initialises with a class expression loads nothing",
      { "main.ts": `const URL = ${URL_CLASS.replace("class URL", "class")};\n${WORKER}` },
      false,
    ],
  ])("%s", (_, files, loads) => {
    expect(
      referencesOf({ "package.json": ESM, ...modules("worker"), ...files }, evaluation).some(
        (line) => line.endsWith(" worker.ts"),
      ),
    ).toBe(loads);
  });

  it("loads the file a bare relative URL reference names, its query and its fragment removed, and none a scheme or a solidus names", () => {
    expect(
      referencesOf(
        {
          "package.json": ESM,
          ...modules("inner", "queried", "remote", "rooted"),
          "main.ts": [
            'export const inner = new URL("pkg/./../inner.ts", import.meta.url);',
            'export const queried = new URL("queried.ts?raw#top", import.meta.url);',
            'export const remote = new URL("https://example.com/remote.ts", import.meta.url);',
            'export const rooted = new URL("/rooted.ts", import.meta.url);',
            'export const resolved = import.meta.resolve("rooted.ts");',
            "",
          ].join("\n"),
        },
        evaluation,
      ),
    ).toEqual(["main.ts:1:22 inner.ts", "main.ts:2:24 queried.ts"]);
  });

  it("loads nothing where the constructor, the base, the method or the path is another", () => {
    expect(
      referencesOf(
        {
          "package.json": ESM,
          ...modules("constructed", "pattern", "based", "metaBased", "called", "metaCalled"),
          "main.ts": [
            "declare global {",
            "  interface ImportMeta {",
            "    readonly base: string;",
            "    other(path: string): string;",
            "  }",
            "}",
            "class Located {",
            "  constructor(",
            "    readonly path: string,",
            "    readonly base: string,",
            "  ) {}",
            "}",
            "export class Target {",
            '  static url = "https://example.com/";',
            "  static resolve(path: string): string {",
            "    return path;",
            "  }",
            "  constructor() {",
            '    console.log(new URL("./based.ts", new.target.url));',
            '    console.log(new.target.resolve("./called.ts"));',
            "  }",
            "}",
            'export const constructed = new Located("./constructed.ts", import.meta.url);',
            'export const pattern = new RegExp("./pattern.ts", import.meta.url);',
            'export const metaBased = new URL("./metaBased.ts", import.meta.base);',
            'export const metaCalled = import.meta.other("./metaCalled.ts");',
            "",
          ].join("\n"),
        },
        evaluation,
      ),
      "a class the target declares and one it does not, `new.target` for `import.meta`, and another member of `import.meta`",
    ).toEqual([]);
  });
});

describe("a global a declaration file declares as an alias of a module's export", () => {
  it("names nothing through its own type query", () => {
    expect(
      referencesOf(
        {
          "package.json": ESM,
          "mod.ts": "export const value = 1;\n",
          "globals.d.ts": [
            "declare global {",
            '  var aliased: typeof import("./mod.js").value;',
            "}",
            "export {};",
            "",
          ].join("\n"),
        },
        () => true,
      ),
      "the global is used nowhere, so nothing reads the export",
    ).toEqual([]);
  });

  function globals(keys: Readonly<Record<string, string>>): string {
    return [
      "declare global {",
      ...Object.entries(keys).map(
        ([global, key]) => `  var ${global}: typeof import("./mod.js")["${key}"];`,
      ),
      "}",
      "export {};",
      "",
    ].join("\n");
  }

  it("names the export at a use of the global, through the alias, beside the global itself", () => {
    expect(
      resolutionsOf(
        {
          "package.json": ESM,
          "mod.ts": "export const value = 1;\n",
          "globals.d.ts": globals({ aliased: "value" }),
          "main.ts": "export const read = aliased;\n",
        },
        (reference) => reference.position.path === "main.ts",
      ),
    ).toEqual([
      "main.ts:1:21 global batch",
      "main.ts:1:21 global.aliased batch",
      "main.ts:1:21 value alias",
    ]);
  });

  it("names the export once where two declaration files declare the one global", () => {
    expect(
      referencesOf(
        {
          "package.json": ESM,
          "mod.ts": "export const value = 1;\n",
          "globals.d.ts": globals({ aliased: "value" }),
          "more.d.ts": globals({ aliased: "value" }),
          "main.ts": "export const read = aliased;\n",
        },
        (reference) => reference.position.path === "main.ts",
      ).filter((line) => line.endsWith(" value")),
    ).toEqual(["main.ts:1:21 value"]);
  });

  it("names by name the export the checker leaves unanswered, and nothing for a name no declaration bears", () => {
    const declared = globals({ named: "value", missing: "absent" });

    expect(
      resolutionsOf(
        {
          "package.json": ESM,
          "mod.ts": "export const value = 1;\n",
          "globals.d.ts": declared,
          "main.ts": "export const read = [named, missing];\n",
        },
        (reference) => reference.position.path === "main.ts",
        {
          panicsOn: askingAt(
            "globals.d.ts",
            declared.indexOf('"value"'),
            declared.indexOf('"absent"'),
          ),
        },
      ),
    ).toEqual([
      "main.ts:1:22 global batch",
      "main.ts:1:22 global.named batch",
      "main.ts:1:22 value by-name",
      "main.ts:1:29 global batch",
      "main.ts:1:29 global.missing batch",
    ]);
  });
});

describe("a use the checker leaves unanswered", () => {
  it("names by name what a named, a default or a namespace import binds its local to", () => {
    const main = [
      'import { counted as tally } from "./lib.js";',
      'import fallback from "./lib.js";',
      'import * as space from "./lib.js";',
      "export const total = tally() + fallback() + space.counted();",
      "",
    ].join("\n");

    expect(
      referencesOf(
        {
          "package.json": ESM,
          "lib.ts": [
            "export function counted(): number {",
            "  return 1;",
            "}",
            "export default function pad(): number {",
            "  return 2;",
            "}",
            "",
          ].join("\n"),
          "main.ts": main,
        },
        byName,
        { panicsOn: asking(main, "tally()", "fallback()", "space.") },
      ),
      "the exported name a renamed import and a default import stand for, and every file " +
        "for a namespace",
    ).toEqual([
      "main.ts:4:22 counted",
      "main.ts:4:32 pad",
      "main.ts:4:45 lib.ts",
      "main.ts:4:45 main.ts",
    ]);
  });

  it("names every file through an import assignment, which binds a whole module", () => {
    const main = 'import whole = require("./lib");\nexport const read = whole.libValue;\n';

    expect(
      referencesOf({ "package.json": CJS, ...modules("lib"), "main.ts": main }, byName, {
        panicsOn: asking(main, "whole."),
      }),
    ).toEqual(["main.ts:2:21 lib.ts", "main.ts:2:21 main.ts"]);
  });

  it("names nothing through an import whose exported name no declaration of the target bears", () => {
    const main = 'import { thing as local } from "outside";\nexport const total = local();\n';

    expect(
      referencesOf({ "package.json": ESM, ...modules("lib"), "main.ts": main }, byName, {
        panicsOn: asking(main, "local()"),
      }),
      "the module is no file of the target, so the name it exports is a declaration elsewhere",
    ).toEqual([]);
  });
});

describe("a component file's markup", () => {
  const COMPONENTS = `${JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ESNext",
      module: "NodeNext",
      moduleResolution: "nodenext",
      noEmit: true,
    },
    include: ["**/*.ts", "**/*.vue"],
  })}\n`;
  const APP = [
    '<script setup lang="ts">',
    'import * as space from "./lib.js";',
    'import { otherValue } from "./other.js";',
    "</script>",
    "<template>{{ space.shown }} {{ otherValue }}</template>",
    "",
  ].join("\n");

  it("reads the exports of a module a binding holds whole, and by name what an unanswered binding names", () => {
    expect(
      resolutionsOf(
        {
          "package.json": ESM,
          "tsconfig.json": COMPONENTS,
          "lib.ts": "export const shown = 1;\nconst hidden = 2;\nconsole.log(hidden);\n",
          ...modules("other"),
          "App.vue": APP,
          "main.ts": 'import App from "./App.vue";\nconsole.log(App);\n',
        },
        (reference) => reference.position.path === "App.vue" && read(reference),
        { components: [".vue"], panicsOn: askingAt("App.vue", APP.indexOf("otherValue }") - 1) },
      ),
      "the namespace's module and its export, never the declaration it keeps to itself",
    ).toEqual([
      "App.vue:2:13 lib.ts alias",
      "App.vue:2:13 shown alias",
      "App.vue:3:10 otherValue by-name",
    ]);
  });
});
