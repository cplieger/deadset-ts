import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { removeWorkspaces, workspaceAt } from "../../__test-helpers__/workspace-tree.ts";
import { readManifest, type ManifestEntry } from "../manifest.ts";
import { memberEntries, targetManifestIn } from "./workspace-manifests.ts";

afterEach(removeWorkspaces);

function workspace(): ReturnType<typeof workspaceAt> {
  return workspaceAt(
    {
      "package.json": JSON.stringify({
        name: "root",
        private: true,
        workspaces: ["packages/*"],
        bin: { tool: "./tool.ts" },
      }),
      "tool.ts": "",
      "packages/lib/package.json": JSON.stringify({
        name: "lib",
        version: "1.0.0",
        bin: { lib: "./dist/cli.js" },
        exports: { ".": "./dist/index.js", "./*": "./dist/*.js" },
      }),
      "packages/lib/tsconfig.json": "{}",
      "packages/lib/src/index.ts": "",
      "packages/lib/src/cli.ts": "",
      "packages/legacy/package.json": JSON.stringify({
        name: "legacy",
        main: "./src/main.ts",
        bin: { legacy: "./lib/missing.js" },
      }),
      "packages/legacy/src/main.ts": "",
      "packages/internal/package.json": JSON.stringify({
        name: "internal",
        private: true,
        main: "./src/inner.ts",
        exports: { "./x": "./src/x.ts" },
      }),
      "packages/internal/src/inner.ts": "",
      "packages/plain/package.json": JSON.stringify({
        name: "plain",
        exports: { "./*": "./src/*.ts" },
      }),
      "packages/plain/tsconfig.json": "{}",
      "packages/plain/src/a.ts": "",
    },
    {},
    {
      "packages/lib/tsconfig.json": {
        files: ["packages/lib/src/index.ts", "packages/lib/src/cli.ts"],
        outDir: "packages/lib/dist",
        rootDir: "packages/lib/src",
      },
      "packages/plain/tsconfig.json": { files: ["packages/plain/src/a.ts"] },
    },
  );
}

function rows(root: string, entries: readonly ManifestEntry[]): string[] {
  return entries.map(
    (entry) =>
      `${entry.member} ${entry.path.slice(root.length + 1)} ${entry.role}${entry.published ? " published" : ""}`,
  );
}

describe("memberEntries", () => {
  it("reads every other member's entries back to source, a private member's exports left out", () => {
    const { root, resolver } = workspace();

    expect(rows(root, memberEntries(nodeHost(), resolver, root))).toEqual([
      "packages/internal/package.json main packages/internal/src/inner.ts import",
      "packages/legacy/package.json main packages/legacy/src/main.ts import published",
      'packages/legacy/package.json bin["legacy"] packages/legacy/lib/missing.js run',
      'packages/lib/package.json bin["lib"] packages/lib/src/cli.ts run',
      'packages/lib/package.json exports["."] packages/lib/src/index.ts import published',
      'packages/lib/package.json exports["./*"] packages/lib/dist/*.js import published',
      'packages/lib/package.json exports["./*"] packages/lib/dist/*.ts import published',
      'packages/lib/package.json exports["./*"] packages/lib/src/*.ts import published',
      'packages/lib/package.json exports["./*"] packages/lib/dist/*.tsx import published',
      'packages/lib/package.json exports["./*"] packages/lib/src/*.tsx import published',
      'packages/plain/package.json exports["./*"] packages/plain/src/*.ts import published',
    ]);
  });
});

describe("targetManifestIn", () => {
  it("reads the target's own entries back to the sources of the member it is", () => {
    const { root, resolver } = workspace();
    const lib = join(root, "packages/lib");

    expect(
      rows(root, targetManifestIn(resolver, lib, readManifest(nodeHost(), lib)).entries),
    ).toEqual([
      'bin["lib"] packages/lib/src/cli.ts run',
      'exports["."] packages/lib/src/index.ts import published',
      'exports["./*"] packages/lib/dist/*.js import published',
      'exports["./*"] packages/lib/dist/*.ts import published',
      'exports["./*"] packages/lib/src/*.ts import published',
      'exports["./*"] packages/lib/dist/*.tsx import published',
      'exports["./*"] packages/lib/src/*.tsx import published',
    ]);
  });
});
