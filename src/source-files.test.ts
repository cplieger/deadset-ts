import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeProject } from "../__test-helpers__/projects.ts";
import { runSession, openEngine } from "./session.ts";
import { sourceFilesOf } from "./source-files.ts";

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    module: "NodeNext",
    moduleResolution: "nodenext",
    outDir: "dist",
  },
  include: ["src"],
});

function namedIn(files: Readonly<Record<string, string>>, paths: readonly string[]): string[][] {
  const root = writeProject({ "tsconfig.json": TSCONFIG, ...files });
  try {
    const { projects } = runSession(
      openEngine({ collectTiming: false }),
      [join(root, "tsconfig.json")],
      (project) => {
        const own = sourceFilesOf(project, root);
        return paths.map((path) =>
          own.named(join(root, path)).map((file) => file.fileName.slice(root.length + 1)),
        );
      },
    );
    return projects[0] ?? [];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the own files a written path names", () => {
  it("reads an emitted file below the output directory back to its source below the directory every input shares", () => {
    expect(
      namedIn({ "src/a.ts": "export const a = 1;\n", "src/lib/b.ts": "export const b = 1;\n" }, [
        "dist/a.js",
        "dist/lib/b.d.ts",
      ]),
    ).toEqual([["src/a.ts"], ["src/lib/b.ts"]]);
  });

  it("reads a subpath pattern below the output directory as every source it stands for, at any depth", () => {
    expect(
      namedIn({ "src/a.ts": "export const a = 1;\n", "src/lib/b.ts": "export const b = 1;\n" }, [
        "dist/*.js",
      ]),
    ).toEqual([["src/a.ts", "src/lib/b.ts"]]);
  });

  it("matches the text on both sides of a pattern's wildcard without letting them overlap", () => {
    expect(
      namedIn(
        {
          "src/a.ts": "export const a = 1;\n",
          "src/aa.ts": "export const aa = 1;\n",
          "src/aba.ts": "export const aba = 1;\n",
        },
        ["src/a*a.ts"],
      ),
    ).toEqual([["src/aa.ts", "src/aba.ts"]]);
  });
});
