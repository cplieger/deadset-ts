import { rmSync } from "node:fs";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { writeProject } from "../../__test-helpers__/projects.ts";
import { run, type Writer } from "../run.ts";

const LOAD_TIMEOUT = 60_000;

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

/** A manifest declaring one installed package at one version, and the package's own manifest. */
function installed(name: string, version: string, dir = ""): Record<string, string> {
  return {
    [`${dir}package.json`]: `${JSON.stringify({
      name: `@example/${dir === "" ? "app" : dir.slice(0, -1)}`,
      private: true,
      type: "module",
      devDependencies: { [name]: version },
    })}\n`,
    [`${dir}node_modules/${name}/package.json`]: `${JSON.stringify({ name, version })}\n`,
  };
}

function rootsOf(files: Readonly<Record<string, string>>): string[] {
  const root = writeProject({
    "deadset.json": `${JSON.stringify({ target: { kind: "application" }, ts: { test_files: ["**/*.unit.ts"] } })}\n`,
    "setup.ts": "export const ready = true;\n",
    "global.ts": "export const started = true;\n",
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
    .filter((line) => line !== "")
    .map((line) => line.replace(/ts:\/\/@example\/[a-z]+\//u, ""));
}

/** The roots of the files a test name matches. */
function testRoots(
  files: Readonly<Record<string, string>>,
  file = /^(?:setup|global)\.ts#/u,
): string[] {
  return rootsOf(files).filter((line) => file.test(line));
}

const VITEST_3 = installed("vitest", "3.2.4");
const VITEST_4 = installed("vitest", "4.0.0");

describe("the setup files of a Vitest workspace file", () => {
  it(
    "are the literals each inline project's test object names, each rooted alone and none of its exports",
    () => {
      expect(
        testRoots({
          ...VITEST_3,
          "vitest.workspace.ts":
            'export default ["packages/*", { test: { setupFiles: ["./setup.ts"], globalSetup: "./global.ts" } }];\n',
        }),
      ).toEqual(["global.ts#\ttest-runner\t./global.ts", "setup.ts#\ttest-runner\t./setup.ts"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "are read through parentheses, type assertions and every argument of a call",
    () => {
      expect(
        testRoots({
          ...VITEST_3,
          "vitest.projects.ts": [
            "function defineWorkspace(projects: readonly object[]): readonly object[] {",
            "  return projects;",
            "}",
            "",
            "export default defineWorkspace([",
            '  { test: ({ setupFiles: [("./setup.ts")] as string[] }) },',
            '  { test: { globalSetup: "./global.ts" as const } },',
            "]) satisfies object;",
            "",
          ].join("\n"),
        }),
      ).toEqual(["global.ts#\ttest-runner\t./global.ts", "setup.ts#\ttest-runner\t./setup.ts"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "are read against the root a project's test object moves them to",
    () => {
      expect(
        testRoots(
          {
            ...VITEST_3,
            "unit/setup.ts": "export const ready = true;\n",
            "vitest.workspace.ts":
              'export default [{ test: { root: "./unit", setupFiles: ["./setup.ts"] } }];\n',
          },
          /setup\.ts#/u,
        ),
      ).toEqual(["unit/setup.ts#\ttest-runner\t./setup.ts"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "are none where the installed Vitest is 4, which reads no workspace file",
    () => {
      expect(
        testRoots(
          {
            ...VITEST_4,
            "vitest.workspace.ts": 'export default [{ test: { setupFiles: ["./setup.ts"] } }];\n',
          },
          /^(?:setup|vitest\.workspace)\.ts#/u,
        ),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "are none in a package that declares no Vitest",
    () => {
      expect(
        testRoots({
          "package.json": `${JSON.stringify({ name: "@example/app", private: true })}\n`,
          "vitest.workspace.ts": 'export default [{ test: { setupFiles: ["./setup.ts"] } }];\n',
        }),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});

describe("the setup files of an inline project of a Vitest configuration", () => {
  it(
    "are test files under every Vitest the row reads",
    () => {
      for (const vitest of [VITEST_3, VITEST_4]) {
        expect(
          testRoots({
            ...vitest,
            "vitest.config.ts":
              'export default { test: { projects: [{ test: { setupFiles: ["./setup.ts"] } }] } };\n',
          }),
        ).toEqual(["setup.ts#\ttest-runner\t./setup.ts"]);
      }
    },
    LOAD_TIMEOUT,
  );
});

describe("the test files of a Playwright configuration", () => {
  const PLAYWRIGHT = installed("@playwright/test", "1.50.0");

  it(
    "are those its pattern matches below its test directory, each project's read on its own",
    () => {
      expect(
        testRoots(
          {
            ...PLAYWRIGHT,
            "e2e/home.spec.ts": "export {};\n",
            "e2e/helper.ts": "export {};\n",
            "flows/pay.flow.ts": "export {};\n",
            "outside.spec.ts": "export {};\n",
            "playwright.config.ts": [
              "export default {",
              '  testDir: "./e2e",',
              '  projects: [{ name: "chromium" }, { name: "flows", testDir: "./flows", testMatch: "*.flow.ts" }],',
              "};",
              "",
            ].join("\n"),
          },
          /^(?:e2e|flows|outside)/u,
        ),
      ).toEqual([
        "e2e/home.spec.ts#\ttest-runner\t**/*.{spec,test}.{js,ts,jsx,tsx,cjs,cts,cjsx,ctsx,mjs,mts,mjsx,mtsx}",
        "flows/pay.flow.ts#\ttest-runner\t*.flow.ts",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "match a pattern as Playwright does, anywhere below the test directory and in any case",
    () => {
      expect(
        testRoots(
          {
            ...PLAYWRIGHT,
            "flows/cart/pay.flow.ts": "export {};\n",
            "flows/Refund.FLOW.ts": "export {};\n",
            "flows/tests/one.spec.ts": "export {};\n",
            "flows/two.spec.ts": "export {};\n",
            "other/three.flow.ts": "export {};\n",
            "playwright.config.ts":
              'export default { testDir: "./flows", testMatch: ["*.flow.ts", "tests/*.spec.ts"] };\n',
          },
          /^(?:flows|other)/u,
        ),
      ).toEqual([
        "flows/Refund.FLOW.ts#\ttest-runner\t*.flow.ts",
        "flows/cart/pay.flow.ts#\ttest-runner\t*.flow.ts",
        "flows/tests/one.spec.ts#\ttest-runner\ttests/*.spec.ts",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "are read through a top-level binding the default export names",
    () => {
      expect(
        testRoots(
          {
            ...PLAYWRIGHT,
            "e2e/home.e2e.ts": "export {};\n",
            "e2e/home.spec.ts": "export {};\n",
            "playwright.config.ts":
              'const config = { testDir: "./e2e", testMatch: "**/*.e2e.ts" };\n\nexport default config;\n',
          },
          /^e2e/u,
        ),
      ).toEqual(["e2e/home.e2e.ts#\ttest-runner\t**/*.e2e.ts"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "are none where a value the configuration's text does not state moves its test directory",
    () => {
      expect(
        testRoots(
          {
            ...PLAYWRIGHT,
            "e2e/home.spec.ts": "export {};\n",
            "playwright.config.ts": "export default { testDir: process.env.DIR };\n",
          },
          /^e2e/u,
        ),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});
