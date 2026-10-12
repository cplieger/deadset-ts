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

  it("loads nothing where the constructor, the base, the method or the path is another", () => {
    expect(
      referencesOf(
        {
          "package.json": ESM,
          ...modules("constructed", "pattern", "based", "metaBased", "called", "metaCalled"),
          "pkg/inner.ts": "export const innerValue = 1;\n",
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
            'export const inner = new URL("pkg/./inner.ts", import.meta.url);',
            "",
          ].join("\n"),
        },
        evaluation,
      ),
      "a class the target declares and one it does not, `new.target` for `import.meta`, another member of `import.meta`, " +
        "and a path that starts with neither ./ nor ../",
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
