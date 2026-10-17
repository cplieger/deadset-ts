import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { emitterInputOf, findingsOf } from "../__test-helpers__/emitter-input.ts";
import { targetConfigFiles, writeProject } from "../__test-helpers__/projects.ts";
import { discoverProjects } from "./load/discover.ts";
import { htmlEntries } from "./html-entries.ts";
import { relativePath } from "./paths.ts";
import { resolve } from "./resolve.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine, runSession } from "./session.ts";
import { sourceFilesOf } from "./source-files.ts";

/** A source file holding one statement, so a file nothing loads is its one finding. */
function source(name: string): Readonly<Record<string, string>> {
  return { [`src/${name}.ts`]: `console.log("${name}");\n` };
}

/** An application whose only entry points are the scripts of its HTML files. */
const PROJECT: Readonly<Record<string, string>> = {
  "package.json": '{ "name": "@example/app", "type": "module" }\n',
  ...source("cased"),
  ...source("unquoted"),
  ...source("classic"),
  ...source("typed"),
  ...source("data"),
  ...source("remote"),
  ...source("inline"),
  ...source("after"),
  ...source("hidden"),
  ...source("nested"),
  ...source("tracked"),
  "index.html": [
    "<!doctype html>",
    "<SCRIPT Type='module' SRC='./src/cased.ts'></SCRIPT>",
    "<script type=module src=src/unquoted.ts></script>",
    '<script src="./src/classic.ts"></script>',
    '<script type="Text/JavaScript" src="./src/typed.ts"></script>',
    '<script type="application/json" src="./src/data.ts"></script>',
    '<script type="module" src="//src/remote.ts"></script>',
    '<script type="module">import "./src/inline.ts";</script>',
    '<p>import "./src/after.ts";</p>',
    "",
  ].join("\n"),
  "pages/about.html": '<script type="module" src="/src/nested.ts"></script>\n',
  "node_modules/kit/index.html": '<script type="module" src="../../src/hidden.ts"></script>\n',
  ".git/index.html": '<script type="module" src="../src/tracked.ts"></script>\n',
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The files of the project reported as never imported, by path. */
function neverImported(): string[] {
  const root = writeProject(PROJECT);
  roots.push(root);
  const repository = JSON.stringify({ target: { kind: "application" } });
  const { config } = resolve({ repository: { text: repository, label: "deadset.json" } });
  return findingsOf(emitterInputOf(root, config))
    .filter((finding) => finding.code === "DS1602")
    .map((finding) => finding.position.path)
    .sort();
}

describe("the scripts of an HTML file", () => {
  const found = neverImported();

  it.each([
    ["src/cased.ts", "an attribute whose name is written in capitals, its value single-quoted"],
    ["src/unquoted.ts", "an unquoted value with no leading ./"],
    ["src/inline.ts", "an import of an inline module script"],
    ["src/classic.ts", "a classic script with no type"],
    ["src/typed.ts", "a classic script whose JavaScript type is written in capitals"],
    ["src/nested.ts", "a value starting with / read against the manifest's directory"],
  ])("root %s, named by %s", (path) => {
    expect(found).not.toContain(path);
  });

  it.each([
    ["src/data.ts", "a script whose type is neither module nor JavaScript"],
    ["src/remote.ts", "a value naming another origin"],
    ["src/after.ts", "text after the end tag of an inline module script"],
    ["src/hidden.ts", "an HTML file inside a node_modules directory"],
    ["src/tracked.ts", "an HTML file inside the .git directory"],
  ])("leave %s unloaded, named by %s", (path) => {
    expect(found).toContain(path);
  });
});

describe("a page that loads a configuration's compiled output", () => {
  it("roots the source each relative or root-absolute src reads back to, and no other", () => {
    const root = writeProject({
      "package.json": '{ "name": "@example/app", "type": "module" }\n',
      "web/tsconfig.json": JSON.stringify({
        compilerOptions: { rootDir: ".", outDir: "../public", module: "nodenext" },
        include: ["*.ts"],
      }),
      "web/app.ts": 'console.log("app");\n',
      "web/panel.ts": 'console.log("panel");\n',
      "web/orphan.ts": 'console.log("orphan");\n',
      "public/index.html": [
        '<script type="module" src="./app.js"></script>',
        '<script type="module" src="/panel.js"></script>',
        "",
      ].join("\n"),
    });
    roots.push(root);
    const repository = JSON.stringify({ target: { kind: "application" } });
    const { config } = resolve({ repository: { text: repository, label: "deadset.json" } });

    expect(
      findingsOf(emitterInputOf(root, config))
        .filter((finding) => finding.code === "DS1602")
        .map((finding) => finding.position.path),
    ).toEqual(["web/orphan.ts"]);
  });
});

/**
 * Each file the HTML files of one written project load, below its root, with the value
 * that named it, in ascending order. Inline scripts are parsed unless `parse` is false.
 */
function entriesOf(files: Readonly<Record<string, string>>, parse = true): string[] {
  const root = writeProject(files);
  try {
    const host = nodeHost();
    const engine = openEngine({ collectTiming: false });
    const configFiles = targetConfigFiles(discoverProjects(engine, host, scopeForDir(host, root)));
    const found: string[] = [];
    runSession(engine, configFiles, (project) => {
      const entries = htmlEntries(
        host,
        root,
        sourceFilesOf(project, root),
        parse ? (fileName, text) => engine.parseSourceFile(fileName, text) : undefined,
      );
      found.push(
        ...entries.map(
          (entry) => `${relativePath(root, entry.file.fileName) ?? "?"} <- ${entry.source}`,
        ),
      );
    });
    return found.sort();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** One source file per name below `src/`, each holding one statement. */
function sources(...names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [`src/${name}.ts`, `console.log("${name}");\n`]));
}

const MANIFEST = { "package.json": '{ "name": "@example/app", "type": "module" }\n' };

describe("the files the scripts of a project's HTML files load", () => {
  it("are named by the src of a module script, in any spelling of its attributes", () => {
    expect(
      entriesOf({
        ...MANIFEST,
        ...sources("cased", "unquoted", "quoted", "repeated"),
        "index.html": [
          "<SCRIPT Type='module' SRC='./src/cased.ts'></SCRIPT>",
          "<script type=module src=src/unquoted.ts></script>",
          '<script type="module" src="./src/quoted.ts" src="./src/repeated.ts"></script>',
          "",
        ].join("\n"),
      }),
    ).toEqual([
      "src/cased.ts <- ./src/cased.ts",
      "src/quoted.ts <- ./src/quoted.ts",
      "src/unquoted.ts <- src/unquoted.ts",
    ]);
  });

  it("are named by the src of a classic script of no type or a JavaScript one, and of no other", () => {
    expect(
      entriesOf({
        ...MANIFEST,
        ...sources("classic", "typed", "data", "plain"),
        "index.html": [
          '<script src="./src/classic.ts"></script>',
          '<script type="Text/JavaScript" src="./src/typed.ts"></script>',
          '<script type="application/json" src="./src/data.ts"></script>',
          '<script type="text/plain">import "./src/plain.ts";</script>',
          "",
        ].join("\n"),
      }),
    ).toEqual(["src/classic.ts <- ./src/classic.ts", "src/typed.ts <- ./src/typed.ts"]);
  });

  it("are the files an inline module script imports or re-exports by a relative or root-absolute specifier", () => {
    expect(
      entriesOf({
        ...MANIFEST,
        ...sources("first", "again", "rooted", "second", "after"),
        "helper.ts": 'console.log("helper");\n',
        "index.html": [
          '<script type="module">import "./src/first.ts"; export * from "./src/again.ts"; import "helper";</script>',
          '<script src="./src/missing.ts"></script>',
          '<script type="module">import "/src/rooted.ts";',
          'import "./src/second.ts";</script>',
          'import "./src/after.ts";',
          "",
        ].join("\n"),
      }),
    ).toEqual([
      "src/again.ts <- ./src/again.ts",
      "src/first.ts <- ./src/first.ts",
      "src/rooted.ts <- /src/rooted.ts",
      "src/second.ts <- ./src/second.ts",
    ]);
  });

  it("are read from an inline module script to the end of the file where it has no end tag", () => {
    expect(
      entriesOf({
        ...MANIFEST,
        ...sources("x", "xy"),
        "index.html": '<p></p><script type="module">import "./src/xy',
      }),
    ).toEqual(["src/xy.ts <- ./src/xy"]);
  });

  it("are none an inline script names where no parser is given", () => {
    expect(
      entriesOf(
        {
          ...MANIFEST,
          ...sources("inline", "linked"),
          "index.html": [
            '<script type="module">import "./src/inline.ts";</script>',
            '<script type="module" src="./src/linked.ts"></script>',
            "",
          ].join("\n"),
        },
        false,
      ),
    ).toEqual(["src/linked.ts <- ./src/linked.ts"]);
  });

  it("are read from every HTML file below the root but none in node_modules, and from no other file", () => {
    expect(
      entriesOf({
        ...MANIFEST,
        ...sources("top", "nested", "deep", "hidden", "text"),
        "index.html": '<script type="module" src="./src/top.ts"></script>\n',
        "pages/about.html": '<script type="module" src="../src/nested.ts"></script>\n',
        "pages/more/deep.html": '<script type="module" src="../../src/deep.ts"></script>\n',
        "node_modules/kit/index.html":
          '<script type="module" src="../../src/hidden.ts"></script>\n',
        "notes.txt": '<script type="module" src="./src/text.ts"></script>\n',
        "html/readme.md": '<script type="module" src="../src/text.ts"></script>\n',
      }),
    ).toEqual([
      "src/deep.ts <- ../../src/deep.ts",
      "src/nested.ts <- ../src/nested.ts",
      "src/top.ts <- ./src/top.ts",
    ]);
  });

  it("read a root-absolute value against the nearest manifest's directory, and else the root's", () => {
    expect(
      entriesOf({
        ...MANIFEST,
        "main.ts": 'console.log("root main");\n',
        "app/package.json": '{ "name": "@example/inner", "type": "module" }\n',
        "app/main.ts": 'console.log("app main");\n',
        "app/web/pages/index.html": '<script type="module" src="/main.ts"></script>\n',
        "docs/index.html": '<script type="module" src="/main.ts"></script>\n',
      }),
    ).toEqual(["app/main.ts <- /main.ts", "main.ts <- /main.ts"]);
  });

  it("are read to the source file a value names with no extension", () => {
    expect(
      entriesOf({
        ...MANIFEST,
        ...sources("plain"),
        "index.html": '<script type="module" src="./src/plain"></script>\n',
      }),
    ).toEqual(["src/plain.ts <- ./src/plain"]);
  });

  it("are none for a value naming another origin or scheme", () => {
    expect(
      entriesOf({
        ...MANIFEST,
        ...sources("remote", "scheme"),
        "index.html": [
          '<script type="module" src="//src/remote.ts"></script>',
          '<script type="module" src="file:./src/scheme.ts"></script>',
          "",
        ].join("\n"),
      }),
    ).toEqual([]);
  });
});
