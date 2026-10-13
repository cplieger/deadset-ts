import { describe, expect, it } from "vitest";
import { gitIgnored } from "./git-ignore.ts";
import type { Host } from "./host.ts";

/** A host whose only files are the `.gitignore` texts `files` holds below `/repo`. */
function hostWith(files: Readonly<Record<string, string>>): Host {
  return {
    workingDirectory: () => "/",
    readFile: (path) => {
      const text = files[path.slice("/repo/".length)];
      if (text === undefined) {
        throw new Error(`${path}: absent`);
      }
      return text;
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

/** The paths of `paths` below `/repo` that the `.gitignore` files `files` ignore. */
function ignoredOf(files: Readonly<Record<string, string>>, paths: readonly string[]): string[] {
  const ignored = gitIgnored(hostWith(files), "/repo");
  return paths.filter((path) => ignored(`/repo/${path}`));
}

describe("the files a tree's .gitignore files ignore", () => {
  it("matches a name with no separator at any depth, and a directory pattern only as a directory", () => {
    expect(
      ignoredOf({ ".gitignore": "# build output\ndist/\n*.log\n\n" }, [
        "dist/index.d.ts",
        "packages/a/dist/index.d.ts",
        "dist",
        "src/debug.log",
        "src/index.ts",
      ]),
    ).toEqual(["dist/index.d.ts", "packages/a/dist/index.d.ts", "src/debug.log"]);
  });

  it("anchors a pattern with a separator to its own file's directory", () => {
    expect(
      ignoredOf({ ".gitignore": "/build\npackages/*/out\n", "packages/b/.gitignore": "lib\n" }, [
        "build/a.js",
        "src/build/a.js",
        "packages/a/out/a.js",
        "packages/a/src/out/a.js",
        "packages/b/lib/a.js",
        "packages/a/lib/a.js",
      ]),
    ).toEqual(["build/a.js", "packages/a/out/a.js", "packages/b/lib/a.js"]);
  });

  it("re-includes a file a later negation names, but not one below an ignored directory", () => {
    expect(
      ignoredOf({ ".gitignore": "*.d.ts\n!keep.d.ts\ndist/\n!dist/keep.d.ts\n" }, [
        "src/a.d.ts",
        "src/keep.d.ts",
        "dist/keep.d.ts",
      ]),
    ).toEqual(["src/a.d.ts", "dist/keep.d.ts"]);
  });

  it("ignores nothing outside the tree's root", () => {
    expect(gitIgnored(hostWith({ ".gitignore": "*\n" }), "/repo")("/elsewhere/a.ts")).toBe(false);
  });
});
