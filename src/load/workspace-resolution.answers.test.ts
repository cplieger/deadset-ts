import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  removeWorkspaces,
  source,
  workspaceAt,
  type TreeLayout,
} from "../../__test-helpers__/workspace-tree.ts";

afterEach(removeWorkspaces);

const ROOT_MANIFEST = JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] });

/**
 * `a` with one manifest and its files below `packages/a`, each configuration a layout
 * below it written as an empty file; `b` is linked to it.
 */
function linkedTo(
  manifest: Readonly<Record<string, unknown>>,
  files: readonly string[],
  layouts: Readonly<Record<string, TreeLayout>> = {},
): ReturnType<typeof workspaceAt> {
  const below = (path: string): string => `packages/a/${path}`;
  return workspaceAt(
    {
      "package.json": ROOT_MANIFEST,
      "packages/a/package.json": JSON.stringify({ name: "a", ...manifest }),
      ...Object.fromEntries([...files, ...Object.keys(layouts)].map((path) => [below(path), ""])),
      "packages/b/package.json": JSON.stringify({ name: "b" }),
    },
    { "packages/b/node_modules/a": "packages/a" },
    Object.fromEntries(
      Object.entries(layouts).map(([path, layout]) => [
        below(path),
        {
          files: layout.files.map(below),
          ...(layout.outDir === undefined ? {} : { outDir: below(layout.outDir) }),
          ...(layout.rootDir === undefined ? {} : { rootDir: below(layout.rootDir) }),
        },
      ]),
    ),
  );
}

const COMPILED_TO_DIST = {
  "tsconfig.json": { files: ["src/index.ts"], outDir: "dist", rootDir: "src" },
};

const COMPILED_IN_PLACE = { "tsconfig.json": { files: ["src/index.ts"] } };

describe("which imports the resolver is asked about", () => {
  it.each([
    ["a", true],
    ["a/deep/path", true],
    ["c", false],
    ["./a", false],
  ])("names %s: %s", (specifier, named) => {
    const { resolver } = linkedTo({}, []);

    expect(resolver.names(specifier)).toBe(named);
  });
});

describe("the compiler's answer for a member import", () => {
  it("stands where it is outside the package the link names", () => {
    const { root, resolve } = linkedTo(
      { exports: "./dist/index.js" },
      ["src/index.ts"],
      COMPILED_TO_DIST,
    );

    expect(
      resolve("a", "packages/b/src", {
        resolvedFileName: join(root, "vendor/a/index.d.ts"),
        isExternalLibraryImport: true,
      }),
    ).toEqual({ kind: "default" });
  });

  it("stands for a package no configuration builds, though source sits beside it", () => {
    const { root, resolve } = linkedTo({ main: "./lib/index.js" }, [
      "lib/index.js",
      "lib/index.ts",
    ]);

    expect(
      resolve("a", "packages/b/src", {
        resolvedFileName: join(root, "packages/a/lib/index.js"),
        isExternalLibraryImport: true,
      }),
    ).toEqual({ kind: "default" });
  });

  it("is read back to source where it is built output the program reads as its own", () => {
    const { root, resolve } = linkedTo(
      { exports: "./dist/index.js" },
      ["src/index.ts", "dist/index.d.ts"],
      COMPILED_TO_DIST,
    );

    expect(
      resolve("a", "packages/b/src", {
        resolvedFileName: join(root, "packages/a/dist/index.d.ts"),
      }),
    ).toEqual(source(root, "packages/a/src/index.ts", "a"));
  });

  it("is source where any one of the package's configurations compiles it", () => {
    const { root, resolve } = linkedTo({ types: "./types/index.d.ts" }, ["types/index.d.ts"], {
      "tsconfig.build.json": { files: ["src/index.ts"] },
      "tsconfig.json": { files: ["src/index.ts", "types/index.d.ts"] },
    });

    expect(
      resolve("a", "packages/b/src", {
        resolvedFileName: join(root, "packages/a/types/index.d.ts"),
        isExternalLibraryImport: true,
      }),
    ).toEqual(source(root, "packages/a/types/index.d.ts", "a"));
  });
});

describe("a member import nothing answers for", () => {
  it("reads an output target back to the source beside it where no configuration writes elsewhere", () => {
    const { root, resolve } = linkedTo(
      { main: "./src/index.js" },
      ["src/index.ts"],
      COMPILED_IN_PLACE,
    );

    expect(resolve("a", "packages/b/src")).toEqual(source(root, "packages/a/src/index.ts", "a"));
  });

  it.each([
    [
      "a source target that does not exist",
      { exports: "./src/missing.ts" },
      ["src/index.ts"],
      COMPILED_IN_PLACE,
      "its manifest names ./src/missing.ts, which does not exist and which no tsconfig*.json of the package compiles to",
    ],
    [
      "a declaration file a configuration lists that does not exist",
      { types: "./types/index.d.ts" },
      ["src/index.ts"],
      { "tsconfig.json": { files: ["src/index.ts", "types/index.d.ts"] } },
      "its manifest names ./types/index.d.ts, which does not exist and which no tsconfig*.json of the package compiles to",
    ],
    [
      "built targets no configuration maps back to source",
      { exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } } },
      ["src/index.ts", "dist/index.js"],
      COMPILED_IN_PLACE,
      "its manifest names ./dist/index.d.ts, ./dist/index.js, output no tsconfig*.json of the package maps back to source",
    ],
    [
      "a missing target of a package with no configuration",
      { main: "./dist/index.js" },
      ["src/index.ts"],
      {},
      "the package has no tsconfig*.json and its manifest names ./dist/index.js, which does not exist",
    ],
  ])("is unresolved for %s, with why", (_, manifest, files, layouts, reason) => {
    const { resolve } = linkedTo(manifest, files, layouts);
    const answer = resolve("a", "packages/b/src");

    expect(answer.kind).toBe("unresolved");
    expect(answer.kind === "unresolved" ? answer.reason : "").toContain(reason);
  });
});
