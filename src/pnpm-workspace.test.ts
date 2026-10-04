import { describe, expect, it } from "vitest";
import { pnpmPackages } from "./pnpm-workspace.ts";

describe("pnpmPackages", () => {
  it("reads a block sequence of plain and quoted strings, comments dropped", () => {
    const text = [
      "# the packages",
      "packages:",
      "  - packages/*",
      "  - 'apps/*' # applications",
      '  - "!**/test/**"',
      "",
      "catalog:",
      "  react: ^19.0.0",
    ].join("\n");

    expect(pnpmPackages(text)).toEqual({
      kind: "listed",
      patterns: ["packages/*", "apps/*", "!**/test/**"],
    });
  });

  it("reads a sequence written at the key's own indentation", () => {
    expect(pnpmPackages("packages:\n- packages/*\n- tools\n")).toEqual({
      kind: "listed",
      patterns: ["packages/*", "tools"],
    });
  });

  it("reads a one-line flow sequence", () => {
    expect(pnpmPackages("packages: [packages/*, 'docs', \"site\",]\n")).toEqual({
      kind: "listed",
      patterns: ["packages/*", "docs", "site"],
    });
  });

  it("answers absent where the document declares no packages key", () => {
    expect(pnpmPackages("onlyBuiltDependencies:\n  - esbuild\n")).toEqual({ kind: "absent" });
  });

  it.each([
    ["an anchor", "packages: &all\n  - a\n"],
    ["an alias item", "packages:\n  - *all\n"],
    ["a mapping item", "packages:\n  - name: a\n"],
    ["a scalar", "packages: packages/*\n"],
    ["a flow sequence over several lines", "packages: [\n  a,\n]\n"],
    ["a block scalar item", "packages:\n  - |\n    a\n"],
    ["an escape in a double-quoted item", 'packages:\n  - "a\\tb"\n'],
    ["an empty value", "packages:\n\nother: 1\n"],
    ["a key declared twice", "packages:\n  - a\npackages:\n  - b\n"],
  ])("refuses %s", (_, text) => {
    expect(pnpmPackages(text).kind).toBe("refused");
  });
});
