import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { analyzeRoot, writeProject } from "../__test-helpers__/projects.ts";
import { run, type Writer } from "./run.ts";
import { openEngine } from "./session.ts";

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

/** Parses the build scripts, which no program of the fixture holds. */
const parser = openEngine({ collectTiming: false });
afterAll(() => {
  parser.close();
});

/** A project whose files only the bundler calls of its build scripts name. */
const BUILT = analyzeRoot(fixture("projects", "build-scripts"), {
  references: { testFiles: [] },
  roots: {
    patterns: [],
    entryFiles: [],
    testFiles: [],
    publishedAPI: false,
    parse: (fileName, text) => parser.parseSourceFile(fileName, text),
  },
});
const SYMBOLS = BUILT.inventories[0]?.symbols ?? [];
const ROOTS = BUILT.roots[0]?.liveUnderReachability ?? [];

/** The rules that root one file of the fixture, by its path. */
function rulesRooting(path: string): string[] {
  const file = SYMBOLS.find((symbol) => symbol.kind === "file" && symbol.position.path === path);
  return ROOTS.filter((root) => root.id === file?.id).map((root) => `${root.kind} ${root.source}`);
}

describe("the entries a build script's bundler call names", () => {
  it.each([
    ["src/browser.ts", "src/browser.ts"],
    ["src/worker-entry.ts", "src/worker-entry.ts"],
    ["src/pages/home.ts", "src/pages/*.ts"],
    ["src/pages/about.ts", "src/pages/*.ts"],
    ["src/app.ts", "./src/app.ts"],
    ["src/lib.ts", "../src/lib.ts"],
    ["src/rolled.ts", "src/rolled.ts"],
    ["src/ran.ts", "src/ran.ts"],
    ["src/iife.ts", "src/iife.ts"],
    ["src/callback.ts", "src/callback.ts"],
  ])("root %s", (path, source) => {
    expect(rulesRooting(path)).toEqual([`bundler-entry ${source}`]);
  });

  it.each([
    ["src/request.ts", "a module request webpack resolves as a package"],
    ["src/computed.ts", "a template with a substitution"],
    ["src/unbuilt.ts", "the call of a module that is no bundler named here"],
    ["src/uncalled.ts", "the call in a function nothing the script runs calls"],
    ["src/shadowed.ts", "the call of a parameter that shadows the bundler's import"],
    ["src/reassigned.ts", "the options of a `let` binding the script reassigns"],
  ])("root nothing for %s, written as %s", (path) => {
    expect(rulesRooting(path)).toEqual([]);
  });
});

describe("an export of a file a build script's bundler call names", () => {
  it("is read by the bundle, so one only its own file references keeps its export keyword", () => {
    const out = mkdtempSync(join(tmpdir(), "deadset-ts-build-scripts-"));
    try {
      const report = join(out, "report.json");
      run(
        ["analyze", `--target=${fixture("projects", "build-scripts")}`, `--report=${report}`],
        new MemoryWriter(),
        new MemoryWriter(),
        nodeHost(),
      );
      const findings = (
        JSON.parse(readFileSync(report, "utf8")) as {
          findings: { code: string; position: { path: string }; symbol: { name: string } }[];
        }
      ).findings.map((one) => `${one.code} ${one.position.path} ${one.symbol.name}`);

      expect(findings.filter((one) => one.includes("src/browser.ts"))).toEqual([]);
      expect(findings).toContain("DS1001 src/unbuilt.ts value");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("a file a library's build script bundles", () => {
  it("is published API, so the members of a class it exports are reported at possible", () => {
    const root = writeProject({
      "package.json": JSON.stringify({
        name: "@example/bundled",
        type: "module",
        main: "./src/index.ts",
        scripts: { build: "node build.js" },
      }),
      "deadset.json": JSON.stringify({ target: { kind: "library" } }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, module: "esnext", target: "es2022" },
        include: ["src"],
      }),
      "build.js":
        'import { build } from "esbuild";\n\nbuild({ entryPoints: ["src/browser.ts"] });\n',
      "src/index.ts": "export const version = 1;\n",
      "src/browser.ts": "export class Logger {\n  info(): string {\n    return 'i';\n  }\n}\n",
    });
    const out = mkdtempSync(join(tmpdir(), "deadset-ts-build-scripts-"));
    try {
      const report = join(out, "report.json");
      run(
        ["analyze", "--target=.", "--min-confidence=possible", `--report=${report}`],
        new MemoryWriter(),
        new MemoryWriter(),
        { ...nodeHost(), workingDirectory: () => root },
      );
      const { findings } = JSON.parse(readFileSync(report, "utf8")) as {
        findings: { code: string; symbol: { name: string }; confidence: string }[];
      };

      expect(
        findings
          .filter((one) => one.symbol.name.startsWith("Logger"))
          .map((one) => `${one.code} ${one.symbol.name} ${one.confidence}`),
      ).toEqual(["DS1003 Logger.info possible"]);
    } finally {
      rmSync(out, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a build script nodemon's command runs", () => {
  it("names its bundler's entries as a package script does", () => {
    const root = writeProject({
      "package.json": JSON.stringify({
        name: "@example/watched",
        type: "module",
        nodemonConfig: { exec: "node build.js" },
      }),
      "deadset.json": JSON.stringify({ target: { kind: "application" } }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, module: "esnext", target: "es2022" },
        include: ["src"],
      }),
      "build.js":
        'import { build } from "esbuild";\n\nbuild({ entryPoints: ["src/browser.ts"] });\n',
      "src/browser.ts": "console.log('browser');\n",
      "src/stray.ts": "console.log('stray');\n",
    });
    const out = mkdtempSync(join(tmpdir(), "deadset-ts-build-scripts-"));
    try {
      const report = join(out, "report.json");
      run(
        ["analyze", "--target=.", "--min-confidence=possible", `--report=${report}`],
        new MemoryWriter(),
        new MemoryWriter(),
        { ...nodeHost(), workingDirectory: () => root },
      );
      const { findings } = JSON.parse(readFileSync(report, "utf8")) as {
        findings: { code: string; symbol: { name: string } }[];
      };

      expect(
        findings
          .filter((one) => one.code === "DS1602")
          .map((one) => one.symbol.name)
          .sort(),
      ).toEqual(["src/stray.ts"]);
    } finally {
      rmSync(out, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
