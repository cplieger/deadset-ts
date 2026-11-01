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
    expect(
      yamlDocument("a: 'it''s'\nb: \"x\\ty\"\nc: ~\nd: -1.5\ne: FALSE\nf: 0x1F\ng: 0o17\nh: .inf"),
    ).toEqual({ a: "it's", b: "x\ty", c: null, d: -1.5, e: false, f: 31, g: 15, h: ".inf" });
  });

  it("reads anchors and aliases, block and flow, and an aliased collection whole", () => {
    expect(
      yamlDocument(
        [
          "a: &x 1",
          "b: *x",
          "base: &base",
          "  k: v",
          "copy: *base",
          "list:",
          "  - &item one",
          "  - *item",
          "flow: { c: &c [p, q], d: *c, e: *x }",
        ].join("\n"),
      ),
    ).toEqual({
      a: 1,
      b: 1,
      base: { k: "v" },
      copy: { k: "v" },
      list: ["one", "one"],
      flow: { c: ["p", "q"], d: ["p", "q"], e: 1 },
    });
  });

  it.each([
    [
      "a literal block scalar, clipped",
      "a: |\n  x\n  # kept\n\n  y\n\nb: 1",
      { a: "x\n# kept\n\ny\n", b: 1 },
    ],
    ["a folded block scalar, stripped", "a: >-\n  x\n  y\n\n  z\n", { a: "x y\nz" }],
    ["a kept block scalar", "a: |+\n  x\n\n\nb: 1", { a: "x\n\n\n", b: 1 }],
    ["a kept block scalar at the end of the text", "a: |+\n  x\n", { a: "x\n" }],
    ["a kept block scalar with a trailing empty line", "a: |+\n  x\n\n", { a: "x\n\n" }],
    ["a kept block scalar with no final line break", "a: |+\n  x", { a: "x" }],
    ["a clipped block scalar with no final line break", "a: |\n  x", { a: "x" }],
    ["a kept block scalar header on the last line, with no final line break", "a: |+", { a: "" }],
    ["a kept literal block scalar of blank lines only", "a: |+\n\n", { a: "\n" }],
    ["a kept folded block scalar of blank lines only", "a: >+\n\n", { a: "\n" }],
    ["a tab inside a block scalar's body", "a: |\n  x\n  \ty\n", { a: "x\n\ty\n" }],
    ["a document marker inside a block scalar", "a: |\n  ---\n  y\n", { a: "---\ny\n" }],
    [
      "a blank line inside a flow sequence's plain scalar",
      "a: [one\n\n  two]\n",
      { a: ["one\ntwo"] },
    ],
    [
      "a blank line inside a flow mapping's quoted scalar",
      'a: {run: "x\n\n  y"}\n',
      { a: { run: "x\ny" } },
    ],
    ["an escaped line break inside a flow collection", 'a: ["x\\\n  y"]\n', { a: ["xy"] }],
    [
      "a comment sign inside a quoted scalar's second line in a flow collection",
      'a: ["one\n  two # three"]\n',
      { a: ["one two # three"] },
    ],
    [
      "a comment inside a flow collection",
      "a: [one, # c\n  two]\nb: 1\n",
      { a: ["one", "two"], b: 1 },
    ],
    ["a comment sign inside a flow plain scalar", "a: [a#b]", { a: ["a#b"] }],
    ["an indentation indicator", "a: >2\n   indented\n  b\n", { a: " indented\nb\n" }],
    ["a header with a comment", "a: |  # c\n  x\n", { a: "x\n" }],
    ["YAML's escapes", 'a: "\\x41\\u0042\\e\\N\\_\\/"', { a: "AB\x1b\x85\xa0/" }],
    ["a quoted scalar over lines", "a: 'it''s\n  folded\n\n  twice'", { a: "it's folded\ntwice" }],
    [
      "a plain scalar over lines",
      "a: plain\n  continued\n\n  after",
      { a: "plain continued\nafter" },
    ],
    [
      "a value after a comment-only key line",
      'a: # c\n  value\nb: # d\n  "q"',
      { a: "value", b: "q" },
    ],
    [
      "a `__proto__` key, as an own member",
      "__proto__: {x: 1}",
      JSON.parse('{"__proto__": {"x": 1}}'),
    ],
  ])("reads %s", (_, text, value) => {
    expect(yamlDocument(text)).toEqual(value);
  });

  it.each([
    ["an alias of no anchor", "a: *x"],
    ["an anchor on a key", "&x a: 1"],
    ["a tag", "a: !!str 1"],
    ["a plain scalar going on after its comment", "a: x # c\n  y"],
    ["a second document", "a: 1\n---\nb: 2"],
    ["a tab indentation", "a:\n\tb: 1"],
    ["a line indented under a scalar", "a: 1\n    b: 2\n  c: 3"],
    ["an unclosed quote", "a: 'x"],
    ["an unclosed flow sequence", "a: [x, y"],
    ["text after a closing quote", 'a: "x" y'],
    ["an alias followed by more text", "b: &x 1\na: *x y"],
    ["an anchor before a sequence item on its line", "a: &x - x"],
    ["a flow plain scalar going on after its comment", "a: [one # c\n  two]"],
    ["a flow plain scalar starting with a comment sign", "a: [a,#b]"],
    ["text after a flow collection", "a: [x]y"],
  ])("has no value for %s", (_, text) => {
    expect(yamlDocument(text)).toBeUndefined();
  });

  it("reads aliases that grow the value within its budget, and has no value for a document whose aliases grow it past", () => {
    const dag = (levels: number): string =>
      [
        "a0: &a0 {run: node a.js}",
        ...Array.from({ length: levels }, (_, at) => `a${at + 1}: &a${at + 1} [*a${at}, *a${at}]`),
        `steps: *a${levels}`,
      ].join("\n");
    const wide = [
      "s: &s {run: node a.js}",
      ...Array.from({ length: 200 }, (_, at) => `k${at}: *s`),
    ];

    expect((yamlDocument(dag(9)) as Record<string, unknown>)["steps"]).toHaveLength(2);
    expect(Object.keys(yamlDocument(wide.join("\n")) as object)).toHaveLength(201);
    expect(yamlDocument(dag(18))).toBeUndefined();
    expect(
      yamlDocument(dag(18).replaceAll(/\[(\*a\d+), (\*a\d+)\]/gu, "\n  - $1\n  - $2")),
    ).toBeUndefined();
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

  it("refuses a key declared twice, and one whose own lines lie outside the subset or alias another key's anchor", () => {
    expect(yamlKey("packages: [a]\npackages: [b]\n", "packages").kind).toBe("refused");
    expect(yamlKey("catalog: &all [a]\npackages: *all\n", "packages").kind).toBe("refused");
  });
});
