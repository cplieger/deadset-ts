import { describe, expect, it } from "vitest";
import { dirnamePath, isAbsolutePath, joinPath, normalizePath, resolvePath } from "./paths.ts";

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
