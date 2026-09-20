import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contractDocument, fixture } from "../__test-helpers__/fixtures.ts";
import {
  computedComponent,
  isRef,
  nameComponent,
  REF_EXPRESSIONS,
  renderRef,
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
  return { text, computed: false };
}

function computed(text: string): Component {
  return { text, computed: true };
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

/**
 * One row per accepted TypeScript case of the published corpus: the parts a symbol
 * of that form is rendered from, and the token the corpus carries. Rendering the
 * parts must reproduce the token byte for byte, which is what makes a reference
 * written by hand into an ignore entry match one this analyzer emits.
 */
const RENDERED: readonly { module: Module; fragment: Fragment; input: string }[] = [
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
    fragment: declaration([name("TabStrip"), name("#frame")]),
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
    module: { package: "@example/app", path: "src/layout.ts" },
    fragment: declaration([name("Layout"), name("gap")]),
    input: "ts://@example/app/src/layout.ts#Layout.gap",
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
];

describe("the reference grammar", () => {
  it("is the set of expressions the pinned grammar page publishes for this language", () => {
    expect([...REF_EXPRESSIONS].sort()).toEqual(publishedExpressions("ts").sort());
  });

  it("publishes one expression per form group the page names, and no other", () => {
    expect(REF_EXPRESSIONS.length).toBe(publishedExpressions("ts").length);
    expect(publishedExpressions("go").length, "the page also fixes the other language").toBe(7);
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

  it("names both languages the Contract's issue-kind vocabulary does", () => {
    const languages = contractDocument("kinds.json")["languages"] as string[];

    expect(languages).toEqual(["go", "ts"]);
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

  it("renders every accepted token of the corpus, each once", () => {
    const rendered = new Set(RENDERED.map((row) => row.input));
    const accepted = corpus()
      .filter((token) => token.language === "ts" && token.accepted)
      .map((token) => token.input);

    expect([...rendered].sort()).toEqual([...accepted].sort());
  });
});

describe("one component's spelling", () => {
  it.each([
    { given: "TabStrip", want: "TabStrip" },
    { given: "default", want: "default" },
    { given: "static", want: "static" },
    { given: "größe", want: "größe" },
    { given: "$dollar", want: "$dollar" },
    { given: "#frame", want: "#frame" },
    { given: "content-type", want: "'content-type'" },
    { given: "it's", want: "'it\\'s'" },
    { given: "back\\slash", want: "'back\\\\slash'" },
    { given: "1.5", want: "'1.5'" },
    { given: "", want: "''" },
  ])("spells $given as $want", ({ given, want }) => {
    expect(nameComponent(given)).toBe(want);
  });

  it("drops every ASCII whitespace character from a computed key", () => {
    expect(computedComponent("Symbol . iterator")).toBe("[Symbol.iterator]");
    expect(computedComponent("globalThis\t.\nSymbol.iterator")).toBe(
      "[globalThis.Symbol.iterator]",
    );
  });

  it("keeps two spellings of one key apart, because they are two declarations", () => {
    expect(computedComponent("Symbol.iterator")).not.toBe(
      computedComponent("globalThis.Symbol.iterator"),
    );
  });
});
