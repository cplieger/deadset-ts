import { afterEach, describe, expect, it } from "vitest";
import { removeWorkspaces, source, workspaceAt } from "../../__test-helpers__/workspace-tree.ts";

afterEach(removeWorkspaces);

const ROOT_MANIFEST = JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] });

const SOURCES = [
  "packages/a/src/index.ts",
  "packages/a/src/other.ts",
  "packages/a/src/feature.ts",
  "packages/a/src/utils/x.ts",
];

/** `a` declares `exports` over sources its configuration compiles in place; `b` is linked to it. */
function exporting(exports: unknown): ReturnType<typeof workspaceAt> {
  return workspaceAt(
    {
      "package.json": ROOT_MANIFEST,
      "packages/a/package.json": JSON.stringify({ name: "a", exports }),
      "packages/a/tsconfig.json": "{}",
      ...Object.fromEntries(SOURCES.map((path) => [path, ""])),
      "packages/b/package.json": JSON.stringify({ name: "b" }),
    },
    { "packages/b/node_modules/a": "packages/a" },
    { "packages/a/tsconfig.json": { files: SOURCES } },
  );
}

const PATTERNS = { "./utils/*": "./src/utils/*.ts", "./*.js": "./src/*.ts" };

describe("the exports target a member import reads", () => {
  it.each([
    ["a pattern whose wildcard matches one character", PATTERNS, "a/utils/x", "src/utils/x.ts"],
    ["a pattern with text after its wildcard", PATTERNS, "a/feature.js", "src/feature.ts"],
    [
      "a subpath of a map with no `.` key",
      { "./feature": "./src/feature.ts" },
      "a/feature",
      "src/feature.ts",
    ],
    [
      "the longest pattern prefix, written first",
      { "./utils/*": "./src/index.ts", "./*": "./src/other.ts" },
      "a/utils/x",
      "src/index.ts",
    ],
    [
      "the longest pattern prefix, written last",
      { "./*": "./src/other.ts", "./utils/*": "./src/index.ts" },
      "a/utils/x",
      "src/index.ts",
    ],
    [
      "the longest pattern prefix over a longer key",
      { "./utils/*": "./src/index.ts", "./*/strings.js": "./src/other.ts" },
      "a/utils/strings.js",
      "src/index.ts",
    ],
    [
      "the longer of two keys with one prefix, written first",
      { "./utils/*.js": "./src/index.ts", "./utils/*": "./src/other.ts" },
      "a/utils/x.js",
      "src/index.ts",
    ],
    [
      "the longer of two keys with one prefix, written last",
      { "./utils/*": "./src/other.ts", "./utils/*.js": "./src/index.ts" },
      "a/utils/x.js",
      "src/index.ts",
    ],
    [
      "the first alternative of a fallback list the conditions select",
      { ".": [{ "@x/source": "./src/other.ts" }, "./src/index.ts"] },
      "a",
      "src/index.ts",
    ],
    [
      "a target in a fallback list that only an unset condition names",
      { ".": [{ "@x/source": "./src/index.ts" }] },
      "a",
      "src/index.ts",
    ],
    [
      "the `.` key of a map that also holds a condition",
      { ".": "./src/index.ts", import: "./src/other.ts" },
      "a",
      "src/index.ts",
    ],
  ])("is %s", (_, exports, specifier, file) => {
    const { root, resolve } = exporting(exports);

    expect(resolve(specifier, "packages/b/src")).toEqual(source(root, `packages/a/${file}`, "a"));
  });

  it.each([
    ["a subpath shorter than the pattern", PATTERNS, "a/utils/"],
    ["a subpath outside every pattern", PATTERNS, "a/elsewhere/x"],
    ["a subpath that only ends like a key without a wildcard", "./src/index.ts", "a/."],
    ["a target not written relative to the package", { ".": "src/index.ts" }, "a"],
  ])("is none for %s", (_, exports, specifier) => {
    const { resolve } = exporting(exports);
    const answer = resolve(specifier, "packages/b/src");

    expect(answer.kind).toBe("unresolved");
    expect(answer.kind === "unresolved" ? answer.reason : "").toContain(
      "its manifest names no target,",
    );
  });
});

describe("a member manifest with no exports", () => {
  it("names the subpath `.` by its main field", () => {
    const { root, resolve } = workspaceAt(
      {
        "package.json": ROOT_MANIFEST,
        "packages/a/package.json": JSON.stringify({ name: "a", main: "./dist/index.js" }),
        "packages/a/tsconfig.json": "{}",
        "packages/a/src/index.ts": "",
        "packages/b/package.json": JSON.stringify({ name: "b" }),
      },
      { "packages/b/node_modules/a": "packages/a" },
      {
        "packages/a/tsconfig.json": {
          files: ["packages/a/src/index.ts"],
          outDir: "packages/a/dist",
          rootDir: "packages/a/src",
        },
      },
    );

    expect(resolve("a", "packages/b/src")).toEqual(source(root, "packages/a/src/index.ts", "a"));
  });

  it("names only the fields it writes in the reason nothing answers", () => {
    const { resolve } = workspaceAt(
      {
        "package.json": ROOT_MANIFEST,
        "packages/a/package.json": JSON.stringify({ name: "a", types: "./dist/index.d.ts" }),
        "packages/a/tsconfig.json": "{}",
        "packages/a/src/index.ts": "",
        "packages/b/package.json": JSON.stringify({ name: "b" }),
      },
      { "packages/b/node_modules/a": "packages/a" },
      { "packages/a/tsconfig.json": { files: ["packages/a/src/index.ts"] } },
    );
    const answer = resolve("a", "packages/b/src");

    expect(answer.kind === "unresolved" ? answer.reason : "").toContain(
      "its manifest names ./dist/index.d.ts, which does not exist and which no tsconfig*.json of the package compiles to",
    );
  });

  it("reads another subpath as a path below the package", () => {
    const { root, resolve } = workspaceAt(
      {
        "package.json": ROOT_MANIFEST,
        "packages/a/package.json": JSON.stringify({ name: "a", main: "./index.js" }),
        "packages/a/tsconfig.json": "{}",
        "packages/a/utils/strings.ts": "",
        "packages/b/package.json": JSON.stringify({ name: "b" }),
      },
      { "packages/b/node_modules/a": "packages/a" },
      { "packages/a/tsconfig.json": { files: ["packages/a/utils/strings.ts"] } },
    );

    expect(resolve("a/utils/strings", "packages/b/src")).toEqual(
      source(root, "packages/a/utils/strings.ts", "a"),
    );
  });
});

describe("an importer's dependency on a member, with no link", () => {
  /** `name` at `packages/lib`, version 1.2.0; `app` declares `dependencies` for it. */
  function depending(
    name: string,
    dependencies: (root: string) => Readonly<Record<string, unknown>>,
  ): ReturnType<typeof workspaceAt> {
    return workspaceAt(
      (root) => ({
        "package.json": ROOT_MANIFEST,
        "packages/lib/package.json": JSON.stringify({
          name,
          version: "1.2.0",
          exports: "./src/index.ts",
        }),
        "packages/lib/tsconfig.json": "{}",
        "packages/lib/src/index.ts": "",
        "packages/app/package.json": JSON.stringify({ name: "app", ...dependencies(root) }),
      }),
      {},
      { "packages/lib/tsconfig.json": { files: ["packages/lib/src/index.ts"] } },
    );
  }

  it.each([
    ["lib", "workspace:../lib", "source"],
    ["lib", "workspace:<root>/packages/lib", "source"],
    ["lib", "workspace:lib@^1.0.0", "source"],
    ["@scope/lib", "workspace:@scope/lib@*", "source"],
    ["lib", "workspace:other@*", "default"],
    ["lib", "workspace:^2.0.0", "default"],
    ["lib", "workspace:^", "source"],
    ["lib", "workspace:~", "source"],
  ])("on %s written %s gives a %s answer", (name, specifier, kind) => {
    const { resolve } = depending(name, (root) => ({
      dependencies: { [name]: specifier.replace("<root>", root) },
    }));

    expect(resolve(name, "packages/app/src").kind).toBe(kind);
  });

  it("passes over a dependency field that is null", () => {
    const { root, resolve } = depending("lib", () => ({
      dependencies: { lib: "workspace:*" },
      devDependencies: null,
    }));

    expect(resolve("lib", "packages/app/src")).toEqual(
      source(root, "packages/lib/src/index.ts", "lib"),
    );
  });

  it("names the one of two same-named members its path points at", () => {
    const { root, resolve } = workspaceAt({
      "package.json": ROOT_MANIFEST,
      "packages/one/package.json": JSON.stringify({ name: "same", exports: "./src/index.ts" }),
      "packages/one/src/index.ts": "",
      "packages/two/package.json": JSON.stringify({ name: "same", exports: "./src/index.ts" }),
      "packages/two/src/index.ts": "",
      "packages/app/package.json": JSON.stringify({
        name: "app",
        dependencies: { same: "workspace:../two" },
      }),
    });

    expect(resolve("same", "packages/app/src")).toEqual(
      source(root, "packages/two/src/index.ts", "same"),
    );
  });
});
