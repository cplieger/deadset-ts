/**
 * Glob patterns over paths in two forms. The configured form (the configuration, convention
 * rows, bundler entries, workspace member patterns) has `*` and `?` within a segment, `**`
 * across segments and brace lists. A `.gitignore` line has git's form: bracket expressions
 * and backslash escapes, no brace lists (https://git-scm.com/docs/gitignore#_pattern_format).
 * A configured root is not a glob: it names a symbol reference, and is read where it is used.
 */

type GlobForm = "configured" | "gitignore";

/**
 * One character of a pattern as the expression syntax reads it literally. The set escaped
 * is closed: under the unicode flag an escape of any other character is refused outright.
 */
function quoted(character: string): string {
  return /[.*+?^${}()|[\]\\/]/u.test(character) ? `\\${character}` : character;
}

/**
 * The ASCII ranges each POSIX class a bracket expression may name holds, as git's own
 * character table reads them, each range written as its first and last character.
 */
const CLASSES: ReadonlyMap<string, string> = new Map([
  ["alnum", "09AZaz"],
  ["alpha", "AZaz"],
  ["blank", "\t\t  "],
  ["cntrl", "\0\x1f\x7f\x7f"],
  ["digit", "09"],
  ["graph", "!~"],
  ["lower", "az"],
  ["print", " ~"],
  ["punct", "!/:@[`{~"],
  ["space", "\t\n\r\r  "],
  ["upper", "AZ"],
  ["xdigit", "09AFaf"],
]);

/** What a pattern git cannot read matches: nothing, as git aborts the whole match. */
const NOTHING = "(?!)";

/** One code point as a member of an expression class. */
function member(point: number): string {
  return `\\u{${point.toString(16)}}`;
}

/**
 * The class a bracket expression opening at `open` denotes, and the index past its `]`,
 * read as git's wildmatch reads it: a leading `!` or `^` negates it, a `]` first is a
 * member, `\` escapes one character, `x-y` is a range (one whose `y` is below `x` holds
 * `x` alone) and `[:name:]` a POSIX class. An unclosed bracket or an unknown class name
 * matches nothing. Neither form matches the solidus.
 */
function bracket(pattern: string, open: number): { source: string; end: number } {
  let at = open + 1;
  const negated = pattern[at] === "!" || pattern[at] === "^";
  if (negated) {
    at += 1;
  }
  const next = (): number | undefined => {
    const point = pattern.codePointAt(at);
    at += point !== undefined && point > 0xffff ? 2 : 1;
    return point;
  };
  let members = "";
  let low: number | undefined;
  for (let first = true; ; first = false) {
    let point = next();
    if (point === undefined) {
      return { source: NOTHING, end: pattern.length };
    }
    if (point === 0x5d && !first) {
      return { source: negated ? `[^/${members}]` : `(?!/)[${members}]`, end: at };
    }
    if (point === 0x2d && low !== undefined && at < pattern.length && pattern[at] !== "]") {
      let high = next();
      if (high === 0x5c) {
        high = next();
      }
      if (high === undefined) {
        return { source: NOTHING, end: pattern.length };
      }
      members += high >= low ? `${member(low)}-${member(high)}` : "";
      low = undefined;
      continue;
    }
    if (point === 0x5b && pattern[at] === ":") {
      const close = pattern.indexOf("]", at + 1);
      if (close < 0) {
        return { source: NOTHING, end: pattern.length };
      }
      if (close > at + 1 && pattern[close - 1] === ":") {
        const ranges = CLASSES.get(pattern.slice(at + 1, close - 1));
        if (ranges === undefined) {
          return { source: NOTHING, end: pattern.length };
        }
        for (let one = 0; one < ranges.length; one += 2) {
          members += `${member(ranges.charCodeAt(one))}-${member(ranges.charCodeAt(one + 1))}`;
        }
        low = undefined;
        at = close + 1;
        continue;
      }
    }
    if (point === 0x5c) {
      point = next();
      if (point === undefined) {
        return { source: NOTHING, end: pattern.length };
      }
    }
    members += member(point);
    low = point;
  }
}

/** The expression source of one pattern with no brace list. */
function source(pattern: string, form: GlobForm): string {
  let text = "";
  let at = 0;
  while (at < pattern.length) {
    if (pattern.startsWith("**/", at)) {
      text += "(?:[^/]*/)*";
      at += 3;
      continue;
    }
    if (pattern.startsWith("**", at)) {
      text += ".*";
      at += 2;
      continue;
    }
    const character = pattern[at] ?? "";
    if (form === "gitignore" && character === "[") {
      const read = bracket(pattern, at);
      text += read.source;
      at = read.end;
      continue;
    }
    if (form === "gitignore" && character === "\\" && at + 1 < pattern.length) {
      text += quoted(pattern[at + 1] ?? "");
      at += 2;
      continue;
    }
    at += 1;
    text += character === "*" ? "[^/]*" : character === "?" ? "[^/]" : quoted(character);
  }
  return text;
}

/** A pattern with every brace list expanded into its alternatives; a lone `{` stands for itself. */
export function braceExpanded(pattern: string): readonly string[] {
  const open = pattern.indexOf("{");
  const close = open < 0 ? -1 : pattern.indexOf("}", open);
  if (close < 0) {
    return [pattern];
  }
  const before = pattern.slice(0, open);
  const after = pattern.slice(close + 1);
  return pattern
    .slice(open + 1, close)
    .split(",")
    .flatMap((member) => braceExpanded(before + member + after));
}

/** The expression one whole-path pattern of the configured form denotes. */
export function globExpression(pattern: string): RegExp {
  const alternatives = braceExpanded(pattern).map((one) => source(one, "configured"));
  return new RegExp(`^(?:${alternatives.join("|")})$`, "u");
}

/** The expression one `.gitignore` pattern denotes over a path below its file's directory. */
export function gitignoreExpression(pattern: string): RegExp {
  return new RegExp(`^${source(pattern, "gitignore")}$`, "u");
}

const SEGMENTS = new Map<string, RegExp>();

/**
 * Whether one directory name matches one segment of a workspace's member pattern, its brace
 * lists already expanded. Neither `*` nor `?` matches a leading dot, as npm's workspaces read
 * them: https://docs.npmjs.com/cli/using-npm/workspaces
 */
export function segmentMatches(segment: string, name: string): boolean {
  if (name.startsWith(".") && !segment.startsWith(".")) {
    return false;
  }
  let expression = SEGMENTS.get(segment);
  if (expression === undefined) {
    expression = globExpression(segment);
    SEGMENTS.set(segment, expression);
  }
  return expression.test(name);
}

/**
 * Whether one path's segments match a member pattern's, `**` standing for any run of segments
 * that starts with no dot.
 */
export function pathMatches(pattern: readonly string[], path: readonly string[]): boolean {
  const [head, ...rest] = pattern;
  if (head === undefined) {
    return path.length === 0;
  }
  if (head === "**") {
    return (
      pathMatches(rest, path) ||
      (path.length > 0 && !(path[0] ?? "").startsWith(".") && pathMatches(pattern, path.slice(1)))
    );
  }
  const [name, ...below] = path;
  return name !== undefined && segmentMatches(head, name) && pathMatches(rest, below);
}
