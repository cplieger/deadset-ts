import { describe, expect, it } from "vitest";
import { analyzeProject, type AnalyzeOptions } from "../__test-helpers__/projects.ts";
import type { Reference } from "./references.ts";

const LOAD_TIMEOUT = 60_000;

const PACKAGE = `${JSON.stringify({ name: "@example/app", private: true, type: "module" })}\n`;

const TSCONFIG = `${JSON.stringify({
  compilerOptions: {
    strict: true,
    target: "ESNext",
    lib: ["ESNext", "DOM"],
    module: "NodeNext",
    moduleResolution: "nodenext",
    allowJs: true,
    rootDir: "src",
    outDir: "dist",
  },
  include: ["src/**/*"],
})}\n`;

/** Node's worker threads, as @types/node declares them. */
const THREADS = [
  'declare module "node:worker_threads" {',
  "  export class Worker {",
  "    constructor(filename: string | URL, options?: { readonly eval?: boolean });",
  "  }",
  "}",
  'declare module "worker_threads" {',
  '  export * from "node:worker_threads";',
  "}",
  "",
].join("\n");

function workers(...names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [`src/${name}.ts`, `console.log("${name}");\n`]));
}

function typedPackage(name: string, declarations: string): Record<string, string> {
  return {
    [`node_modules/${name}/package.json`]: `${JSON.stringify({ name, version: "1.0.0", types: "./index.d.ts" })}\n`,
    [`node_modules/${name}/index.d.ts`]: declarations,
  };
}

/** Each file a worker's call evaluates, as `<calling declaration> <file>`, the files below the root. */
function started(
  files: Readonly<Record<string, string>>,
  options: Omit<AnalyzeOptions, "references"> = {},
): string[] {
  const result = analyzeProject(
    { "package.json": PACKAGE, "tsconfig.json": TSCONFIG, ...files },
    { ...options, references: { testFiles: [] } },
  );
  const symbols = result.inventories[0]?.symbols ?? [];
  const label = (id: string): string => {
    const symbol = symbols.find((one) => one.id === id);
    return symbol === undefined ? "" : symbol.kind === "file" ? symbol.position.path : symbol.name;
  };
  const isWorkerFile = (id: string): boolean => /^src\/(?!app\b|other\b)/u.test(label(id));
  return (result.references[0]?.references ?? [])
    .filter((reference: Reference) => reference.use === "evaluation" && isWorkerFile(reference.to))
    .map((reference) => `${label(reference.from)} ${label(reference.to)}`)
    .sort();
}

describe("a worker a browser's call starts", () => {
  it(
    "is the file a relative URL reference names against the calling file, and none a scheme or a solidus names",
    () => {
      expect(
        started({
          ...workers("bare", "rooted", "remote"),
          "src/app.ts": [
            'export const a = new Worker("bare.ts");',
            'export const b = new Worker("/src/rooted.ts");',
            'export const c = new Worker("https://example.com/src/remote.ts");',
            "",
          ].join("\n"),
        }),
      ).toEqual(["a src/bare.ts"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is evaluated from the declaration whose code starts it, so a worker a dead function starts is reached from it alone",
    () => {
      expect(
        started({
          ...workers("idle", "eager"),
          "src/app.ts": [
            "export function idle(): Worker {",
            '  return new Worker("./idle.ts");',
            "}",
            'new SharedWorker("./eager.ts");',
            "",
          ].join("\n"),
        }),
      ).toEqual(["idle src/idle.ts", "src/app.ts src/eager.ts"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is the file its literal names where the target augments the platform's constructor, and through globalThis",
    () => {
      expect(
        started({
          ...workers("augmented", "global", "registered"),
          "src/env.d.ts": "interface Worker {\n  readonly tag?: string;\n}\n",
          "src/app.ts": [
            'export const a = new Worker("./augmented.ts", { type: "module" });',
            'export const b = new (globalThis.SharedWorker)("./global.ts");',
            'export const c = globalThis.navigator.serviceWorker.register("./registered.ts");',
            "",
          ].join("\n"),
        }),
      ).toEqual(["a src/augmented.ts", "b src/global.ts", "c src/registered.ts"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is the file its literal names with the query and the fragment removed, a module URL's bare name included",
    () => {
      expect(
        started({
          ...workers("queried", "shared", "located"),
          "src/app.ts": [
            'export const a = new Worker(new URL("./queried.ts?worker", import.meta.url), { type: "module" });',
            'export const b = new SharedWorker("./shared.ts#main");',
            'export const c = new Worker(new URL("located.ts", import.meta.url));',
            "",
          ].join("\n"),
        }),
      ).toEqual(["a src/queried.ts", "b src/shared.ts", "c src/located.ts"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is none where the address is built by another constructor or against another base",
    () => {
      expect(
        started({
          ...workers("option", "located", "based", "indexed"),
          "src/env.d.ts": "interface ImportMeta {\n  readonly base: string;\n}\n",
          "src/app.ts": [
            'export const a = new Worker(new Option("./option.ts", import.meta.url) as never);',
            'export const b = new Worker(new URL("./located.ts", location.href));',
            'export const c = new Worker(new URL("./based.ts", import.meta.base));',
            'export const d = new Worker(new URL("./indexed.ts", import.meta["base"]));',
            "",
          ].join("\n"),
        }),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is none where the target declares the constructor, the URL or the navigator itself",
    () => {
      expect(
        started({
          ...workers("local", "shadowed", "constructed"),
          "src/app.ts": [
            "class URL {",
            "  constructor(",
            "    readonly path: string,",
            "    readonly base: string,",
            "  ) {}",
            "}",
            "",
            "class Worker {",
            "  constructor(readonly path: string) {}",
            "}",
            "",
            "const navigator = { serviceWorker: { register: (url: string): string => url } };",
            "",
            'export const a = new globalThis.Worker(new URL("./local.ts", import.meta.url) as never);',
            'export const b = navigator.serviceWorker.register("./shadowed.ts");',
            'export const c = new Worker("./constructed.ts");',
            "",
          ].join("\n"),
        }),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is none for a call other than navigator.serviceWorker.register",
    () => {
      expect(
        started({
          ...workers("registration", "registry", "agent"),
          "src/env.d.ts":
            "interface Navigator {\n  readonly registry: { register(url: string): void };\n}\n",
          ...typedPackage(
            "agent",
            "declare global {\n  var agent: { readonly serviceWorker: { register(url: string): void } };\n}\nexport {};\n",
          ),
          "src/app.ts": [
            'import type {} from "agent";',
            "",
            'void navigator.serviceWorker.getRegistration("./registration.ts");',
            'navigator.registry.register("./registry.ts");',
            'agent.serviceWorker.register("./agent.ts");',
            "",
          ].join("\n"),
        }),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is none where the constructor is a package's global alias rather than the platform's",
    () => {
      expect(
        started({
          ...workers("pooled"),
          "tsconfig.json": `${JSON.stringify({
            compilerOptions: {
              strict: true,
              target: "ESNext",
              lib: ["ESNext"],
              module: "NodeNext",
              moduleResolution: "nodenext",
              allowUmdGlobalAccess: true,
              noEmit: true,
            },
            include: ["**/*.ts"],
          })}\n`,
          ...typedPackage(
            "pool",
            "declare class Pool {\n  constructor(script: string);\n}\nexport = Pool;\nexport as namespace Worker;\n",
          ),
          "src/app.ts":
            'import type {} from "pool";\n\nexport const pool = new Worker("./pooled.ts");\n',
        }),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is the file its literal names where the checker leaves the constructor unanswered",
    () => {
      const app = 'export const w = new Worker("./worker.ts");\n';
      const pos = app.indexOf(" Worker");
      expect(
        started(
          { ...workers("worker"), "src/app.ts": app },
          {
            panicsOn: (accessor, locations) =>
              accessor === "getSymbolAtLocation" &&
              locations.some((location) => location.endsWith(`/src/app.ts:${String(pos)}`)),
          },
        ),
      ).toEqual(["w src/worker.ts"]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a thread Node's Worker starts", () => {
  it(
    "is the file a ./ or ../ path names against the package's directory, an output path naming its source",
    () => {
      expect(
        started({
          ...workers("pool/emitted", "pool/direct", "beside", "rooted"),
          "src/threads.d.ts": THREADS,
          "src/app.ts": [
            'import { Worker as Thread } from "node:worker_threads";',
            'import * as threads from "worker_threads";',
            "",
            'export const a = new Thread("./dist/pool/emitted.js");',
            'export const b = new threads.Worker("./src/pool/direct.ts");',
            'export const c = new Thread("./beside.js");',
            'export const d = new Thread("src/rooted.ts");',
            "",
          ].join("\n"),
        }),
      ).toEqual(["a src/pool/emitted.ts", "b src/pool/direct.ts"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is the file a join or resolve of the calling file's own directory and literals names, against that directory",
    () => {
      expect(
        started({
          ...workers("pool/joined", "pool/resolved", "pool/meta", "pool/computed", "pool/web"),
          "src/threads.d.ts": THREADS,
          "src/node.d.ts": [
            "declare const __dirname: string;",
            "interface ImportMeta { readonly dirname: string; }",
            'declare module "node:path" {',
            "  export function join(...parts: string[]): string;",
            "  export function resolve(...parts: string[]): string;",
            "}",
            "",
          ].join("\n"),
          "src/app.ts": [
            'import { Worker } from "node:worker_threads";',
            'import * as path from "node:path";',
            'import { resolve } from "node:path";',
            "declare const name: string;",
            "",
            'export const a = new Worker(path.join(__dirname, "pool", "joined.ts"));',
            'export const b = new Worker(resolve(__dirname, "./pool/resolved.ts"));',
            'export const c = new Worker(path.join(import.meta.dirname, "pool/meta.ts"));',
            'export const d = new Worker(path.join(__dirname, "pool", name));',
            'export const e = new globalThis.Worker(path.join(__dirname, "pool/web.ts"));',
            "",
          ].join("\n"),
        }),
      ).toEqual(["a src/pool/joined.ts", "b src/pool/resolved.ts", "c src/pool/meta.ts"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "reads the nearest package's directory, where its scripts run",
    () => {
      expect(
        started({
          ...workers("nested/thread", "thread"),
          "src/threads.d.ts": THREADS,
          "src/nested/package.json": `${JSON.stringify({ name: "@example/nested", private: true })}\n`,
          "src/nested/app.ts": [
            'import { Worker } from "node:worker_threads";',
            'export const a = new Worker("./thread.ts");',
            "",
          ].join("\n"),
        }),
      ).toEqual(["a src/nested/thread.ts"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is read through the binding where the module has no declaration: an import, an import assignment and a require",
    () => {
      expect(
        started({
          ...workers("imported", "assigned", "member"),
          "src/required.js": "",
          "src/env.d.ts": "declare function require(id: string): any;\n",
          "src/app.ts": [
            "// @ts-expect-error: the module is not installed",
            'import { Worker } from "node:worker_threads";',
            "// @ts-expect-error: the module is not installed",
            'import threads = require("worker_threads");',
            'const Member = require("node:worker_threads").Worker;',
            "",
            'export const a = new Worker("./src/imported.ts");',
            'export const b = new threads.Worker("./src/assigned.ts");',
            'export const c = new Member("./src/member.ts");',
            "",
          ].join("\n"),
          "src/legacy.cjs": [
            'const { Worker } = require("node:worker_threads");',
            'new Worker("./src/required.js");',
            "",
          ].join("\n"),
        }),
      ).toEqual([
        "a src/imported.ts",
        "b src/assigned.ts",
        "c src/member.ts",
        "src/legacy.cjs src/required.js",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is read through a default import and the require createRequire returns, and not through the file's own require",
    () => {
      expect(
        started({
          ...workers("defaulted"),
          "src/loaded.js": "",
          "src/own.js": "",
          "src/app.ts": [
            "// @ts-expect-error: the module is not installed",
            'import threads from "node:worker_threads";',
            'export const a = new threads.Worker("./src/defaulted.ts");',
            "",
          ].join("\n"),
          "src/loaded.cjs": [
            'const load = require("node:module").createRequire(__filename);',
            'const { Worker } = load("node:worker_threads");',
            'new Worker("./src/loaded.js");',
            "",
          ].join("\n"),
          "src/own.cjs": [
            "function require(name) {",
            "  return {};",
            "}",
            'const { Worker } = require("node:worker_threads");',
            'new Worker("./src/own.js");',
            "",
          ].join("\n"),
        }),
      ).toEqual(["a src/defaulted.ts", "src/loaded.cjs src/loaded.js"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is none where an eval option other than false makes the address code",
    () => {
      expect(
        started({
          ...workers("evaluated", "shorthand", "plain"),
          "src/threads.d.ts": THREADS,
          "src/app.ts": [
            'import { Worker } from "node:worker_threads";',
            "const evaluate = true;",
            'export const a = new Worker("./src/evaluated.ts", { eval: evaluate });',
            "const options = { eval: true };",
            'export const b = new Worker("./src/shorthand.ts", { ...options, eval: (true) });',
            'export const c = new Worker("./src/plain.ts", { eval: false });',
            "",
          ].join("\n"),
        }),
      ).toEqual(["c src/plain.ts"]);
    },
    LOAD_TIMEOUT,
  );
});
