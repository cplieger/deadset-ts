import { rmSync } from "node:fs";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { analyzeProject, writeProject } from "../__test-helpers__/projects.ts";
import { run, type Writer } from "./run.ts";

const LOAD_TIMEOUT = 60_000;

const PACKAGE = `${JSON.stringify({
  name: "@example/app",
  private: true,
  type: "module",
  main: "./src/app.ts",
})}\n`;

const APPLICATION = `${JSON.stringify({ target: { kind: "application" } })}\n`;

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

function workers(...names: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    names.map((name) => [`src/${name}.ts`, `export const ${name}Value = true;\n`]),
  );
}

function typedPackage(name: string, declarations: string): Record<string, string> {
  return {
    [`node_modules/${name}/package.json`]: `${JSON.stringify({ name, version: "1.0.0", types: "./index.d.ts" })}\n`,
    [`node_modules/${name}/index.d.ts`]: declarations,
  };
}

function workerRoots(files: Readonly<Record<string, string>>): string[] {
  const root = writeProject({ "package.json": PACKAGE, "deadset.json": APPLICATION, ...files });
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const out = new MemoryWriter();
  const err = new MemoryWriter();
  expect(run(["print-roots", `--target=${root}`], out, err, nodeHost()), err.text).toBe(0);
  return out.text
    .split("\n")
    .map((line) => line.replace("ts://@example/app/", ""))
    .filter((line) => line.startsWith("src/") && !line.startsWith("src/app.ts#"));
}

describe("a worker a call addresses", () => {
  it(
    "is the file a relative URL reference names with no leading dot segment, and none a scheme or a solidus names",
    () => {
      expect(
        workerRoots({
          ...workers("bare", "rooted", "remote"),
          "src/app.ts": [
            'export const a = new Worker("bare.ts");',
            'export const b = new Worker("/src/rooted.ts");',
            'export const c = new Worker("https://example.com/src/remote.ts");',
            "",
          ].join("\n"),
        }),
      ).toEqual(["src/bare.ts#\tworker\tbare.ts"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is the file its literal names where the target augments the platform's constructor",
    () => {
      expect(
        workerRoots({
          ...workers("augmented"),
          "src/env.d.ts": "interface Worker {\n  readonly tag?: string;\n}\n",
          "src/app.ts": 'export const a = new Worker("./augmented.ts", { type: "module" });\n',
        }),
      ).toEqual(["src/augmented.ts#\tworker\t./augmented.ts"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is the file its literal names with the query and the fragment removed, rooted alone",
    () => {
      expect(
        workerRoots({
          ...workers("queried", "shared"),
          "src/app.ts": [
            'export const a = new Worker(new URL("./queried.ts?worker", import.meta.url), { type: "module" });',
            'export const b = new SharedWorker("./shared.ts#main");',
            "",
          ].join("\n"),
        }),
      ).toEqual([
        "src/queried.ts#\tworker\t./queried.ts?worker",
        "src/shared.ts#\tworker\t./shared.ts#main",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is none where the address is built by another constructor or against another base",
    () => {
      expect(
        workerRoots({
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
    "is none where the target declares the URL constructor or the navigator itself",
    () => {
      expect(
        workerRoots({
          ...workers("local", "shadowed"),
          "src/app.ts": [
            "class URL {",
            "  constructor(",
            "    readonly path: string,",
            "    readonly base: string,",
            "  ) {}",
            "}",
            "",
            "const navigator = { serviceWorker: { register: (url: string): string => url } };",
            "",
            'export const a = new Worker(new URL("./local.ts", import.meta.url) as never);',
            'export const b = navigator.serviceWorker.register("./shadowed.ts");',
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
        workerRoots({
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
        workerRoots({
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
    "is rooted where the checker leaves the constructor unanswered",
    () => {
      const app = 'export const w = new Worker("./worker.ts");\n';
      const pos = app.indexOf(" Worker");
      const analyzed = analyzeProject(
        { "package.json": PACKAGE, ...workers("worker"), "src/app.ts": app },
        {
          roots: { patterns: [], entryFiles: [], testFiles: [], publishedAPI: false },
          panicsOn: (accessor, locations) =>
            accessor === "getSymbolAtLocation" &&
            locations.some((location) => location.endsWith(`/src/app.ts:${String(pos)}`)),
        },
      );
      const file = analyzed.inventories[0]?.symbols.find(
        (symbol) => symbol.kind === "file" && symbol.position.path === "src/worker.ts",
      );

      expect(
        analyzed.roots[0]?.liveUnderReachability
          .filter((one) => one.id === file?.id)
          .map((one) => `${one.kind} ${one.source}`),
      ).toEqual(["worker ./worker.ts"]);
    },
    LOAD_TIMEOUT,
  );
});
