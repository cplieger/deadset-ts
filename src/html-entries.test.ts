import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { emitterInputOf } from "../__test-helpers__/emitter-input.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { findingsOf } from "./findings/emitters.ts";
import { resolve } from "./resolve.ts";

/** A source file holding one statement, so a file nothing loads is its one finding. */
function source(name: string): Readonly<Record<string, string>> {
  return { [`src/${name}.ts`]: `console.log("${name}");\n` };
}

/** An application whose only entry points are the module scripts of its HTML files. */
const PROJECT: Readonly<Record<string, string>> = {
  "package.json": '{ "name": "@example/app", "type": "module" }\n',
  ...source("cased"),
  ...source("unquoted"),
  ...source("classic"),
  ...source("remote"),
  ...source("inline"),
  ...source("after"),
  ...source("hidden"),
  ...source("nested"),
  "index.html": [
    "<!doctype html>",
    "<SCRIPT Type='module' SRC='./src/cased.ts'></SCRIPT>",
    "<script type=module src=src/unquoted.ts></script>",
    '<script src="./src/classic.ts"></script>',
    '<script type="module" src="//src/remote.ts"></script>',
    '<script type="module">import "./src/inline.ts";</script>',
    '<p>import "./src/after.ts";</p>',
    "",
  ].join("\n"),
  "pages/about.html": '<script type="module" src="/src/nested.ts"></script>\n',
  "node_modules/kit/index.html": '<script type="module" src="../../src/hidden.ts"></script>\n',
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
  const { config } = resolve({ repository, repositoryLabel: "deadset.json" });
  return findingsOf(emitterInputOf(root, config))
    .filter((finding) => finding.code === "DS1502")
    .map((finding) => finding.position.path)
    .sort();
}

describe("the module scripts of an HTML file", () => {
  const found = neverImported();

  it.each([
    ["src/cased.ts", "an attribute whose name is written in capitals, its value single-quoted"],
    ["src/unquoted.ts", "an unquoted value with no leading ./"],
    ["src/inline.ts", "an import of an inline module script"],
    ["src/nested.ts", "a value starting with / read against the manifest's directory"],
  ])("root %s, named by %s", (path) => {
    expect(found).not.toContain(path);
  });

  it.each([
    ["src/classic.ts", "a script whose type is not module"],
    ["src/remote.ts", "a value naming another origin"],
    ["src/after.ts", "text after the end tag of an inline module script"],
    ["src/hidden.ts", "an HTML file inside a node_modules directory"],
  ])("leave %s unloaded, named by %s", (path) => {
    expect(found).toContain(path);
  });
});
