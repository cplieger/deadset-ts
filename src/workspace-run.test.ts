import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { runAnalysis, type RunAnalysis } from "./analysis.ts";
import { resolve } from "./resolve.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine, type Engine } from "./session.ts";

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

/** The analysis of one target under one repository configuration. */
function analyze(
  target: string,
  repository: Record<string, unknown> = {},
  engine: Engine = openEngine({ collectTiming: false }),
): RunAnalysis {
  const { config, provenance } = resolve({
    repository: JSON.stringify({ target: { kind: "application" }, ...repository }),
    repositoryLabel: "deadset.json",
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

/** Two packages: `b` uses one export of `a`, which publishes it from an unbuilt `dist/`. */
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
    const root = writeWorkspace({
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
    });
    const analysis = analyze(root, {
      analysis: {
        configurations: [
          { id: "b", project: "packages/b/tsconfig.json" },
          { id: "c", project: "packages/c/tsconfig.json" },
        ],
      },
    });

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
  });

  it("is resolved from the target's workspace when the target is one of its packages", () => {
    const root = writeWorkspace(UNBUILT);

    expect(found(analyze(join(root, "packages/b")))).toEqual([]);
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
