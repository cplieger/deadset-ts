import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { findWorkspace, type ParsedLayout } from "./workspace.ts";
import {
  packageNameOf,
  workspaceResolver,
  type DefaultResolution,
  type MemberResolution,
} from "./workspace-resolution.ts";

const written: string[] = [];

afterEach(() => {
  for (const root of written.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The conditions an ECMAScript import under `nodenext` reads, with no custom one. */
const IMPORT = new Set(["types", "import", "node", "default"]);

/**
 * A workspace below a fresh directory: `files` maps paths to text, `links` maps link
 * paths to the directory each names, and `layouts` maps a configuration path to what
 * parsing it answers, every path below the root.
 */
function workspaceAt(
  files: Readonly<Record<string, string>>,
  links: Readonly<Record<string, string>> = {},
  layouts: Readonly<
    Record<string, { files: readonly string[]; outDir?: string; rootDir?: string }>
  > = {},
): {
  readonly root: string;
  readonly resolve: (
    specifier: string,
    from: string,
    answered?: DefaultResolution,
    conditions?: ReadonlySet<string>,
  ) => MemberResolution;
} {
  const root = mkdtempSync(join(tmpdir(), "deadset-ts-resolution-"));
  written.push(root);
  mkdirSync(join(root, ".git"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(join(root, target), join(root, path));
  }
  const parse = (configFile: string): ParsedLayout | undefined => {
    const layout = layouts[configFile.slice(root.length + 1)];
    return layout === undefined
      ? undefined
      : {
          fileNames: layout.files.map((file) => join(root, file)),
          outDir: layout.outDir === undefined ? undefined : join(root, layout.outDir),
          rootDir: layout.rootDir === undefined ? undefined : join(root, layout.rootDir),
        };
  };
  const workspace = findWorkspace(nodeHost(), root, parse);
  if (workspace === undefined) {
    throw new Error("the written tree declares no workspace");
  }
  const resolver = workspaceResolver(nodeHost(), workspace);
  return {
    root,
    resolve: (specifier, from, answered, conditions = IMPORT) =>
      resolver.resolve(specifier, join(root, from), conditions, answered),
  };
}

const ROOT_MANIFEST = JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] });

/** `a` publishes `./dist/` compiled from `src/`; `b` imports it. */
const COMPILED: Readonly<Record<string, string>> = {
  "package.json": ROOT_MANIFEST,
  "packages/a/package.json": JSON.stringify({
    name: "a",
    version: "1.2.0",
    exports: {
      ".": "./dist/index.js",
      "./utils/*": { types: "./dist/utils/*.d.ts", default: "./dist/utils/*.js" },
    },
  }),
  "packages/a/tsconfig.json": "{}",
  "packages/a/src/index.ts": "",
  "packages/a/src/utils/strings.ts": "",
  "packages/b/package.json": JSON.stringify({ name: "b" }),
};

const A_LAYOUT = {
  "packages/a/tsconfig.json": {
    files: ["packages/a/src/index.ts", "packages/a/src/utils/strings.ts"],
    outDir: "packages/a/dist",
    rootDir: "packages/a/src",
  },
};

/** A resolution to one file below the root. */
function source(root: string, path: string, member: string): MemberResolution {
  return { kind: "source", file: join(root, path), member };
}

describe("packageNameOf", () => {
  it.each([
    ["a", "a"],
    ["a/deep/path", "a"],
    ["@scope/a", "@scope/a"],
    ["@scope/a/sub", "@scope/a"],
    ["./a", undefined],
    ["#internal", undefined],
    ["node:fs", undefined],
    ["@scope", undefined],
  ])("reads %s as %s", (specifier, name) => {
    expect(packageNameOf(specifier)).toBe(name);
  });
});

describe("a member import's resolution", () => {
  it("reads the output a link reaches back to the source it is compiled from", () => {
    const { root, resolve } = workspaceAt(
      COMPILED,
      { "packages/b/node_modules/a": "packages/a" },
      A_LAYOUT,
    );

    expect(
      resolve("a", "packages/b/src", {
        resolvedFileName: join(root, "packages/a/dist/index.d.ts"),
        isExternalLibraryImport: true,
      }),
    ).toEqual(source(root, "packages/a/src/index.ts", "a"));
  });

  it("reads a wildcard subpath through the pattern's own target", () => {
    const { root, resolve } = workspaceAt(
      COMPILED,
      { "packages/b/node_modules/a": "packages/a" },
      A_LAYOUT,
    );

    expect(resolve("a/utils/strings", "packages/b/src")).toEqual(
      source(root, "packages/a/src/utils/strings.ts", "a"),
    );
  });

  it("keeps the compiler's answer where the link names another package of the same name", () => {
    const { root, resolve } = workspaceAt(
      { ...COMPILED, "registry/a/package.json": JSON.stringify({ name: "a", version: "0.1.0" }) },
      { "packages/b/node_modules/a": "registry/a" },
      A_LAYOUT,
    );

    expect(
      resolve("a", "packages/b/src", { resolvedFileName: join(root, "registry/a/index.d.ts") }),
    ).toEqual({ kind: "default" });
  });

  it.each([
    ["workspace:*", "source"],
    ["workspace:^1.0.0", "source"],
    ["^1.0.0", "source"],
    ["~1.2.0 || ^3", "source"],
    ["^2.0.0", "default"],
    ["file:../a", "source"],
  ])("with no link, follows the importer's dependency %s to a %s answer", (specifier, kind) => {
    const { resolve } = workspaceAt(
      {
        ...COMPILED,
        "packages/b/package.json": JSON.stringify({ name: "b", dependencies: { a: specifier } }),
      },
      {},
      A_LAYOUT,
    );

    expect(resolve("a", "packages/b/src").kind).toBe(kind);
  });

  it("with no link and no dependency, keeps the compiler's answer", () => {
    const { resolve } = workspaceAt(COMPILED, {}, A_LAYOUT);

    expect(resolve("a", "packages/b/src")).toEqual({ kind: "default" });
  });

  it("reads a package's import of its own name from its source", () => {
    const { root, resolve } = workspaceAt(COMPILED, {}, A_LAYOUT);

    expect(resolve("a", "packages/a/src")).toEqual(source(root, "packages/a/src/index.ts", "a"));
  });

  it("keeps a source file the compiler already reads as the program's own", () => {
    const { root, resolve } = workspaceAt(COMPILED, {}, A_LAYOUT);

    expect(
      resolve("a", "packages/a/src", {
        resolvedFileName: join(root, "packages/a/src/index.ts"),
        isExternalLibraryImport: false,
      }),
    ).toEqual({ kind: "default" });
  });

  it("tries the target the importer's conditions select before the manifest's other targets", () => {
    const { root, resolve } = workspaceAt(
      {
        ...COMPILED,
        "packages/a/package.json": JSON.stringify({
          name: "a",
          exports: { ".": { "@x/source": "./src/other.ts", "@w/source": "./src/index.ts" } },
        }),
        "packages/a/src/other.ts": "",
      },
      { "packages/b/node_modules/a": "packages/a" },
      {
        "packages/a/tsconfig.json": {
          files: ["packages/a/src/index.ts", "packages/a/src/other.ts"],
        },
      },
    );

    expect(
      resolve(
        "a",
        "packages/b/src",
        undefined,
        new Set(["@w/source", "types", "import", "default"]),
      ),
    ).toEqual(source(root, "packages/a/src/index.ts", "a"));
  });

  it.each([
    ["./dist/src/index.js", "the configuration's directory"],
    ["./dist/index.js", "the directory its inputs share"],
  ])("reads %s back to source with no root directory, below %s", (target) => {
    const { root, resolve } = workspaceAt(
      {
        ...COMPILED,
        "packages/a/package.json": JSON.stringify({ name: "a", exports: { ".": target } }),
      },
      { "packages/b/node_modules/a": "packages/a" },
      {
        "packages/a/tsconfig.json": {
          files: ["packages/a/src/index.ts"],
          outDir: "packages/a/dist",
        },
      },
    );

    expect(resolve("a", "packages/b/src")).toEqual(source(root, "packages/a/src/index.ts", "a"));
  });

  it("keeps the compiler's answer for a built declaration file none of the package's configurations writes", () => {
    const { root, resolve } = workspaceAt(
      {
        ...COMPILED,
        "packages/a/package.json": JSON.stringify({ name: "a", types: "./dist/index.d.ts" }),
        "packages/a/dist/index.d.ts": "",
      },
      { "packages/b/node_modules/a": "packages/a" },
      { "packages/a/tsconfig.json": { files: ["packages/a/src/index.ts"] } },
    );

    expect(
      resolve("a", "packages/b/src", {
        resolvedFileName: join(root, "packages/a/dist/index.d.ts"),
        isExternalLibraryImport: true,
      }),
    ).toEqual({ kind: "default" });
  });

  it("is unresolved where the manifest's target does not exist and maps to no source", () => {
    const { resolve } = workspaceAt(
      {
        ...COMPILED,
        "packages/a/package.json": JSON.stringify({ name: "a", types: "./dist/index.d.ts" }),
      },
      { "packages/b/node_modules/a": "packages/a" },
      { "packages/a/tsconfig.json": { files: ["packages/a/src/index.ts"] } },
    );

    expect(resolve("a", "packages/b/src").kind).toBe("unresolved");
  });

  it("reads a declaration file one of the package's configurations compiles as its source", () => {
    const { root, resolve } = workspaceAt(
      {
        ...COMPILED,
        "packages/a/package.json": JSON.stringify({ name: "a", types: "./types/index.d.ts" }),
        "packages/a/types/index.d.ts": "",
      },
      { "packages/b/node_modules/a": "packages/a" },
      {
        "packages/a/tsconfig.json": {
          files: ["packages/a/src/index.ts", "packages/a/types/index.d.ts"],
        },
      },
    );

    expect(
      resolve("a", "packages/b/src", {
        resolvedFileName: join(root, "packages/a/types/index.d.ts"),
        isExternalLibraryImport: true,
      }),
    ).toEqual(source(root, "packages/a/types/index.d.ts", "a"));
  });

  it("prefers a manifest target that is source over a declaration file the package does not compile", () => {
    const { root, resolve } = workspaceAt(
      {
        ...COMPILED,
        "packages/a/package.json": JSON.stringify({
          name: "a",
          exports: { ".": { types: "./build/index.d.ts", "@w/source": "./src/index.ts" } },
        }),
        "packages/a/build/index.d.ts": "",
      },
      { "packages/b/node_modules/a": "packages/a" },
      { "packages/a/tsconfig.json": { files: ["packages/a/src/index.ts"] } },
    );

    expect(
      resolve("a", "packages/b/src", {
        resolvedFileName: join(root, "packages/a/build/index.d.ts"),
        isExternalLibraryImport: true,
      }),
    ).toEqual(source(root, "packages/a/src/index.ts", "a"));
  });

  it("keeps the compiler's answer for a package no configuration builds", () => {
    const { root, resolve } = workspaceAt(
      {
        ...COMPILED,
        "packages/a/package.json": JSON.stringify({ name: "a", main: "./lib/index.js" }),
        "packages/a/lib/index.js": "",
      },
      { "packages/b/node_modules/a": "packages/a" },
    );

    expect(
      resolve("a", "packages/b/src", {
        resolvedFileName: join(root, "packages/a/lib/index.js"),
        isExternalLibraryImport: true,
      }),
    ).toEqual({ kind: "default" });
  });

  it("takes the package the link names where two share a name", () => {
    const { root, resolve } = workspaceAt(
      {
        "package.json": ROOT_MANIFEST,
        "packages/one/package.json": JSON.stringify({ name: "same", exports: "./src/index.ts" }),
        "packages/one/src/index.ts": "",
        "packages/two/package.json": JSON.stringify({ name: "same", exports: "./src/index.ts" }),
        "packages/two/src/index.ts": "",
        "packages/b/package.json": JSON.stringify({
          name: "b",
          dependencies: { same: "workspace:*" },
        }),
      },
      { "packages/b/node_modules/same": "packages/two" },
      {
        "packages/one/tsconfig.json": { files: [] },
        "packages/two/tsconfig.json": { files: [] },
      },
    );

    expect(resolve("same", "packages/b/src")).toEqual(
      source(root, "packages/two/src/index.ts", "same"),
    );
  });

  it("is unresolved where two packages share a name and nothing links the importer to one", () => {
    const { resolve } = workspaceAt({
      "package.json": ROOT_MANIFEST,
      "packages/one/package.json": JSON.stringify({ name: "same", exports: "./src/index.ts" }),
      "packages/two/package.json": JSON.stringify({ name: "same", exports: "./src/index.ts" }),
      "packages/b/package.json": JSON.stringify({
        name: "b",
        dependencies: { same: "workspace:*" },
      }),
    });
    const answer = resolve("same", "packages/b/src");

    expect(answer.kind).toBe("unresolved");
    expect(answer.kind === "unresolved" ? answer.reason : "").toMatch(
      /2 workspace packages are named same/u,
    );
  });
});
