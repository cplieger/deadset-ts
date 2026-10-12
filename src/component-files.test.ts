import { describe, expect, it } from "vitest";
import { componentModule, exportsDefault, lineOf, readComponent } from "./component-files.ts";

const TERMINATORS = new Set(["\n", "\r", "\u2028", "\u2029"]);

const EXTENSIONS = [".vue", ".svelte", ".astro"] as const;

/** The content of every block one file's text is read as holding, in file order. */
function blocksOf(text: string, extension = ".vue"): string[] {
  return readComponent(text, extension).blocks.map((block) =>
    text.slice(block.contentStart, block.contentEnd),
  );
}

/** One line per warning: the line it names and its reason. */
function warningsOf(text: string, extension = ".vue"): string[] {
  return readComponent(text, extension).warnings.map(
    (warning) => `${String(lineOf(text, warning.offset))}: ${warning.reason}`,
  );
}

/** Every markup action of one file's text, as one line. */
function actionsOf(text: string, extension = ".vue"): string[] {
  return readComponent(text, extension).markup.map((one) => one.action);
}

/**
 * Every offset of the file's text in the module either holds the same code unit, inside
 * a block or as a line terminator or the BOM, or a space or `;` outside every block.
 */
function expectAligned(text: string, extension: string): void {
  const module = componentModule(text, extension).text;
  const inside = readComponent(text, extension).blocks.map((block) => [
    block.contentStart,
    block.contentEnd,
  ]);
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
    ["words before a block", "<p>some text</p>\n<script>const o = 14;</script>", ["const o = 14;"]],
    ["a less-than in the text", "1 < 2\n<script>const p = 15;</script>", ["const p = 15;"]],
    [
      "a stray brace in the markup",
      "<p>{ open</p>\n<script>const q = 16;</script>",
      ["const q = 16;"],
    ],
    [
      "a comment holding a greater-than",
      "<!-- a > b\n<script>bad(</script>\n-->\n<script>const r = 17;</script>",
      ["const r = 17;"],
    ],
    ["a comment never closed", "<!--\n<script>const hidden = 1;</script>", []],
    [
      "a comment ending in what looks like a tag",
      "<!--<b-->\n<script>const s = 18;</script>",
      ["const s = 18;"],
    ],
    ["an end tag closing no element", "</div>\n<script>const t = 19;</script>", ["const t = 19;"]],
    [
      "a void and a self-closing element before a block",
      '<Child />\n<img src="a.png">\n<script>const u = 20;</script>',
      ["const u = 20;"],
    ],
    [
      "a type and a lang padded with spaces",
      '<script type=" Module " lang=" TS ">const v: number = 21;</script>',
      ["const v: number = 21;"],
    ],
    [
      "a self-closing script naming no src",
      '<script lang="ts" />\n<script>const w = 22;</script>',
      ["const w = 22;"],
    ],
    ["a BOM inside the markup", "<p>\ufeff</p>\n<script>const x = 23;</script>", ["const x = 23;"]],
    ["a block right after a BOM", "\ufeff<script>const y = 24;</script>", ["const y = 24;"]],
    ["a start tag after a space on the first line", " <script>const no = 0;</script>", []],
    [
      "a start tag after a BOM that does not begin a line",
      "\ufeff<p></p> <script>const no = 0;</script>",
      [],
    ],
    [
      "a stray brace whose match lies past a block",
      '<p>{ open</p>\n<script lang="ts">const z = 25;</script>\n<p>}</p>',
      ["const z = 25;"],
    ],
    [
      "an end tag with a solidus after its name",
      "<div>\n</div/>\n<script>const a = 26;</script>",
      ["const a = 26;"],
    ],
    [
      "a solidus inside a start tag that does not end it",
      "<div / >\n<script>const no = 0;</script>",
      [],
    ],
    [
      "a self-closing element whose last attribute has no value",
      "<Child disabled/>\n<script>const b = 27;</script>",
      ["const b = 27;"],
    ],
    [
      "a block's end tag with a solidus after its name",
      "<script>const c = 28;</script/>\n<script>const d = 29;</script>",
      ["const c = 28;", "const d = 29;"],
    ],
    ["a frontmatter after a BOM", "\ufeff---\nconst e = 30;\n---\n", ["const e = 30;\n"]],
    ["fences padded with spaces and tabs", "--- \nconst f = 31;\n---\t\n", ["const f = 31;\n"]],
    ["a first line ending in a fence", "# ---\nconst m = 12;\n---\n", []],
    ["a first line holding more than a fence", "---x\nconst m = 12;\n---\n", []],
  ];

  for (const [name, text, blocks] of cases) {
    it.each(EXTENSIONS)(`reads ${name} in a %s file`, (extension) => {
      expect(blocksOf(text, extension)).toEqual(blocks);
      expectAligned(text, extension);
    });
  }

  it("keeps a block's offsets, so every line and column of the module is the file's", () => {
    const text =
      '<template>\n  <p>é😀</p>\n</template>\r\n<script lang="ts">\nconst wide = "😀"; const x = 1;\n</script>\n';
    const module = componentModule(text, ".vue").text;
    expect(module.indexOf("const x")).toBe(text.indexOf("const x"));
    expect(module.slice(0, text.length).split(/\r\n|\n/u)).toHaveLength(
      text.split(/\r\n|\n/u).length,
    );
  });

  it("breaks the statement at the start tag of every block after the first", () => {
    const text = "<p>a</p>\n<script>const a = 1</script>\n<script>(b)</script>";
    const module = componentModule(text, ".vue").text.slice(0, text.length);
    const breaks = [...module].flatMap((char, at) => (char === ";" ? [at] : []));
    expect(breaks).toEqual([text.indexOf("<script>(b)")]);
  });

  it("takes the strongest language any block names, and TypeScript for a file with none", () => {
    expect(
      componentModule("<script>a</script>\n<script lang='jsx'>b</script>", ".vue").extension,
    ).toBe(".jsx");
    expect(
      componentModule("<script lang='tsx'>a</script>\n<script lang='ts'>b</script>", ".vue")
        .extension,
    ).toBe(".tsx");
    expect(componentModule("---\na\n---\n<script>b</script>", ".vue").extension).toBe(".ts");
    expect(componentModule("<p></p>", ".vue").extension).toBe(".ts");
  });

  it("maps every block verbatim and appends a default export where no block writes one", () => {
    const text = '<script lang="ts">\nconst a = 1;\n</script>\n';
    const module = componentModule(text, ".vue");
    expect(module.mappings).toEqual([[18, 14, 18, 14, 0]]);
    expect(module.text.slice(text.length)).toBe("\nexport default (0 as any);\n");
    expect(
      componentModule("<script>let b;</script>", ".vue").text.endsWith("\nexport default {};\n"),
    ).toBe(true);
    const own = "<script>\nexport default { name: 'own' };\n</script>";
    expect(componentModule(own, ".vue").text.slice(own.length)).toBe("\n\n");
  });

  it("maps no segment for an empty block", () => {
    expect(componentModule("<script></script>", ".vue").mappings).toEqual([]);
  });

  it("appends a typed default export to a TSX module", () => {
    const module = componentModule("<script lang='tsx'>let a;</script>", ".vue");
    expect(module.extension).toBe(".tsx");
    expect(module.text.endsWith("\nexport default (0 as any);\n")).toBe(true);
  });

  it("imports the file a src attribute names, mapped to the attribute, in either form", () => {
    const text =
      '<script src="./x.js"/>\n<script src=y.ts></script>\n<script>const z = 1;</script>';
    const read = readComponent(text, ".vue");
    expect(read.imports.map((one) => one.specifier)).toEqual(["./x.js", "./y.ts"]);
    expect(blocksOf(text)).toEqual(["const z = 1;"]);
    const module = componentModule(text, ".vue");
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

  it("warns for no element but a script, and for no script that does not begin a line", () => {
    const text = [
      "<div>",
      "<p>a</p> <span>b</span>",
      "</div>",
      "<div> <script>const x = 1;</script></div>",
    ].join("\n");
    expect(warningsOf(text)).toEqual([]);
  });

  it("warns for a line-start script tag inside a block, and for none past its end or mid-line", () => {
    expect(warningsOf("<script>\nconst a = '\n<script lang=\"ts\">';\n</script>")).toEqual([
      "3: it begins a line inside a block",
    ]);
    expect(warningsOf("<script>a</script>\n<script>b</script>")).toEqual([]);
    expect(warningsOf('<script>const s = "<script>";</script>')).toEqual([]);
  });

  it("imports the file a src attribute names, whatever its form, and warns for one naming none", () => {
    const text = [
      '<script src=" ./a.js "></script>',
      '<script src="../b.js"></script>',
      '<script src="./c:d.js"></script>',
      '<script src=""></script>',
      '<script src="/e.js"></script>',
    ].join("\n");
    expect(readComponent(text, ".vue").imports.map((one) => one.specifier)).toEqual([
      "./a.js",
      "../b.js",
      "./c:d.js",
    ]);
    expect(warningsOf(text)).toEqual([
      '4: its src "" names no file',
      '5: its src "/e.js" names no file',
    ]);
  });

  it("lists every expression and attribute value of the markup as an action", () => {
    const text =
      '<template>\n  <li v-for="row of rows" :key="row.id">{{ row.label }}</li>\n</template>\n<script>const rows = [];</script>';
    expect(readComponent(text, ".vue").markup.map((one) => one.action)).toEqual([
      'v-for="row of rows"',
      ':key="row.id"',
      "{{ row.label }}",
    ]);
    const svelte = "<button on:click={() => save(item)} {disabled}>{item.name}</button>";
    expect(readComponent(svelte, ".svelte").markup.map((one) => one.text)).toEqual([
      "() => save(item)",
      "disabled",
      "item.name",
    ]);
    expect(actionsOf(svelte)).toEqual(["on:click={() => save(item)}", "{disabled}", "{item.name}"]);
  });

  it("lists each action at the offset its text starts at in the file", () => {
    const text = '<p {disabled} title="a" on:click={go} :key=row.id>';
    expect(readComponent(text, ".vue").markup.map((one) => [one.start, one.text])).toEqual([
      [4, "disabled"],
      [21, "a"],
      [34, "go"],
      [43, "row.id"],
    ]);
  });

  it("collapses an action written over several lines to one line", () => {
    const text = '<p :class="{\n    active: on,\n  }">{ a  +\n  b }</p>';
    expect(actionsOf(text)).toEqual([':class="{ active: on, }"', "{ a + b }"]);
  });

  it("ends an attribute name at a space, a solidus or the tag's end", () => {
    expect(actionsOf('<p hidden>{x}</p><p title=a hidden :key="k">')).toEqual([
      "{x}",
      "title=a",
      ':key="k"',
    ]);
  });

  it("reads an equals sign that starts an attribute name as part of the name", () => {
    expect(actionsOf("<p =x>")).toEqual([]);
  });

  for (const name of [
    "Avatar",
    "Zone",
    "article",
    "zone",
    "Step0",
    "Col9",
    "my-el",
    "a.b",
    "svelte:head",
    "h_1",
  ]) {
    it(`reads ${name} as a tag name`, () => {
      expect(actionsOf(`<${name} title="{x}"></${name}>`)).toEqual(['title="{x}"']);
    });
  }

  for (const [name, space] of [
    ["a tab", "\t"],
    ["a form feed", "\f"],
    ["a carriage return", "\r"],
  ] as const) {
    it(`ends a tag name at ${name}`, () => {
      expect(actionsOf(`<p${space}title="{x}"></p>`)).toEqual(['title="{x}"']);
    });
  }

  it("reads a less-than before a character no tag name starts with as text", () => {
    expect(actionsOf('a <~ title="{x}">')).toEqual(["{x}"]);
  });

  it("skips a quoted string inside an expression, a closing brace in it included", () => {
    expect(
      readComponent('<p>{"}"} {\'}\'} {`}`} {"\\"}"}</p>', ".vue").markup.map((one) => one.text),
    ).toEqual(['"}"', "'}'", "`}`", '"\\"}"']);
  });

  it("reads an expression holding a script tag that does not begin a line", () => {
    expect(readComponent("<p>{a <script> b}</p>", ".vue").markup.map((one) => one.text)).toEqual([
      "a <script> b",
    ]);
  });

  it("reads markup cut off at the end of the file", () => {
    expect(actionsOf('<p title="a ')).toEqual(['title="a']);
    expect(actionsOf("<p title=a")).toEqual(["title=a"]);
    expect(actionsOf("<p {a ", ".svelte")).toEqual(["{a"]);
    expect(actionsOf("<p title={a ", ".svelte")).toEqual(["title={a"]);
    expect(actionsOf("<p>{x}</p")).toEqual(["{x}"]);
    expect(warningsOf("<div>\n<script")).toEqual(["2: it is inside an element"]);
    const mapped = componentModule("<script src=x.js", ".vue").mappings.map((one) =>
      one.slice(2, 4),
    );
    expect(mapped).toEqual([[8, 8]]);
  });

  it("lists no action for an attribute with no value", () => {
    const text = '<button disabled @click="go">Go</button>';
    expect(readComponent(text, ".vue").markup.map((one) => one.action)).toEqual(['@click="go"']);
  });

  it("reads no action inside a doctype, a processing instruction or a broken end tag", () => {
    const text = "<?php {pi} ?>\n<!doctype {html}>\n<p>{x}</p>";
    expect(readComponent(text, ".vue").markup.map((one) => one.text)).toEqual(["x"]);
    expect(readComponent("</p@ {y}>", ".vue").markup.map((one) => one.text)).toEqual(["y"]);
    expect(readComponent("<!doctype html {>}", ".vue").markup).toEqual([]);
  });

  it("reads no action inside a raw-text element, closed or not", () => {
    expect(readComponent("<script>{</script>\n<p>}</p>", ".vue").markup).toEqual([]);
    const unclosed = '<script>\nconst a = "{x}";';
    expect(readComponent(unclosed, ".vue").markup).toEqual([]);
    expect(blocksOf(unclosed)).toEqual(['\nconst a = "{x}";']);
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

  it("finds no default export in a word that only follows export or names default", () => {
    expect(exportsDefault("const value = config.default;")).toBe(false);
    expect(exportsDefault("export const a = 1;")).toBe(false);
    expect(exportsDefault("api.export(config.default);")).toBe(false);
    expect(exportsDefault("const value = api.export().default;")).toBe(false);
    expect(exportsDefault("export { helper }; const fallback = helper.default;")).toBe(false);
  });

  it("tracks every kind of bracket, so a default export inside one is not at the top level", () => {
    expect(exportsDefault("declare module 'm' { function f(): void; export default f; }")).toBe(
      false,
    );
    expect(exportsDefault("declare module 'm' { const a: string[]; export default a; }")).toBe(
      false,
    );
    expect(exportsDefault("declare module 'm' { const a = 1; export default a; }")).toBe(false);
    expect(exportsDefault("declare module 'm' { export { x as default }; }")).toBe(false);
    expect(exportsDefault("const options = {}; export default options;")).toBe(true);
    expect(exportsDefault("register(app); export default app;")).toBe(true);
    expect(exportsDefault("const list = []; export default list;")).toBe(true);
  });

  it("skips comments and strings to their own end", () => {
    expect(exportsDefault("/*\nexport default 1;\n*/\nconst a = 1;")).toBe(false);
    expect(exportsDefault("/*/ export default 1 */")).toBe(false);
    expect(exportsDefault("/* note */ export default 1;")).toBe(true);
    expect(exportsDefault("/* export default 1")).toBe(false);
    expect(exportsDefault("const a = 1; // trailing note")).toBe(false);
    expect(exportsDefault('const s = "export default";')).toBe(false);
    expect(exportsDefault("const s = 'it\\'s'; export default s;")).toBe(true);
    expect(exportsDefault("const s = 'open")).toBe(false);
  });

  it("skips a template literal and its substitutions to the closing backtick", () => {
    expect(exportsDefault("const t = `a`; export default t;")).toBe(true);
    expect(exportsDefault("const t = `it\\`s`; export default t;")).toBe(true);
    expect(exportsDefault('const t = `${"`"}`; export default t;')).toBe(true);
    expect(exportsDefault("const t = `cost: $5`; export default t;")).toBe(true);
    expect(exportsDefault("const t = `a{`; export default t;")).toBe(true);
    expect(exportsDefault("// ${\nconst t = `${a;")).toBe(false);
  });

  it("reads a slash as a regular expression only where one may start", () => {
    expect(exportsDefault("const share = domain / 2; export default share;")).toBe(true);
    expect(exportsDefault("const half = count++ / 2;\nexport default half; // done")).toBe(true);
    expect(exportsDefault("const half = count++ / 2")).toBe(false);
    expect(exportsDefault("/export default/u.test(name);")).toBe(false);
  });

  it("skips a regular expression to its closing slash, outside a class and unescaped", () => {
    expect(exportsDefault("const spaces = /\\s+/gu; export default spaces;")).toBe(true);
    expect(exportsDefault("const r = /(export default)/u;")).toBe(false);
    expect(exportsDefault("const r = /\\[/u; export default r;")).toBe(true);
    expect(exportsDefault("const r = /[/(/]/u; export default r;")).toBe(true);
    expect(exportsDefault("const r = /[a]/u; export default r;")).toBe(true);
  });

  it("finds an `export * as default` as a default export, and appends none beside it", () => {
    expect(exportsDefault('export * as default from "./x.js";')).toBe(true);
    expect(exportsDefault('export * as other from "./x.js";')).toBe(false);
    expect(exportsDefault('export * from "./x.js"; const as = 1; const d = { default: as };')).toBe(
      false,
    );
    const text = '<script lang="ts">\nexport * as default from "./inner.js";\n</script>';
    expect(componentModule(text, ".vue").text.slice(text.length)).toBe("\n\n");
  });

  const SHORT_COMMENTS = [
    "<!-->\n<script>const shown = 1;</script>\n<!-- -->\n",
    "<!--->\n<script>const shown = 1;</script>\n<!-- -->\n",
    "<!-- a --!>\n<script>const shown = 1;</script>\n<!-- -->\n",
  ];

  it.each([".vue", ".astro", ".html"])(
    "closes <!-->, <!---> and --!> in a %s file, as Astro's readHTMLComment does and Vue's tokenizer does the first two",
    (extension) => {
      for (const text of SHORT_COMMENTS) {
        expect(blocksOf(text, extension)).toEqual(["const shown = 1;"]);
      }
      expect(blocksOf("<!--!>\n<script>const shown = 1;</script>\n", extension)).toEqual([
        "const shown = 1;",
      ]);
    },
  );

  it("reads a .svelte comment to the first --> past its <!--, as Svelte's element parser does", () => {
    for (const text of SHORT_COMMENTS) {
      expect(blocksOf(text, ".svelte")).toEqual([]);
    }
    expect(blocksOf("<!-->\n<script>a</script>\n-->\n<script>b</script>", ".svelte")).toEqual([
      "b",
    ]);
  });

  it.each(EXTENSIONS)("ends a comment that opens right after a --> in a %s file", (extension) => {
    expect(blocksOf("--><!--\n<script>a</script>\n-->\n<script>b</script>", extension)).toEqual([
      "b",
    ]);
  });

  it.each(EXTENSIONS)(
    "lets no unmatched brace in a %s start tag hide a later block",
    (extension) => {
      for (const tag of [
        "<p {open></p>",
        "<p title={open></p>",
        "<img {open",
        "<img title={open",
      ]) {
        expect(blocksOf(`${tag}\n<script lang="ts">const a = 1;</script>`, extension)).toEqual([
          "const a = 1;",
        ]);
      }
      for (const tag of ["<p {open", "<p {open>", "<p title={open>"]) {
        expect(warningsOf(`${tag}\n<script lang="ts">const a = 1;</script>`, extension)).toEqual([
          "2: it is inside an element",
        ]);
      }
    },
  );

  it("reads a .vue start tag's unmatched brace as part of a name or value, as Vue's tokenizer does", () => {
    expect(readComponent("<p {open>", ".vue").markup).toEqual([]);
    expect(readComponent("<p title={open>x</p>", ".vue").markup).toEqual([
      { start: 9, text: "{open", action: "title={open" },
    ]);
  });

  it.each([".svelte", ".astro"])(
    "ends a %s start tag's unmatched braced value at the first > or a line-start script tag",
    (extension) => {
      expect(readComponent("<p {open>x</p>", extension).markup).toEqual([
        { start: 4, text: "open", action: "{open" },
      ]);
      expect(readComponent("<p title={a\n<script>b</script>", extension).markup).toEqual([
        { start: 10, text: "a\n", action: "title={a" },
      ]);
      expect(readComponent("<p {open", extension).markup.map((one) => one.text)).toEqual(["open"]);
    },
  );

  it("keeps the last character of an unclosed quoted value, and reads a backslash in one as text", () => {
    expect(readComponent('<p title="open', ".vue").markup.map((one) => one.text)).toEqual(["open"]);
    const text = '<a title="C:\\"></a>\n<script lang="ts">const a = "y";</script>';
    expect(blocksOf(text)).toEqual(['const a = "y";']);
    expect(readComponent(text, ".vue").markup.map((one) => one.text)).toEqual(["C:\\"]);
  });

  it("counts lines as the compiler does", () => {
    expect(lineOf("a\r\nb\rc\u2028d\ne", 9)).toBe(5);
    expect(lineOf("a\r\nb", 3)).toBe(2);
    expect(lineOf("a\nb", 1)).toBe(1);
    expect(lineOf("a\u2029b", 2)).toBe(2);
  });
});
