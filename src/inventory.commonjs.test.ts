import { describe, expect, it } from "vitest";
import { analyzeProject } from "../__test-helpers__/projects.ts";
import type { Inventory } from "./inventory.ts";

const JAVASCRIPT = `${JSON.stringify({
  compilerOptions: {
    allowJs: true,
    checkJs: false,
    module: "NodeNext",
    moduleResolution: "nodenext",
    noEmit: true,
    target: "ESNext",
  },
})}\n`;

/** One JavaScript project's inventory, from a tree holding a manifest and these files. */
function inventoryOf(files: Readonly<Record<string, string>>): Inventory | undefined {
  return analyzeProject({
    "tsconfig.json": JAVASCRIPT,
    "package.json": '{ "name": "cjs" }\n',
    ...files,
  }).inventories[0];
}

/**
 * Each declaration one file holds but the file itself, as
 * `<kind> <name> <fragment> <line>:<column> <exported>`, with `held` where it is unknown
 * whether it is used, and `open` last where the file's table is open.
 */
function declared(files: Readonly<Record<string, string>>, path: string): string[] {
  const held = inventoryOf(files);
  const unknown = new Set(held?.unanswered ?? []);
  const symbols = (held?.symbols ?? []).filter((symbol) => symbol.position.path === path);
  const open = symbols.some(
    (symbol) => symbol.kind === "file" && held?.openTables.has(symbol.id) === true,
  );
  return [
    ...symbols
      .filter((symbol) => symbol.kind !== "file")
      .map(
        (symbol) =>
          `${symbol.kind} ${symbol.name} ${symbol.ref.slice(symbol.ref.indexOf("#"))} ` +
          `${String(symbol.position.line)}:${String(symbol.position.column)} ` +
          `${symbol.exported ? "exported" : "local"}${unknown.has(symbol.id) ? " held" : ""}`,
      ),
    ...(open ? ["open"] : []),
  ];
}

describe("a CommonJS export table", () => {
  it("names the module value an identifier assigns as a default alias, and exports the declaration", () => {
    expect(declared({ "a.js": "function one() {}\nmodule.exports = one;\n" }, "a.js")).toEqual([
      "function one #one 1:10 exported",
      "export-alias default #default:alias 2:8 exported held",
    ]);
  });

  it("declares a function or class expression the module value is as the default, members included", () => {
    const files = {
      "f.js": "module.exports = function named(a) {};\nmodule.exports.extra = 1;\n",
      "k.js": "module.exports = class Named {\n  m() {}\n  static s() {}\n};\n",
    };
    expect(declared(files, "f.js")).toEqual([
      "function named #default 1:8 exported held",
      "variable extra #extra 2:16 exported held",
    ]);
    expect(declared(files, "k.js")).toEqual([
      "class Named #default 1:8 exported held",
      "method default.m #default.m 2:3 local held",
      "method default.s #default.s:static 3:10 local held",
    ]);
  });

  it("places the module value at the exports name it assigns, apart from the file's own position", () => {
    const files = {
      "f.js": "module.exports = function () {};\n",
      "c.js": "exports = module.exports = function () {};\nexports.extra = 1;\n",
    };
    expect(declared(files, "f.js")).toEqual(["function default #default 1:8 exported held"]);
    expect(declared(files, "c.js")).toEqual([
      "function default #default 1:18 exported held",
      "variable extra #extra 2:9 exported held",
    ]);
    const ids = (inventoryOf(files)?.symbols ?? []).map((symbol) => symbol.id);
    expect(ids).toContain("f.js:1:1");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares an arrow the module value is as the default, and nothing for a module value a require gives", () => {
    const files = {
      "w.js": "module.exports = () => 1;\n",
      "r.js":
        "exports.early = 1;\nmodule.exports = require('./x.js');\nmodule.exports.after = 2;\n",
      "x.js": "exports.x = 1;\n",
    };
    expect(declared(files, "w.js")).toEqual(["function default #default 1:8 exported held"]);
    expect(declared(files, "r.js")).toEqual(["variable after #after 3:16 exported held"]);
  });

  it("reads a require another file declares as the module system's", () => {
    const files = {
      "globals.d.ts": "declare function require(id: string): unknown;\n",
      "r.js": "module.exports = require('./x.js');\nmodule.exports.after = 2;\n",
    };
    expect(declared(files, "r.js")).toEqual(["variable after #after 2:16 exported held"]);
  });

  it("declares one entry per property of an object literal the module value is", () => {
    expect(
      declared(
        {
          "t.js":
            "function liveC() {}\nmodule.exports = {\n  liveC,\n  renamed: liveC,\n  x: 1,\n  f() {},\n  g: () => 1,\n  K: class {},\n  'quoted key': 2,\n};\n",
        },
        "t.js",
      ),
    ).toEqual([
      "function liveC #liveC 1:10 local",
      "export-alias liveC #liveC:alias 3:3 exported held",
      "export-alias renamed #renamed:alias 4:3 exported held",
      "variable x #x 5:3 exported held",
      "function f #f 6:3 exported held",
      "function g #g 7:3 exported held",
      "class K #K 8:3 exported held",
      "variable 'quoted key' #'quoted key' 9:3 exported held",
    ]);
  });

  it("declares a property each literal-keyed write of the exports declares", () => {
    expect(
      declared(
        {
          "p.js":
            "exports.k = function () {};\nexports.v = 1;\nmodule.exports.w = 2;\nmodule.exports['q'] = 3;\nObject.defineProperty(exports, 'd', { value: 4 });\nexports.__esModule = true;\nObject.defineProperty(exports, '__esModule', { value: true });\nexports.ns = require('./other.js');\n",
          "other.js": "exports.o = 1;\n",
        },
        "p.js",
      ),
    ).toEqual([
      "function k #k 1:9 exported held",
      "variable v #v 2:9 exported held",
      "variable w #w 3:16 exported held",
      "variable q #q 4:16 exported held",
      "variable d #d 5:32 exported held",
      "export-alias ns #ns:alias 8:9 exported held",
    ]);
  });

  it("keeps an object literal closed over a spread require, and declares its accessors", () => {
    const files = {
      "s.js": "module.exports = { ...require('./x.js'), a: 1 };\n",
      "x.js": "exports.x = 1;\n",
      "la.js": "module.exports = {\n  get g() {\n    return 1;\n  },\n  set s(v) {},\n};\n",
    };
    expect(declared(files, "s.js")).toEqual(["variable a #a 1:42 exported held"]);
    expect(declared(files, "la.js")).toEqual([
      "variable g #g 2:7 exported held",
      "variable s #s 5:7 exported held",
    ]);
  });

  it("declares a property a defineProperty getter or a numeric key writes", () => {
    const files = {
      "g.js":
        "Object.defineProperty(exports, 'g', { get() { return 1; } });\nObject.defineProperty(module.exports, 'h', { get: () => 2 });\n",
      "n.js": "exports[0] = 'zero';\n",
    };
    expect(declared(files, "g.js")).toEqual([
      "variable g #g 1:32 exported held",
      "variable h #h 2:39 exported held",
    ]);
    expect(declared(files, "n.js")).toEqual(["variable '0' #'0' 1:9 exported held"]);
  });

  it("declares nothing a write Node discards declares: one after exports stops aliasing, or before the module value is replaced", () => {
    const files = {
      "x.js": "exports = module.exports = {};\nexports.a = 1;\nexports = {};\nexports.b = 2;\n",
      "y.js": "exports.early = 1;\nmodule.exports = { late: 2 };\n",
      "z.js": "exports.a = 1;\nexports = {};\nObject.defineProperty(exports, 'k', { value: 1 });\n",
    };
    expect(declared(files, "x.js")).toEqual(["variable a #a 2:9 exported held"]);
    expect(declared(files, "y.js")).toEqual(["variable late #late 2:20 exported held"]);
    expect(declared(files, "z.js")).toEqual(["variable a #a 1:9 exported held"]);
  });

  it("keeps the entries of a table a write it does not model opens, and lists the table open", () => {
    const files = {
      "o.js": "exports.a = 1;\nObject.assign(module.exports, {});\n",
      "u.js": "exports.top = 1;\nif (globalThis.x) {\n  module.exports.later = 2;\n}\n",
      "d.js": "module.exports = function () {};\nmodule.exports.default = 1;\n",
      "r.js": "exports.a = 1;\nfunction read() {\n  return exports.a;\n}\nread();\n",
    };
    expect(declared(files, "o.js")).toEqual(["variable a #a 1:9 exported held", "open"]);
    expect(declared(files, "u.js")).toEqual(["variable top #top 1:9 exported held", "open"]);
    expect(declared(files, "d.js")).toEqual([
      "function default #default 1:8 exported held",
      "open",
    ]);
    expect(declared(files, "r.js")).toEqual([
      "variable a #a 1:9 exported held",
      "function read #read 2:10 local",
    ]);
  });

  it("lists the table open on each other write of the exports, and not on a comparison with module", () => {
    const files = {
      "spread.js": "const base = {};\nmodule.exports = { ...base, a: 1 };\n",
      "undeclared.js": "module.exports = notDeclared;\nmodule.exports.after = 1;\n",
      "literal.js": "module.exports = 42;\nmodule.exports.after = 1;\n",
      "computed.js": "exports.a = 1;\nconst k = 'b';\nmodule.exports[k] = 2;\n",
      "logical.js": "exports.a = 1;\nmodule.exports ||= {};\n",
      "aliased.js": "exports.a = 1;\nconst m = module;\nm.exports.x = 1;\n",
      "passed.js": "exports.a = 1;\nkeep(exports);\nfunction keep() {}\n",
      "shorthand.js": "exports.a = 1;\nkeep({ exports });\nfunction keep() {}\n",
      "main.js": "exports.a = 1;\nif (require.main === module) {\n  run();\n}\nfunction run() {}\n",
    };
    expect(declared(files, "spread.js")).toEqual([
      "variable base #base 1:7 local",
      "variable a #a 2:29 exported held",
      "open",
    ]);
    expect(declared(files, "undeclared.js")).toEqual([
      "variable after #after 2:16 exported held",
      "open",
    ]);
    expect(declared(files, "literal.js")).toEqual([
      "variable after #after 2:16 exported held",
      "open",
    ]);
    expect(declared(files, "computed.js")).toEqual([
      "variable a #a 1:9 exported held",
      "variable k #k 2:7 local",
      "open",
    ]);
    expect(declared(files, "logical.js")).toEqual(["variable a #a 1:9 exported held", "open"]);
    expect(declared(files, "aliased.js")).toEqual([
      "variable a #a 1:9 exported held",
      "variable m #m 2:7 local",
      "open",
    ]);
    expect(declared(files, "passed.js")).toEqual([
      "variable a #a 1:9 exported held",
      "function keep #keep 3:10 local",
      "open",
    ]);
    expect(declared(files, "shorthand.js")).toEqual([
      "variable a #a 1:9 exported held",
      "function keep #keep 3:10 local",
      "open",
    ]);
    expect(declared(files, "main.js")).toEqual([
      "variable a #a 1:9 exported held",
      "function run #run 5:10 local",
    ]);
  });

  it("lists the table open on a write through a top-level this, in a file that never names exports", () => {
    expect(declared({ "t.cjs": "function live() {}\nthis.live = live;\n" }, "t.cjs")).toEqual([
      "function live #live 1:10 local",
      "open",
    ]);
  });

  it("is read in a CommonJS file only, where module and exports are the free bindings", () => {
    const files = {
      "c.cjs": "exports.c = 1;\n",
      "e.mjs": "exports.e = 1;\n",
      "s.js": "import './c.cjs';\nexports.s = 1;\n",
      "m/package.json": '{ "type": "module" }\n',
      "m/index.js": "exports.m = 1;\n",
    };
    expect(declared(files, "c.cjs")).toEqual(["variable c #c 1:9 exported held"]);
    expect(declared(files, "e.mjs")).toEqual([]);
    expect(declared(files, "s.js")).toEqual([]);
    expect(declared(files, "m/index.js")).toEqual([]);
  });

  it("is shadowed only where a declaration of the name encloses the occurrence", () => {
    const files = {
      "for.js": "function live() {}\nmodule.exports = live;\nfor (const module of []) {}\n",
      "block.js":
        "function live() {}\nexports.live = live;\n{\n  let exports = {};\n  exports.inner = 1;\n}\n",
      "catch.js":
        "function live() {}\nexports.live = live;\ntry {\n  run();\n} catch (exports) {\n  exports.caught = 1;\n}\nfunction run() {}\n",
      "nested.js":
        "function live() {}\nmodule.exports = live;\nfunction f() {\n  for (const module of []) {\n    module.exports = 1;\n  }\n}\n",
      "function.js": "{\n  function exports() {}\n}\nexports.x = 1;\n",
      "switch.js":
        "switch (globalThis.k) {\n  case 1:\n    let module = {};\n    module.exports = 1;\n}\nexports.y = 2;\n",
      "parameter.js": "exports.a = 1;\nfunction f(exports) {\n  exports.x = 1;\n}\n",
      "named.js": "exports.a = 1;\nconst g = function module() {\n  module.exports = 1;\n};\n",
      "inner.js": "exports.a = 1;\nfunction f() {\n  var exports = {};\n  exports.x = 1;\n}\n",
      "static.js":
        "exports.a = 1;\nclass C {\n  static {\n    var exports = {};\n    exports.x = 1;\n  }\n}\n",
      "class.js":
        "exports.a = 1;\nconst K = class exports {\n  m() {\n    exports.x = 1;\n  }\n};\n",
      "let.js": "exports.a = 1;\nfor (let exports = {}; ; ) {\n  exports.x = 1;\n  break;\n}\n",
      "in.js": "exports.a = 1;\nfor (const exports in {}) {\n  exports.x = 1;\n}\n",
      "if.js":
        "exports.a = 1;\nfunction f() {\n  if (globalThis.k) function exports() {}\n  exports.x = 1;\n}\n",
      "own.js": "exports.a = 1;\nfunction f(module = module.exports) {}\n",
      "tdz.js": "exports.a = 1;\nfor (const module of [module.exports]) {}\n",
      "pattern.js":
        "exports.a = 1;\nfunction f() {\n  var { exports } = { exports: {} };\n  exports.x = 1;\n}\n",
      "const.js":
        "exports.a = 1;\n{\n  const { exports } = { exports: {} };\n  exports.x = 1;\n}\n",
      "destructured.js": "exports.a = 1;\nfunction f({ exports }) {\n  exports.x = 1;\n}\n",
      "caught.js":
        "exports.a = 1;\ntry {\n  run();\n} catch ({ exports }) {\n  exports.x = 1;\n}\nfunction run() {}\n",
      "klass.js": "exports.a = 1;\n{\n  class exports {}\n  exports.x = 1;\n}\n",
    };
    expect(declared(files, "for.js")).toEqual([
      "function live #live 1:10 exported",
      "export-alias default #default:alias 2:8 exported held",
    ]);
    expect(declared(files, "block.js")).toEqual([
      "function live #live 1:10 local",
      "export-alias live #live:alias 2:9 exported held",
    ]);
    expect(declared(files, "catch.js")).toEqual([
      "function live #live 1:10 local",
      "export-alias live #live:alias 2:9 exported held",
      "function run #run 8:10 local",
    ]);
    expect(declared(files, "nested.js")).toEqual([
      "function live #live 1:10 exported",
      "export-alias default #default:alias 2:8 exported held",
      "function f #f 3:10 local",
    ]);
    expect(declared(files, "function.js")).toEqual(["variable x #x 4:9 exported held"]);
    expect(declared(files, "switch.js")).toEqual(["variable y #y 6:9 exported held"]);
    expect(declared(files, "parameter.js")).toEqual([
      "variable a #a 1:9 exported held",
      "function f #f 2:10 local",
    ]);
    expect(declared(files, "named.js")).toEqual([
      "variable a #a 1:9 exported held",
      "variable g #g 2:7 local",
    ]);
    expect(declared(files, "inner.js")).toEqual([
      "variable a #a 1:9 exported held",
      "function f #f 2:10 local",
    ]);
    expect(declared(files, "static.js")).toEqual([
      "variable a #a 1:9 exported held",
      "class C #C 2:7 local",
    ]);
    expect(declared(files, "class.js")).toEqual([
      "variable a #a 1:9 exported held",
      "variable K #K 2:7 local",
    ]);
    expect(declared(files, "let.js")).toEqual(["variable a #a 1:9 exported held"]);
    expect(declared(files, "in.js")).toEqual(["variable a #a 1:9 exported held"]);
    expect(declared(files, "if.js")).toEqual([
      "variable a #a 1:9 exported held",
      "function f #f 2:10 local",
    ]);
    expect(declared(files, "own.js")).toEqual([
      "variable a #a 1:9 exported held",
      "function f #f 2:10 local",
    ]);
    expect(declared(files, "tdz.js")).toEqual(["variable a #a 1:9 exported held"]);
    for (const path of ["pattern.js", "destructured.js"]) {
      expect(declared(files, path)).toEqual([
        "variable a #a 1:9 exported held",
        "function f #f 2:10 local",
      ]);
    }
    expect(declared(files, "const.js")).toEqual(["variable a #a 1:9 exported held"]);
    expect(declared(files, "caught.js")).toEqual([
      "variable a #a 1:9 exported held",
      "function run #run 7:10 local",
    ]);
    expect(declared(files, "klass.js")).toEqual(["variable a #a 1:9 exported held"]);
  });

  it("reads a var of the file, destructured or not, as the wrapper's own parameter, which holds the module system's value, and an if-body function as binding only in its clause, so a later use is the parameter", () => {
    const files = {
      "after.js": "module.exports.a = 1;\nvar module = { exports: {} };\n",
      "skipped.js":
        "if (globalThis.k) {\n  var module = { exports: {} };\n}\nmodule.exports.a = 1;\n",
      "alias.js": "exports.a = 1;\nfor (var module of [module.exports]) {\n  module.x = 1;\n}\n",
      "if.js": "if (globalThis.k) function exports() {}\nexports.x = 1;\n",
      "first.js": "var module = { exports: {} };\nmodule.exports.v = 1;\n",
      "object.js": "exports.a = 1;\nvar { exports } = { exports: {} };\n",
      "array.js": "module.exports.b = 1;\nvar [module] = [{ exports: {} }];\n",
      "nested.js": "exports.d = 1;\nvar { k: [exports = {}] } = { k: [] };\n",
      "of.js": "module.exports.a = 1;\nfor (var { module } of []) {}\nmodule.exports.b = 2;\n",
      "in.js": "exports.a = 1;\nfor (var [exports] in {}) {}\nexports.b = 2;\n",
      "unrun.js":
        "if (globalThis.k) {\n  var { module } = { module: {} };\n}\nmodule.exports.a = 1;\n",
    };
    expect(declared(files, "after.js")).toEqual([
      "variable a #a 1:16 exported held",
      "variable module #module 2:5 local",
    ]);
    expect(declared(files, "skipped.js")).toEqual(["variable a #a 4:16 exported held"]);
    expect(declared(files, "alias.js")).toEqual(["variable a #a 1:9 exported held", "open"]);
    expect(declared(files, "if.js")).toEqual(["variable x #x 2:9 exported held"]);
    expect(declared(files, "object.js")).toEqual([
      "variable a #a 1:9 exported held",
      "variable exports #exports 2:7 local",
    ]);
    expect(declared(files, "array.js")).toEqual([
      "variable b #b 1:16 exported held",
      "variable module #module 2:6 local",
    ]);
    expect(declared(files, "nested.js")).toEqual(["variable d #d 1:9 exported held"]);
    expect(declared(files, "of.js")).toEqual([
      "variable a #a 1:16 exported held",
      "variable b #b 3:16 exported held",
    ]);
    expect(declared(files, "in.js")).toEqual([
      "variable a #a 1:9 exported held",
      "variable b #b 3:9 exported held",
    ]);
    expect(declared(files, "unrun.js")).toEqual(["variable a #a 4:16 exported held"]);
    // Node writes nothing here, as `module` is reassigned first; reading the write as the
    // module system's keeps an entry no file has, and misses none.
    expect(declared(files, "first.js")).toEqual([
      "variable module #module 1:5 local",
      "variable v #v 2:16 exported held",
    ]);
  });

  it("lists the table open on a write a parameter default makes, beside a body var of the name", () => {
    const files = {
      "default.js":
        "exports.a = 1;\nfunction f(x = (module.exports.b = 2)) {\n  var module = {};\n}\n",
      "arrow.js":
        "exports.a = 1;\nfunction f(x = () => (module.exports.b = 2)) {\n  var module = {};\n  x();\n}\n",
    };
    for (const path of ["default.js", "arrow.js"]) {
      expect(declared(files, path)).toEqual([
        "variable a #a 1:9 exported held",
        "function f #f 2:10 local",
        "open",
      ]);
    }
  });

  it("lists the table open on a use beside a block function of the name in a nested function", () => {
    const files = {
      "sloppy.js":
        "function live() {}\nexports.live = live;\nfunction f() {\n  {\n    function exports() {}\n  }\n  exports.inner = 1;\n}\n",
      "strict.js":
        "function live() {}\nexports.live = live;\nfunction f() {\n  'use strict';\n  {\n    function exports() {}\n  }\n  exports.inner = 1;\n}\n",
    };
    // Sloppy code hoists the block function over the whole function (Annex B.3.2), so Node
    // writes nothing through it there; listing the table open misses no write.
    for (const path of ["sloppy.js", "strict.js"]) {
      expect(declared(files, path)).toEqual([
        "function live #live 1:10 local",
        "export-alias live #live:alias 2:9 exported held",
        "function f #f 3:10 local",
        "open",
      ]);
    }
  });
});

describe("a JavaScript @typedef", () => {
  it("is a type with its properties as members, beside the CommonJS table of its file", () => {
    expect(
      declared(
        {
          "d.js": "/** @typedef {{ x: string }} Box */\nfunction live() {}\nexports.live = live;\n",
        },
        "d.js",
      ),
    ).toEqual([
      "type-member Box.x #Box.x 1:17 local",
      "type Box #Box 1:30 exported",
      "function live #live 2:10 local",
      "export-alias live #live:alias 3:9 exported held",
    ]);
  });
});
