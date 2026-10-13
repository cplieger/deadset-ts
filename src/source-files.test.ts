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

describe("the own files an output path names below an output directory", () => {
  it("are read back through the layout the project's files were read with, the compiler options read once", () => {
    const root = writeProject({
      "tsconfig.json": TSCONFIG,
      "src/a.ts": "export const a = 1;\n",
      "src/lib/b.ts": "export const b = 1;\n",
    });
    try {
      const { projects } = runSession(
        openEngine({ collectTiming: false }),
        [join(root, "tsconfig.json")],
        (project) => {
          let reads = 0;
          const bound = <T extends object>(target: T, key: string | symbol): unknown => {
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function" ? (value as () => unknown).bind(target) : value;
          };
          const program = new Proxy(project.program, {
            get: (target, key) => {
              if (key === "getCompilerOptions") {
                reads += 1;
              }
              return bound(target, key);
            },
          });
          const view = new Proxy(project, {
            get: (target, key) => (key === "program" ? program : bound(target, key)),
          });
          const own = sourceFilesOf(view, root);
          const named = ["build/a.js", "build/lib/b.d.ts", "build/c.js"].map((path) =>
            own
              .namedAsOutput(join(root, "build"), join(root, path))
              .map((file) => file.fileName.slice(root.length + 1)),
          );
          return { named, reads };
        },
      );

      expect(projects[0]?.named).toEqual([["src/a.ts"], ["src/lib/b.ts"], []]);
      expect(projects[0]?.reads, "the layout is computed once").toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
