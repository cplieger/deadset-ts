import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  cannotStartPackageName,
  dirnamePath,
  extensionOf,
  hasURLScheme,
  isAbsolutePath,
  isExplicitPath,
  isPathRelativeURL,
  isPathSpecifier,
  isRelativeSpecifier,
  joinPath,
  normalizePath,
  queriedModulePath,
  relativePath,
  resolvePath,
  startsRelativePath,
} from "./paths.ts";

describe("isAbsolutePath", () => {
  it.each([
    { path: "/src/a.ts", absolute: true },
    { path: "/", absolute: true },
    { path: "src/a.ts", absolute: false },
    { path: "./src", absolute: false },
    { path: "", absolute: false },
  ])("answers $absolute for $path", ({ path, absolute }) => {
    expect(isAbsolutePath(path)).toBe(absolute);
  });
});

describe("normalizePath", () => {
  it.each([
    { path: "/a/b/c", want: "/a/b/c" },
    { path: "/a//b///c", want: "/a/b/c" },
    { path: "/a/./b", want: "/a/b" },
    { path: "/a/b/../c", want: "/a/c" },
    { path: "/a/b/../../c", want: "/c" },
    { path: "/a/../../b", want: "/b" },
    { path: "/..", want: "/" },
    { path: "/", want: "/" },
    { path: "a/b/../c", want: "a/c" },
    { path: "../a", want: "../a" },
    { path: "../../a", want: "../../a" },
    { path: "a/../../b", want: "../b" },
    { path: ".", want: "." },
    { path: "", want: "." },
    { path: "/a/b/", want: "/a/b" },
  ])("normalizes $path to $want", ({ path, want }) => {
    expect(normalizePath(path)).toBe(want);
  });
});

describe("joinPath", () => {
  it.each([
    { parts: ["/a", "b"], want: "/a/b" },
    { parts: ["/a", "../b"], want: "/b" },
    { parts: ["a", "b", "c"], want: "a/b/c" },
    { parts: ["/a", ""], want: "/a" },
    { parts: ["", "b"], want: "b" },
    { parts: [], want: "." },
    { parts: ["/a", "./b", "c"], want: "/a/b/c" },
  ])("joins $parts to $want", ({ parts, want }) => {
    expect(joinPath(...parts)).toBe(want);
  });
});

describe("dirnamePath", () => {
  it.each([
    { path: "/a/b/c.json", want: "/a/b" },
    { path: "/a/c.json", want: "/a" },
    { path: "/c.json", want: "/" },
    { path: "a/b/c.json", want: "a/b" },
    { path: "c.json", want: "." },
    { path: "/", want: "/" },
  ])("answers $want for $path", ({ path, want }) => {
    expect(dirnamePath(path)).toBe(want);
  });
});

describe("extensionOf", () => {
  it.each([
    { path: "/a/src/App.vue", want: ".vue" },
    { path: "App.test.svelte", want: ".svelte" },
    { path: "/a.b/Card", want: "" },
    { path: "/a/.astro", want: "" },
    { path: "", want: "" },
  ])("answers $want for $path", ({ path, want }) => {
    expect(extensionOf(path)).toBe(want);
  });
});

describe("resolvePath", () => {
  it.each([
    { against: "/work", path: "a/b", want: "/work/a/b" },
    { against: "/work", path: "/a/b", want: "/a/b" },
    { against: "/work/sub", path: "../a", want: "/work/a" },
    { against: "/work", path: ".", want: "/work" },
    { against: "/work", path: "/a/../b", want: "/b" },
  ])("resolves $path against $against to $want", ({ against, path, want }) => {
    expect(resolvePath(against, path)).toBe(want);
  });
});

describe("relativePath", () => {
  it.each([
    { root: "/work", path: "/work/src/a.ts", want: "src/a.ts" },
    { root: "/work/", path: "/work/src/a.ts", want: "src/a.ts" },
    { root: "/work/./", path: "/work/src/a.ts", want: "src/a.ts" },
    { root: "/work", path: "/work/a.ts", want: "a.ts" },
    { root: "/", path: "/a.ts", want: "a.ts" },
    { root: "/", path: "/", want: undefined },
    { root: "/work", path: "/work", want: undefined },
    { root: "/work", path: "/worktree/a.ts", want: undefined },
    { root: "/work", path: "/other/a.ts", want: undefined },
    { root: "/work/sub", path: "/work/a.ts", want: undefined },
    { root: "/work", path: "/work/sub/../a.ts", want: "a.ts" },
  ])("answers $want for $path below $root", ({ root, path, want }) => {
    expect(relativePath(root, path)).toBe(want);
  });
});

describe("queriedModulePath", () => {
  it.each([
    { specifier: "./worker.ts?worker", path: "./worker.ts" },
    { specifier: "../w.ts?sharedworker&url", path: "../w.ts" },
    { specifier: "./page.ts?url", path: "./page.ts" },
    { specifier: "./page.ts?raw", path: undefined },
    { specifier: "./page.ts?inline&raw", path: undefined },
    { specifier: "./page.ts?raw=1", path: undefined },
    { specifier: "./page.ts?rawish", path: "./page.ts" },
    { specifier: "./page.ts", path: undefined },
    { specifier: "pkg/page.ts?worker", path: undefined },
  ])("answers $path for $specifier", ({ specifier, path }) => {
    expect(queriedModulePath(specifier)).toBe(path);
  });
});

describe("the relative-specifier predicates", () => {
  /** Specifiers drawn from the characters that decide the answer, so the edges recur. */
  const specifiers = fc.string({ unit: fc.constantFrom(".", "/", "a", "\\", ":"), maxLength: 6 });

  it("start a relative path exactly where `./` or `../` begins the specifier", () => {
    fc.assert(
      fc.property(specifiers, (specifier) => {
        expect(startsRelativePath(specifier)).toBe(/^\.\.?\//u.test(specifier));
      }),
    );
  });

  it("name a relative specifier exactly where it is `.`, `..` or starts a relative path", () => {
    fc.assert(
      fc.property(specifiers, (specifier) => {
        expect(isRelativeSpecifier(specifier)).toBe(/^\.\.?(?:\/|$)/u.test(specifier));
      }),
    );
  });

  it.each([
    { specifier: ".", starts: false, relative: true },
    { specifier: "..", starts: false, relative: true },
    { specifier: "./a", starts: true, relative: true },
    { specifier: "../a", starts: true, relative: true },
    { specifier: "...", starts: false, relative: false },
    { specifier: ".a", starts: false, relative: false },
    { specifier: "/a", starts: false, relative: false },
    { specifier: ".\\a", starts: false, relative: false },
    { specifier: "a/./b", starts: false, relative: false },
  ])("answers $starts and $relative for $specifier", ({ specifier, starts, relative }) => {
    expect(startsRelativePath(specifier)).toBe(starts);
    expect(isRelativeSpecifier(specifier)).toBe(relative);
  });
});

describe("the path and URL predicates", () => {
  /** Strings drawn from the characters that decide each answer, so the edges recur. */
  const texts = fc.string({
    unit: fc.constantFrom(".", "/", "a", "Z", "1", "+", "-", ":", "\\"),
    maxLength: 6,
  });

  it.each([
    {
      name: "isPathSpecifier",
      predicate: isPathSpecifier,
      replaced: (text: string) => /^(?:\.{1,2}(?:\/|$)|\/)/u.test(text),
    },
    {
      name: "isExplicitPath",
      predicate: isExplicitPath,
      replaced: (text: string) => ["/", "./", "../"].some((prefix) => text.startsWith(prefix)),
    },
    {
      name: "cannotStartPackageName",
      predicate: cannotStartPackageName,
      replaced: (text: string) => text.startsWith(".") || text.startsWith("/"),
    },
    {
      name: "hasURLScheme",
      predicate: hasURLScheme,
      replaced: (text: string) => /^[A-Za-z][A-Za-z\d+.-]*:/u.test(text),
    },
    {
      name: "isPathRelativeURL",
      predicate: isPathRelativeURL,
      replaced: (text: string) =>
        !(text === "" || text.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(text)),
    },
  ])("$name answers as the check it replaced", ({ predicate, replaced }) => {
    fc.assert(
      fc.property(texts, (text) => {
        expect(predicate(text)).toBe(replaced(text));
      }),
    );
  });

  it.each([
    { text: ".", path: true, explicit: false, notPackage: true },
    { text: "..", path: true, explicit: false, notPackage: true },
    { text: "./a", path: true, explicit: true, notPackage: true },
    { text: "/a", path: true, explicit: true, notPackage: true },
    { text: ".a", path: false, explicit: false, notPackage: true },
    { text: "a/b", path: false, explicit: false, notPackage: false },
  ])(
    "answers $path, $explicit and $notPackage for $text",
    ({ text, path, explicit, notPackage }) => {
      expect(isPathSpecifier(text)).toBe(path);
      expect(isExplicitPath(text)).toBe(explicit);
      expect(cannotStartPackageName(text)).toBe(notPackage);
    },
  );

  it.each([
    { text: "node:fs", scheme: true, relative: false },
    { text: "a.b+c-d:x", scheme: true, relative: false },
    { text: "1a:x", scheme: false, relative: true },
    { text: "//host/a", scheme: false, relative: false },
    { text: "a.js", scheme: false, relative: true },
    { text: "", scheme: false, relative: false },
  ])("answers $scheme and $relative for the URL $text", ({ text, scheme, relative }) => {
    expect(hasURLScheme(text)).toBe(scheme);
    expect(isPathRelativeURL(text)).toBe(relative);
  });
});
