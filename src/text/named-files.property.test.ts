import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { spelledFiles } from "./named-files.ts";

/** The files of the package a drawn text spells one of. */
const FILES = ["/pkg/a.ts", "/pkg/lib/index.mjs", "/pkg/src/b c.cts", "/pkg/src/deep/x.y.tsx"];

/** Text a drawn spelling stands between: shell syntax, launcher options and other words. */
const AROUND = [
  "",
  " ",
  "node ",
  "--inject:",
  "-r",
  "$(pwd)/",
  '"',
  "'",
  "\\",
  "=",
  "x",
  "@",
  "&&",
];

/**
 * Every spelling of `file` below `/pkg` the rule names it by: relative to the package, with or
 * without `./`, with `/` or `\` between names, with or without its extension, and for an index
 * file without its `/index` part, or `.` for the package's own.
 */
function spellingsOf(file: string): readonly string[] {
  const relative = file.slice("/pkg/".length);
  const bare = relative.replace(/\.[cm]?[jt]sx?$/u, "");
  const forms = [relative, bare];
  if (bare.endsWith("index")) {
    forms.push(bare === "index" ? "." : bare.slice(0, -"/index".length));
  }
  return forms
    .flatMap((form) => [form, `./${form}`])
    .flatMap((form) => [form, form.replaceAll("/", "\\")]);
}

describe("spelledFiles", () => {
  it("names every file one of whose spellings stands anywhere in the text", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FILES),
        fc.nat(),
        fc.constantFrom(...AROUND),
        fc.constantFrom(...AROUND),
        (file, pick, before, after) => {
          const spellings = spellingsOf(file);
          const text = `${before}${spellings[pick % spellings.length]!}${after}`;

          expect(
            spelledFiles(
              text,
              "/pkg",
              FILES.map((one) => ({ file: one, paths: [one] })),
            ),
            text,
          ).toContain(file);
        },
      ),
      { numRuns: 2000 },
    );
  });
});
