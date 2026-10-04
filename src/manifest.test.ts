import { describe, expect, it } from "vitest";
import type { Host } from "./host.ts";
import { readManifest, scriptTokens } from "./manifest.ts";

/** A host holding one manifest at `/pkg`, or none. */
function hostWith(manifest: string | undefined): Host {
  return {
    workingDirectory: () => "/",
    readFile: (path) => {
      if (path === "/pkg/package.json" && manifest !== undefined) {
        return manifest;
      }
      throw new Error(`${path}: absent`);
    },
    readDirectory: () => [],
    kindOf: () => "absent",
    realPath: (path) => path,
    analyzerVersion: () => "0.0.0",
    temporaryDirectory: () => {
      throw new Error("no temporary directory");
    },
    componentMapperCommand: () => [],
    writeDocument: (path) => {
      throw new Error(`${path}: this host writes nothing`);
    },
  };
}

/** Every entry the manifest names, as `member path role published`. */
function entries(manifest: unknown): string[] {
  return readManifest(hostWith(JSON.stringify(manifest)), "/pkg").entries.map(
    (entry) => `${entry.member} ${entry.path} ${entry.role} ${String(entry.published)}`,
  );
}

describe("readManifest", () => {
  it("reads main, module and types written with or without a leading dot", () => {
    expect(entries({ main: "index.js", module: "./esm/index.js", types: "./index.d.ts" })).toEqual([
      "main /pkg/index.js import true",
      "module /pkg/esm/index.js import true",
      "types /pkg/index.d.ts import true",
    ]);
  });

  it("reads a bin written as one path or as a command map", () => {
    expect(entries({ bin: "./cli.js" })).toEqual(["bin /pkg/cli.js run false"]);
    expect(entries({ bin: { a: "./a.js", b: "b.js" } })).toEqual([
      'bin["a"] /pkg/a.js run false',
      'bin["b"] /pkg/b.js run false',
    ]);
  });

  it("walks every condition, subpath and alternative of exports, and skips a blocked subpath", () => {
    expect(
      entries({
        exports: {
          ".": { import: { types: "./a.d.ts", default: "./a.js" }, require: "./a.cjs" },
          "./alt": ["./b.js", "./c.js"],
          "./blocked": null,
          "./*": "./lib/*.js",
        },
      }),
    ).toEqual([
      'exports["."]["import"]["types"] /pkg/a.d.ts import true',
      'exports["."]["import"]["default"] /pkg/a.js import true',
      'exports["."]["require"] /pkg/a.cjs import true',
      'exports["./alt"]["0"] /pkg/b.js import true',
      'exports["./alt"]["1"] /pkg/c.js import true',
      'exports["./*"] /pkg/lib/*.js import true',
    ]);
  });

  it("refuses an exports target written without a leading dot, which names a package", () => {
    expect(entries({ exports: { ".": "lib/index.js" } })).toEqual([]);
  });

  it("names no file outside the package: an absolute path, a URL, an empty string", () => {
    expect(
      entries({ main: "/abs/index.js", module: "https://example.com/x.js", types: "" }),
    ).toEqual([]);
  });

  it("says whether exports is written at all, which decides what a library publishes", () => {
    expect(readManifest(hostWith(JSON.stringify({ exports: {} })), "/pkg").declaresExports).toBe(
      true,
    );
    expect(readManifest(hostWith(JSON.stringify({ main: "./a.js" })), "/pkg").declaresExports).toBe(
      false,
    );
  });

  it("names nothing where the manifest is absent or is not one JSON object", () => {
    expect(readManifest(hostWith(undefined), "/pkg")).toEqual({
      entries: [],
      declaresExports: false,
    });
    expect(readManifest(hostWith("{"), "/pkg")).toEqual({ entries: [], declaresExports: false });
    expect(readManifest(hostWith("[]"), "/pkg")).toEqual({ entries: [], declaresExports: false });
  });
});

describe("scriptTokens", () => {
  it.each([
    ["node ./a.ts --flag", ["node", "./a.ts", "--flag"]],
    ["a&&b", ["a", "b"]],
    ["a||b", ["a", "b"]],
    ["a;b", ["a", "b"]],
    ["a|b", ["a", "b"]],
    ["a &&  b\tc", ["a", "b", "c"]],
    ['node "./a.ts"', ["node", "./a.ts"]],
    ["node './a.ts'", ["node", "./a.ts"]],
    ["node \"'./a.ts'\"", ["node", "'./a.ts'"]],
    ["node \"./a.ts'", ["node", "\"./a.ts'"]],
    ["vitest 'src/*.ts'", ["vitest"]],
  ])("splits %j into %j", (command, tokens) => {
    expect(scriptTokens(command)).toEqual(tokens);
  });
});

describe("the scripts of a manifest", () => {
  it("name each distinct token of each script, read against the manifest's directory", () => {
    expect(
      entries({ scripts: { gen: "node ./bin/gen.ts && node ./bin/gen.ts", skipped: 3 } }),
    ).toEqual([
      'scripts["gen"] /pkg/node script false',
      'scripts["gen"] /pkg/bin/gen.ts script false',
    ]);
  });
});
