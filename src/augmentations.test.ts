import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitterInputOf, findingsOf } from "../__test-helpers__/emitter-input.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { augmentationReferences } from "./augmentations.ts";
import type { Inventory, InventorySymbol, SymbolKind } from "./inventory.ts";
import type { Reference } from "./references.ts";
import { resolve } from "./resolve.ts";

/**
 * Every finding of the fixture's production sweep, as `code path:line name`, analysed in a
 * copy holding its `installed` tree as `node_modules`, which nothing committed carries.
 */
const FINDINGS = ((): string[] => {
  const root = mkdtempSync(join(tmpdir(), "deadset-ts-global-augmentation-"));
  try {
    cpSync(fixture("projects", "global-augmentation"), root, { recursive: true });
    renameSync(join(root, "installed"), join(root, "node_modules"));
    const document = join(root, "deadset.json");
    const { config } = resolve({
      repository: readFileSync(document, "utf8"),
      repositoryLabel: document,
    });
    return findingsOf(emitterInputOf(root, config)).map(
      (finding) =>
        `${finding.code} ${finding.position.path}:${String(finding.position.line)} ${finding.symbol.name}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})();

describe("a declare global block that augments a library interface", () => {
  it("is judged by the members a use reads, from its own file or another", () => {
    expect(FINDINGS.filter((line) => line.includes(" src/pages.ts:"))).toEqual([
      "DS1003 src/pages.ts:5 global.ImportMeta.unread",
    ]);
  });

  it("is used by a test file that reads a member it declares", () => {
    expect(FINDINGS.filter((line) => line.includes(" src/sheets.test.ts:"))).toEqual([]);
  });

  it("is used through every namespace between the member a use reads and the block", () => {
    expect(FINDINGS.filter((line) => line.includes(" src/env.ts:"))).toEqual([
      "DS1003 src/env.ts:5 global.NodeJS.ProcessEnv.UNREAD",
    ]);
  });

  it("is test-only in test-support code where only a test file reads a member it declares", () => {
    expect(FINDINGS.filter((line) => line.includes(" src/support.ts:"))).toEqual([
      "DS1004 src/support.ts:1 global",
      "DS1004 src/support.ts:7 fixtureDir",
      "DS1201 src/support.ts:2 global.ImportMeta",
    ]);
  });
});

describe("a declare global block no use reaches", () => {
  it("is reported with the interface it declares", () => {
    expect(FINDINGS.filter((line) => line.includes(" src/probe.ts:"))).toEqual([
      "DS1002 src/probe.ts:1 global",
      "DS1201 src/probe.ts:2 global.Probe",
    ]);
  });
});

describe("a module augmentation of a library's interface", () => {
  it("is used through the namespace that holds the interface", () => {
    expect(FINDINGS.filter((line) => line.includes(" src/plugins.ts:"))).toEqual([]);
  });

  it("is used through the member a property access reads", () => {
    const root = writeProject({
      "deadset.json": '{ "target": { "kind": "application" } }\n',
      "package.json": '{ "name": "app", "private": true, "type": "module", "main": "./main.ts" }\n',
      "node_modules/lib/package.json": '{ "name": "lib", "types": "./index.d.ts" }\n',
      "node_modules/lib/index.d.ts":
        "export interface Plugins {}\nexport declare const plugins: Plugins;\n",
      "main.ts": [
        'import { plugins } from "lib";',
        "",
        'declare module "lib" {',
        "  interface Plugins {",
        "    search(): void;",
        "  }",
        "}",
        "",
        "plugins.search();",
        "",
      ].join("\n"),
    });
    try {
      const document = join(root, "deadset.json");
      const { config } = resolve({
        repository: readFileSync(document, "utf8"),
        repositoryLabel: document,
      });
      expect(findingsOf(emitterInputOf(root, config)).map((finding) => finding.code)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is used through the member a literal key passed to the library's generic selects", () => {
    const root = writeProject({
      "deadset.json": '{ "target": { "kind": "application" } }\n',
      "package.json": '{ "name": "app", "private": true, "type": "module", "main": "./main.ts" }\n',
      "node_modules/lib/package.json": '{ "name": "lib", "types": "./index.d.ts" }\n',
      "node_modules/lib/index.d.ts": [
        "export interface ProvidedContext {}",
        "export declare function inject<K extends keyof ProvidedContext>(key: K): ProvidedContext[K];",
        "",
      ].join("\n"),
      "main.ts": [
        'import { inject } from "lib";',
        "",
        'declare module "lib" {',
        "  interface ProvidedContext {",
        "    token: string;",
        "    unusedKey: number;",
        "  }",
        "}",
        "",
        'console.log(inject("token"));',
        "",
      ].join("\n"),
    });
    try {
      const document = join(root, "deadset.json");
      const { config } = resolve({
        repository: readFileSync(document, "utf8"),
        repositoryLabel: document,
      });
      expect(
        findingsOf(emitterInputOf(root, config)).map(
          (finding) => `${finding.code} ${finding.symbol.name}`,
        ),
      ).toEqual(["DS1003 lib.ProvidedContext.unusedKey"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("an augmentation of a dependency's interface whose member a string key names", () => {
  it("is read where a method of a dependency's type takes the key through keyof", () => {
    const root = writeProject({
      "package.json":
        '{ "name": "@example/app", "type": "module", "main": "./src/main.ts", "devDependencies": { "@example/runner": "1.0.0" } }\n',
      "node_modules/@example/runner/package.json":
        '{ "name": "@example/runner", "version": "1.0.0", "types": "./index.d.ts" }\n',
      "node_modules/@example/runner/index.d.ts":
        "export interface ProvidedContext {}\nexport interface Project {\n  provide<K extends keyof ProvidedContext>(key: K, value: ProvidedContext[K]): void;\n}\n",
      "src/main.ts":
        'import type { Project } from "@example/runner";\n\ndeclare module "@example/runner" {\n  export interface ProvidedContext {\n    fixtureUrl: string;\n  }\n}\n\nexport function setup(project: Project): void {\n  project.provide("fixtureUrl", "x");\n}\n',
    });
    try {
      const { config } = resolve({
        repository: '{ "target": { "kind": "application" } }',
        repositoryLabel: "deadset.json",
      });
      expect(findingsOf(emitterInputOf(root, config)).map((finding) => finding.code)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Each finding of an application at `main.ts` over `files`, as its code and subject. */
function findingsIn(files: Readonly<Record<string, string>>): string[] {
  const root = writeProject({
    "deadset.json": '{ "target": { "kind": "application" } }\n',
    "package.json": '{ "name": "app", "private": true, "type": "module", "main": "./main.ts" }\n',
    ...files,
  });
  try {
    const document = join(root, "deadset.json");
    const { config } = resolve({
      repository: readFileSync(document, "utf8"),
      repositoryLabel: document,
    });
    return findingsOf(emitterInputOf(root, config)).map(
      (finding) => `${finding.code} ${finding.symbol.name}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("an interface a file that is no module declares", () => {
  it("merges into the global scope, so it is used through the member a use reads", () => {
    expect(
      findingsIn({
        "env.d.ts":
          "interface ImportMeta {\n  glob(pattern: string): Record<string, unknown>;\n  spare(): void;\n}\n",
        "main.ts": 'export const files = import.meta.glob("./x/*");\n',
      }),
    ).toEqual(["DS1203 ImportMeta.spare"]);
  });
});

describe("a module augmentation no import of the target names", () => {
  it("is used through the member a use reads, as a declare global block is", () => {
    expect(
      findingsIn({
        "package.json":
          '{ "name": "app", "private": true, "type": "module", "main": "./main.ts", "dependencies": { "lib": "1.0.0" } }\n',
        "node_modules/lib/package.json": '{ "name": "lib", "types": "./index.d.ts" }\n',
        "node_modules/lib/index.d.ts": 'export { commands } from "./internal.js";\n',
        "node_modules/lib/internal.d.ts":
          "export interface Commands {}\nexport declare const commands: Commands;\n",
        "main.ts": [
          'import { commands } from "lib";',
          "",
          'declare module "lib/internal.js" {',
          "  interface Commands {",
          "    emulate(): void;",
          "  }",
          "}",
          "",
          "commands.emulate();",
          "",
        ].join("\n"),
      }),
    ).toEqual([]);
  });
});

describe("a module augmentation in test-support code", () => {
  it("is test-support code test code reaches, with every declaration it holds", () => {
    const root = writeProject({
      "deadset.json":
        '{ "target": { "kind": "application" }, "analysis": { "min_confidence": "possible" } }\n',
      "package.json":
        '{ "name": "app", "private": true, "type": "module", "main": "./main.ts", "dependencies": { "lib": "1.0.0" } }\n',
      "node_modules/lib/package.json": '{ "name": "lib", "types": "./index.d.ts" }\n',
      "node_modules/lib/index.d.ts":
        "export interface Commands {}\nexport declare const commands: Commands;\n",
      "main.ts": "export const ready = true;\n",
      "support.ts": [
        'import { commands } from "lib";',
        "",
        'declare module "lib" {',
        "  interface Commands {",
        "    emulate(): void;",
        "  }",
        "}",
        "",
        "export function emulate(): void {",
        "  commands.emulate();",
        "}",
        "",
      ].join("\n"),
      "main.test.ts": 'import { emulate } from "./support.js";\n\nemulate();\n',
    });
    try {
      const document = join(root, "deadset.json");
      const { config } = resolve({
        repository: readFileSync(document, "utf8"),
        repositoryLabel: document,
      });
      expect(
        findingsOf(emitterInputOf(root, config)).map(
          (finding) => `${finding.code} ${finding.symbol.name} ${finding.confidence}`,
        ),
      ).toEqual(["DS1004 lib possible", "DS1004 emulate possible", "DS1201 lib.Commands possible"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** One declaration of `path` at its own line, its reference spelling the chain `name`. */
function declared(
  path: string,
  line: number,
  kind: SymbolKind,
  name: string,
  parent: string,
): InventorySymbol {
  return {
    id: `${path}:${String(line)}:1`,
    ref: `ts://./${path}#${kind === "file" ? "" : name}`,
    name: kind === "file" ? path : name,
    kind,
    position: { path, line, column: 1 },
    endLine: line,
    parent,
    exported: false,
    visibility: "public",
    static: false,
  };
}

const MAIN = declared("main.ts", 1, "file", "", "");
const LIB = declared("main.ts", 2, "namespace", "lib", MAIN.id);
const PLUGINS = declared("main.ts", 3, "interface", "lib.P", LIB.id);
const SEARCH = declared("main.ts", 4, "type-member", "lib.P.search", PLUGINS.id);
const GLOBAL = declared("main.ts", 5, "namespace", "global", MAIN.id);
const SPACE = declared("main.ts", 6, "namespace", "global.NS", GLOBAL.id);
const DEEP = declared("main.ts", 7, "interface", "global.NS.Deep", SPACE.id);
const READ = declared("main.ts", 8, "type-member", "global.NS.Deep.read", DEEP.id);
const BOX = declared("main.ts", 9, "class", "global.Box", GLOBAL.id);
const SIZE = declared("main.ts", 10, "class-member", "global.Box.size", BOX.id);
const OUTER = declared("main.ts", 11, "namespace", "Outer", MAIN.id);
const NESTED = declared("main.ts", 12, "namespace", "Outer.global", OUTER.id);
const VALUE = declared("main.ts", 13, "variable", "Outer.global.value", NESTED.id);
const NAMED = declared("main.ts", 14, "interface", "global", MAIN.id);
const FIELD = declared("main.ts", 15, "type-member", "global.field", NAMED.id);
const SCRIPT = declared("script.ts", 1, "file", "", "");
const SHAPE = declared("script.ts", 2, "interface", "Shape", SCRIPT.id);
const AREA = declared("script.ts", 3, "type-member", "Shape.area", SHAPE.id);

/** The inventory of a module holding a module augmentation, a `declare global` block and look-alikes, and a script. */
const HELD: Inventory = {
  symbols: [MAIN, LIB, PLUGINS, SEARCH, GLOBAL, SPACE, DEEP, READ, BOX, SIZE].concat([
    OUTER,
    NESTED,
    VALUE,
    NAMED,
    FIELD,
    SCRIPT,
    SHAPE,
    AREA,
  ]),
  declarations: new Map(),
  cost: { batches: 0, exportTables: 0, memberTables: 0 },
  unanswered: [],
  byName: new Map(),
  modules: new Map([[LIB.id, "lib"]]),
  dependents: new Map(),
};

/** A write from the file to one declaration, made by a test file at a line of its own. */
function written(to: InventorySymbol): Reference {
  return {
    from: MAIN.id,
    to: to.id,
    position: { path: "main.ts", line: 20, column: 3 },
    use: "write",
    resolution: "contextual",
    test: true,
  };
}

/** What each reference reads through, by the name of the declaration read. */
function readThrough(to: InventorySymbol, scripts?: ReadonlySet<string>): string[] {
  const byId = new Map(HELD.symbols.map((symbol) => [symbol.id, symbol.name]));
  return augmentationReferences(HELD, [written(to)], scripts).map(
    (reference) => byId.get(reference.to) ?? reference.to,
  );
}

describe("a use of a declaration an augmentation holds", () => {
  it("reads every interface and namespace between it and a declare global block, and the block, where the use is", () => {
    expect(augmentationReferences(HELD, [written(READ)])).toEqual(
      [DEEP, SPACE, GLOBAL].map((to) => ({ ...written(to), use: "read" })),
    );
  });

  it("reads no other container between it and the block", () => {
    expect(readThrough(SIZE)).toEqual(["global"]);
  });

  it("reads the interfaces of a module declaration, and the declaration", () => {
    expect(readThrough(SEARCH)).toEqual(["lib.P", "lib"]);
  });

  it("reads the interfaces a script's global scope holds, and not the script", () => {
    expect(readThrough(AREA, new Set([SCRIPT.id]))).toEqual(["Shape"]);
    expect(readThrough(AREA)).toEqual([]);
  });

  it("reads nothing where no augmentation holds the declaration, a namespace or interface named global included", () => {
    expect(readThrough(VALUE)).toEqual([]);
    expect(readThrough(FIELD)).toEqual([]);
  });
});
