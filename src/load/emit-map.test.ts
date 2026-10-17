import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { emitterInputOf, findingsOf } from "../../__test-helpers__/emitter-input.ts";
import { writeProject } from "../../__test-helpers__/projects.ts";
import { resolve } from "../resolve.ts";

const LIBRARY = JSON.stringify({ target: { kind: "library" } });

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function exporting(name: string): string {
  return `export function ${name}(): number {\n  return 1;\n}\n`;
}

interface Library {
  readonly compilerOptions: Readonly<Record<string, unknown>>;
  readonly include: readonly string[];
  readonly exports: Readonly<Record<string, unknown>>;
  readonly files: Readonly<Record<string, string>>;
}

function findingsOfLibrary(library: Library): string[] {
  const root = writeProject({
    "package.json": `${JSON.stringify({ name: "@example/lib", type: "module", exports: library.exports })}\n`,
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: { strict: true, module: "NodeNext", ...library.compilerOptions },
      include: library.include,
    })}\n`,
    ...library.files,
  });
  roots.push(root);
  const { config } = resolve({ repository: { text: LIBRARY, label: "deadset.json" } });
  return findingsOf(emitterInputOf(root, config)).map(
    (finding) => `${finding.code} ${finding.symbol.name}`,
  );
}

describe("an output path a library exports", () => {
  it("is read back below the directory every input shares, for sources in sibling directories", () => {
    expect(
      findingsOfLibrary({
        compilerOptions: { outDir: "dist" },
        include: ["src"],
        exports: { "./a": "./dist/a/x.js", "./b": "./dist/b/y.js" },
        files: { "src/a/x.ts": exporting("x"), "src/b/y.ts": exporting("y") },
      }),
    ).toEqual([]);
  });

  it("is read back below the directory every input shares, where a later source shares less than the first two", () => {
    expect(
      findingsOfLibrary({
        compilerOptions: { outDir: "dist" },
        include: ["src", "lib"],
        exports: {
          "./x": "./dist/src/a/x.js",
          "./y": "./dist/src/a/y.js",
          "./z": "./dist/lib/z.js",
        },
        files: {
          "src/a/x.ts": exporting("x"),
          "src/a/y.ts": exporting("y"),
          "lib/z.ts": exporting("z"),
        },
      }),
    ).toEqual([]);
  });

  it("is read back below the declaration directory for a declaration output, where one is declared", () => {
    expect(
      findingsOfLibrary({
        compilerOptions: { outDir: "dist", declaration: true, declarationDir: "types" },
        include: ["src"],
        exports: { ".": { types: "./types/a.d.ts" }, "./b": "./dist/b.js" },
        files: { "src/a.ts": exporting("a"), "src/b.ts": exporting("b") },
      }),
    ).toEqual([]);
  });

  it("names no source for a declaration output below the code output directory, where a declaration directory is declared", () => {
    expect(
      findingsOfLibrary({
        compilerOptions: { outDir: "dist", declaration: true, declarationDir: "types" },
        include: ["src"],
        exports: { ".": { types: "./dist/a.d.ts" }, "./b": "./dist/b.js" },
        files: { "src/a.ts": exporting("a"), "src/b.ts": exporting("b") },
      }),
    ).toEqual(["DS1101 a", "DS1602 src/a.ts"]);
  });
});
