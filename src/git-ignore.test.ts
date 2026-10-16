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

  it("reads bracket expressions, the .gitignore files above the root up to the repository's, and its info/exclude", () => {
    const host: Host = {
      ...hostWith({
        ".gitignore": "*.[oa]\n",
        ".git/info/exclude": "scratch/\n",
        "pkg/.gitignore": "[!k]eep.log\n",
      }),
      kindOf: (path) => (path === "/repo/.git" ? "directory" : "absent"),
    };
    const ignored = gitIgnored(host, "/repo/pkg");

    expect(
      ["lib.o", "lib.a", "lib.c", "scratch/a.ts", "seep.log", "keep.log"].filter((path) =>
        ignored(`/repo/pkg/${path}`),
      ),
    ).toEqual(["lib.o", "lib.a", "scratch/a.ts", "seep.log"]);
  });

  it("reads POSIX classes and a reversed range in a bracket expression as git does", () => {
    expect(
      ignoredOf({ ".gitignore": "file[[:digit:]].txt\n[z-a].log\n*.o\n" }, [
        "file1.txt",
        "filex.txt",
        "z.log",
        "m.log",
        "lib.o",
      ]),
    ).toEqual(["file1.txt", "z.log", "lib.o"]);
  });

  it("reads a linked worktree's info/exclude from the repository's common directory", () => {
    const texts: Readonly<Record<string, string>> = {
      "/repo/.git": "gitdir: /main/.git/worktrees/repo\n",
      "/main/.git/worktrees/repo/commondir": "../..\n",
      "/main/.git/info/exclude": "scratch/\n",
    };
    const host: Host = {
      ...hostWith({}),
      readFile: (path) => {
        const text = texts[path];
        if (text === undefined) {
          throw new Error(`${path}: absent`);
        }
        return text;
      },
      kindOf: (path) => (path === "/repo/.git" ? "file" : "absent"),
    };

    expect(gitIgnored(host, "/repo")("/repo/scratch/a.ts")).toBe(true);
  });

  it("ignores nothing outside the tree's root", () => {
    expect(gitIgnored(hostWith({ ".gitignore": "*\n" }), "/repo")("/elsewhere/a.ts")).toBe(false);
  });
});
