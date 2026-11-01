import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ModuleKind, ModuleResolutionKind } from "@typescript/native/sync";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { TSCONFIG } from "../../__test-helpers__/projects.ts";
import { FailureExit } from "../failure.ts";
import { resolve } from "../resolve.ts";
import { scopeForDir, type Scope } from "../scope.ts";
import { openEngine } from "../session.ts";
import { loadRun } from "./load.ts";

/** The bound on one case, which opens the compiler over a written tree. */
const LOAD_TIMEOUT = 60_000;

/** A tree written below a fresh directory, removed after the case. */
function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "deadset-ts-formed-"));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function configOf(document: unknown = { target: { kind: "application" } }) {
  return resolve({ repository: { text: JSON.stringify(document), label: "deadset.json" } }).config;
}

/** Each program the run analyzes: its id, its configuration below `root`, its files and its options. */
function load(root: string, document?: unknown, scope?: Scope) {
  const host = nodeHost();
  return loadRun(
    openEngine({ collectTiming: false }),
    host,
    scope ?? scopeForDir(host, root),
    configOf(document),
    ({ classified }) =>
      classified.analyzed.map(({ plan }) => ({
        id: plan.id,
        configFile: plan.configFile.slice(root.length + 1),
        files: plan.parsed.fileNames.map((file) => file.slice(root.length + 1)),
        module: plan.options.module,
        moduleResolution: plan.options.moduleResolution,
      })),
  );
}

/** The one program the run forms below `root`: its module options, and each file's module format by path. */
function formatsOf(root: string) {
  const host = nodeHost();
  const [only] = loadRun(
    openEngine({ collectTiming: false }),
    host,
    scopeForDir(host, root),
    configOf(),
    ({ classified }) =>
      classified.analyzed.map(({ plan, project }) => ({
        module: plan.options.module,
        moduleResolution: plan.options.moduleResolution,
        formats: Object.fromEntries(
          project
            .ownSourceFiles()
            .map((file) => [
              file.fileName.slice(root.length + 1),
              project.program.getSourceFileMetadata(file.fileName)?.impliedNodeFormat,
            ]),
        ),
      })),
  ).result;
  return only;
}

const NODE = { module: ModuleKind.NodeNext, moduleResolution: ModuleResolutionKind.NodeNext };
const BUNDLER = { module: ModuleKind.Preserve, moduleResolution: ModuleResolutionKind.Bundler };

describe("the programs a run forms for JavaScript files", () => {
  it(
    "forms one program per package over the files git would track that are no build output, a hand-written file beside its declaration file kept",

    () => {
      const root = tree({
        "package.json": '{ "name": "@example/app", "type": "module" }\n',
        ".gitignore": "dist/\n",
        "index.js": "export const a = 1;\n",
        "dist/bundle.js": "export const built = 1;\n",
        "vendor.min.js": "export const v = 1;\n",
        "long.js": `export const long = "${"x".repeat(11_000)}";\n`,
        "node_modules/dep/index.js": "module.exports = 1;\n",
        "tools/package.json": "{ not json\n",
        "tools/cli.js": "export const cli = 1;\n",
        "src/tsconfig.json": `${JSON.stringify({ compilerOptions: { allowJs: true, noEmit: true } })}\n`,
        "src/covered.js": "export const covered = 1;\n",
        "lib/legacy.js": "export const legacy = 1;\n",
        "lib/legacy.d.ts": "export declare const legacy: number;\n",
      });

      const { result } = load(root);

      expect(result).toEqual([
        {
          id: "src/tsconfig.json",
          configFile: "src/tsconfig.json",
          files: ["src/covered.js"],
          module: undefined,
          moduleResolution: undefined,
        },
        {
          id: "package.json",
          configFile: "jsconfig.deadset-ts.json",
          files: ["index.js", "lib/legacy.js"],
          ...NODE,
        },
        {
          id: "tools/package.json",

          configFile: "tools/jsconfig.deadset-ts.json",
          files: ["tools/cli.js"],
          ...BUNDLER,
        },
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "names a root holding no manifest by the root itself, resolves it as a bundler does, and keeps the JavaScript a package no configuration builds ships beside its types",
    () => {
      const root = tree({
        "page.js": "function onLoad() {}\n",
        "typed.js": "export const typed = 1;\n",
        "typed.d.ts": "export declare const typed: number;\n",
      });

      expect(load(root).result).toEqual([
        {
          id: ".",
          configFile: "jsconfig.deadset-ts.json",
          files: ["page.js", "typed.js"],
          ...BUNDLER,
        },
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "resolves a package a bundling row applies to as the bundler does, whatever its manifest says of Node",
    () => {
      const root = tree({
        "package.json":
          '{ "name": "@example/app", "type": "module", "devDependencies": { "vite": "8.999.0" } }\n',
        "node_modules/vite/package.json": '{ "name": "vite", "version": "8.999.0" }\n',
        "index.js": "export const a = 1;\n",
      });

      expect(load(root).result).toEqual([
        {
          id: "package.json",
          configFile: "jsconfig.deadset-ts.json",
          files: ["index.js"],
          ...BUNDLER,
        },
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "opens a jsconfig.json as a compiler configuration, and leaves out one beside a tsconfig.json",
    () => {
      const root = tree({
        "web/jsconfig.json": "{}\n",
        "web/app.js": "export const app = 1;\n",
        "lib/jsconfig.json": "{}\n",
        "lib/tsconfig.json": TSCONFIG,
        "lib/lib.ts": "export const lib = 1;\n",
      });

      expect(load(root).result.map(({ id, files }) => ({ id, files }))).toEqual([
        { id: "lib/tsconfig.json", files: ["lib/lib.ts"] },
        { id: "web/jsconfig.json", files: ["web/app.js"] },
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "forms the program a build matrix entry naming a package.json names, less a nested package's files",
    () => {
      const root = tree({
        "web/package.json": '{ "name": "@example/web", "main": "main.js" }\n',
        "web/main.js": "export const main = 1;\n",
        "web/nested/package.json": '{ "name": "@example/nested" }\n',
        "web/nested/n.js": "export const n = 1;\n",
        "other.js": "export const other = 1;\n",
      });

      const { result } = load(root, {
        target: { kind: "application" },
        analysis: { configurations: [{ id: "web", project: "web/package.json" }] },
      });

      expect(result).toEqual([
        { id: "web", configFile: "web/jsconfig.deadset-ts.json", files: ["web/main.js"], ...NODE },
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "loads a declared consumer holding no compiler configuration through the programs formed below it",
    () => {
      const root = tree({
        "target/tsconfig.json": TSCONFIG,
        "target/lib.ts": "export const lib = 1;\n",
        "consumer/package.json": '{ "name": "@example/consumer", "type": "module" }\n',
        "consumer/use.js": "export const use = 1;\n",
      });
      const host = nodeHost();
      const scope: Scope = {
        target: { id: "", path: join(root, "target") },
        consumers: [{ id: "", path: join(root, "consumer") }],
      };

      const loaded = loadRun(
        openEngine({ collectTiming: false }),
        host,
        scope,
        configOf(),
        ({ classified }) => classified.consumed.map(({ project }) => project.configFile),
      );

      expect(loaded.result).toEqual([join(root, "consumer", "jsconfig.deadset-ts.json")]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "ends the run with missing-consumer where no declared dependency a formed consumer's JavaScript imports is installed",
    () => {
      const root = tree({
        "target/tsconfig.json": TSCONFIG,
        "target/lib.ts": "export const lib = 1;\n",
        "consumer/package.json":
          '{ "name": "@example/consumer", "type": "module", "dependencies": { "left-pad": "1.3.0" } }\n',
        "consumer/use.js": 'import pad from "left-pad";\nconsole.log(pad);\n',
      });
      const scope: Scope = {
        target: { id: "", path: join(root, "target") },
        consumers: [{ id: "", path: join(root, "consumer") }],
      };

      expect(() => load(root, undefined, scope)).toThrow(
        `setup failure: missing-consumer: the consumer ${join(root, "consumer")} does not build, its dependencies not installed: use.js:1: use.js imports "left-pad", a declared dependency, and no dependency the configuration's JavaScript files import is installed: run the package manager's install`,
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "reads a member a formed consumer program imports from the member's source, where the consumer declares a workspace",
    () => {
      const root = tree({
        "target/tsconfig.json": TSCONFIG,
        "target/lib.ts": "export const lib = 1;\n",
        "consumer/package.json":
          '{ "name": "@example/root", "private": true, "type": "module", "workspaces": ["packages/*"] }\n',
        "consumer/packages/a/package.json":
          '{ "name": "@example/a", "private": true, "type": "module", "exports": "./index.js" }\n',
        "consumer/packages/a/index.js": "export const a = 1;\n",
        "consumer/packages/b/package.json":
          '{ "name": "@example/b", "private": true, "type": "module", "dependencies": { "@example/a": "workspace:*" } }\n',
        "consumer/packages/b/main.js": 'import { a } from "@example/a";\nconsole.log(a);\n',
      });
      const scope: Scope = {
        target: { id: "", path: join(root, "target") },
        consumers: [{ id: "", path: join(root, "consumer") }],
      };

      const loaded = loadRun(
        openEngine({ collectTiming: false }),
        nodeHost(),
        scope,
        configOf(),
        ({ plan, classified }) => ({
          builds: plan.plans.map((one) => [one.configFile.slice(root.length + 1), one.build.kind]),
          consumed: classified.consumed.length,
        }),
      );

      expect(loaded.result, "the importing member's program carries the member's answer").toEqual({
        builds: [
          ["target/tsconfig.json", "project"],
          ["consumer/packages/a/jsconfig.deadset-ts.json", "configuration"],
          ["consumer/packages/b/jsconfig.deadset-ts.json", "program"],
        ],
        consumed: 2,
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "keeps a program whose relative specifiers resolve to no file, and records each one an optional load does not write",
    () => {
      const root = tree({
        "package.json": '{ "name": "@example/app", "main": "index.cjs" }\n',
        "index.cjs": [
          'require("./gone.cjs");',
          "try {",
          '  require("./local.cjs");',
          "} catch {}",
          'const fallback = require("./fallback.cjs") ?? {};',
          'require("../dist/out.cjs");',
          "console.log(fallback);",
          "",
        ].join("\n"),
      });
      const host = nodeHost();

      const loaded = loadRun(
        openEngine({ collectTiming: false }),
        host,
        scopeForDir(host, root),
        configOf(),
        ({ classified }) => classified.unresolvedSpecifiers,
      );

      expect(loaded.result).toEqual([
        { specifier: "./gone.cjs", position: { path: "index.cjs", line: 1, column: 9 } },
        { specifier: "../dist/out.cjs", position: { path: "index.cjs", line: 6, column: 9 } },
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "ends the run with missing-module where no declared dependency the JavaScript files import is installed",
    () => {
      const root = tree({
        "package.json":
          '{ "name": "@example/app", "type": "module", "dependencies": { "left-pad": "1.3.0" } }\n',
        "index.js": 'import pad from "left-pad";\nimport "node:fs";\nconsole.log(pad);\n',
      });

      let thrown: unknown;
      try {
        load(root);
      } catch (error: unknown) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(FailureExit);
      expect((thrown as FailureExit).failures).toEqual([
        {
          failureClass: "missing-module",
          detail:
            "index.js:1: index.js imports \"left-pad\", a declared dependency, and no dependency the configuration's JavaScript files import is installed: run the package manager's install",
        },
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "reads a file outside the target root a program reaches as no file of the target's",
    () => {
      const root = tree({
        "target/tsconfig.json": `${JSON.stringify({
          compilerOptions: { module: "nodenext", noEmit: true, allowImportingTsExtensions: true },
          include: ["*.ts"],
        })}\n`,
        "target/main.ts": 'import { s } from "../shared/x.ts";\nconsole.log(s);\n',
        "shared/x.ts": "export const s = 1;\n",
      });
      const host = nodeHost();

      const loaded = loadRun(
        openEngine({ collectTiming: false }),
        host,
        scopeForDir(host, join(root, "target")),
        configOf(),
        ({ classified }) =>
          classified.analyzed.flatMap(({ project }) =>
            project.ownSourceFiles().map((file) => file.fileName.slice(root.length + 1)),
          ),
      );

      expect(loaded.result).toEqual(["target/main.ts"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "leaves out the files below a directory an applied convention row names as generated",
    () => {
      const root = tree({
        "package.json": '{ "name": "@example/app", "devDependencies": { "next": "16.0.0" } }\n',
        "node_modules/next/package.json": '{ "name": "next", "version": "16.0.0" }\n',
        "index.js": "export const a = 1;\n",
        ".next/server/page.js": "export const built = 1;\n",
      });

      expect(load(root).result).toEqual([
        {
          id: "package.json",
          configFile: "jsconfig.deadset-ts.json",
          files: ["index.js"],
          ...BUNDLER,
        },
      ]);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    ["cd srv && node index.js", NODE],
    ["NODE_ENV=production node srv/index.js", NODE],
    ["env -- node srv/index.js", NODE],
    ["npx -c 'node srv/index.js'", NODE],
    ["env --frobnicate node srv/index.js", BUNDLER],
    ["node --enable-source-maps srv/index.js", BUNDLER],
    ["tsx srv/index.js", BUNDLER],
    ["node", BUNDLER],
  ])(
    "reads the script %j of a package whose manifest names no Node member as resolving as %o",
    (start, runtime) => {
      const root = tree({
        "package.json": `${JSON.stringify({ name: "@example/app", scripts: { start } })}\n`,
        "srv/index.js": "export const a = 1;\n",
      });

      expect(load(root).result).toMatchObject([runtime]);
    },
    LOAD_TIMEOUT,
  );

  it.each<[string, Record<string, unknown>, typeof NODE | typeof BUNDLER, number]>([
    ["type module", { type: "module" }, NODE, ModuleKind.ESNext],
    ["type commonjs", { type: "commonjs" }, NODE, ModuleKind.CommonJS],
    ["no type", {}, NODE, ModuleKind.CommonJS],
  ])(
    "reads each file's module format from its extension and, for a .js file, the manifest's %s",
    (_, members, runtime, js) => {
      const root = tree({
        "package.json": `${JSON.stringify({ name: "@example/app", scripts: { start: "node a.js" }, ...members })}\n`,
        "a.js": "export const a = 1;\n",
        "b.mjs": "export const b = 1;\n",
        "c.cjs": "module.exports = {};\n",
      });

      expect(formatsOf(root)).toEqual({
        ...runtime,
        formats: { "a.js": js, "b.mjs": ModuleKind.ESNext, "c.cjs": ModuleKind.CommonJS },
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "gives a consumer's programs the runtime its own manifest and rows say, not the target's",
    () => {
      const root = tree({
        "target/package.json":
          '{ "name": "@example/target", "devDependencies": { "vite": "8.999.0" } }\n',
        "target/node_modules/vite/package.json": '{ "name": "vite", "version": "8.999.0" }\n',
        "target/index.js": "export const t = 1;\n",
        "node-consumer/package.json": '{ "name": "@example/node", "type": "module" }\n',
        "node-consumer/use.js": "export const use = 1;\n",
        "vite-consumer/package.json":
          '{ "name": "@example/vite", "type": "module", "devDependencies": { "vite": "8.999.0" } }\n',
        "vite-consumer/node_modules/vite/package.json":
          '{ "name": "vite", "version": "8.999.0" }\n',
        "vite-consumer/use.js": "export const use = 1;\n",
      });
      const host = nodeHost();
      const scope: Scope = {
        target: { id: "", path: join(root, "target") },
        consumers: [
          { id: "", path: join(root, "node-consumer") },
          { id: "", path: join(root, "vite-consumer") },
        ],
      };

      const loaded = loadRun(
        openEngine({ collectTiming: false }),
        host,
        scope,
        configOf(),
        ({ plan }) =>
          plan.plans.map((one) => ({
            configFile: one.configFile.slice(root.length + 1),
            module: one.options.module,
            moduleResolution: one.options.moduleResolution,
          })),
      );

      expect(loaded.result).toEqual([
        { configFile: "target/jsconfig.deadset-ts.json", ...BUNDLER },
        { configFile: "node-consumer/jsconfig.deadset-ts.json", ...NODE },
        { configFile: "vite-consumer/jsconfig.deadset-ts.json", ...BUNDLER },
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "bounds a group by a package.json that does not parse, reads no dependency above it for its files, and records it unread",
    () => {
      const root = tree({
        "package.json":
          '{ "name": "@example/app", "type": "module", "dependencies": { "left-pad": "1.3.0" } }\n',
        "index.js": "export const a = 1;\n",
        "tools/package.json": "{ not json\n",
        "tools/cli.js": 'import pad from "left-pad";\nconsole.log(pad);\n',
      });
      const host = nodeHost();

      const loaded = loadRun(
        openEngine({ collectTiming: false }),
        host,
        scopeForDir(host, root),
        configOf(),
        ({ plan, classified }) => ({
          analyzed: classified.analyzed.map(({ plan: one }) => one.id),
          unread: plan.unread.map((one) =>
            one.kind === "manifest"
              ? {
                  ...one,
                  configFile: one.configFile.slice(root.length + 1),
                  manifest: one.manifest.slice(root.length + 1),
                }
              : one,
          ),
        }),
      );

      expect(loaded.result).toEqual({
        analyzed: ["package.json", "tools/package.json"],
        unread: [
          {
            kind: "manifest",
            configFile: "tools/jsconfig.deadset-ts.json",
            manifest: "tools/package.json",
          },
        ],
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "records an ignore file that cannot be read, which then ignores nothing",
    () => {
      const root = tree({
        "package.json": '{ "name": "@example/app" }\n',
        ".gitignore": "dist/\n",
        "index.js": "export const a = 1;\n",
        "dist/out.js": "export const out = 1;\n",
      });
      const real = nodeHost();
      const ignoreFile = join(root, ".gitignore");
      const host = new Proxy(real, {
        get(target, key, receiver) {
          if (key === "readFile") {
            return (path: string, limit?: number) => {
              if (path === ignoreFile) {
                throw new Error("EACCES: permission denied");
              }
              return target.readFile(path, limit);
            };
          }
          return Reflect.get(target, key, receiver) as unknown;
        },
      });

      const loaded = loadRun(
        openEngine({ collectTiming: false }),
        host,
        scopeForDir(host, root),
        configOf(),
        ({ plan }) => ({
          unread: plan.unread,
          files: plan.plans.flatMap((one) =>
            one.parsed.fileNames.map((file) => file.slice(root.length + 1)),
          ),
        }),
      );

      expect(loaded.result).toEqual({
        unread: [{ kind: "ignore-file", path: ignoreFile, reason: "EACCES: permission denied" }],
        files: ["dist/out.js", "index.js"],
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "ends the run with missing-module where an allowJs configuration's JavaScript files import no installed declared dependency",
    () => {
      const root = tree({
        "package.json":
          '{ "name": "@example/app", "type": "module", "dependencies": { "left-pad": "1.3.0" } }\n',
        "tsconfig.json": `${JSON.stringify({
          compilerOptions: { allowJs: true, noEmit: true, module: "nodenext" },
          include: ["src/*.ts", "scripts/*.js"],
        })}\n`,
        "src/a.ts": "export const a = 1;\n",
        "scripts/run.js": 'import pad from "left-pad";\nconsole.log(pad);\n',
      });

      expect(() => load(root)).toThrow(
        /^setup failure: missing-module: scripts\/run\.js:1: scripts\/run\.js imports "left-pad", a declared dependency/mu,
      );
    },
    LOAD_TIMEOUT,
  );
});
