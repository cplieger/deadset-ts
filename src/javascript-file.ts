export const JAVASCRIPT_FILE = /\.(?:js|jsx|mjs|cjs)$/u;

/** A minified file by its name; any other is one by its size and its mean line length. */
const MINIFIED_NAME = /\.min\.(?:js|mjs|cjs)$/u;
const MINIFIED_BYTES = 10_240;
const MINIFIED_LINE = 500;

/** Whether one name is a minified file's, which decides it without its text. */
export function minifiedByName(fileName: string): boolean {
  return MINIFIED_NAME.test(fileName);
}

/** Whether one JavaScript file is minified: by its name, or by its text's size and mean line length. */
export function minified(fileName: string, text: string): boolean {
  if (!JAVASCRIPT_FILE.test(fileName)) {
    return false;
  }
  if (minifiedByName(fileName)) {
    return true;
  }
  // A UTF-16 unit encodes to at most three UTF-8 bytes, so a shorter text is below the size.
  if (text.length * 3 < MINIFIED_BYTES) {
    return false;
  }
  const lines = text.split(/\r?\n/u).length;
  return (
    new TextEncoder().encode(text).byteLength >= MINIFIED_BYTES &&
    text.length / lines > MINIFIED_LINE
  );
}
