import { describe, expect, it } from "vitest";
import { componentModule, exportsDefault, lineOf, readComponent } from "./component-files.ts";

const TERMINATORS = new Set(["\n", "\r", "\u2028", "\u2029"]);

/** The content of every block one file's text is read as holding, in file order. */
function blocksOf(text: string): string[] {
  return readComponent(text).blocks.map((block) =>
    text.slice(block.contentStart, block.contentEnd),
  );
}

/** One line per warning: the line it names and its reason. */
function warningsOf(text: string): string[] {
  return readComponent(text).warnings.map(
    (warning) => `${String(lineOf(text, warning.offset))}: ${warning.reason}`,
  );
}

/**
 * Every offset of the file's text in the module either holds the same code unit, inside
 * a block or as a line terminator or the BOM, or a space or `;` outside every block.
 */
function expectAligned(text: string): void {
  const module = componentModule(text).text;
  const inside = readComponent(text).blocks.map((block) => [block.contentStart, block.contentEnd]);
  expect(module.length).toBeGreaterThan(text.length);
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] ?? "";
    const held = module[at] ?? "";
    if (inside.some(([from = 0, to = 0]) => from <= at && at < to)) {
      expect(held).toBe(char);
    } else if (TERMINATORS.has(char) || (at === 0 && char === "\ufeff")) {
      expect(held).toBe(char);
    } else {
      expect([" ", ";"]).toContain(held);
    }
  }
}

describe("component files", () => {
  const cases: readonly (readonly [string, string, readonly string[]])[] = [
    [
      "two blocks, in file order",
      '<script lang="ts">\nexport const shared = 1;\n</script>\n<template><p>{{ shared }}</p></template>\n<script setup lang="ts">\nconst local = shared;\n</script>\n',
      ["\nexport const shared = 1;\n", "\nconst local = shared;\n"],
    ],
    [
      "a script inside a comment",
      '<!--\n<script lang="ts">bad(</script>\n-->\n<script lang="ts">const a = 1;</script>',
      ["const a = 1;"],
    ],
    [
      "script text inside an attribute and an interpolation",
      '<template><a :title="\'<script>\'">{{ "</script>" }}</a></template>\n<script>const b = 2;</script>',
      ["const b = 2;"],
    ],
    [
      "an end tag name only starting with script",
      '<script lang="ts">const s = "</scripty>";</script>',
      ['const s = "</scripty>";'],
    ],
    [
      "case, spacing and newlines inside the tags",
      "<ScRiPt\n\tLaNg\n=\n'Ts'\n  SeTuP\n>const c = 3;</sCrIpT\n>",
      ["const c = 3;"],
    ],
    ["an unquoted lang", "<script lang=ts>const d: number = 4;</script>", ["const d: number = 4;"]],
    ["an empty block", "<script></script>\n<script>const e = 5;</script>", ["", "const e = 5;"]],
    [
      "CRLF line endings and a BOM",
      '\ufeff<template>\r\n</template>\r\n<script lang="ts">\r\nconst f = 6;\r\n</script>\r\n',
      ["\r\nconst f = 6;\r\n"],
    ],
    [
      "a nested script is markup",
      '<svelte:head>\n<script type="application/ld+json">{"a":1}</script>\n</svelte:head>\n<script>const g = 7;</script>',
      ["const g = 7;"],
    ],
    [
      "a script of a script type inside an element",
      "<div>\n<script>const n = 1;</script>\n</div>",
      [],
    ],
    [
      "an expression in braces holding a less-than and a script tag",
      '{#if a<b && c}{"<script>"}{/if}\n<script lang="ts">const h = 8;</script>',
      ["const h = 8;"],
    ],
    [
      "a style holding script text",
      '<style>a::before { content: "<script>"; }</style>\n<script>const i = 9;</script>',
      ["const i = 9;"],
    ],
    [
      "a start tag that does not begin a line",
      '<div></div> <script>const no = 0;</script>\n<script lang="ts">const j = 10;</script>',
      ["const j = 10;"],
    ],
    [
      "a frontmatter block before the markup",
      '---\nimport { k } from "./k.js";\n---\n<h1>{k}</h1>\n<script>const l = 11;</script>\n',
      ['import { k } from "./k.js";\n', "const l = 11;"],
    ],
    ["a first line that is not a fence", "<h1>---</h1>\n---\nconst m = 12;\n---\n", []],
    ["a frontmatter never closed", "---\nconst n = 13;\n", []],
    ["a file holding no block", "<template><p>text</p></template>\n", []],
  ];

  for (const [name, text, blocks] of cases) {
    it(`reads ${name}`, () => {
      expect(blocksOf(text)).toEqual(blocks);
      expectAligned(text);
    });
  }

  it("keeps a block's offsets, so every line and column of the module is the file's", () => {
    const text =
      '<template>\n  <p>é😀</p>\n</template>\r\n<script lang="ts">\nconst wide = "😀"; const x = 1;\n</script>\n';
    const module = componentModule(text).text;
    expect(module.indexOf("const x")).toBe(text.indexOf("const x"));
    expect(module.slice(0, text.length).split(/\r\n|\n/u)).toHaveLength(
      text.split(/\r\n|\n/u).length,
    );
  });

  it("breaks the statement at the start tag of every block after the first", () => {
    const text = "<script>const a = 1</script>\n<script>(b)</script>";
    const module = componentModule(text).text;
    expect(module[text.indexOf("<script>(b)")]).toBe(";");
    expect(module[0]).toBe(" ");
  });

  it("takes the strongest language any block names, and TypeScript for a file with none", () => {
    expect(componentModule("<script>a</script>\n<script lang='jsx'>b</script>").extension).toBe(
      ".jsx",
    );
    expect(
      componentModule("<script lang='tsx'>a</script>\n<script lang='ts'>b</script>").extension,
    ).toBe(".tsx");
    expect(componentModule("---\na\n---\n<script>b</script>").extension).toBe(".ts");
    expect(componentModule("<p></p>").extension).toBe(".ts");
  });

  it("maps every block verbatim and appends a default export where no block writes one", () => {
    const text = '<script lang="ts">\nconst a = 1;\n</script>\n';
    const module = componentModule(text);
    expect(module.mappings).toEqual([[18, 14, 18, 14, 0]]);
    expect(module.text.slice(text.length)).toBe("\nexport default (0 as any);\n");
    expect(componentModule("<script>let b;</script>").text.endsWith("\nexport default {};\n")).toBe(
      true,
    );
    const own = "<script>\nexport default { name: 'own' };\n</script>";
    expect(componentModule(own).text.slice(own.length)).toBe("\n\n");
  });

  it("imports the file a src attribute names, mapped to the attribute, in either form", () => {
    const text =
      '<script src="./x.js"/>\n<script src=y.ts></script>\n<script>const z = 1;</script>';
    const read = readComponent(text);
    expect(read.imports.map((one) => one.specifier)).toEqual(["./x.js", "./y.ts"]);
    expect(blocksOf(text)).toEqual(["const z = 1;"]);
    const module = componentModule(text);
    expect(module.text.slice(99, 143)).toBe('import * as __component_src_0 from "./x.js";');
    expect(module.mappings.slice(1)).toEqual([
      [99, 44, 8, 12, 1],
      [144, 44, 31, 8, 1],
    ]);
  });

  it("warns for each line-start script tag it reads no block for, naming the line", () => {
    const text = [
      "<div>",
      "<script>const nested = 1;</script>",
      "</div>",
      '<script lang="coffee">x = 1</script>',
      '<script type="text/x-template"><p></p></script>',
      '<script src="https://example.com/x.js"></script>',
      "<script>",
      "const a = '",
      "<script>';",
      "</script>",
    ].join("\n");
    expect(warningsOf(text)).toEqual([
      "2: it is inside an element",
      '4: its lang "coffee" is not ts, tsx, js or jsx',
      '5: its type "text/x-template" is not a script type',
      '6: its src "https://example.com/x.js" names no file',
      "9: it begins a line inside a block",
    ]);
  });

  it("lists every expression and attribute value of the markup as an action", () => {
    const text =
      '<template>\n  <li v-for="row of rows" :key="row.id">{{ row.label }}</li>\n</template>\n<script>const rows = [];</script>';
    expect(readComponent(text).markup.map((one) => one.action)).toEqual([
      'v-for="row of rows"',
      ':key="row.id"',
      "{{ row.label }}",
    ]);
    const svelte = "<button on:click={() => save(item)} {disabled}>{item.name}</button>";
    expect(readComponent(svelte).markup.map((one) => one.text)).toEqual([
      "() => save(item)",
      "disabled",
      "item.name",
    ]);
  });

  it("finds a default export at the top level and nowhere else", () => {
    expect(exportsDefault("export default 1;")).toBe(true);
    expect(exportsDefault("const a = 1; export { a as default };")).toBe(true);
    expect(exportsDefault("export { default } from './x';")).toBe(true);
    expect(exportsDefault("// export default 1\nconst a = 1;")).toBe(false);
    expect(exportsDefault("/* export default */ const a = 1;")).toBe(false);
    expect(exportsDefault("const s = 'export default';")).toBe(false);
    expect(exportsDefault("const t = `${'x'} export default`;")).toBe(false);
    expect(exportsDefault("const r = /export default/u;")).toBe(false);
    expect(exportsDefault("declare module 'm' { export default 1; }")).toBe(false);
    expect(exportsDefault("const o = { default: 1 }; export { o };")).toBe(false);
  });

  it("counts lines as the compiler does", () => {
    expect(lineOf("a\r\nb\rc\u2028d\ne", 9)).toBe(5);
    expect(lineOf("a\r\nb", 3)).toBe(2);
  });
});
