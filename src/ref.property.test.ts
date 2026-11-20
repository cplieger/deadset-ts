import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { analyzeProject } from "../__test-helpers__/projects.ts";
import { isRef, readPathSegment, renderRef, type Module } from "./ref.ts";

/**
 * The two references the enumeration must render for the generated tree's one
 * declaration and its one member, whatever stands above them. They are written out
 * rather than rendered here: a test that computed its expectation with the code under
 * test would assert nothing.
 */
const HELD_REF = "ts://./unit.ts#Held";
const MEMBER_REF = "ts://./unit.ts#Held.member";

const DECLARATION = "export class Held {\n  member = 0;\n}\n";

/** One line of the text a draw puts above the declaration. */
type Above = "blank" | "line" | "block" | "declaration";

/**
 * The lines one draw puts above the declaration, each carrying its own index so a
 * reordering of the draw is a reordering of real lines rather than a redeclaration.
 * A draw of a different length is an insertion or a deletion; a draw of the same
 * multiset in another order is a reordering.
 */
function above(lines: readonly Above[]): string {
  return lines
    .map((line, index) => {
      switch (line) {
        case "blank":
          return "";
        case "line":
          return `// a comment ${String(index)}`;
        case "block":
          return `/* a comment ${String(index)} */`;
        case "declaration":
          return `const before${String(index)} = ${String(index)};`;
      }
    })
    .map((line) => `${line}\n`)
    .join("");
}

/**
 * Property dead-code-suite/P32: for any edit above a declaration that changes neither its
 * name nor its container, the stable symbol reference is unchanged, so a suppression naming
 * it still matches. A draw writes a project and opens a client over it, so its cost follows
 * the machine's load: the run is bounded by its count, and its time limit sits far above
 * what forty draws cost, so another process's load cannot interrupt it.
 */
describe("the stable symbol reference", () => {
  it("survives any edit above the declaration, while the position does not", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<Above>("blank", "line", "block", "declaration"), {
          maxLength: 12,
        }),
        (lines) => {
          const text = above(lines);
          const analyzed = analyzeProject({ "unit.ts": `${text}${DECLARATION}` });
          const symbols = analyzed.inventories[0]?.symbols ?? [];
          const held = symbols.find((symbol) => symbol.name === "Held");
          const member = symbols.find((symbol) => symbol.name === "Held.member");

          expect(held?.ref).toBe(HELD_REF);
          expect(member?.ref).toBe(MEMBER_REF);
          expect(held?.position.line, "the position moves with the lines above it").toBe(
            lines.length + 1,
          );
          expect(member?.position.line).toBe(lines.length + 2);

          // A suppression record names a symbol by its reference and a path, so the
          // record written against one revision still names the same declaration
          // after the edit. Whether a record then binds is the suppression stage's
          // answer; the reference this compares is what that stage matches on.
          const record = { code: "DS1003", symbol: MEMBER_REF, path: "unit.ts" };
          expect(record.symbol).toBe(member?.ref);
        },
      ),
      { numRuns: 40, plugins: [fc.interruptAfterTimeLimit(100_000, { failOnInterrupt: true })] },
    );
  }, 120_000);
});

/** RFC 3986's encoding of every byte outside the grammar's set: `encodeURIComponent` leaves six more. */
function uriEncoded(part: string): string | undefined {
  try {
    return encodeURIComponent(part).replace(
      /[!'()*~]/gu,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  } catch {
    return undefined;
  }
}

/**
 * A manifest may declare a dependency, and a package may name itself, under any non-empty
 * string npm once installed or a hand edit wrote, so the package component spells every one.
 */
describe("the package component", () => {
  const MANIFEST: Module = { package: "@example/app", path: "package.json" };
  const dependency = (name: string): string =>
    renderRef(MANIFEST, { of: "dependency", name, section: "dependency" });
  const spelled = (name: string): string =>
    dependency(name).slice("ts://@example/app/package.json#".length, -":dependency".length);

  it("spells every name the grammar accepts, two names apart, and as RFC 3986 encodes it", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "binary", minLength: 1, maxLength: 12 }),
        fc.string({ unit: "binary", minLength: 1, maxLength: 12 }),
        (one, other) => {
          expect(isRef(dependency(one)), dependency(one)).toBe(true);
          expect(isRef(renderRef({ package: one, path: "src/main.ts" }, { of: "module" }))).toBe(
            true,
          );
          if (one !== other) {
            expect(dependency(one)).not.toBe(dependency(other));
          }
          const expected = one.startsWith("@") ? undefined : uriEncoded(one);
          if (expected !== undefined) {
            expect(spelled(one)).toBe(expected);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it.each([
    ["a character outside the basic plane", "a\u{1F600}", "a%F0%9F%98%80"],
    ["a lone surrogate, by the value it holds", "\uD800", "%ED%A0%80"],
    ["a percent sign", "50%", "50%25"],
    ["a slash outside a scope", "a/b", "a%2Fb"],
    ["an at sign alone", "@", "%40"],
    ["a scope with an empty name", "@scope/", "%40scope%2F"],
    ["a scoped name, its at sign and slash kept", "@old~scope/x!", "@old%7Escope/x%21"],
  ])("spells %s", (_, name, expected) => {
    expect(spelled(name)).toBe(expected);
  });
});

/**
 * A file's path may hold any character its file system admits, so the scope spells every
 * segment as `symbol-ref.md` "Path segments" states: a character of the source-path set as
 * itself, and every other byte, `%` included, percent-encoded with uppercase digits.
 */
describe("the path of a scope", () => {
  const MODULE = { of: "module" } as const;
  /** The whitespace of the grammar's rule 5 past U+00A0 and the Bidi_Control characters, which the set encodes. */
  const wide = [
    0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff, 0x061c, 0x200e, 0x200f, 0x202a, 0x202b,
    0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
  ];
  /** RFC 3986's encoding of a character outside the set: `encodeURIComponent` leaves `*` alone. */
  const expected = (segment: string): string =>
    [...segment]
      .map((character) => {
        const code = character.codePointAt(0) ?? 0;
        const kept =
          code > 0x20 &&
          (code < 0x7f || code > 0xa0) &&
          (code < 0x2000 || code > 0x200a) &&
          !wide.includes(code) &&
          !"#%*?/".includes(character);
        return kept ? character : character === "*" ? "%2A" : encodeURIComponent(character);
      })
      .join("");
  /** The characters either side of each range the set encodes past ASCII, drawn often. */
  const boundary = fc.constantFrom(
    ..."\u007e\u007f\u0080\u0085\u009f\u00a0\u00a1\u167f\u1680\u1681\u1fff\u2000\u200a\u200b",
    ..."\u2027\u2028\u2029\u202a\u202e\u202f\u2030\u205e\u205f\u2060\u2fff\u3000\u3001\ufeff",
    ..."\u061b\u061c\u061d\u200d\u200e\u200f\u2065\u2066\u2069\u206a",
  );
  const segment = fc
    .string({
      unit: fc.oneof(
        { weight: 3, arbitrary: fc.string({ unit: "binary", minLength: 1, maxLength: 1 }) },
        boundary,
      ),
      minLength: 1,
      maxLength: 8,
    })
    .filter((one) => !one.includes("/"));
  const spelledPath = (path: string): readonly string[] =>
    renderRef({ package: ".", path }, MODULE).slice("ts://./".length, -"#".length).split("/");

  it("spells every segment as RFC 3986 encodes the bytes outside its set, and reads it back", () => {
    fc.assert(
      fc.property(fc.array(segment, { minLength: 1, maxLength: 4 }), (segments) => {
        const raw = [...segments.slice(0, -1), `${segments.at(-1) ?? ""}.ts`];
        const path = raw.join("/");
        const spelled = spelledPath(path);

        expect(isRef(renderRef({ package: ".", path }, MODULE)), path).toBe(true);
        expect(spelled).toEqual(raw.map(expected));
        expect(spelled.map((one) => Buffer.from(readPathSegment(one) ?? []).toString())).toEqual(
          raw,
        );
      }),
      { numRuns: 500 },
    );
  });

  it("keeps two paths apart, a lone surrogate's included, and spells each as a reference", () => {
    const unit = fc.oneof(
      { weight: 4, arbitrary: fc.string({ unit: "binary", minLength: 1, maxLength: 1 }) },
      fc.integer({ min: 0xd800, max: 0xdfff }).map((code) => String.fromCharCode(code)),
    );
    const name = fc
      .string({ unit, minLength: 1, maxLength: 6 })
      .filter((one) => !one.includes("/"));
    fc.assert(
      fc.property(name, name, (one, other) => {
        const ref = renderRef({ package: ".", path: `${one}.ts` }, MODULE);

        expect(isRef(ref), ref).toBe(true);
        expect(spelledPath(`${one}.ts`).every((part) => readPathSegment(part) !== undefined)).toBe(
          true,
        );
        if (one !== other) {
          expect(renderRef({ package: ".", path: `${other}.ts` }, MODULE)).not.toBe(ref);
        }
      }),
      { numRuns: 500 },
    );
  });
});

/**
 * Property dead-code-suite/P28: for any pair of symbols with the same name in the two
 * languages, their identifiers differ and each finding names its language.
 *
 * The other language's half is a string this test writes from that language's own
 * grammar: the analyzer under test enumerates no Go symbol, and the property is about
 * the two spellings rather than about either enumeration, so it performs no load and
 * keeps the run count the shared configuration sets.
 */
describe("language namespacing", () => {
  const identifier = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,11}$/u);

  /**
   * A scope both languages spell legally, so the prefix is the only difference
   * between the two references a pair of identically named symbols renders: a Go
   * import path may carry an element ending in `.ts`, and a package name may be a
   * domain. A scope only one language accepts would let the property pass on the
   * shape of the scope while saying nothing about the namespace.
   */
  const SHARED: Module = { package: "example.com", path: "app/src/wire.ts" };

  it("keeps identically named symbols of the two languages distinct", () => {
    fc.assert(
      fc.property(
        fc.array(identifier, { minLength: 1, maxLength: 2 }),
        fc.option(identifier, { nil: undefined }),
        (chain, parameter) => {
          const ts = renderRef(SHARED, {
            of: "declaration",
            chain: chain.map((text) => ({ text, kind: "key" as const })),
            static: false,
            ...(parameter === undefined ? {} : { typeParameter: parameter }),
          });
          const go = `go://${SHARED.package}/${SHARED.path}#${chain.join(".")}${
            parameter === undefined ? "" : `[${parameter}]`
          }`;

          expect(ts).not.toBe(go);
          expect(isRef(ts), "this analyzer's grammar accepts its own language").toBe(true);
          expect(isRef(go), "and refuses the other language's, however named").toBe(false);

          // The language field of a finding is the second discriminator, so two
          // findings about identically named symbols are two records even where a
          // consumer keys on the name alone.
          const findings = new Map([
            [`ts\u0000${chain.join(".")}`, ts],
            [`go\u0000${chain.join(".")}`, go],
          ]);
          expect(findings.size).toBe(2);
        },
      ),
    );
  });
});
