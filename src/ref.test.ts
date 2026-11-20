import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contractDocument, fixture, readFixture } from "../__test-helpers__/fixtures.ts";
import {
  computedComponent,
  isUnsafe,
  hasRefShape,
  importRef,
  isRef,
  nameComponent,
  parameterRef,
  readPathSegment,
  REF_EXPRESSIONS,
  REF_SHAPE,
  renderRef,
  spell,
  type Component,
  type Fragment,
  type Module,
} from "./ref.ts";

/** One case of the Contract's published token corpus. */
interface Token {
  readonly input: string;
  readonly language: string;
  readonly form: string;
  readonly accepted: boolean;
  readonly reason: string;
  /** For a refused case, whether the shape every document checks admits it. */
  readonly shape?: boolean;
}

/** One case of the Contract's published path segment corpus. */
interface SegmentCase {
  readonly set: string;
  readonly spelled: string;
  readonly canonical: boolean;
  /** The bytes a canonical spelling spells, two lowercase hexadecimal digits each. */
  readonly raw_hex?: string;
  readonly reason: string;
}

/** The source-path cases of the segment corpus: the one set this language spells a path in. */
function sourcePathSegments(): readonly SegmentCase[] {
  return (
    JSON.parse(readFixture("contract", "grammar", "segment-corpus.json")) as readonly SegmentCase[]
  ).filter((one) => one.set === "source-path");
}

/** The text bytes spell, where they are well-formed UTF-8, which is all a string can hold. */
function textOf(hex: string): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(hex, "hex"));
  } catch {
    return undefined;
  }
}

/** The expression the grammar page prints expanded under its shape section. */
function publishedShape(): string {
  const page = readFileSync(fixture("contract", "grammar", "symbol-ref.md"), "utf8");
  const section = page.slice(page.indexOf("### The shape every document checks"));
  return /```text\n(\^[^\n]*)\n```/u.exec(section)?.[1] ?? "no expanded shape on the page";
}

function corpus(): readonly Token[] {
  return JSON.parse(
    readFileSync(fixture("contract", "grammar", "symbol-ref-corpus.json"), "utf8"),
  ) as readonly Token[];
}

/**
 * The expressions the grammar page publishes for one language, read from the block
 * it prints them expanded in: one line naming the language and the forms that share
 * the expression, then the expression itself.
 */
function publishedExpressions(language: string): string[] {
  const lines = readFileSync(fixture("contract", "grammar", "symbol-ref.md"), "utf8").split("\n");
  const found: string[] = [];
  lines.forEach((line, index) => {
    const head = /^(?<language>go|ts) (?<forms>[a-z-]+(?:, [a-z-]+)*)$/u.exec(line);
    const expression = lines[index + 1] ?? "";
    if (head?.groups?.["language"] === language && expression.startsWith("^")) {
      found.push(expression);
    }
  });
  return found;
}

function name(text: string): Component {
  return { text, kind: "key" };
}

function privateName(text: string): Component {
  return { text, kind: "private" };
}

function computed(text: string): Component {
  return { text, kind: "computed" };
}

function declaration(
  chain: readonly Component[],
  extra: { readonly static?: boolean; readonly typeParameter?: string } = {},
): Fragment {
  return {
    of: "declaration",
    chain,
    static: extra.static ?? false,
    ...(extra.typeParameter === undefined ? {} : { typeParameter: extra.typeParameter }),
  };
}

const APP: Module = { package: "@example/app", path: "src/wire.ts" };
const TABS: Module = { package: "@example/app", path: "src/features/tabs/index.ts" };
const INDEX: Module = { package: "@example/app", path: "src/index.ts" };
const MANIFEST: Module = { package: "@example/app", path: "package.json" };

/** The one accepted import-binding token of the corpus, which `importRef` renders. */
const IMPORT_BINDING = "ts://@example/app/src/main.ts#basename:import";

/** The accepted parameter tokens of the corpus, each with the holder `parameterRef` renders it from. */
const PARAMETERS: readonly { holder: string; name: string; input: string }[] = [
  {
    holder: "ts://@example/app/src/main.ts#partial",
    name: "unread",
    input: "ts://@example/app/src/main.ts#partial(unread)",
  },
  {
    holder: "ts://@example/app/src/wire.ts#Codec.of:static",
    name: "raw",
    input: "ts://@example/app/src/wire.ts#Codec.of:static(raw)",
  },
  {
    holder: "ts://@example/app/src/main.ts#",
    name: "first",
    input: "ts://@example/app/src/main.ts#(first)",
  },
];

/**
 * One row per accepted TypeScript case of the published corpus: the parts a symbol
 * of that form is rendered from, and the token the corpus carries. Rendering the
 * parts must reproduce the token byte for byte, which is what makes a reference
 * written by hand into an ignore entry match one this analyzer emits.
 */
const RENDERED: readonly { module: Module; fragment: Fragment; input: string }[] = [
  {
    module: { package: "@example/app", path: "gen/v1/service_pb.ts" },
    fragment: declaration([name("Backrest"), name("getConfig")]),
    input: "ts://@example/app/gen/v1/service_pb.ts#Backrest.getConfig",
  },
  {
    module: { package: "@example/app", path: "gen/eliza_connect.ts" },
    fragment: declaration([name("ElizaService"), name("methods"), name("say")]),
    input: "ts://@example/app/gen/eliza_connect.ts#ElizaService.methods.say",
  },
  { module: APP, fragment: { of: "module" }, input: "ts://@example/app/src/wire.ts#" },
  {
    module: APP,
    fragment: declaration([name("ServerEvent")]),
    input: "ts://@example/app/src/wire.ts#ServerEvent",
  },
  {
    module: TABS,
    fragment: declaration([name("measure")]),
    input: "ts://@example/app/src/features/tabs/index.ts#measure",
  },
  {
    module: TABS,
    fragment: declaration([name("GAP")]),
    input: "ts://@example/app/src/features/tabs/index.ts#GAP",
  },
  {
    module: { package: "@example/app", path: "src/App.tsx" },
    fragment: declaration([name("App")]),
    input: "ts://@example/app/src/App.tsx#App",
  },
  {
    module: { package: "@example/app", path: "scripts/build.mjs" },
    fragment: declaration([name("bundle")]),
    input: "ts://@example/app/scripts/build.mjs#bundle",
  },
  {
    module: { package: "@example/app", path: "src/Panel.vue" },
    fragment: declaration([name("Row"), name("dead")]),
    input: "ts://@example/app/src/Panel.vue#Row.dead",
  },
  {
    module: { package: "@example/app", path: "src/Card.svelte" },
    fragment: declaration([name("Tile"), name("hidden")]),
    input: "ts://@example/app/src/Card.svelte#Tile.hidden",
  },
  {
    module: { package: "@example/app", path: "src/Page.astro" },
    fragment: { of: "module" },
    input: "ts://@example/app/src/Page.astro#",
  },
  {
    module: { package: "@example/app", path: "src/types.d.ts" },
    fragment: declaration([name("Manifest")]),
    input: "ts://@example/app/src/types.d.ts#Manifest",
  },
  {
    module: { package: ".", path: "src/wire.ts" },
    fragment: declaration([name("ServerEvent")]),
    input: "ts://./src/wire.ts#ServerEvent",
  },
  {
    module: { package: "@example/app", path: "src/app.ts" },
    fragment: declaration([name("default")]),
    input: "ts://@example/app/src/app.ts#default",
  },
  {
    module: INDEX,
    fragment: { of: "alias", name: "TabStrip" },
    input: "ts://@example/app/src/index.ts#TabStrip:alias",
  },
  {
    module: INDEX,
    fragment: { of: "alias", name: "Strip" },
    input: "ts://@example/app/src/index.ts#Strip:alias",
  },
  {
    module: INDEX,
    fragment: { of: "alias", name: "default" },
    input: "ts://@example/app/src/index.ts#default:alias",
  },
  {
    module: { package: "@example/app", path: "src/shims.d.ts" },
    fragment: { of: "alias", name: "default", block: "*.vue" },
    input: "ts://@example/app/src/shims.d.ts#'*.vue'.default:alias",
  },
  {
    module: { package: "@example/app", path: "src/shims.d.ts" },
    fragment: { of: "alias", name: "default", block: "lodash" },
    input: "ts://@example/app/src/shims.d.ts#'lodash'.default:alias",
  },
  {
    module: TABS,
    fragment: declaration([name("TabStrip"), name("cachedLayout")]),
    input: "ts://@example/app/src/features/tabs/index.ts#TabStrip.cachedLayout",
  },
  {
    module: TABS,
    fragment: declaration([name("TabStrip"), name("render")]),
    input: "ts://@example/app/src/features/tabs/index.ts#TabStrip.render",
  },
  {
    module: TABS,
    fragment: declaration([name("TabStrip"), privateName("#frame")]),
    input: "ts://@example/app/src/features/tabs/index.ts#TabStrip.#frame",
  },
  {
    module: TABS,
    fragment: declaration([name("TabStrip"), name("count")], { static: true }),
    input: "ts://@example/app/src/features/tabs/index.ts#TabStrip.count:static",
  },
  {
    module: APP,
    fragment: declaration([name("Headers"), name("content-type")]),
    input: "ts://@example/app/src/wire.ts#Headers.'content-type'",
  },
  {
    module: APP,
    fragment: declaration([name("Quirks"), name("it's")]),
    input: "ts://@example/app/src/wire.ts#Quirks.'it\\'s'",
  },
  {
    module: TABS,
    fragment: declaration([name("TabStrip"), computed("Symbol.iterator")]),
    input: "ts://@example/app/src/features/tabs/index.ts#TabStrip.[Symbol.iterator]",
  },
  {
    module: APP,
    fragment: declaration([name("ServerEvent"), name("seq")]),
    input: "ts://@example/app/src/wire.ts#ServerEvent.seq",
  },
  {
    module: APP,
    fragment: declaration([name("Labels"), name("größe")]),
    input: "ts://@example/app/src/wire.ts#Labels.größe",
  },
  {
    module: APP,
    fragment: declaration([name("Prices"), name("a€b")]),
    input: "ts://@example/app/src/wire.ts#Prices.'a€b'",
  },
  {
    module: APP,
    fragment: declaration([name("Prices"), name("a\u200Bb")]),
    input: "ts://@example/app/src/wire.ts#Prices.'a\u200Bb'",
  },
  {
    module: { package: "@example/app", path: "src/wire.ts" },
    fragment: declaration([name("Prices"), name("#a")]),
    input: "ts://@example/app/src/wire.ts#Prices.'#a'",
  },
  {
    module: { package: "@example/app", path: "src/wire.ts" },
    fragment: declaration([name("Prices"), name("ab")]),
    input: "ts://@example/app/src/wire.ts#Prices.ab",
  },
  {
    module: { package: "@example/app", path: "src/wire.ts" },
    fragment: declaration([name("Prices"), name("16")]),
    input: "ts://@example/app/src/wire.ts#Prices.'16'",
  },
  {
    module: { package: "@example/app", path: "src/wire.ts" },
    fragment: declaration([name("Prices"), name("t\tb")]),
    input: "ts://@example/app/src/wire.ts#Prices.'t\tb'",
  },
  {
    module: { package: "@example/app", path: "src/wire.ts" },
    fragment: declaration([name("Prices"), name("\u001b[31mX")]),
    input: "ts://@example/app/src/wire.ts#Prices.'\\u{1B}[31mX'",
  },
  {
    module: { package: "@example/app", path: "src/wire.ts" },
    fragment: declaration([name("Prices"), name("a\u0000b")]),
    input: "ts://@example/app/src/wire.ts#Prices.'a\\u{0}b'",
  },
  {
    module: { package: "@example/app", path: "src/wire.ts" },
    fragment: declaration([name("Prices"), name("safe\u202E.exe")]),
    input: "ts://@example/app/src/wire.ts#Prices.'safe\\u{202E}.exe'",
  },
  {
    module: { package: "@example/app", path: "src/wire.ts" },
    fragment: declaration([name("Prices"), name("x\u2028y")]),
    input: "ts://@example/app/src/wire.ts#Prices.'x\\u{2028}y'",
  },
  {
    module: { package: "@example/app", path: "src/wire.ts" },
    fragment: declaration([name("Prices"), name("\uD800")]),
    input: "ts://@example/app/src/wire.ts#Prices.'\\u{D800}'",
  },
  {
    module: { package: "@example/app", path: "src/wire.ts" },
    fragment: declaration([name("Prices"), name("a\u009Bb\u007F")]),
    input: "ts://@example/app/src/wire.ts#Prices.'a\\u{9B}b\\u{7F}'",
  },
  {
    module: { package: "@example/app", path: "src/wire.ts" },
    fragment: declaration([name("Prices"), name("\u061C\u200F\u2069")]),
    input: "ts://@example/app/src/wire.ts#Prices.'\\u{61C}\\u{200F}\\u{2069}'",
  },
  {
    module: { package: "@example/app", path: "src/layout.ts" },
    fragment: declaration([name("Layout"), name("gap")]),
    input: "ts://@example/app/src/layout.ts#Layout.gap",
  },
  {
    module: { package: "@example/app", path: "src/layout.ts" },
    fragment: declaration([name("Frame"), name("inset")]),
    input: "ts://@example/app/src/layout.ts#Frame.inset",
  },
  {
    module: APP,
    fragment: declaration([name("Kind"), name("Resize")]),
    input: "ts://@example/app/src/wire.ts#Kind.Resize",
  },
  {
    module: APP,
    fragment: declaration([name("Kind"), name("tab-close")]),
    input: "ts://@example/app/src/wire.ts#Kind.'tab-close'",
  },
  {
    module: APP,
    fragment: declaration([name("Wire"), name("Server"), name("Event")]),
    input: "ts://@example/app/src/wire.ts#Wire.Server.Event",
  },
  {
    module: APP,
    fragment: declaration([name("decode")], { typeParameter: "T" }),
    input: "ts://@example/app/src/wire.ts#decode<T>",
  },
  {
    module: APP,
    fragment: declaration([name("Codec"), name("decode")], { typeParameter: "T" }),
    input: "ts://@example/app/src/wire.ts#Codec.decode<T>",
  },
  {
    module: APP,
    fragment: declaration([name("Codec"), name("of")], { static: true, typeParameter: "T" }),
    input: "ts://@example/app/src/wire.ts#Codec.of:static<T>",
  },
  {
    module: APP,
    fragment: declaration([name("Wire"), name("Codec"), name("decode")], { typeParameter: "T" }),
    input: "ts://@example/app/src/wire.ts#Wire.Codec.decode<T>",
  },
  {
    module: APP,
    fragment: declaration([name("Wire"), name("Server"), name("Codec"), name("decode")], {
      typeParameter: "T",
    }),
    input: "ts://@example/app/src/wire.ts#Wire.Server.Codec.decode<T>",
  },
  {
    module: MANIFEST,
    fragment: { of: "dependency", name: "lodash", section: "dependency" },
    input: "ts://@example/app/package.json#lodash:dependency",
  },
  {
    module: MANIFEST,
    fragment: { of: "dependency", name: "@types/node", section: "dev-dependency" },
    input: "ts://@example/app/package.json#@types/node:dev-dependency",
  },
  {
    module: MANIFEST,
    fragment: { of: "dependency", name: "typescript", section: "peer-dependency" },
    input: "ts://@example/app/package.json#typescript:peer-dependency",
  },
  {
    module: { package: ".", path: "static-src/package.json" },
    fragment: { of: "dependency", name: "html-validate", section: "dev-dependency" },
    input: "ts://./static-src/package.json#html-validate:dev-dependency",
  },
  {
    module: { package: "@example/app", path: "package.json" },
    fragment: { of: "dependency", name: "left~pad", section: "dependency" },
    input: "ts://@example/app/package.json#left%7Epad:dependency",
  },
  {
    module: { package: "@legacy!/tool", path: "src/main.ts" },
    fragment: declaration([name("run")]),
    input: "ts://@legacy%21/tool/src/main.ts#run",
  },
  {
    module: { package: "@example/app", path: "tools/package.json" },
    fragment: { of: "dependency", name: "lodash", section: "dependency" },
    input: "ts://@example/app/tools/package.json#lodash:dependency",
  },
  {
    module: { package: ".", path: "src/my file.ts" },
    fragment: declaration([name("unused")]),
    input: "ts://./src/my%20file.ts#unused",
  },
  {
    module: { package: ".", path: "src/a#b.ts" },
    fragment: declaration([name("unused")]),
    input: "ts://./src/a%23b.ts#unused",
  },
  {
    module: { package: ".", path: "src/100%.ts" },
    fragment: declaration([name("unused")]),
    input: "ts://./src/100%25.ts#unused",
  },
  {
    module: { package: ".", path: "app/[id].tsx" },
    fragment: declaration([name("default")]),
    input: "ts://./app/[id].tsx#default",
  },
  {
    module: { package: ".", path: "src/größe.ts" },
    fragment: declaration([name("X")]),
    input: "ts://./src/größe.ts#X",
  },
  {
    module: { package: ".", path: "src/h.ts" },
    fragment: declaration([name("Headers"), name("content type")]),
    input: "ts://./src/h.ts#Headers.'content type'",
  },
  {
    module: { package: ".", path: "my tools/package.json" },
    fragment: { of: "dependency", name: "lodash", section: "dependency" },
    input: "ts://./my%20tools/package.json#lodash:dependency",
  },
  {
    module: { package: ".", path: "src/a\u0085b.ts" },
    fragment: declaration([name("unused")]),
    input: "ts://./src/a%C2%85b.ts#unused",
  },
  {
    module: { package: ".", path: "src/a\u00a0b\u2028.ts" },
    fragment: declaration([name("unused")]),
    input: "ts://./src/a%C2%A0b%E2%80%A8.ts#unused",
  },
  {
    module: { package: "@example/app", path: "src/headers.ts" },
    fragment: declaration([name("Headers"), name("content\u00a0type")]),
    input: "ts://@example/app/src/headers.ts#Headers.'content\u00a0type'",
  },
];

describe("the reference grammar", () => {
  it("is the set of expressions the pinned grammar page publishes for this language", () => {
    expect([...REF_EXPRESSIONS].sort()).toEqual(publishedExpressions("ts").sort());
  });

  it("publishes one expression per form group the page names, and no other", () => {
    expect(REF_EXPRESSIONS.length).toBe(publishedExpressions("ts").length);
    expect(publishedExpressions("go").length, "the page also fixes the other language").toBe(8);
  });

  it("accepts every token the corpus accepts for this language", () => {
    const refused = corpus()
      .filter((token) => token.language === "ts" && token.accepted && !isRef(token.input))
      .map((token) => `${token.form}: ${token.input}`);

    expect(refused, "isRef must accept every accepted TypeScript token").toEqual([]);
  });

  it("refuses every token the corpus refuses for this language", () => {
    const accepted = corpus()
      .filter((token) => token.language === "ts" && !token.accepted && isRef(token.input))
      .map((token) => `${token.form}: ${token.input} (${token.reason})`);

    expect(accepted, "isRef must refuse every refused TypeScript token").toEqual([]);
  });

  it("refuses every token of the other language, accepted there or not", () => {
    const accepted = corpus()
      .filter((token) => token.language === "go" && isRef(token.input))
      .map((token) => `${token.form}: ${token.input}`);

    expect(accepted, "a reference of another language is not one of this language's").toEqual([]);
  });

  it("refuses a reference that differs from an accepted one only in its language", () => {
    // A scope both languages spell legally, so the prefix is the only thing the
    // refusal can rest on: an import path may carry a `.ts` element, and a package
    // name may be a domain.
    const shared = "example.com/app/src/wire.ts#ServerEvent";

    expect(isRef(`ts://${shared}`)).toBe(true);
    expect(isRef(`go://${shared}`), "the prefix is what refuses it").toBe(false);
  });

  it("names the languages the Contract's language registry does", () => {
    const rows = contractDocument("languages.json")["languages"] as { language: string }[];
    const languages = rows.map((row) => row.language);

    expect(languages).toEqual(["go", "ts", "proto"]);
    expect(
      REF_EXPRESSIONS.every((expression) => expression.startsWith("^ts://")),
      "every expression of this analyzer is anchored on its own language prefix",
    ).toBe(true);
  });
});

describe("the canonical spelling of one reference", () => {
  it.each(RENDERED)("renders $input", ({ module, fragment, input }) => {
    expect(renderRef(module, fragment)).toBe(input);
  });

  it("renders an import binding as the corpus spells it", () => {
    const main = renderRef({ package: "@example/app", path: "src/main.ts" }, { of: "module" });

    expect(importRef(main, "basename")).toBe(IMPORT_BINDING);
  });

  it.each(PARAMETERS)("renders the parameter $input", ({ holder, name, input }) => {
    expect(parameterRef(holder, name)).toBe(input);
  });

  it("renders every accepted token of the corpus, each once", () => {
    const rendered = new Set([
      ...RENDERED.map((row) => row.input),
      IMPORT_BINDING,
      ...PARAMETERS.map((row) => row.input),
    ]);
    // No declaration this analyzer reads is a union constituent yet, so it renders no case reference.
    const accepted = corpus()
      .filter(
        (token) => token.language === "ts" && token.accepted && token.form !== "case-constituent",
      )
      .map((token) => token.input);

    expect([...rendered].sort()).toEqual([...accepted].sort());
  });
});

describe("the shape every document checks", () => {
  it("is the expression the pinned grammar page publishes, and the one the finding schema's reference takes", () => {
    const schema = contractDocument("finding.schema.json") as {
      $defs: { reference: { pattern: string } };
    };

    expect(REF_SHAPE).toBe(publishedShape());
    expect(REF_SHAPE).toBe(schema.$defs.reference.pattern);
  });

  it("admits every token the corpus accepts, in every language", () => {
    const refused = corpus()
      .filter((token) => token.accepted && !hasRefShape(token.input))
      .map((token) => `${token.language} ${token.form}: ${token.input}`);

    expect(refused).toEqual([]);
  });

  it("decides every refused token of the corpus as the corpus's shape member does", () => {
    const disagreeing = corpus()
      .filter((token) => !token.accepted && hasRefShape(token.input) !== token.shape)
      .map((token) => `${token.input}: shape ${String(token.shape)}`);

    expect(disagreeing).toEqual([]);
  });
});

describe("one source-path segment's spelling", () => {
  const segments = sourcePathSegments();
  const canonical = segments.filter((one) => one.canonical);

  it("is decided by a corpus that covers both outcomes", () => {
    expect(canonical.length).toBeGreaterThan(0);
    expect(segments.length).toBeGreaterThan(canonical.length);
  });

  it.each(
    canonical.flatMap((one) => {
      const text = textOf(one.raw_hex ?? "");
      return text === undefined ? [] : [[one.spelled, text, one.reason] as const];
    }),
  )("spells a segment as %s", (spelled, text) => {
    expect(renderRef({ package: ".", path: `${text}/unit.ts` }, { of: "module" })).toBe(
      `ts://./${spelled}/unit.ts#`,
    );
  });

  it("spells a lone surrogate by the bytes of its value, as a package component does", () => {
    expect(renderRef({ package: ".", path: "a\uD800/unit.ts" }, { of: "module" })).toBe(
      "ts://./a%ED%A0%80/unit.ts#",
    );
  });

  it.each(canonical.map((one) => [one.spelled, one.raw_hex ?? "", one.reason] as const))(
    "reads %s as the bytes %s",
    (spelled, hex) => {
      expect(Buffer.from(readPathSegment(spelled) ?? []).toString("hex")).toBe(hex);
    },
  );

  it.each(
    segments.filter((one) => !one.canonical).map((one) => [one.spelled, one.reason] as const),
  )("reads %j as the spelling of no segment: %s", (spelled) => {
    expect(readPathSegment(spelled)).toBeUndefined();
  });

  it("reads a segment holding a lone surrogate, which no encoder writes, as the spelling of none", () => {
    expect(readPathSegment("a\uD800")).toBeUndefined();
  });

  it("keeps a byte run as itself exactly where a strict UTF-8 decoder reads a character", () => {
    // Every run of up to four bytes over each boundary of RFC 3629's table, with `a` kept
    // and DEL, the C1 controls and the no-break space escaped; Node's fatal TextDecoder is
    // the oracle.
    const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const leads = [
      0x61, 0x7f, 0x80, 0xbf, 0xc0, 0xc1, 0xc2, 0xdf, 0xe0, 0xe1, 0xec, 0xed, 0xee, 0xef, 0xf0,
      0xf1, 0xf3, 0xf4, 0xf5, 0xff,
    ];
    const trails = [0x61, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0];
    const escape = (byte: number) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    const encoded = (point: number): boolean => point >= 0x7f && point <= 0xa0;
    const decoded = (bytes: Uint8Array): string | undefined => {
      try {
        return strict.decode(bytes);
      } catch {
        return undefined;
      }
    };
    const oracle = (bytes: Uint8Array): string => {
      let out = "";
      for (let at = 0; at < bytes.length;) {
        let length = 1;
        let read: string | undefined;
        for (; length <= 4 && at + length <= bytes.length; length += 1) {
          read = decoded(bytes.subarray(at, at + length));
          if (read !== undefined) {
            break;
          }
        }
        if (read === undefined) {
          out += escape(bytes[at] ?? 0);
          at += 1;
        } else if (encoded(read.codePointAt(0) ?? 0)) {
          out += Array.from(bytes.subarray(at, at + length), escape).join("");
          at += length;
        } else {
          out += read;
          at += length;
        }
      }
      return out;
    };
    let runs: number[][] = leads.map((lead) => [lead]);
    const differing: string[] = [];
    for (let size = 1; size <= 4; size += 1) {
      for (const run of runs) {
        const bytes = Uint8Array.from(run);
        const hex = Buffer.from(bytes).toString("hex");
        const spelled = oracle(bytes);
        const allEscaped = run.map(escape).join("");
        if (Buffer.from(readPathSegment(spelled) ?? []).toString("hex") !== hex) {
          differing.push(`${hex}: ${spelled} not read back`);
        }
        if ((readPathSegment(allEscaped) !== undefined) !== (allEscaped === spelled)) {
          differing.push(`${hex}: ${allEscaped} read against the oracle's ${spelled}`);
        }
      }
      if (size < 4) {
        runs = runs.flatMap((run) => trails.map((trail) => [...run, trail]));
      }
    }

    expect(differing).toEqual([]);
  });
});

describe("one component's spelling", () => {
  it.each([
    { given: "TabStrip", want: "TabStrip" },
    { given: "default", want: "default" },
    { given: "static", want: "static" },
    { given: "größe", want: "größe" },
    { given: "$dollar", want: "$dollar" },
    { given: "#frame", want: "'#frame'" },
    { given: "content-type", want: "'content-type'" },
    { given: "it's", want: "'it\\'s'" },
    { given: "back\\slash", want: "'back\\\\slash'" },
    { given: "1.5", want: "'1.5'" },
    { given: "", want: "''" },
    { given: "#", want: "'#'" },
    { given: "a\u0300", want: "a\u0300" },
    { given: "ℕ", want: "ℕ" },
    { given: "a\u200Cb", want: "a\u200Cb" },
    { given: "a€b", want: "'a€b'" },
    { given: "·a", want: "'·a'" },
    { given: "a©", want: "'a©'" },
    { given: "\u{1F600}", want: "'\u{1F600}'" },
    { given: "a\u200Bb", want: "'a\u200Bb'" },
    { given: "a\u00ADb", want: "'a\u00ADb'" },
    { given: "a\u2060b", want: "'a\u2060b'" },
    { given: "\u0300a", want: "'\u0300a'" },
    { given: "#a€b", want: "'#a€b'" },
  ])("spells $given as $want", ({ given, want }) => {
    expect(nameComponent(given)).toBe(want);
    expect(isRef(`ts://./src/a.ts#Headers.${nameComponent(given)}`)).toBe(true);
  });

  it.each([
    { given: "t\tb", want: "'t\tb'" },
    { given: "l\nm", want: "'l\\nm'" },
    { given: "c\rr", want: "'c\\rr'" },
    { given: "\uFFFD", want: "'\uFFFD'" },
    { given: "\u{1F600}", want: "'\u{1F600}'" },
    { given: "a\u00A0b", want: "'a\u00A0b'" },
    { given: "a\u200Db", want: "a\u200Db" },
    { given: "a b", want: "'a b'" },
    { given: "\uD800", want: "'\\u{D800}'" },
    { given: "a\uDC00", want: "'a\\u{DC00}'" },
    { given: "\uDC00\uD800", want: "'\\u{DC00}\\u{D800}'" },
    { given: "a\u0000b", want: "'a\\u{0}b'" },
    { given: "\u001b[31mX", want: "'\\u{1B}[31mX'" },
    { given: "v\u000Bw", want: "'v\\u{B}w'" },
    { given: "f\u000Cg", want: "'f\\u{C}g'" },
    { given: "\u007F", want: "'\\u{7F}'" },
    { given: "n\u0085l", want: "'n\\u{85}l'" },
    { given: "c\u009Bd", want: "'c\\u{9B}d'" },
    { given: "safe\u202E.exe", want: "'safe\\u{202E}.exe'" },
    { given: "x\u2028y\u2029z", want: "'x\\u{2028}y\\u{2029}z'" },
    {
      given: "\u061C\u200E\u200F\u2066\u2069",
      want: "'\\u{61C}\\u{200E}\\u{200F}\\u{2066}\\u{2069}'",
    },
    { given: "\\u{41}", want: "'\\\\u{41}'" },
  ])(
    "spells the key $given as $want, a reference with no raw character of the unsafe set but a tab",
    ({ given, want }) => {
      expect(nameComponent(given)).toBe(want);
      const ref = `ts://./src/a.ts#Headers.${nameComponent(given)}`;
      expect(isRef(ref)).toBe(true);
      expect(
        [...ref].some((character) => character !== "\t" && isUnsafe(character.codePointAt(0) ?? 0)),
      ).toBe(false);
    },
  );

  it("refuses a string holding a lone surrogate, which no UTF-8 document carries", () => {
    expect(isRef("ts://./src/a.ts#Box.'\uD800'")).toBe(false);
    expect(isRef("ts://./src/a.ts#Box.'\uFFFD'")).toBe(true);
    expect(isRef("ts://./src/a.ts#Box.'\\u{D800}'")).toBe(true);
  });

  it("refuses a raw character of the unsafe set and an escape the writer never writes", () => {
    for (const fragment of [
      "'safe\u202E.exe'",
      "'x\u2028y'",
      "'\\u{1b}'",
      "'\\u{01B}'",
      "'\\u{41}'",
      "'\\u{9}'",
      "'\\u{A}'",
      "'\\u{D}'",
    ]) {
      expect(isRef(`ts://./src/a.ts#Box.${fragment}`), fragment).toBe(false);
    }
  });

  it("spells a private name with its number sign and a key of the same text quoted", () => {
    expect(spell({ text: "#frame", kind: "private" })).toBe("#frame");
    expect(spell({ text: "#frame", kind: "key" })).toBe("'#frame'");
    expect(spell({ text: "frame", kind: "key" })).toBe("frame");
    expect(spell({ text: "Symbol.iterator", kind: "computed" })).toBe("[Symbol.iterator]");
  });

  it("spells a name of 16 Mi characters, bare or quoted, on a flat stack", () => {
    const long = "a".repeat(16 << 20);

    expect(nameComponent(long)).toBe(long);
    expect(nameComponent(`${long}€`)).toBe(`'${long}€'`);
  });

  it("writes a name bare exactly when it is an ECMAScript IdentifierName", () => {
    const identifierName = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u;
    const differing: string[] = [];
    for (let point = 0; point <= 0x10ffff; point += 1) {
      if (point >= 0xd800 && point <= 0xdfff) {
        continue;
      }
      const character = String.fromCodePoint(point);
      for (const name of [character, `a${character}`]) {
        if ((nameComponent(name) === name) !== identifierName.test(name)) {
          differing.push(point.toString(16));
        }
      }
    }
    expect(differing).toEqual([]);
  });

  it("drops every ASCII whitespace character from a computed key", () => {
    expect(computedComponent("Symbol . iterator")).toBe("[Symbol.iterator]");
    expect(computedComponent("globalThis\t.\nSymbol.iterator")).toBe(
      "[globalThis.Symbol.iterator]",
    );
  });

  it.each([
    "\u0085",
    "\u00a0",
    "\u1680",
    "\u2000",
    "\u200a",
    "\u2028",
    "\u2029",
    "\u202f",
    "\u205f",
    "\u3000",
    "\ufeff",
  ])("drops %j, whitespace past ASCII, from a computed key", (space) => {
    expect(computedComponent(`Symbol.${space}iterator${space}`)).toBe("[Symbol.iterator]");
  });

  it.each(["\u200b", "\u00a1", "\u2027"])(
    "keeps %j, which is no whitespace, in a computed key",
    (kept) => {
      expect(computedComponent(`a${kept}b`)).toBe(`[a${kept}b]`);
    },
  );

  it("keeps two spellings of one key apart, because they are two declarations", () => {
    expect(computedComponent("Symbol.iterator")).not.toBe(
      computedComponent("globalThis.Symbol.iterator"),
    );
  });
});
