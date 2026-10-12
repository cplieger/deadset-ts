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
    ["a # inside quotes", "packages:\n  - 'a #b'\n  - \"c #d\"\n", ["a #b", "c #d"]],
    ["a # with no space before it", "packages:\n  - packages/a#b\n", ["packages/a#b"]],
    ["a comment after an item", "packages:\n  - tools #note\n", ["tools"]],
    ["a comment line at the first column", "packages:\n# note\n  - a\n", ["a"]],
    ["a blank line between items", "packages:\n  - a\n\n  - b\n", ["a", "b"]],
    ["empty quoted strings", "packages:\n  - ''\n  - \"\"\n", ["", ""]],
    ["a plain string ending in a quote", "packages:\n  - a'\n  - b\"\n", ["a'", 'b"']],
    ["an empty flow sequence", "packages: []\n", []],
    ["a blank flow sequence", "packages: [ ]\n", []],
    ["a flow sequence of one", "packages: [a]\n", ["a"]],
    ["a flow sequence of two", "packages: [a, b]\n", ["a", "b"]],
    ["a flow sequence with a spaced trailing comma", "packages: [a, b, ]\n", ["a", "b"]],
    ["a flow sequence after two spaces", "packages:  [a]\n", ["a"]],
    ["a sequence ended by the next key", "packages:\n  - a\nother: 1\n", ["a"]],
    [
      "a sequence ended by a line at its indentation that is no item",
      "packages:\n- x\n-a\n",
      ["x"],
    ],
  ])("reads %s", (_, text, patterns) => {
    expect(pnpmPackages(text)).toEqual({ kind: "listed", patterns });
  });

  it.each([
    [
      "a lone single quote",
      "packages:\n  - '\n",
      `the packages item "- '" is not a plain or quoted string`,
    ],
    [
      "a lone double quote",
      'packages:\n  - "\n',
      'the packages item "- \\"" is not a plain or quoted string',
    ],
    [
      "an unclosed single quote",
      "packages:\n  - 'ab\n",
      `the packages item "- 'ab" is not a plain or quoted string`,
    ],
    [
      "an unclosed double quote",
      'packages:\n  - "ab\n',
      'the packages item "- \\"ab" is not a plain or quoted string',
    ],
    [
      "an unescaped quote inside single quotes",
      "packages:\n  - 'it's'\n",
      `the packages item "- 'it's'" is not a plain or quoted string`,
    ],
    [
      "an item with no value",
      "packages:\n- a\n-\n",
      'the packages item "-" is not a plain or quoted string',
    ],
    [
      "a nested sequence item",
      "packages:\n  - - a\n",
      'the packages item "- - a" is not a plain or quoted string',
    ],
    [
      "a complex key item",
      "packages:\n  - ? a\n",
      'the packages item "- ? a" is not a plain or quoted string',
    ],
    [
      "a mapping item with no value",
      "packages:\n  - a:\n",
      'the packages item "- a:" is not a plain or quoted string',
    ],
    [
      "an alias item",
      "packages:\n  - *all\n",
      'the packages item "- *all" is not a plain or quoted string',
    ],
    [
      "an indented line that is no item",
      "packages:\n  - a\n  key: v\n",
      'packages holds "key: v", not a sequence item',
    ],
    [
      "an indented line that is no item, with a comment",
      "packages:\n  - a\n  key: v # c\n",
      'packages holds "key: v", not a sequence item',
    ],
    [
      "an indented line holding a dash",
      "packages:\n  - a\n  b - c\n",
      'packages holds "b - c", not a sequence item',
    ],
  ])("refuses %s, saying why", (_, text, reason) => {
    expect(pnpmPackages(text)).toEqual({ kind: "refused", reason });
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
