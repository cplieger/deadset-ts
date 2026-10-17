import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { FailureExit } from "../failure.ts";
import { findWorkspace, referenceOnlyIn, type ParsedLayout } from "./workspace.ts";

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
      "packages/empty-name/package.json": named(""),
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

  it("is found above a member whose directory name begins with two dots", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": JSON.stringify({ name: "root", workspaces: ["..pkg", "a"] }),
      "..pkg/package.json": named("dd"),
      "a/package.json": named("a"),
    });

    expect(memberDirs(root, join(root, "..pkg"))).toEqual([".", "..pkg", "a"]);
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

    expect(() => findWorkspace(nodeHost(), root, NO_LAYOUT)).toThrow(FailureExit);
    expect(() => findWorkspace(nodeHost(), root, NO_LAYOUT)).toThrow(/pnpm-workspace\.yaml/u);
  });

  it("reads a package a written name reaches through a symbolic link", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*", "linked"] }),
      "packages/a/package.json": named("a"),
      "elsewhere/pkg/package.json": named("pkg"),
    });
    symlinkSync(join(root, "elsewhere/pkg"), join(root, "linked"));

    expect(memberDirs(root)).toEqual([".", "linked", "packages/a"]);
  });

  it("orders a member's configurations by file name, whatever order its directory lists them in", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": JSON.stringify({ name: "root", workspaces: ["a"] }),
      "a/package.json": named("a"),
      "a/tsconfig.json": "{}",
      "a/tsconfig.build.json": "{}",
      "a/tsconfig.app.json": "{}",
    });
    const real = nodeHost();
    const host = {
      ...real,
      readDirectory: (dir: string) => [...real.readDirectory(dir)].reverse(),
    };
    const configurations = findWorkspace(host, root, (configFile) => ({
      fileNames: [configFile],
    }))?.members[1]?.configurations.map((one) => [...one.fileNames].join());

    expect(configurations).toEqual(
      ["tsconfig.app.json", "tsconfig.build.json", "tsconfig.json"].map((name) =>
        join(root, "a", name),
      ),
    );
  });

  it("refuses a workspaces array holding anything but strings, naming the manifest", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*", 1] }),
      "packages/a/package.json": named("a"),
    });

    expect(() => findWorkspace(nodeHost(), root, NO_LAYOUT)).toThrow(FailureExit);
    expect(() => findWorkspace(nodeHost(), root, NO_LAYOUT)).toThrow(
      /package\.json: workspaces is neither an array of strings/u,
    );
  });

  it("is none where the nearest manifest holds no object", () => {
    const root = writeTree({ ".git/": "", "package.json": "null" });

    expect(memberDirs(root)).toBeUndefined();
  });

  it("reads every depth ** names, but not into a directory whose pnpm-workspace.yaml declares its own", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": JSON.stringify({ name: "outer", workspaces: ["**"] }),
      "a/package.json": named("a"),
      "deep/er/pkg/package.json": named("pkg"),
      "nested/package.json": named("nested"),
      "nested/pnpm-workspace.yaml": "packages:\n  - inner/*\n",
      "nested/inner/x/package.json": named("x"),
    });

    expect(memberDirs(root)).toEqual([".", "a", "deep/er/pkg", "nested"]);
  });

  it("reads nothing below node_modules, whether ** or a written name reaches it", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": JSON.stringify({ name: "root", workspaces: ["**", "node_modules/dep"] }),
      "a/package.json": named("a"),
      "a/node_modules/inner/package.json": named("inner"),
      "node_modules/dep/package.json": named("dep"),
    });

    expect(memberDirs(root)).toEqual([".", "a"]);
  });

  it("reads no .git directory a pattern for hidden directories names", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/.*"] }),
      "packages/.config/package.json": named("config"),
      "packages/.git/package.json": named("git"),
    });

    expect(memberDirs(root)).toEqual([".", "packages/.config"]);
  });

  it("expands a brace list at the start of a pattern, and reads a closing brace with no opening one as written", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": JSON.stringify({ name: "root", workspaces: ["{one,two}", "x}"] }),
      "one/package.json": named("one"),
      "two/package.json": named("two"),
      "x}/package.json": named("x"),
    });

    expect(memberDirs(root)).toEqual([".", "one", "two", "x}"]);
  });

  it("matches ? to exactly one character, and a leading dot only to a segment written with one", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/a?", "packages/.h*"] }),
      "packages/ab/package.json": named("ab"),
      "packages/xb/package.json": named("xb"),
      "packages/abc/package.json": named("abc"),
      "packages/.hidden/package.json": named("hidden"),
      "packages/.other/package.json": named("other"),
    });

    expect(memberDirs(root)).toEqual([".", "packages/.hidden", "packages/ab"]);
  });

  it("reads no pattern that leaves the workspace root", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*", "../other/*"] }),
      "packages/a/package.json": named("a"),
      "other/x/package.json": named("x"),
    });

    expect(memberDirs(root)).toEqual([".", "packages/a"]);
  });

  it("applies an exclusion written with ./ and an empty segment", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": JSON.stringify({
        name: "root",
        workspaces: ["packages/*", "!./packages//b"],
      }),
      "packages/a/package.json": named("a"),
      "packages/b/package.json": named("b"),
    });

    expect(memberDirs(root)).toEqual([".", "packages/a"]);
  });

  it("excludes only the directories an exclusion names, ** standing for any run of segments but no hidden one", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": JSON.stringify({
        name: "root",
        workspaces: ["packages/**", "packages/.cache/skip", "!packages/**/skip", "!packages/a"],
      }),
      "packages/a/package.json": named("a"),
      "packages/a/sub/package.json": named("sub"),
      "packages/skip/package.json": named("skip"),
      "packages/b/c/skip/package.json": named("deep-skip"),
      "packages/.cache/skip/package.json": named("cached-skip"),
      "packages/keep/package.json": named("keep"),
    });

    expect(memberDirs(root)).toEqual([
      ".",
      "packages/.cache/skip",
      "packages/a/sub",
      "packages/keep",
    ]);
  });

  it("keeps the root a member whatever the exclusions match", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*", "!."] }),
      "packages/a/package.json": named("a"),
    });

    expect(memberDirs(root)).toEqual([".", "packages/a"]);
  });

  it("answers a workspace already read where the nearest declaration is its own, and reads another afresh", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      "packages/a/package.json": named("a"),
      "packages/b/package.json": named("b"),
      "other/package.json": JSON.stringify({ name: "other", workspaces: ["*"] }),
      "other/c/package.json": named("c"),
    });
    const known = findWorkspace(nodeHost(), root, NO_LAYOUT);

    expect(findWorkspace(nodeHost(), join(root, "packages/b"), NO_LAYOUT, known)).toBe(known);
    const other = findWorkspace(nodeHost(), join(root, "other"), NO_LAYOUT, known);
    expect(other).not.toBe(known);
    expect(other?.members.map((member) => member.name)).toEqual(["other", "c"]);
  });

  it("answers no member for a path under no manifest, and holds no such file only for references", () => {
    const root = writeTree({
      ".git/": "",
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      "packages/a/package.json": named("a"),
    });
    const workspace = findWorkspace(nodeHost(), root, NO_LAYOUT);
    const outside = join(dirname(root), "elsewhere", "x.ts");
    const inMember = join(root, "packages/a/src/x.ts");
    const referenceOnly = referenceOnlyIn(workspace!, new Set([join(root, "packages/a/src/y.ts")]));

    expect(workspace?.memberOf(outside)).toBeUndefined();
    expect(workspace?.memberOf(inMember)?.name).toBe("a");
    expect([outside, inMember, join(root, "packages/a/src/y.ts")].map(referenceOnly)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("reads an output tree with no root directory below the configuration's directory, then below its inputs", () => {
    expect(
      layoutOf((dir) => ({
        fileNames: [join(dir, "src/index.ts"), join(dir, "src/x/y.ts")],
        outDir: join(dir, "dist"),
      }))?.sourceDirs,
    ).toEqual(["a", "a/src"]);
  });

  it("reads no output tree for a configuration that names no output directory", () => {
    expect(layoutOf((dir) => ({ fileNames: [join(dir, "src/index.ts")] }))).toBeUndefined();
  });

  it("reads the output tree of a configuration that names only a declaration directory", () => {
    expect(
      layoutOf((dir) => ({
        fileNames: [join(dir, "src/index.ts")],
        declarationDir: join(dir, "types"),
      })),
    ).toEqual({ outDir: undefined, declarationDir: "a/types", sourceDirs: ["a", "a/src"] });
  });

  it("reads no declaration file as an input of the output tree", () => {
    expect(
      layoutOf((dir) => ({
        fileNames: [
          join(dir, "src/index.ts"),
          join(dir, "types/x.d.ts"),
          join(dir, "types/y.d.mts"),
          join(dir, "types/z.d.cts"),
        ],
        outDir: join(dir, "dist"),
      }))?.sourceDirs,
    ).toEqual(["a", "a/src"]);
  });

  it("reads a file whose name holds .d.ts short of its end as an input", () => {
    expect(
      layoutOf((dir) => ({
        fileNames: [join(dir, "src/index.ts"), join(dir, "lib/icons.d.tsx")],
        outDir: join(dir, "dist"),
      }))?.sourceDirs,
    ).toEqual(["a"]);
  });

  it("reads the output tree of a configuration that compiles only declaration files below its own directory", () => {
    expect(
      layoutOf((dir) => ({ fileNames: [join(dir, "types/x.d.ts")], outDir: join(dir, "dist") }))
        ?.sourceDirs,
    ).toEqual(["a"]);
  });
});

/**
 * The output tree a member's one configuration writes, read through `parse` given the
 * member's directory, its paths below the workspace root.
 */
function layoutOf(parse: (dir: string) => ParsedLayout):
  | {
      readonly outDir: string | undefined;
      readonly declarationDir: string | undefined;
      readonly sourceDirs: readonly (string | undefined)[];
    }
  | undefined {
  const root = writeTree({
    ".git/": "",
    "package.json": JSON.stringify({ name: "root", workspaces: ["a"] }),
    "a/package.json": named("a"),
    "a/tsconfig.json": "{}",
  });
  const layout = findWorkspace(nodeHost(), root, (configFile) => parse(dirname(configFile)))
    ?.members[1]?.configurations[0]?.layout;
  const below = (path: string | undefined): string | undefined =>
    path === undefined ? undefined : path.slice(root.length + 1);
  return layout === undefined
    ? undefined
    : {
        outDir: below(layout.outDir),
        declarationDir: below(layout.declarationDir),
        sourceDirs: layout.sourceDirs.map(below),
      };
}
