import { describe, expect, it } from "vitest";
import type { Node } from "@typescript/native/ast";
import { amdLoadOf, amdPath, amdUnresolved, type AmdLoad } from "./amd.ts";
import { openEngine } from "./session.ts";

const engine = openEngine({ collectTiming: false });

/** The AMD loads of `text`'s calls, in source order. */
function loads(text: string): readonly AmdLoad[] {
  const found: AmdLoad[] = [];
  const visit = (node: Node): void => {
    const load = amdLoadOf(node);
    if (load !== undefined) {
      found.push(load);
    }
    node.forEachChild(visit);
  };
  visit(engine.parseSourceFile("/project/x.js", text));
  return found;
}

/** Each load's ids with whether the factory receives it, and whether its list is computed. */
function shapes(text: string): readonly unknown[] {
  return loads(text).map((load) => ({
    callee: load.callee.text,
    ids: load.ids.map(({ id, received }) => [id.text, received]),
    computed: load.computed,
  }));
}

describe("amdLoadOf", () => {
  it("reads each of AMD's forms, leaving out the ids that name no module", () => {
    expect(
      shapes(`
        define(["./a", "require", "exports", "module", "pkg"], function (a, r, e, m, p) {});
        define("named", ["./b"], function () {});
        require(["./c", "./d"], (c) => c);
      `),
    ).toEqual([
      {
        callee: "define",
        ids: [
          ["./a", true],
          ["pkg", true],
        ],
        computed: false,
      },
      { callee: "define", ids: [["./b", false]], computed: false },
      {
        callee: "require",
        ids: [
          ["./c", true],
          ["./d", false],
        ],
        computed: false,
      },
    ]);
  });

  it("counts a rest parameter and a factory written as no function as receiving every id", () => {
    expect(
      shapes(`
        define(["./a", "./b"], function (...all) {});
        define(["./c"], factory);
      `),
    ).toEqual([
      {
        callee: "define",
        ids: [
          ["./a", true],
          ["./b", true],
        ],
        computed: false,
      },
      { callee: "define", ids: [["./c", true]], computed: false },
    ]);
  });

  it("reads a list with a computed element, and one written as no array literal, as computed", () => {
    expect(
      shapes(`
        define(["./a", name], function () {});
        define(list, function () {});
        define("named", list, function () {});
      `),
    ).toEqual([
      { callee: "define", ids: [["./a", false]], computed: true },
      { callee: "define", ids: [], computed: true },
      { callee: "define", ids: [], computed: true },
    ]);
  });

  it("reads a define of a factory or a value alone as loading nothing, and CommonJS's require as no AMD call", () => {
    expect(
      shapes(`
        define(function () { return {}; });
        define({ value: 1 });
        require("./x");
        other(["./y"], function () {});
        a.define(["./z"], function () {});
      `),
    ).toEqual([
      { callee: "define", ids: [], computed: false },
      { callee: "define", ids: [], computed: false },
    ]);
  });
});

describe("amdPath", () => {
  it("appends .js to a relative id and resolves it against the directory", () => {
    expect(amdPath("/project/src", "./a")).toBe("/project/src/a.js");
    expect(amdPath("/project/src", "../lib/b")).toBe("/project/lib/b.js");
  });

  it("reads no path from a package id or an id RequireJS reads as a URL", () => {
    expect(amdPath("/project/src", "pkg")).toBeUndefined();
    expect(amdPath("/project/src", "./a.js")).toBeUndefined();
    expect(amdPath("/project/src", "/abs/a")).toBeUndefined();
  });
});

describe("amdUnresolved", () => {
  const unresolved = (text: string): readonly boolean[] => loads(text).map(amdUnresolved);

  it("reads a computed list and a URL-shaped id as unresolved, and a package id as resolved", () => {
    expect(
      unresolved(`
        define(["./a", "pkg"], function () {});
        define([name], function () {});
        define(["./a.js"], function () {});
        define(["/abs/a"], function () {});
        define(["https://cdn.example/a"], function () {});
      `),
    ).toEqual([false, true, true, true, true]);
  });
});
