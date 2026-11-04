import { describe, expect, it } from "vitest";
import { openEngine } from "../session.ts";
import { relativeSpecifiers, staticModule, type Value } from "./static-module.ts";

const engine = openEngine({ collectTiming: false });
const read = (text: string, name = "/project/tool.config.mjs") =>
  staticModule(engine.parseSourceFile(name, text));

/** A value as plain data, positions left out. */
function plain(value: Value): unknown {
  switch (value.kind) {
    case "text":
      return value.text;
    case "boolean":
      return value.value;
    case "array":
      return value.elements.map(plain);
    case "object":
      return Object.fromEntries(
        value.members.map((member) => [member.key ?? "<hidden>", plain(member.value)]),
      );
    case "directory":
      return { directory: value.segments };
    case "opaque":
      return "<opaque>";
  }
}

describe("a module's default export", () => {
  it.each([
    ["an object literal", 'export default { root: "web" };\n', [{ root: "web" }]],
    [
      "a top-level const, let or var read through to its initializer",
      'const a = { root: "a" };\nlet b = a;\nvar c = b;\nexport default c;\n',
      [{ root: "a" }],
    ],
    [
      "a call read in every argument",
      'const base = { root: "base" };\nexport default merge(base, define({ test: { root: "test" } }));\n',
      [{ root: "base" }, { test: { root: "test" } }],
    ],
    [
      "a default specifier",
      'const config = { root: "named" };\nexport { config as default };\n',
      [{ root: "named" }],
    ],
    ["export =", 'export = { root: "cjs" };\n', [{ root: "cjs" }]],
    [
      "a spread, a computed key, a shorthand and a method hidden or opaque",
      'const root = "x";\nexport default { ...other, [key]: 1, ["lit"]: "y", root, m() {} };\n',
      [{ "<hidden>": "<opaque>", lit: "y", root: "<opaque>", m: "<opaque>" }],
    ],
    [
      "a name a scope shadows read as nothing written",
      'const a = { root: "top" };\nfunction f(a) {\n  return a;\n}\nexport default f({});\n',
      [{}],
    ],
  ])("is read from %s", (_label, text, want) => {
    expect(read(text).defaultExport.map(plain)).toEqual(want);
  });

  it("is a JSON document's value", () => {
    expect(
      read('{ "root": "json", "list": ["a", true] }\n', "/project/.toolrc.json").defaultExport.map(
        plain,
      ),
    ).toEqual([{ root: "json", list: ["a", true] }]);
  });
});

describe("the options a call of a module's export passes", () => {
  it.each([
    ["a named import", 'import { plugin } from "tool";\nplugin({ dir: "a" });\n', [{ dir: "a" }]],
    [
      "a renamed import, read through a top-level name and no call",
      'import { plugin as p } from "tool";\nconst options = { dir: "b" };\np(options);\np(wrap({ dir: "no" }));\n',
      [{ dir: "b" }, "<opaque>"],
    ],
    [
      "a namespace import",
      'import * as tool from "tool";\ntool.plugin({ dir: "c" });\n',
      [{ dir: "c" }],
    ],
    [
      "a require binding through the require createRequire returns",
      'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nconst { plugin } = require("tool");\nplugin({ dir: "d" });\n',
      [{ dir: "d" }],
    ],
    [
      "a require binding of the whole module",
      'const tool = require("tool");\ntool.plugin({ dir: "e" });\nrequire("tool").plugin({ dir: "f" });\n',
      [{ dir: "e" }, { dir: "f" }],
    ],
    [
      "an import assignment",
      'import tool = require("tool");\ntool.plugin({ dir: "g" });\n',
      [{ dir: "g" }],
    ],
    [
      "a member a require binding reads",
      'const plugin = require("tool").plugin;\nplugin({ dir: "h" });\n',
      [{ dir: "h" }],
    ],
    [
      "the require createRequire returns, read as a member and through a second name",
      'const Module = require("node:module");\nconst load = Module.createRequire(__filename);\nconst again = load;\nagain("tool").plugin({ dir: "i" });\n',
      [{ dir: "i" }],
    ],
    [
      "the file's own require function, which no checker proves the file's",
      'function require(name) {\n  return {};\n}\nconst { plugin } = require("tool");\nplugin({ dir: "own" });\n',
      [{ dir: "own" }],
    ],
  ])("is read through %s", (_label, text, want) => {
    expect(read(text).options("tool", "plugin").map(plain)).toEqual(want);
  });

  it.each([
    [
      "a parameter that shadows the binding",
      'import { plugin } from "tool";\nfunction f(plugin) {\n  plugin({ dir: "no" });\n}\n',
    ],
    [
      "a local of an enclosing function",
      'import { plugin } from "tool";\nfunction f() {\n  if (x) {\n    var plugin = other;\n  }\n  plugin({ dir: "no" });\n}\n',
    ],
    [
      "a block-scoped local",
      'import { plugin } from "tool";\n{\n  const plugin = other;\n  plugin({ dir: "no" });\n}\n',
    ],
    [
      "a catch binding",
      'import { plugin } from "tool";\ntry {\n} catch (plugin) {\n  plugin({ dir: "no" });\n}\n',
    ],
    [
      "another module's export",
      'import { plugin } from "other";\nplugin({ dir: "no" });\nimport { other } from "tool";\nother({ dir: "no" });\n',
    ],
  ])("reads nothing through %s", (_label, text) => {
    expect(read(text).options("tool", "plugin")).toEqual([]);
  });

  it("reads a parameter named require as the platform's, as an AMD callback receives it", () => {
    expect(
      read('define(function (require) {\n  require("tool").plugin({ dir: "amd" });\n});\n')
        .options("tool", "plugin")
        .map(plain),
    ).toEqual([{ dir: "amd" }]);
  });

  it("reads no require binding below the top level", () => {
    expect(
      read(
        'function f() {\n  const { plugin } = require("tool");\n  plugin({ dir: "inner" });\n}\n',
      ).options("tool", "plugin"),
    ).toEqual([]);
  });
});

describe("the module value of a file Node runs as CommonJS", () => {
  it.each([
    [
      "the last write of module.exports, with the members later writes add",
      'module.exports = { a: "first" };\nmodule.exports = exports = { root: "last" };\nmodule.exports.extra = "later";\n',
      [{ root: "last", extra: "later" }],
    ],
    [
      "a top-level name read through to its initializer",
      'const config = { root: "named" };\nmodule.exports = config;\n',
      [{ root: "named" }],
    ],
    [
      "members alone where nothing replaces the module value",
      'exports.root = "members";\nmodule.exports.other = true;\n',
      [{ root: "members", other: true }],
    ],
    [
      "a hidden member where a write it does not model may set one",
      'module.exports = { root: "a" };\nmodule.exports.root ??= "b";\n',
      [{ root: "a", "<hidden>": "<opaque>" }],
    ],
  ])("is %s", (_label, text, want) => {
    expect(read(text, "/project/tool.config.cjs").defaultExport.map(plain)).toEqual(want);
  });

  it("is no module value where the file declares its own module", () => {
    expect(
      read(
        'const module = { exports: {} };\nmodule.exports = { root: "own" };\n',
        "/project/tool.config.cjs",
      ).defaultExport,
    ).toEqual([]);
  });
});

describe("the values a module writes out", () => {
  it.each([
    [
      "a join of the module's own directory and literals",
      'import { resolve } from "node:path";\nexport default { dir: resolve(__dirname, "src", "app") };\n',
      [{ dir: { directory: ["src", "app"] } }],
    ],
    [
      "a join of import.meta.dirname",
      'import path from "node:path";\nexport default { dir: path.join(import.meta.dirname, "web") };\n',
      [{ dir: { directory: ["web"] } }],
    ],
    [
      "opaque where a segment is computed",
      "export default { dir: resolve(__dirname, name) };\n",
      [{ dir: "<opaque>" }],
    ],
    [
      "opaque where a scope declares __dirname",
      'const __dirname = "/elsewhere";\nexport default { dir: resolve(__dirname, "web") };\n',
      [{ dir: "<opaque>" }],
    ],
    [
      "opaque through a let the file assigns again",
      'let config = { root: "first" };\nconfig = { root: "second" };\nexport default config;\n',
      ["<opaque>"],
    ],
  ])("is %s", (_label, text, want) => {
    expect(read(text).defaultExport.map(plain)).toEqual(want);
  });
});

describe("the calls a module makes of another module's exports", () => {
  it("reads a default import as the module's value and its namespace both", () => {
    const module = read(
      'import tool from "tool";\ntool({ dir: "value" });\ntool.plugin({ dir: "member" });\n',
    );
    expect(module.options("tool", "default").map(plain)).toEqual([{ dir: "value" }]);
    expect(module.options("tool", "plugin").map(plain)).toEqual([{ dir: "member" }]);
  });

  it("reads a require's value called with no binding between them", () => {
    expect(
      read('require("tool")({ dir: "direct" });\n', "/project/build.js")
        .options("tool", "default")
        .map(plain),
    ).toEqual([{ dir: "direct" }]);
  });

  it("reads through a require the file writes as a function, which no checker proves the file's", () => {
    expect(
      read('const require = (name) => () => name;\nrequire("tool")({ dir: "own" });\n')
        .options("tool", "default")
        .map(plain),
    ).toEqual([{ dir: "own" }]);
  });
});

describe("the relative specifiers of one parsed file", () => {
  it.each([
    [
      "imports, re-exports, import() and require() calls",
      'import "./a.js";\nexport { b } from "./b.js";\nconst c = import("./c.js");\nrequire("../d.js");\nrequire("pkg");\n',
      ["./a.js", "./b.js", "./c.js", "../d.js"],
    ],
    [
      "the require createRequire returns, under another name, and module.require",
      'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nload("./e.js");\nmodule.require("./f.js");\n',
      ["./e.js", "./f.js"],
    ],
    [
      "the require a createRequire imported under another name returns",
      'import { createRequire as make } from "node:module";\nconst load = make(import.meta.url);\nload("./e.js");\n',
      ["./e.js"],
    ],
    [
      "a require imported under another name",
      'import { require as load } from "loader";\nload("./e.js");\n',
      ["./e.js"],
    ],
    [
      "a call of a require the file writes itself, which no checker proves the file's, and none of a computed path",
      'function require(name) {\n  return name;\n}\nrequire("./own.js");\nimport(`./${name}.js`);\n',
      ["./own.js"],
    ],
    [
      "a require a parameter receives, as an AMD callback's",
      'define(function (require) {\n  require("./amd.js");\n});\n',
      ["./amd.js"],
    ],
    [
      "a require read through two names, and none through names that hold each other",
      'const load = require("node:module").createRequire(__filename);\nconst again = load;\nagain("./g.js");\nvar a = b;\nvar b = a;\na("./h.js");\n',
      ["./g.js"],
    ],
  ])("are those of %s", (_label, text, want) => {
    expect(relativeSpecifiers(engine.parseSourceFile("/project/x.js", text))).toEqual(want);
  });

  it("are read from its tree once, however many projects ask", () => {
    const parsed = engine.parseSourceFile(
      "/a.ts",
      'import { b } from "./b.js";\nexport const c = require("./c.js");\nexport * from "pkg";\n',
    );
    let walks = 0;
    const counted = new Proxy(parsed, {
      get: (target, key) => {
        if (key === "statements") {
          walks += 1;
        }
        return Reflect.get(target, key) as unknown;
      },
    });

    const first = relativeSpecifiers(counted);
    const again = relativeSpecifiers(counted);

    expect(first).toEqual(["./b.js", "./c.js"]);
    expect(again, "the second answer is the first").toBe(first);
    expect(walks, "and its tree is walked once").toBe(1);
  });
});
