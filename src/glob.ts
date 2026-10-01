/**
 * Glob patterns over the paths of the target's own files, as the configuration
 * writes them. Both `ts.test_files` and `ts.entry_files` name files this way, and
 * one grammar answers for both.
 *
 * A configured root is not written in this grammar. It names a symbol reference
 * rather than a path, `*` there spans the solidus and a brace list means nothing,
 * so that rule is written where it is read.
 */

/**
 * One literal run of a pattern, with every character the expression syntax claims
 * escaped.
 *
 * The set is the syntax characters and the solidus, and it is closed: an escape of any
 * other character is refused outright by the expression syntax under the unicode flag,
 * so escaping a hyphen, which needs none outside a character class, would refuse every
 * pattern that names a hyphenated path.
 */
function quoted(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\/]/gu, (character) => `\\${character}`);
}

/**
 * The expression one glob pattern denotes. `**` spans path separators while `*` and `?`
 * do not, a brace list is an alternation of its members, and every other character
 * stands for itself.
 */
export function globExpression(pattern: string): RegExp {
  let source = "^";
  let at = 0;
  while (at < pattern.length) {
    const rest = pattern.slice(at);
    if (rest.startsWith("**/")) {
      source += "(?:[^/]*/)*";
      at += 3;
      continue;
    }
    if (rest.startsWith("**")) {
      source += ".*";
      at += 2;
      continue;
    }
    const character = pattern[at] ?? "";
    at += 1;
    if (character === "*") {
      source += "[^/]*";
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    if (character === "{") {
      const close = pattern.indexOf("}", at);
      if (close < 0) {
        source += "\\{";
        continue;
      }
      source += `(?:${pattern.slice(at, close).split(",").map(quoted).join("|")})`;
      at = close + 1;
      continue;
    }
    source += quoted(character);
  }
  return new RegExp(`${source}$`, "u");
}
