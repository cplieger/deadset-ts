import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { analyzeProject } from "../__test-helpers__/projects.ts";
import { isRef, renderRef, type Module } from "./ref.ts";

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
 * Property dead-code-suite/P32: for any edit above a declaration that changes
 * neither its name nor its container, the stable symbol reference is unchanged, so a
 * suppression naming it still matches.
 *
 * One iteration writes a project and opens a compiler client and a snapshot over it,
 * which measures 46 ms on an idle machine, alone and inside the suite alike (1.84 to
 * 1.91 s for the forty draws over five runs), and 105 ms on one loaded by other work.
 * The bound the shared configuration puts on a property is ten seconds and an
 * interrupt fails the run, so the run count is 40: two seconds measured here and
 * about 4.2 seconds at the loaded cost, which leaves that bound the margin a
 * four-core runner needs. The case's own timeout is raised above the bound so that
 * the property's interrupt is what reports a draw that grew too expensive, rather
 * than the case failing on its own clock. The tree changes per iteration, so one
 * session cannot serve several draws: a snapshot is never updated, which is what makes
 * a run's answer independent of the order it reads in.
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
      { numRuns: 40 },
    );
  }, 20_000);
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
            chain: chain.map((text) => ({ text, computed: false })),
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
