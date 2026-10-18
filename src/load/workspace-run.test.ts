import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { runAnalysis, type RunAnalysis } from "../analysis.ts";
import type { Host } from "../host.ts";
import { resolve } from "../resolve.ts";
import { run } from "../run.ts";
import { scopeForDir } from "../scope.ts";
import { openEngine, type Engine } from "../session.ts";
import { writtenPath } from "./workspace-programs.ts";
import { baseUrlPaths } from "./plan.ts";
import { layoutOf, workspaceRun } from "./workspace-run.ts";
import { findWorkspace } from "./workspace.ts";

/**
 * Workspaces written to a fresh directory per case, because a package manager's links
 * are symbolic links under `node_modules`, which nothing committed carries. Each tree
 * holds a `.git` directory at its root, so the workspace search ends there.
 */

const written: string[] = [];

afterEach(() => {
  for (const root of written.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A compiler configuration for one package, `extra` merged into its options. */
function tsconfig(extra: Record<string, unknown> = {}, more: Record<string, unknown> = {}): string {
  return JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ESNext",
      module: "NodeNext",
      moduleResolution: "nodenext",
      ...extra,
    },
    include: ["src/**/*.ts"],
    ...more,
  });
}

/** A package manifest. */
function manifest(fields: Record<string, unknown>): string {
  return JSON.stringify({ version: "1.0.0", type: "module", ...fields });
}

/**
 * One workspace: each `files` entry is a path below the root and its text, and each
 * `links` entry a link path below the root and the directory below the root it names.
 */
function writeWorkspace(
  files: Readonly<Record<string, string>>,
  links: Readonly<Record<string, string>> = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "deadset-ts-workspace-"));
  written.push(root);
  mkdirSync(join(root, ".git"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(join(root, target), join(root, path));
  }
  return root;
}

/** An engine that reads `.vue` files as component files, as the command reads them by default. */
function componentEngine(): Engine {
  return openEngine({
    collectTiming: false,
    components: { extensions: [".vue"], host: nodeHost() },
  });
}

/** The analysis of one target under one repository configuration. */
function analyze(
  target: string,
  repository: Record<string, unknown> = {},
  engine: Engine = componentEngine(),
): RunAnalysis {
  const { config, provenance } = resolve({
    repository: {
      text: JSON.stringify({ target: { kind: "application" }, ...repository }),
      label: "deadset.json",
    },
  });
  const host = nodeHost();
  return runAnalysis(engine, host, scopeForDir(host, target), config, provenance, {
    production: true,
  });
}

/** Each finding as its code, its file and the name of what it is about. */
function found(analysis: RunAnalysis): string[] {
  return analysis.result.findings
    .map((finding) => `${finding.code} ${finding.position.path} ${finding.symbol.name}`)
    .sort();
}

/** What one run reads of the workspace at `root` for the configurations named below it. */
function workspaceOf(
  root: string,
  configFiles: readonly string[],
  engine: Engine,
): ReturnType<typeof workspaceRun> {
  return workspaceRun(
    engine,
    nodeHost(),
    root,
    configFiles.map((name) => {
      const configFile = join(root, name);
      const parsed = engine.parseConfigFile(configFile);
      const paths = baseUrlPaths(parsed.options);
      return {
        configFile,
        parsed,
        options: paths === undefined ? parsed.options : { ...parsed.options, paths },
      };
    }),
    { entries: [], declaresExports: false },
    findWorkspace(nodeHost(), root, (configFile) => layoutOf(engine, configFile)),
  );
}

/** `b` uses one export of `a`, which publishes it from an unbuilt `dist/`. */
const UNBUILT: Readonly<Record<string, string>> = {
  "package.json": manifest({ name: "root", private: true, workspaces: ["packages/*"] }),
  "packages/a/package.json": manifest({
    name: "a",
    private: true,
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
  }),
  "packages/a/tsconfig.json": tsconfig({ outDir: "dist", rootDir: "src", declaration: true }),
  "packages/a/src/index.ts":
    "export function usedBySibling(): number {\n  return 1;\n}\n\nexport function usedByNobody(): number {\n  return 2;\n}\n",
  "packages/b/package.json": manifest({
    name: "b",
    private: true,
    bin: { b: "./src/main.ts" },
    dependencies: { a: "workspace:*" },
  }),
  "packages/b/tsconfig.json": tsconfig(),
  "packages/b/src/main.ts": 'import { usedBySibling } from "a";\n\nconsole.log(usedBySibling());\n',
};

/** `b` imports `a`, whose source imports a third package `c`, read only once `a`'s source is. */
const THIRD: Readonly<Record<string, string>> = {
  ...UNBUILT,
  "packages/a/package.json": manifest({
    name: "a",
    private: true,
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    dependencies: { c: "workspace:*" },
  }),
  "packages/a/src/index.ts":
    'import { usedByA } from "c";\n\nexport function usedBySibling(): number {\n  return usedByA();\n}\n',
  "packages/c/package.json": manifest({
    name: "c",
    private: true,
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
  }),
  "packages/c/tsconfig.json": tsconfig({ outDir: "dist", rootDir: "src", declaration: true }),
  "packages/c/src/index.ts": "export function usedByA(): number {\n  return 1;\n}\n",
};

const THIRD_CONFIGURATIONS = {
  analysis: {
    configurations: [
      { id: "b", project: "packages/b/tsconfig.json" },
      { id: "c", project: "packages/c/tsconfig.json" },
    ],
  },
};

describe("a workspace package imported by name", () => {
  it("is read from the source its unbuilt output is compiled from", () => {
    const root = writeWorkspace(UNBUILT);

    expect(found(analyze(root))).toEqual(["DS1001 packages/a/src/index.ts usedByNobody"]);
  });

  it("is read from the source a condition the importer lists names, through the link", () => {
    const root = writeWorkspace(
      {
        ...UNBUILT,
        "packages/a/package.json": manifest({
          name: "a",
          private: true,
          exports: {
            ".": {
              "@w/source": "./src/index.ts",
              types: "./dist/index.d.ts",
              default: "./dist/index.js",
            },
          },
        }),
        "packages/a/tsconfig.json": tsconfig({ noEmit: true }),
        "packages/b/package.json": manifest({
          name: "b",
          private: true,
          bin: { b: "./src/main.ts" },
        }),
        "packages/b/tsconfig.json": tsconfig({ customConditions: ["@w/source"] }),
      },
      { "packages/b/node_modules/a": "packages/a" },
    );

    expect(found(analyze(root))).toEqual(["DS1001 packages/a/src/index.ts usedByNobody"]);
  });

  it("is judged by no configuration that reaches it only through an import", () => {
    const root = writeWorkspace(UNBUILT);
    const analysis = analyze(root, {
      analysis: { configurations: [{ id: "b", project: "packages/b/tsconfig.json" }] },
    });

    expect(found(analysis)).toEqual([]);
  });

  it("is judged by no configuration where no configuration compiles a file of its own package", () => {
    const root = writeWorkspace({
      ...UNBUILT,
      "packages/b/src/main.ts":
        'import { usedBySibling } from "a";\nimport { helper } from "../extra/helper.js";\n\nconsole.log(usedBySibling(), helper());\n',
      "packages/b/extra/helper.ts":
        "export function helper(): number {\n  return 1;\n}\n\nexport function notCalled(): number {\n  return 2;\n}\n",
    });

    expect(found(analyze(root))).toEqual(["DS1001 packages/a/src/index.ts usedByNobody"]);
  });

  it("does not refuse the importer for an error its source has only under the importer's options", () => {
    const root = writeWorkspace({
      ...UNBUILT,
      "packages/a/tsconfig.json": tsconfig({
        strict: false,
        outDir: "dist",
        rootDir: "src",
        declaration: true,
      }),
      "packages/a/src/index.ts":
        "export function usedBySibling(value) {\n  return value;\n}\n\nexport function usedByNobody(): number {\n  return 2;\n}\n",
      "packages/b/src/main.ts":
        'import { usedBySibling } from "a";\n\nconsole.log(usedBySibling(1));\n',
    });

    expect(found(analyze(root))).toEqual(["DS1001 packages/a/src/index.ts usedByNobody"]);
  });

  it("counts the uses one package's source makes of a third package it imports", () => {
    const root = writeWorkspace(THIRD);
    const analysis = analyze(root, THIRD_CONFIGURATIONS);

    expect(found(analysis)).toEqual([]);
  });

  it("counts the uses one package's source makes of a third package it imports, in a run that reads no component file", () => {
    const root = writeWorkspace(THIRD);
    const analysis = analyze(root, THIRD_CONFIGURATIONS, openEngine({ collectTiming: false }));

    expect(found(analysis)).toEqual([]);
  });

  it("binds no inline directive written in its source to the importer", () => {
    const root = writeWorkspace({
      ...UNBUILT,
      "packages/a/src/index.ts":
        "export function usedBySibling(): number {\n  return 1;\n}\n\n// deadset:ignore DS1001 -- kept for the next release\nexport function usedByNobody(): number {\n  return 2;\n}\n",
    });
    const analysis = analyze(root, {
      analysis: { configurations: [{ id: "b", project: "packages/b/tsconfig.json" }] },
    });

    expect(analysis.result.staleSuppressions).toEqual([]);
  });

  it("is read from source by an importer that references a configuration with no composite output", () => {
    const root = writeWorkspace({
      ...UNBUILT,
      "packages/b/tsconfig.json": tsconfig({}, { references: [{ path: "../a/tsconfig.json" }] }),
    });

    expect(found(analyze(root))).toEqual(["DS1001 packages/a/src/index.ts usedByNobody"]);
  });

  it("is read from source by an importer that references by its directory a configuration with no composite output", () => {
    const root = writeWorkspace({
      ...UNBUILT,
      "packages/b/tsconfig.json": tsconfig({}, { references: [{ path: "../a" }] }),
    });

    expect(found(analyze(root))).toEqual(["DS1001 packages/a/src/index.ts usedByNobody"]);
  });

  it("is read from source through the output of a configuration referenced by its directory", () => {
    const root = writeWorkspace({
      ...UNBUILT,
      "packages/a/tsconfig.json": tsconfig({ composite: true, outDir: "dist", rootDir: "src" }),
      "packages/b/tsconfig.json": tsconfig({}, { references: [{ path: "../a" }] }),
      "packages/b/src/main.ts":
        'import { usedBySibling } from "a";\nimport { usedByNobody } from "../../a/dist/index.js";\n\nconsole.log(usedBySibling(), usedByNobody());\n',
    });

    expect(found(analyze(root))).toEqual([]);
  });

  it("is read from source through the output of a configuration referenced by its file", () => {
    const root = writeWorkspace({
      ...UNBUILT,
      "packages/a/tsconfig.json": tsconfig({ composite: true, outDir: "dist", rootDir: "src" }),
      "packages/b/tsconfig.json": tsconfig({}, { references: [{ path: "../a/tsconfig.json" }] }),
      "packages/b/src/main.ts":
        'import { usedBySibling } from "a";\nimport { usedByNobody } from "../../a/dist/index.js";\n\nconsole.log(usedBySibling(), usedByNobody());\n',
    });

    expect(found(analyze(root))).toEqual([]);
  });

  it("is read from source through the output of a configuration referenced beside one with no composite output", () => {
    const root = writeWorkspace({
      ...UNBUILT,
      "packages/a/tsconfig.json": tsconfig({ composite: true, outDir: "dist", rootDir: "src" }),
      "packages/c/package.json": manifest({ name: "c", private: true }),
      "packages/c/tsconfig.json": tsconfig(),
      "packages/c/src/index.ts": "export const unrelated = 1;\n",
      "packages/b/tsconfig.json": tsconfig(
        {},
        { references: [{ path: "../c" }, { path: "../a/tsconfig.json" }] },
      ),
      "packages/b/src/main.ts":
        'import { usedBySibling } from "a";\nimport { usedByNobody } from "../../a/dist/index.js";\n\nconsole.log(usedBySibling(), usedByNobody());\n',
    });

    expect(found(analyze(root))).toEqual([
      "DS1001 packages/c/src/index.ts unrelated",
      "DS1602 packages/c/src/index.ts packages/c/src/index.ts",
    ]);
  });

  it("is read from source by an importer whose root directory holds only its own source", () => {
    const root = writeWorkspace({
      ...UNBUILT,
      "packages/b/tsconfig.json": tsconfig({ rootDir: "src", outDir: "dist" }),
    });

    expect(found(analyze(root))).toEqual(["DS1001 packages/a/src/index.ts usedByNobody"]);
  });

  it("is held by every configuration that reads it, also through another package's installed declarations", () => {
    // `a` reaches `b`'s source only through `d`'s declaration file, which `a` meets
    // through `node_modules`, so the compiler counts `b`'s files as a library's for `a`.
    // The same files reached first from `a`'s own source would not be, and which
    // arrival the compiler follows first is not fixed.
    const root = writeWorkspace(
      {
        "package.json": manifest({ name: "root", private: true, workspaces: ["packages/*"] }),
        "packages/a/package.json": manifest({
          name: "a",
          private: true,
          bin: { a: "./src/main.ts" },
          dependencies: { d: "workspace:*" },
        }),
        "packages/a/tsconfig.json": tsconfig(),
        "packages/a/src/main.ts": 'import { fromD } from "d";\n\nconsole.log(fromD);\n',
        "packages/d/package.json": manifest({
          name: "d",
          private: true,
          types: "./index.d.ts",
          dependencies: { b: "workspace:*" },
        }),
        "packages/d/index.d.ts":
          'import { used } from "b";\n\nexport declare const fromD: ReturnType<typeof used>;\n',
        "packages/b/package.json": manifest({
          name: "b",
          private: true,
          exports: { ".": { types: "./src/index.ts", default: "./src/index.ts" } },
        }),
        "packages/b/tsconfig.json": tsconfig({ noEmit: true }),
        "packages/b/src/index.ts": 'export { used } from "./m1.js";\n',
        "packages/b/src/m1.ts":
          "export function used(): number {\n  return 1;\n}\n\nexport function unusedInB(): number {\n  return 2;\n}\n",
      },
      { "packages/a/node_modules/d": "packages/d", "packages/d/node_modules/b": "packages/b" },
    );
    const runs = [1, 2, 3, 4].map(() => analyze(root).result.findings);

    expect(
      runs[0]?.map(
        (finding) =>
          `${finding.code} ${finding.position.path} ${finding.symbol.name} ${finding.configurations.join(" ")}`,
      ),
    ).toEqual([
      "DS1001 packages/b/src/m1.ts unusedInB packages/a/tsconfig.json packages/b/tsconfig.json",
    ]);
    expect(new Set(runs.map((findings) => JSON.stringify(findings))).size).toBe(1);
  }, 30_000);

  it("is read from the same source by a run that reads no component file", () => {
    const root = writeWorkspace(UNBUILT);

    expect(found(analyze(root, {}, openEngine({ collectTiming: false })))).toEqual([
      "DS1001 packages/a/src/index.ts usedByNobody",
    ]);
  });

  it("is resolved from the target's workspace when the target is one of its packages", () => {
    const root = writeWorkspace(UNBUILT);

    expect(found(analyze(join(root, "packages/b")))).toEqual([]);
  });

  it.each([
    {
      condition: "node under nodenext",
      exports: { node: "./src/node.ts", default: "./src/index.ts" },
      options: {},
      type: "module",
      unread: "index.ts",
    },
    {
      condition: "node under node16",
      exports: { node: "./src/node.ts", default: "./src/index.ts" },
      options: { module: "Node16", moduleResolution: "node16" },
      type: "module",
      unread: "index.ts",
    },
    {
      condition: "default rather than node under bundler",
      exports: { node: "./src/node.ts", default: "./src/index.ts" },
      options: { module: "ESNext", moduleResolution: "bundler" },
      type: "module",
      unread: "node.ts",
    },
    {
      condition: "import from an ES module",
      exports: { require: "./src/cjs.ts", import: "./src/esm.ts" },
      options: {},
      type: "module",
      unread: "cjs.ts",
    },
    {
      condition: "require from a CommonJS module",
      exports: { require: "./src/cjs.ts", import: "./src/esm.ts" },
      options: {},
      type: "commonjs",
      unread: "esm.ts",
    },
  ])(
    "is read from the source its $condition condition names",
    ({ exports, options, type, unread }) => {
      const sources = Object.fromEntries(
        Object.values(exports).map((target) => [
          `packages/a/${target.slice(2)}`,
          "export const shared = 1;\n",
        ]),
      );
      const root = writeWorkspace({
        ...UNBUILT,
        "packages/a/package.json": manifest({
          name: "a",
          private: true,
          exports: { ".": exports },
        }),
        "packages/a/tsconfig.json": tsconfig({ noEmit: true }),
        ...sources,
        "packages/b/package.json": manifest({
          name: "b",
          private: true,
          type,
          bin: { b: "./src/main.ts" },
          dependencies: { a: "workspace:*" },
        }),
        "packages/b/tsconfig.json": tsconfig(options),
        "packages/b/src/main.ts": 'import { shared } from "a";\n\nconsole.log(shared);\n',
      });

      expect(
        found(analyze(root, {}, openEngine({ collectTiming: false }))).filter((one) =>
          one.endsWith(" shared"),
        ),
      ).toEqual([`DS1001 packages/a/src/${unread} shared`]);
    },
  );
});

/**
 * What the last snapshot of one run opens, which is the session's: the configurations
 * written for it, the programs built, and every file its projects hold.
 */
function sessionKinds(): {
  readonly engine: Engine;
  readonly opened: { written: number; built: number };
  readonly files: string[];
} {
  const real = componentEngine();
  const opened = { written: 0, built: 0 };
  const files: string[] = [];
  const engine: Engine = {
    ...real,
    createSnapshot: (openProjects, createPrograms, configurations) => {
      opened.written = configurations?.size ?? 0;
      opened.built = createPrograms?.length ?? 0;
      const snapshot = real.createSnapshot(openProjects, createPrograms, configurations);
      files.splice(
        0,
        files.length,
        ...snapshot.getProjects().flatMap((project) => project.program.getSourceFileNames()),
      );
      return snapshot;
    },
  };
  return { engine, opened, files };
}

describe("a component file of a workspace package", () => {
  /** `b`'s component is the only importer of `a`, and `b`'s own source imports the component. */
  const COMPONENT: Readonly<Record<string, string>> = {
    ...UNBUILT,
    "packages/b/src/main.ts": 'import Widget from "./Widget.vue";\n\nconsole.log(Widget);\n',
    "packages/b/src/Widget.vue":
      '<script setup lang="ts">\nimport { usedBySibling } from "a";\nconst count = usedBySibling();\n</script>\n\n<template>{{ count }}</template>\n',
  };

  it("is read, and the workspace imports only it makes are read from source", () => {
    const root = writeWorkspace(COMPONENT);
    const { engine, opened } = sessionKinds();
    const analysis = analyze(root, {}, engine);

    expect(found(analysis)).toEqual(["DS1001 packages/a/src/index.ts usedByNobody"]);
    expect(analysis.swept.componentFiles).toEqual(["packages/b/src/Widget.vue"]);
    expect(analysis.run.typeErrorSkips).toEqual([]);
    expect(opened).toEqual({ written: 1, built: 0 });
  });

  it("is judged as the package's own file where its file list names it, its markup holding the member it names", () => {
    const root = writeWorkspace({
      ...COMPONENT,
      "packages/b/tsconfig.json": tsconfig({}, { include: ["src/**/*.ts", "src/**/*.vue"] }),
      "packages/b/src/Widget.vue":
        '<script setup lang="ts">\nimport { usedBySibling } from "a";\ninterface Row {\n  label: number;\n  spare: number;\n}\nconst row: Row = { label: usedBySibling(), spare: 0 };\n</script>\n\n<template>{{ row.label }}</template>\n',
    });
    const analysis = analyze(root);

    expect(found(analysis)).toEqual([
      "DS1001 packages/a/src/index.ts usedByNobody",
      "DS1301 packages/b/src/Widget.vue Row.spare",
    ]);
  });

  it("is read beside the workspace imports the package's own source makes", () => {
    const root = writeWorkspace({
      ...COMPONENT,
      "packages/b/src/main.ts":
        'import { usedBySibling } from "a";\nimport Widget from "./Widget.vue";\n\nconsole.log(usedBySibling, Widget);\n',
      "packages/b/src/Widget.vue":
        '<script setup lang="ts">\nimport { usedByNobody } from "a";\nconst count = usedByNobody();\n</script>\n\n<template>{{ count }}</template>\n',
    });
    const analysis = analyze(root);

    expect(found(analysis)).toEqual([]);
    expect(analysis.swept.componentFiles).toEqual(["packages/b/src/Widget.vue"]);
  });

  it("leaves the configuration's file list as it was when its output directory sits under its files", () => {
    const root = writeWorkspace({
      ...COMPONENT,
      "packages/b/tsconfig.json": tsconfig({ outDir: "dist" }, { include: undefined }),
      "packages/b/dist/stale.ts": "export const stale = 1;\n",
    });
    const { engine, opened, files } = sessionKinds();
    const analysis = analyze(root, {}, engine);

    expect(files.filter((file) => file.includes("/packages/b/dist/"))).toEqual([]);
    expect(found(analysis)).toEqual(["DS1001 packages/a/src/index.ts usedByNobody"]);
    expect(analysis.swept.componentFiles).toEqual(["packages/b/src/Widget.vue"]);
    expect(opened).toEqual({ written: 1, built: 0 });
  });

  it("is read where the configuration imports a JavaScript member, its own JavaScript files kept out of its file list", () => {
    const root = writeWorkspace({
      "package.json": manifest({ name: "root", private: true, workspaces: ["packages/*"] }),
      "packages/a/package.json": manifest({ name: "a", exports: "./index.js" }),
      "packages/a/index.js":
        "export function usedBySibling() {\n  return 1;\n}\n\nexport function usedByNobody() {\n  return 2;\n}\n",
      "packages/b/package.json": manifest({ name: "b", dependencies: { a: "1.0.0" } }),
      "packages/b/tsconfig.json": tsconfig({}, { include: ["src"] }),
      "packages/b/src/main.ts": 'import Widget from "./Widget.vue";\n\nconsole.log(Widget);\n',
      "packages/b/src/Widget.vue":
        '<script setup lang="ts">\nimport { usedBySibling } from "a";\nconst count = usedBySibling();\n</script>\n\n<template>{{ count }}</template>\n',
      "packages/b/src/legacy.js": 'console.log("legacy");\n',
    });
    const analysis = analyze(root);

    expect(analysis.run.componentsUnread).toEqual([]);
    expect(analysis.swept.componentFiles).toEqual(["packages/b/src/Widget.vue"]);
  });

  /**
   * `vendor/` links `a` to a package outside the workspace, so the configuration reads
   * `a` as the member's source from `src/` and as that package from `vendor/`.
   */
  function twoFilesForOneSpecifier(): string {
    return writeWorkspace(
      {
        ...COMPONENT,
        "packages/b/tsconfig.json": tsconfig({}, { include: ["src/**/*.ts", "vendor/**/*.ts"] }),
        "packages/b/src/main.ts":
          'import { usedBySibling } from "a";\nimport Widget from "./Widget.vue";\n\nconsole.log(usedBySibling, Widget);\n',
        "packages/b/vendor/legacy.ts": 'import { legacy } from "a";\n\nconsole.log(legacy);\n',
        "other/a/package.json": manifest({ name: "a", types: "./index.d.ts" }),
        "other/a/index.d.ts": "export declare const legacy: number;\n",
      },
      { "packages/b/vendor/node_modules/a": "other/a" },
    );
  }

  it("is not read, and the reason is named, where one specifier is read as two files", () => {
    const root = twoFilesForOneSpecifier();
    const { engine, opened } = sessionKinds();
    const analysis = analyze(root, {}, engine);

    expect(analysis.run.componentsUnread).toEqual([
      {
        configFile: join(root, "packages/b/tsconfig.json"),
        reason:
          "the imports of a are read as 2 different files, which a configuration cannot state",
      },
    ]);
    expect(opened).toEqual({ written: 0, built: 1 });
    expect(analysis.swept.componentFiles).toEqual([]);
  });

  it("names on standard error the configuration whose component files are not read", () => {
    const root = twoFilesForOneSpecifier();
    writeFileSync(join(root, "deadset.json"), JSON.stringify({ target: { kind: "application" } }));
    const err: string[] = [];
    const host: Host = { ...nodeHost(), workingDirectory: () => root };
    run(
      ["analyze", "--target=.", `--report=${join(root, "report.json")}`],
      { write: () => undefined },
      { write: (text) => err.push(text) },
      host,
    );

    expect(err).toContain(
      "deadset-ts: packages/b/tsconfig.json: its component files are not read: the imports of a are read as 2 different files, which a configuration cannot state\n",
    );
  });
});

describe("a workspace package with no source to read", () => {
  /** `b` imports `c`, whose manifest names a bundler's `dist/` and whose configuration emits nothing. */
  const BUNDLED: Readonly<Record<string, string>> = {
    "package.json": manifest({ name: "root", private: true, workspaces: ["packages/*"] }),
    "packages/c/package.json": manifest({
      name: "c",
      private: true,
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      dependencies: {},
    }),
    "packages/c/tsconfig.json": tsconfig({ noEmit: true }),
    "packages/c/src/index.ts": "export function fromSource(): number {\n  return 1;\n}\n",
    "packages/b/package.json": manifest({
      name: "b",
      private: true,
      bin: { b: "./src/main.ts" },
      dependencies: { c: "workspace:*" },
    }),
    "packages/b/tsconfig.json": tsconfig(),
    "packages/b/src/main.ts": 'import { fromSource } from "c";\n\nconsole.log(fromSource());\n',
  };

  it("drops the derived configuration that imports it, naming the package and the fix", () => {
    const root = writeWorkspace(BUNDLED);
    const analysis = analyze(root);

    expect(analysis.run.notBuilt.map((one) => one.id)).toEqual(["packages/b/tsconfig.json"]);
    expect(analysis.run.notBuilt[0]?.error).toMatch(
      /^setup failure: workspace-member-without-source: .*packages\/b\/src\/main\.ts imports c, a package of the workspace with no source to read/u,
    );
  });

  it("names the first import with no source and counts the others", () => {
    const root = writeWorkspace({
      ...BUNDLED,
      "packages/b/src/main.ts":
        'import { fromSource } from "c";\nimport { other } from "./sub/other.js";\n\nconsole.log(fromSource(), other);\n',
      "packages/b/src/sub/other.ts":
        'import { fromSource } from "c";\n\nexport const other = fromSource();\n',
    });

    expect(analyze(root).run.notBuilt[0]?.error).toMatch(
      /imports c, a package of the workspace with no source to read: .* \(and 1 more\)$/u,
    );
  });

  it("does not refuse a configuration for an import of it a third-party package's declarations make", () => {
    const root = writeWorkspace(
      {
        ...BUNDLED,
        "packages/b/src/main.ts": 'import { fromLib } from "lib";\n\nconsole.log(fromLib);\n',
        "node_modules/lib/package.json": JSON.stringify({
          name: "lib",
          version: "1.0.0",
          type: "module",
          types: "./index.d.ts",
        }),
        "node_modules/lib/index.d.ts":
          'import type { fromSource } from "c";\n\nexport declare const fromLib: ReturnType<typeof fromSource>;\n',
      },
      { "node_modules/c": "packages/c" },
    );
    const run = workspaceOf(
      root,
      ["packages/b/tsconfig.json"],
      openEngine({ collectTiming: false }),
    );

    expect(run?.unbuildable(join(root, "packages/b/tsconfig.json"))).toBeUndefined();
  });

  it("refuses the run when the configuration that imports it is a named one", () => {
    const root = writeWorkspace(BUNDLED);

    expect(() =>
      analyze(root, {
        analysis: {
          configurations: [
            { id: "b", project: "packages/b/tsconfig.json" },
            { id: "c", project: "packages/c/tsconfig.json" },
          ],
        },
      }),
    ).toThrow(
      /^setup failure: workspace-member-without-source: .*imports c, a package of the workspace with no source to read/u,
    );
  });

  it("does not refuse a configuration that holds the import only in another package's source", () => {
    const root = writeWorkspace({
      ...BUNDLED,
      "packages/a/package.json": manifest({
        name: "a",
        private: true,
        exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
        dependencies: { c: "workspace:*" },
      }),
      "packages/a/tsconfig.json": tsconfig({ outDir: "dist", rootDir: "src", declaration: true }),
      "packages/a/src/index.ts":
        'import { fromSource } from "c";\n\nexport function viaA(): number {\n  return fromSource();\n}\n',
      "packages/b/package.json": manifest({
        name: "b",
        private: true,
        bin: { b: "./src/main.ts" },
        dependencies: { a: "workspace:*" },
      }),
      "packages/b/src/main.ts": 'import { viaA } from "a";\n\nconsole.log(viaA());\n',
    });
    const analysis = analyze(root, {
      analysis: { configurations: [{ id: "b", project: "packages/b/tsconfig.json" }] },
    });

    expect(analysis.run.projects.map((one) => one.id)).toEqual(["b"]);
  });

  it("is read as installed once a dist/ none of its configurations writes is built", () => {
    const root = writeWorkspace(
      {
        ...BUNDLED,
        "packages/c/dist/index.d.ts": "export declare function fromSource(): number;\n",
        "packages/c/dist/index.js": "export function fromSource() {\n  return 1;\n}\n",
      },
      { "packages/b/node_modules/c": "packages/c" },
    );
    const analysis = analyze(root);

    expect(analysis.run.notBuilt).toEqual([]);
    expect(found(analysis).filter((one) => one.includes("packages/c/dist/"))).toEqual([]);
  });
});

describe("a third-party package installed in a workspace", () => {
  it("has nothing reported in its declarations", () => {
    const root = writeWorkspace({
      ...UNBUILT,
      "packages/b/src/main.ts":
        'import { usedBySibling } from "a";\nimport { fromLib } from "lib";\n\nconsole.log(usedBySibling(), fromLib());\n',
      "node_modules/lib/package.json": JSON.stringify({
        name: "lib",
        version: "1.0.0",
        type: "module",
        exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
      }),
      "node_modules/lib/index.d.ts":
        "export declare function fromLib(): number;\nexport declare function unusedInLib(): number;\n",
      "node_modules/lib/index.js":
        "export function fromLib() {\n  return 1;\n}\nexport function unusedInLib() {\n  return 2;\n}\n",
    });

    expect(found(analyze(root))).toEqual(["DS1001 packages/a/src/index.ts usedByNobody"]);
  });
});

describe("the entry points of another workspace package", () => {
  it("include every file a wildcard export of a published package names", () => {
    const root = writeWorkspace({
      "package.json": manifest({ name: "root", private: true, workspaces: ["packages/*"] }),
      "packages/a/package.json": manifest({ name: "a", exports: { "./*": "./src/*.ts" } }),
      "packages/a/tsconfig.json": tsconfig({ noEmit: true }),
      "packages/a/src/util.ts": "export function helper(): number {\n  return 1;\n}\n",
    });

    expect(found(analyze(root))).toEqual([]);
  });
});

describe("a target in no workspace", () => {
  it("opens every configuration as a project and builds no program", () => {
    const root = writeWorkspace({
      "package.json": manifest({ name: "solo", bin: { solo: "./src/main.ts" } }),
      "tsconfig.json": tsconfig(),
      "src/main.ts": "console.log(1);\n",
    });
    const real = openEngine({ collectTiming: false });
    let resolvers = 0;
    let built = 0;
    const engine: Engine = {
      ...real,
      createSnapshot: (openProjects, createPrograms) => {
        built += createPrograms?.length ?? 0;
        return real.createSnapshot(openProjects, createPrograms);
      },
      createModuleResolver: (options, entries) => {
        resolvers += 1;
        return real.createModuleResolver(options, entries);
      },
    };

    analyze(root, {}, engine);

    expect({ resolvers, built }).toEqual({ resolvers: 0, built: 0 });
  });
});

describe("a configuration that imports a workspace package, in a run that reads no component file", () => {
  const configFile = "packages/b/tsconfig.json";

  /** The program `b`'s configuration is built as, its options by name and its references. */
  function programOf(files: Readonly<Record<string, string>>): Record<string, unknown> {
    const root = writeWorkspace(files);
    const program = workspaceOf(
      root,
      [configFile],
      openEngine({ collectTiming: false }),
    )?.programs.get(join(root, configFile));
    return program?.kind === "program"
      ? {
          options: Object.keys(program.params.compilerOptions ?? {}).sort(),
          declaration: program.params.compilerOptions?.declaration,
          references: program.params.options?.projectReferences?.map((one) =>
            one.path.slice(root.length + 1),
          ),
        }
      : { kind: program?.kind };
  }

  it("is built with its own options and no references where it states none", () => {
    expect(programOf(UNBUILT)).toEqual({
      options: ["configFilePath", "module", "moduleResolution", "strict", "target"],
      declaration: undefined,
      references: undefined,
    });
  });

  it("is built without its output layout, still emitting declarations where it is composite, and with its references", () => {
    expect(
      programOf({
        ...UNBUILT,
        [configFile]: tsconfig(
          { composite: true, outDir: "dist", rootDir: "src" },
          { references: [{ path: "../a" }] },
        ),
      }),
    ).toEqual({
      options: ["configFilePath", "declaration", "module", "moduleResolution", "strict", "target"],
      declaration: true,
      references: ["packages/a"],
    });
  });

  it("writes no configuration for the snapshots, builds programs, and sends no round trip without a question", () => {
    const root = writeWorkspace(UNBUILT);
    const real = openEngine({ collectTiming: false });
    const sent = { written: 0, built: 0, empty: 0 };
    const engine: Engine = {
      ...real,
      createSnapshot: (openProjects, createPrograms, configurations) => {
        sent.written += configurations?.size ?? 0;
        sent.built += createPrograms?.length ?? 0;
        return real.createSnapshot(openProjects, createPrograms, configurations);
      },
      batch: (questions) => {
        sent.empty += questions.length === 0 ? 1 : 0;
        return real.batch(questions);
      },
    };

    workspaceOf(root, [configFile], engine);

    expect(sent.built).toBeGreaterThan(0);
    expect({ written: sent.written, empty: sent.empty }).toEqual({ written: 0, empty: 0 });
  });
});

describe("a configuration that imports a workspace package, in a run that reads component files", () => {
  const configFile = "packages/b/tsconfig.json";

  /** The configuration written for `b`'s, at its path below the root, its JSON decoded. */
  function writtenFor(files: Readonly<Record<string, string>>): {
    readonly root: string;
    readonly written: Record<string, unknown>;
  } {
    const root = writeWorkspace(files);
    const program = workspaceOf(root, [configFile], componentEngine())?.programs.get(
      join(root, configFile),
    );
    return {
      root,
      written:
        program?.kind === "configuration"
          ? {
              file: writtenPath(nodeHost(), join(root, configFile)).slice(root.length + 1),
              json: program.value,
            }
          : { kind: program?.kind },
    };
  }

  it("is read through a configuration that extends it, lays out no output and maps the member to its source", () => {
    const { root, written } = writtenFor(UNBUILT);

    expect(written).toEqual({
      file: "packages/b/tsconfig.deadset-ts.json",
      json: {
        extends: join(root, configFile),
        compilerOptions: {
          rootDir: null,
          outDir: null,
          declarationDir: null,
          tsBuildInfoFile: null,
          paths: { a: [join(root, "packages/a/src/index.ts")] },
        },
      },
    });
  });

  it("is read through a configuration that keeps its paths, its declarations and its references", () => {
    const { root, written } = writtenFor({
      ...UNBUILT,
      [configFile]: tsconfig(
        { composite: true, outDir: "dist", rootDir: "src", paths: { "#lib/*": ["./src/lib/*"] } },
        { references: [{ path: "../a" }] },
      ),
    });

    expect(written).toEqual({
      file: "packages/b/tsconfig.deadset-ts.json",
      json: {
        extends: join(root, configFile),
        compilerOptions: {
          rootDir: null,
          outDir: null,
          declarationDir: null,
          tsBuildInfoFile: null,
          composite: false,
          declaration: true,
          paths: {
            "#lib/*": [join(root, "packages/b/src/lib/*")],
            a: [join(root, "packages/a/src/index.ts")],
          },
        },
        references: [{ path: join(root, "packages/a") }],
      },
    });
  });

  it("is built as a program, the reason named, where its file list cannot be restated without its output directories", () => {
    const root = writeWorkspace({
      ...UNBUILT,
      [configFile]: tsconfig(
        { outDir: "dist" },
        { include: ["**/*.ts", "bower_components/**/*.ts"] },
      ),
      "packages/b/dist/stale.ts": "export const stale = 1;\n",
      "packages/b/bower_components/x/kept.ts": "export const kept = 1;\n",
    });
    const run = workspaceOf(root, [configFile], componentEngine());

    expect(run?.programs.get(join(root, configFile))?.kind).toBe("program");
    expect(run?.componentsUnread).toEqual([
      {
        configFile: join(root, configFile),
        reason: "its file list cannot be restated without its output directories",
      },
    ]);
  });

  it("names no reason its component files are unread for an import with no source to read", () => {
    const root = writeWorkspace(
      {
        ...UNBUILT,
        "packages/a2/package.json": manifest({
          name: "a",
          private: true,
          exports: { ".": "./src/index.ts" },
        }),
        "packages/a2/tsconfig.json": tsconfig({ noEmit: true }),
        "packages/a2/src/index.ts": "export const other = 1;\n",
        [configFile]: tsconfig({}, { include: ["src/**/*.ts", "vendor/**/*.ts"] }),
        "packages/b/vendor/x.ts":
          'import { usedByNobody } from "a";\n\nconsole.log(usedByNobody);\n',
      },
      { "packages/b/src/node_modules/a": "packages/a" },
    );
    const run = workspaceOf(root, [configFile], componentEngine());

    expect(run?.unbuildable(join(root, configFile))).toMatch(
      /^packages\/b\/vendor\/x\.ts imports a, .*2 workspace packages are named a/u,
    );
    expect(run?.componentsUnread).toEqual([]);
  });

  it("releases every snapshot and module resolver its rounds open", () => {
    const root = writeWorkspace(UNBUILT);
    const real = componentEngine();
    const snapshots: ReturnType<Engine["createSnapshot"]>[] = [];
    const resolvers: ReturnType<Engine["createModuleResolver"]>[] = [];
    const engine: Engine = {
      ...real,
      createSnapshot: (openProjects, createPrograms, configurations) => {
        const snapshot = real.createSnapshot(openProjects, createPrograms, configurations);
        snapshots.push(snapshot);
        return snapshot;
      },
      createModuleResolver: (options, entries) => {
        const resolver = real.createModuleResolver(options, entries);
        resolvers.push(resolver);
        return resolver;
      },
    };

    workspaceOf(root, [configFile], engine);

    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.filter((snapshot) => !snapshot.isDisposed())).toEqual([]);
    expect(resolvers.length).toBeGreaterThan(0);
    expect(
      resolvers.map((resolver) => {
        try {
          resolver.resolveModuleName("a", root);
          return "answers";
        } catch {
          return "released";
        }
      }),
    ).toEqual(resolvers.map(() => "released"));
  });
});

describe("the path a configuration written for a snapshot takes", () => {
  it("is beside the configuration, past every path a file has", () => {
    const root = writeWorkspace({
      "solo/tsconfig.json": "{}",
      "conf.json.d/tsconfig.json": "{}",
      "conf.json.d/tsconfig.deadset-ts.json": "{}",
    });

    expect([
      writtenPath(nodeHost(), join(root, "solo/tsconfig.json")),
      writtenPath(nodeHost(), join(root, "conf.json.d/tsconfig.json")),
    ]).toEqual([
      join(root, "solo/tsconfig.deadset-ts.json"),
      join(root, "conf.json.d/tsconfig.deadset-ts-1.json"),
    ]);
  });
});
