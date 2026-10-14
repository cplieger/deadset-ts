import { rmSync } from "node:fs";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { run, type Writer } from "./run.ts";

const LOAD_TIMEOUT = 60_000;

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

function manifest(devDependencies: Readonly<Record<string, string>> = {}): string {
  return `${JSON.stringify({ name: "@example/app", private: true, type: "module", devDependencies })}\n`;
}

function installed(name: string, version: string): Record<string, string> {
  return {
    [`node_modules/${name}/package.json`]: `${JSON.stringify({ name, version, private: true })}\n`,
  };
}

function modules(...paths: readonly string[]): Record<string, string> {
  return Object.fromEntries(paths.map((path) => [path, "export const value = true;\n"]));
}

function rootsBelow(under: string, files: Readonly<Record<string, string>>): string[] {
  const root = writeProject({
    "package.json": manifest(),
    "deadset.json": `${JSON.stringify({ target: { kind: "application" } })}\n`,
    ...files,
  });
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const out = new MemoryWriter();
  const err = new MemoryWriter();
  expect(run(["print-roots", `--target=${root}`], out, err, nodeHost()), err.text).toBe(0);
  return out.text
    .split("\n")
    .map((line) => line.replace("ts://@example/app/", ""))
    .filter((line) => line.startsWith(under));
}

describe("a file a configuration file names", () => {
  it(
    "is rooted with its exports by a relative string of a JSON configuration file",
    () => {
      expect(
        rootsBelow("plugins/", {
          ...modules("plugins/local.ts"),
          "tool.config.json": `${JSON.stringify({ plugin: "./plugins/local.ts" })}\n`,
        }),
      ).toEqual([
        "plugins/local.ts#\tconfiguration-string\t./plugins/local.ts",
        "plugins/local.ts#value\tconfiguration-string\t./plugins/local.ts",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is rooted by a string of a configuration module the program does not hold",
    () => {
      expect(
        rootsBelow("plugins/", {
          ...modules("plugins/outside.ts"),
          "tool.config.mjs": 'export default { plugin: "./plugins/outside.ts" };\n',
        }),
      ).toEqual([
        "plugins/outside.ts#\tconfiguration-string\t./plugins/outside.ts",
        "plugins/outside.ts#value\tconfiguration-string\t./plugins/outside.ts",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is not rooted by a string at a selection key of an applied row in a configuration module",
    () => {
      expect(
        rootsBelow("src/", {
          "package.json": manifest({ vitest: "5.0.3" }),
          ...installed("vitest", "5.0.3"),
          ...modules("src/covered.ts", "src/aliased.ts"),
          "vitest.config.ts": [
            "export default {",
            "  test: {",
            '    coverage: { include: ["./src/covered.ts"] },',
            '    alias: { app: "./src/aliased.ts" },',
            "  },",
            "};",
            "",
          ].join("\n"),
        }),
      ).toEqual([
        "src/aliased.ts#\tconfiguration-string\t./src/aliased.ts",
        "src/aliased.ts#value\tconfiguration-string\t./src/aliased.ts",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is not rooted by a string at a selection key of an applied row in a configuration module no program holds",
    () => {
      expect(
        rootsBelow("src/", {
          "package.json": manifest({ vitest: "5.0.3" }),
          ...installed("vitest", "5.0.3"),
          ...modules("src/excluded.ts", "src/aliased.ts"),
          "tsconfig.json": `${JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] })}\n`,
          "vitest.config.ts": [
            "export default {",
            "  test: {",
            '    coverage: { exclude: ["src/excluded.ts"] },',
            '    alias: { app: "./src/aliased.ts" },',
            "  },",
            "};",
            "",
          ].join("\n"),
        }),
      ).toEqual([
        "src/aliased.ts#\tconfiguration-string\t./src/aliased.ts",
        "src/aliased.ts#value\tconfiguration-string\t./src/aliased.ts",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is not rooted by a string at a selection key of a JSON configuration file, once per occurrence",
    () => {
      expect(
        rootsBelow("src/", {
          "package.json": manifest({ "@stryker-mutator/core": "10.0.0" }),
          ...installed("@stryker-mutator/core", "10.0.0"),
          ...modules("src/mutated.ts", "src/twice.ts", "src/plugin.ts"),
          "stryker.config.json": `${JSON.stringify({
            mutate: ["src/mutated.ts", "src/twice.ts"],
            plugins: ["./src/plugin.ts"],
            tempDirName: "src/twice.ts",
          })}\n`,
        }),
      ).toEqual([
        "src/plugin.ts#\tconfiguration-string\t./src/plugin.ts",
        "src/plugin.ts#value\tconfiguration-string\t./src/plugin.ts",
        "src/twice.ts#\tconfiguration-string\tsrc/twice.ts",
        "src/twice.ts#value\tconfiguration-string\tsrc/twice.ts",
      ]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a file the platform or a workflow runs", () => {
  it(
    "is rooted with its exports by a module script of an HTML file",
    () => {
      expect(
        rootsBelow("src/", {
          ...modules("src/page.ts"),
          "index.html": '<script type="module" src="./src/page.ts"></script>\n',
        }),
      ).toEqual([
        "src/page.ts#\thtml-entry\t./src/page.ts",
        "src/page.ts#value\thtml-entry\t./src/page.ts",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is rooted with its exports by a run step of a workflow",
    () => {
      expect(
        rootsBelow("scripts/", {
          ...modules("scripts/check.ts"),
          ".github/workflows/ci.yml":
            "jobs:\n  check:\n    steps:\n      - run: node scripts/check.ts\n",
        }),
      ).toEqual([
        "scripts/check.ts#\tworkflow-step\tscripts/check.ts",
        "scripts/check.ts#value\tworkflow-step\tscripts/check.ts",
      ]);
    },
    LOAD_TIMEOUT,
  );
});

describe("the tests a browser-test configuration names", () => {
  it(
    "are the files its own test pattern matches below its test directory",
    () => {
      expect(
        rootsBelow("e2e/", {
          ...modules("e2e/home.e2e.ts", "e2e/home.spec.ts"),
          "playwright.config.ts":
            'export default { testDir: "./e2e", testMatch: "**/*.e2e.ts" };\n',
        }).filter((line) => line.includes("browser-tests")),
      ).toEqual(["e2e/home.e2e.ts#\tbrowser-tests\t**/*.e2e.ts"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "are none where the default export is not written as an object",
    () => {
      expect(
        rootsBelow("e2e/", {
          ...modules("e2e/home.spec.ts"),
          "playwright.config.ts":
            'const config = { testDir: "./e2e" };\n\nexport default config;\n',
        }).filter((line) => line.includes("browser-tests")),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});
