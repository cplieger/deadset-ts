import { describe, expect, it } from "vitest";
import { yamlDocument, yamlKey } from "./yaml.ts";

describe("yamlDocument", () => {
  it("reads block mappings and sequences, quoted keys and scalars, and comments", () => {
    const text = [
      "# legacy linter settings",
      "env:",
      "  browser: true",
      "extends:",
      "  - 'eslint:recommended'",
      '  - "plugin:react/recommended" # the plugin',
      "parser: '@typescript-eslint/parser'",
      "parserOptions:",
      "  ecmaVersion: 12",
      "  sourceType: module",
      "plugins:",
      "- react",
      "- '@typescript-eslint'",
      "rules:",
      "  '@typescript-eslint/no-explicit-any':",
      "    - 0",
      "  quotes: [error, single]",
    ].join("\n");

    expect(yamlDocument(text)).toEqual({
      env: { browser: true },
      extends: ["eslint:recommended", "plugin:react/recommended"],
      parser: "@typescript-eslint/parser",
      parserOptions: { ecmaVersion: 12, sourceType: "module" },
      plugins: ["react", "@typescript-eslint"],
      rules: { "@typescript-eslint/no-explicit-any": [0], quotes: ["error", "single"] },
    });
  });

  it("reads a mapping that starts on a sequence item's line, and nested flow collections", () => {
    const text = [
      "---",
      "overrides:",
      "  - files: ['*.ts']",
      "    parser: x-parser",
      "  - {files: [a, 'b c'], extends: [plugin:y/z]}",
      "plugins: [",
      "  a,",
      "  b",
      "]",
      "url: http://example.test/a#b",
      "pattern: a,b",
      "it: it's",
      "empty:",
    ].join("\n");

    expect(yamlDocument(text)).toEqual({
      overrides: [
        { files: ["*.ts"], parser: "x-parser" },
        { files: ["a", "b c"], extends: ["plugin:y/z"] },
      ],
      plugins: ["a", "b"],
      url: "http://example.test/a#b",
      pattern: "a,b",
      it: "it's",
      empty: null,
    });
  });

  it("reads quoted escapes and the core schema's plain scalars", () => {
    expect(yamlDocument("a: 'it''s'\nb: \"x\\ty\"\nc: ~\nd: -1.5\ne: FALSE")).toEqual({
      a: "it's",
      b: "x\ty",
      c: null,
      d: -1.5,
      e: false,
    });
  });

  it.each([
    ["an anchor", "a: &x 1\nb: *x"],
    ["a tag", "a: !!str 1"],
    ["a block scalar", "a: |\n  text"],
    ["a second document", "a: 1\n---\nb: 2"],
    ["a tab indentation", "a:\n\tb: 1"],
    ["a line indented under a scalar", "a: 1\n    b: 2\n  c: 3"],
    ["an unclosed quote", "a: 'x"],
    ["an unclosed flow sequence", "a: [x, y"],
  ])("has no value for %s", (_, text) => {
    expect(yamlDocument(text)).toBeUndefined();
  });

  it("reads an empty document as null", () => {
    expect(yamlDocument("# nothing\n")).toBeNull();
  });
});

describe("yamlKey", () => {
  it("reads one key whose siblings lie outside the subset, and answers absent for a key not there", () => {
    const text = [
      "catalog: &shared",
      "  react: ^19.0.0",
      "packages:",
      "  - packages/* # the libraries",
      '  - "!**/test/**"',
      "patchedDependencies: |",
      "  packages: not a key",
    ].join("\n");

    expect(yamlKey(text, "packages")).toEqual({
      kind: "value",
      value: ["packages/*", "!**/test/**"],
    });
    expect(yamlKey(text, "overrides")).toEqual({ kind: "absent" });
  });

  it("refuses a key declared twice, and one whose own lines lie outside the subset", () => {
    expect(yamlKey("packages: [a]\npackages: [b]\n", "packages").kind).toBe("refused");
    expect(yamlKey("packages: &all\n  - a\n", "packages").kind).toBe("refused");
  });
});
