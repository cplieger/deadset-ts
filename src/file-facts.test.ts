import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { targetConfigFiles, writeProject } from "../__test-helpers__/projects.ts";
import { discoverProjects } from "./load/discover.ts";
import { heldByInclusion, sourcePaths, sourceTree } from "./file-facts.ts";
import type { DirectoryEntry, Host } from "./host.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine, runSession } from "./session.ts";

const ROOT = "/target";

function hostOf(
  directories: Readonly<Record<string, readonly DirectoryEntry[]>>,
  files: Readonly<Record<string, string>>,
  unreadable: readonly string[] = [],
): Host {
  const below = (path: string): string => path.slice(ROOT.length + 1);
  return {
    workingDirectory: () => ROOT,
    readFile: (path) => {
      const text = files[below(path)];
      if (text === undefined || unreadable.includes(below(path))) {
        throw new Error(`${path}: cannot be read`);
      }
      return text;
    },
    readDirectory: (path) => {
      const dir = path === ROOT ? "" : below(path);
      const entries = directories[dir];
      if (entries === undefined || unreadable.includes(dir)) {
        throw new Error(`${path}: cannot be read`);
      }
      return entries;
    },
    kindOf: (path) => (files[below(path)] === undefined ? "absent" : "file"),
    realPath: (path) => path,
    analyzerVersion: () => "0.0.0-devel",
    temporaryDirectory: () => {
      throw new Error("no temporary directory");
    },
    componentMapperCommand: () => [],
    writeDocument: (path) => {
      throw new Error(`${path}: this host writes nothing`);
    },
  };
}

const file = (name: string): DirectoryEntry => ({ name, directory: false });
const dir = (name: string): DirectoryEntry => ({ name, directory: true });

describe("the source files below the target root", () => {
  it("are every source file a configuration can include, in path order, whatever order the directories list them in", () => {
    const host = hostOf(
      {
        "": [file("z.ts"), dir("m"), file("a.mts"), file("types.d.ts"), file("notes.md")],
        m: [file("b.tsx"), file("c.d.mts"), file("d.cts"), dir("node_modules"), dir(".git")],
        "m/node_modules": [file("dep.ts")],
        "m/.git": [file("hook.ts")],
      },
      {},
    );

    expect(sourcePaths(host, ROOT)).toEqual(["a.mts", "m/b.tsx", "m/d.cts", "z.ts"]);
  });

  it("skip a directory that cannot be read", () => {
    const host = hostOf({ "": [file("a.ts"), dir("locked")], locked: [file("b.ts")] }, {}, [
      "locked",
    ]);

    expect(sourcePaths(host, ROOT)).toEqual(["a.ts"]);
  });

  it("carry the line of each file's last character, and skip a file that cannot be read", () => {
    const host = hostOf(
      { "": [file("a.ts"), file("b.ts"), file("c.ts"), file("d.ts"), file("e.ts")] },
      {
        "package.json": '{ "name": "@example/tree" }',
        "a.ts": "",
        "b.ts": "one\nt",
        "c.ts": "one\r\ntwo\n",
        "d.ts": "one\u2028two\rthree",
        "e.ts": "unread",
      },
      ["e.ts"],
    );

    expect(sourceTree(host, ROOT).map((one) => `${one.path} ${String(one.endLine)}`)).toEqual([
      "a.ts 1",
      "b.ts 2",
      "c.ts 2",
      "d.ts 3",
    ]);
  });
});

function included(files: Readonly<Record<string, string>>): readonly string[] {
  const root = writeProject(files);
  try {
    const host = nodeHost();
    const engine = openEngine({ collectTiming: false });
    const configFiles = targetConfigFiles(discoverProjects(engine, host, scopeForDir(host, root)));
    return runSession(engine, configFiles, (project) =>
      heldByInclusion(project, root),
    ).projects.flat();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the files a program holds by inclusion", () => {
  it("are a file naming another by a triple-slash path reference, and the file it names", () => {
    expect(
      included({
        "main.ts": '/// <reference path="./globals.ts" />\nexport const main = 1;\n',
        "globals.ts": "declare const shared: number;\n",
        "plain.ts": "export const plain = 1;\n",
      }),
    ).toEqual(["main.ts", "globals.ts"]);
  });

  it("are a file carrying a triple-slash types reference", () => {
    expect(
      included({
        "main.ts": '/// <reference types="shim" />\nexport const main = 1;\n',
        "node_modules/@types/shim/package.json":
          '{ "name": "@types/shim", "types": "index.d.ts" }\n',
        "node_modules/@types/shim/index.d.ts": "declare const shim: number;\n",
        "plain.ts": "export const plain = 1;\n",
      }),
    ).toEqual(["main.ts"]);
  });
});
