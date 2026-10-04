import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { DiscoveryError } from "./discover.ts";
import { findWorkspace, type ParsedLayout } from "./workspace.ts";

const written: string[] = [];

afterEach(() => {
  for (const root of written.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A tree below a fresh directory, each entry a path and its text; a path ending in `/` is a directory. */
function writeTree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "deadset-ts-workspace-"));
  written.push(root);
  for (const [path, text] of Object.entries(files)) {
    if (path.endsWith("/")) {
      mkdirSync(join(root, path), { recursive: true });
      continue;
    }
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function named(name: string): string {
  return JSON.stringify({ name });
}

/** A parse that reads no configuration, for cases about which packages are members. */
const NO_LAYOUT = (): ParsedLayout | undefined => undefined;

/** The member directories of the workspace a target sits in, below `root`. */
function memberDirs(root: string, target: string = root): string[] | undefined {
  return findWorkspace(nodeHost(), target, NO_LAYOUT)?.members.map((member) =>
    member.dir === root ? "." : member.dir.slice(root.length + 1),
  );
}

describe("findWorkspace", () => {
  it("reads the packages a manifest's workspaces array names, the root first", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      "packages/b/package.json": named("b"),
      "packages/a/package.json": named("a"),
      "packages/unnamed/package.json": "{}",
      "packages/no-manifest/": "",
    });

    expect(memberDirs(root)).toEqual([".", "packages/a", "packages/b"]);
  });

  it("reads the packages object a yarn manifest declares", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": JSON.stringify({ name: "root", workspaces: { packages: ["libs/*"] } }),
      "libs/a/package.json": named("a"),
    });

    expect(memberDirs(root)).toEqual([".", "libs/a"]);
  });

  it("reads pnpm-workspace.yaml under pnpm's pattern rules", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": named("root"),
      "pnpm-workspace.yaml":
        "packages:\n  - ./packages//*\n  - 'tools/**'\n  - '!tools/**/fixtures/**'\n  - other/../extra\n",
      "packages/a/package.json": named("a"),
      "packages/.hidden/package.json": named("hidden"),
      "packages/a/node_modules/dep/package.json": named("dep"),
      "tools/x/package.json": named("x"),
      "tools/x/fixtures/y/package.json": named("y"),
      "tools/.cache/z/package.json": named("z"),
      "extra/package.json": named("extra"),
    });

    expect(memberDirs(root)).toEqual([".", "extra", "packages/a", "tools/x"]);
  });

  it("is found above a target that is one of its packages", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      "packages/a/package.json": named("a"),
      "packages/b/package.json": named("b"),
    });

    expect(memberDirs(root, join(root, "packages/b"))).toEqual([".", "packages/a", "packages/b"]);
  });

  it("is found above a package that sits inside one of its packages", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      "packages/a/package.json": named("a"),
      "packages/a/examples/demo/package.json": named("demo"),
    });

    expect(memberDirs(root, join(root, "packages/a/examples/demo"))).toEqual([".", "packages/a"]);
  });

  it("is not adopted from an ancestor whose patterns do not name the target's package", () => {
    const outer = writeTree({
      "package.json": JSON.stringify({ name: "outer", workspaces: ["packages/*"] }),
      "packages/a/package.json": named("a"),
      "copies/app/package.json": named("app"),
    });

    expect(memberDirs(outer, join(outer, "copies/app"))).toBeUndefined();
  });

  it("is not adopted from an ancestor whose patterns exclude the target's package", () => {
    const outer = writeTree({
      "package.json": JSON.stringify({
        name: "outer",
        workspaces: ["packages/*", "!packages/app"],
      }),
      "packages/a/package.json": named("a"),
      "packages/app/package.json": named("app"),
    });

    expect(memberDirs(outer, join(outer, "packages/app"))).toBeUndefined();
  });

  it("is adopted from an ancestor by a target whose package is one a brace list names", () => {
    const outer = writeTree({
      "package.json": JSON.stringify({ name: "outer", workspaces: ["packages/{a,app}"] }),
      "packages/a/package.json": named("a"),
      "packages/app/package.json": named("app"),
    });

    expect(memberDirs(outer, join(outer, "packages/app"))).toEqual([
      ".",
      "packages/a",
      "packages/app",
    ]);
  });

  it("is not adopted from an ancestor by a target below node_modules", () => {
    const outer = writeTree({
      "package.json": JSON.stringify({ name: "outer", workspaces: ["**"] }),
      "a/package.json": named("a"),
      "node_modules/dep/package.json": named("dep"),
    });

    expect(memberDirs(outer, join(outer, "node_modules/dep"))).toBeUndefined();
  });

  it("is adopted from an ancestor by a target with no manifest of its own, which is the workspace root's", () => {
    const outer = writeTree({
      "package.json": JSON.stringify({ name: "outer", workspaces: ["packages/*"] }),
      "packages/a/package.json": named("a"),
      "tools/tsconfig.json": "{}",
    });

    expect(memberDirs(outer, join(outer, "tools"))).toEqual([".", "packages/a"]);
  });

  it("is not adopted by a target with no manifest of its own inside a package the patterns do not name", () => {
    const outer = writeTree({
      "package.json": JSON.stringify({ name: "outer", workspaces: ["packages/*"] }),
      "packages/a/package.json": named("a"),
      "copies/app/package.json": named("app"),
      "copies/app/scripts/tsconfig.json": "{}",
    });

    expect(memberDirs(outer, join(outer, "copies/app/scripts"))).toBeUndefined();
  });

  it("lists no directory of an ancestor workspace whose patterns do not name the target's package", () => {
    const outer = writeTree({
      "package.json": JSON.stringify({ name: "outer", workspaces: ["packages/*"] }),
      "packages/a/package.json": named("a"),
      "copies/app/package.json": named("app"),
    });
    const real = nodeHost();
    const listed: string[] = [];
    const host = {
      ...real,
      readDirectory: (dir: string) => {
        listed.push(dir);
        return real.readDirectory(dir);
      },
    };

    findWorkspace(host, join(outer, "copies/app"), NO_LAYOUT);

    expect(listed).toEqual([]);
  });

  it("is not read above the repository root the target is in", () => {
    const outer = writeTree({
      "package.json": JSON.stringify({ name: "outer", workspaces: ["repo"] }),
      "repo/.git/": "",
      "repo/package.json": named("repo"),
    });

    expect(memberDirs(outer, join(outer, "repo"))).toBeUndefined();
  });

  it("is the nearest one, and the outer one's ** does not reach into it", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": JSON.stringify({ name: "outer", workspaces: ["**"] }),
      "a/package.json": named("a"),
      "nested/package.json": JSON.stringify({ name: "nested", workspaces: ["inner/*"] }),
      "nested/inner/x/package.json": named("x"),
    });

    expect(memberDirs(root)).toEqual([".", "a", "nested"]);
    expect(memberDirs(join(root, "nested"))).toEqual([".", "inner/x"]);
  });

  it("names every member that shares a name", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": JSON.stringify({ name: "root", workspaces: ["one", "two"] }),
      "one/package.json": named("same"),
      "two/package.json": named("same"),
    });

    expect(
      findWorkspace(nodeHost(), root, NO_LAYOUT)
        ?.named.get("same")
        ?.map((member) => member.dir.slice(root.length + 1)),
    ).toEqual(["one", "two"]);
  });

  it("is none where the declaration names no package beside the root", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
    });

    expect(memberDirs(root)).toBeUndefined();
  });

  it("refuses a pnpm-workspace.yaml whose packages it does not read, naming the file", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": named("root"),
      "pnpm-workspace.yaml": "packages: &all\n  - a\n",
    });

    expect(() => findWorkspace(nodeHost(), root, NO_LAYOUT)).toThrow(DiscoveryError);
    expect(() => findWorkspace(nodeHost(), root, NO_LAYOUT)).toThrow(/pnpm-workspace\.yaml/u);
  });

  it("reads an output tree with no root directory below the configuration's directory, then below its inputs", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": JSON.stringify({ name: "root", workspaces: ["a"] }),
      "a/package.json": named("a"),
      "a/tsconfig.json": "{}",
    });
    const layout = (configFile: string): ParsedLayout => ({
      fileNames: [
        join(dirname(configFile), "src/index.ts"),
        join(dirname(configFile), "src/x/y.ts"),
      ],
      outDir: join(dirname(configFile), "dist"),
    });

    expect(
      findWorkspace(nodeHost(), root, layout)?.members[1]?.configurations[0]?.layout?.sourceDirs,
    ).toEqual([join(root, "a"), join(root, "a/src")]);
  });
});
