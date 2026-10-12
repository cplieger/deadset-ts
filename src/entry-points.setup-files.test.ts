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

function rootsOf(files: Readonly<Record<string, string>>): string[] {
  const root = writeProject({
    "package.json": `${JSON.stringify({ name: "@example/app", private: true, type: "module" })}\n`,
    "deadset.json": `${JSON.stringify({ target: { kind: "application" } })}\n`,
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
    .map((line) => line.replace("ts://@example/app/", ""));
}

function setupRoots(files: Readonly<Record<string, string>>): string[] {
  return rootsOf(files).filter((line) => /^(?:setup|global)\.ts#/u.test(line));
}

describe("the setup files of a test-runner workspace file", () => {
  it(
    "are the literals its test object names, each rooted alone and none of its exports",
    () => {
      expect(
        setupRoots({
          "vitest.workspace.ts":
            'export default { test: { setupFiles: ["./setup.ts"], globalSetup: "./global.ts" } };\n',
        }),
      ).toEqual(["global.ts#\ttest-runner\t./global.ts", "setup.ts#\ttest-runner\t./setup.ts"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "are read through parentheses and type assertions around the object and its values",
    () => {
      expect(
        setupRoots({
          "vitest.projects.ts": [
            "export default ({",
            '  test: ({ setupFiles: [("./setup.ts")] as string[], globalSetup: "./global.ts" as const }),',
            "}) satisfies object;",
            "",
          ].join("\n"),
        }),
      ).toEqual(["global.ts#\ttest-runner\t./global.ts", "setup.ts#\ttest-runner\t./setup.ts"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "are read from every object a call of the default export takes, one of them without a test object",
    () => {
      expect(
        setupRoots({
          "vitest.workspace.ts": [
            "function projects(...configs: readonly object[]): readonly object[] {",
            "  return configs;",
            "}",
            "",
            'export default projects({ name: "unit" }, { test: { setupFiles: ["./setup.ts"] } });',
            "",
          ].join("\n"),
        }),
      ).toEqual(["setup.ts#\ttest-runner\t./setup.ts"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "are read from a workspace file in a directory below the target root",
    () => {
      expect(
        rootsOf({
          "tools/vitest.workspace.ts": 'export default { test: { setupFiles: ["./setup.ts"] } };\n',
          "tools/setup.ts": "export const ready = true;\n",
        }).filter((line) => line.startsWith("tools/")),
      ).toEqual([
        "tools/setup.ts#\ttest-runner\t./setup.ts",
        "tools/vitest.workspace.ts#\ttest-runner\tvitest.workspace.*",
        "tools/vitest.workspace.ts#default:alias\ttest-runner\tvitest.workspace.*",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    [
      "the configuration",
      'export default { root: "./unit", test: { setupFiles: ["./setup.ts"] } };\n',
    ],
    [
      "its test object",
      'export default { test: { root: "./unit", setupFiles: ["./setup.ts"] } };\n',
    ],
  ])(
    "are none where %s moves the root they are read from",
    (_where, text) => {
      expect(setupRoots({ "vitest.workspace.ts": text })).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});
