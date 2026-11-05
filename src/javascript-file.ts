import { LANGUAGE_ROWS } from "./contract/contract.generated.ts";
import { globExpression } from "./text/glob.ts";

export const JAVASCRIPT_FILE = /\.(?:js|jsx|mjs|cjs)$/u;

/** The patterns the TypeScript row of `languages.json` skips files by, each matched against a name alone. */
const MINIFIED_NAMES = LANGUAGE_ROWS.ts.skippedFiles.map((pattern) => ({
  pattern,
  expression: globExpression(pattern),
}));
const MINIFIED_BYTES = 10_240;
const MINIFIED_LINE = 500;

/** What a minified file is decided by where its text is not read. */
const LONG_LINES = "long lines";

/** The skipped-file pattern one file's name matches, which decides it minified without its text. */
export function minifiedByName(fileName: string): string | undefined {
  const name = fileName.slice(fileName.lastIndexOf("/") + 1);
  return MINIFIED_NAMES.find((one) => one.expression.test(name))?.pattern;
}

/**
 * What decides one JavaScript file minified: the skipped-file pattern its name matches, or
 * {@link LONG_LINES} for a text of the size whose mean line is longer than the limit;
 * undefined for a file that is not minified.
 */
export function minifiedBy(fileName: string, text: string): string | undefined {
  if (!JAVASCRIPT_FILE.test(fileName)) {
    return undefined;
  }
  const named = minifiedByName(fileName);
  if (named !== undefined) {
    return named;
  }
  // A UTF-16 unit encodes to at most three UTF-8 bytes, so a shorter text is below the size.
  if (text.length * 3 < MINIFIED_BYTES) {
    return undefined;
  }
  const lines = text.split(/\r?\n/u).length;
  return utf8Bytes(text) >= MINIFIED_BYTES && text.length / lines > MINIFIED_LINE
    ? LONG_LINES
    : undefined;
}

/** The length of a text in UTF-8, a lone surrogate counting as the three bytes of U+FFFD. */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}
