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

function manifestRoots(
  members: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, string>>,
): string[] {
  const root = writeProject({
    "package.json": `${JSON.stringify({ name: "@example/app", private: true, type: "module", ...members })}\n`,
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
    .map((line) => line.replace("ts://@example/app/", "").split("\t"))
    .filter(
      ([, kind]) => kind === "manifest-binary" || kind === "manifest-entry" || kind === "script",
    )
    .map((fields) => fields.join(" "));
}

describe("a manifest target no emit mapping reaches", () => {
  it(
    "is read back past a first directory of one character",
    () => {
      expect(
        manifestRoots(
          { main: "./o/index.js" },
          {
            "build.config.ts": 'export default { entry: ["./src/index.ts"] };\n',
            "src/index.ts": "export const index = 1;\n",
          },
        ),
      ).toEqual(["src/index.ts# manifest-entry main", "src/index.ts#index manifest-entry main"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is read back to a rooted file directly in the manifest's directory",
    () => {
      expect(
        manifestRoots(
          { main: "./dist/tool.js" },
          {
            "build.config.ts": 'export default { entry: ["./tool.ts"] };\n',
            "tool.ts": "export const tool = 1;\n",
          },
        ),
      ).toEqual(["tool.ts# manifest-entry main", "tool.ts#tool manifest-entry main"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is read back to a file a script of the manifest names",
    () => {
      expect(
        manifestRoots(
          { scripts: { gen: "node ./scripts/gen.ts" }, bin: { gen: "./dist/gen.js" } },
          { "scripts/gen.ts": "export const gen = 1;\n" },
        ),
      ).toEqual([
        'scripts/gen.ts# manifest-binary bin["gen"]',
        'scripts/gen.ts# script scripts["gen"]',
        'scripts/gen.ts#gen manifest-binary bin["gen"]',
        'scripts/gen.ts#gen script scripts["gen"]',
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is not read back to a file another member of the manifest names",
    () => {
      expect(
        manifestRoots(
          { main: "./src/lib.ts", bin: { lib: "./dist/lib.js" } },
          { "src/lib.ts": "export const lib = 1;\n" },
        ),
      ).toEqual(["src/lib.ts# manifest-entry main", "src/lib.ts#lib manifest-entry main"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is read back to nothing where its name is only an output extension",
    () => {
      expect(
        manifestRoots(
          { main: "./dist/.js" },
          {
            "tsconfig.json": `${JSON.stringify({
              compilerOptions: { strict: true, module: "NodeNext", noEmit: true },
              files: ["build.config.ts", "src/.ts"],
            })}\n`,
            "build.config.ts": 'export default { entry: ["./src/.ts"] };\n',
            "src/.ts": "export const blank = 1;\n",
          },
        ),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is not read back to a worker",
    () => {
      expect(
        manifestRoots(
          { main: "./dist/worker.js" },
          {
            "src/app.ts": 'new Worker(new URL("./worker.ts", import.meta.url));\n',
            "src/worker.ts": "export const worker = 1;\n",
          },
        ),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is not read back where a script names it",
    () => {
      expect(
        manifestRoots(
          { scripts: { gen: "node ./dist/gen.js" } },
          {
            "build.config.ts": 'export default { entry: ["./src/gen.ts"] };\n',
            "src/gen.ts": "export const gen = 1;\n",
          },
        ),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});
