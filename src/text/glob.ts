/**
 * Glob patterns over paths in two forms. The configured form (the configuration, convention
 * rows, bundler entries, workspace member patterns) has `*` and `?` within a segment, `**`
 * across segments and brace lists. A `.gitignore` line has git's form: bracket expressions
 * and backslash escapes, no brace lists (https://git-scm.com/docs/gitignore#_pattern_format).
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

// The bound `analysis.2` sets on one glob's length in code points and on its brace expansions.
const GLOB_MAX_CHARACTERS = 1024;
const GLOB_MAX_EXPANSIONS = 256;

/** Why one glob is past the bound of `analysis.2`, or undefined where it is within it. */
export function globOverBound(pattern: string): string | undefined {
  return (
    lengthOverBound(pattern) ??
    (expansions(pattern, new Map()) > GLOB_MAX_EXPANSIONS
      ? `its brace lists expand it to more than ${String(GLOB_MAX_EXPANSIONS)} globs`
      : undefined)
  );
}

/** Why a pattern is longer than `analysis.2` allows, counted in code points. */
function lengthOverBound(pattern: string): string | undefined {
  let characters = 0;
  for (let at = 0; at < pattern.length; at += (pattern.codePointAt(at) ?? 0) > 0xffff ? 2 : 1) {
    characters += 1;
  }
  return characters > GLOB_MAX_CHARACTERS
    ? `holds ${String(characters)} characters, past the bound of ${String(GLOB_MAX_CHARACTERS)}`
    : undefined;
}

/** How many globs `expanded` writes for a pattern, counted without writing them up to the bound. */
function expansions(pattern: string, counted: Map<string, number>): number {
  const held = counted.get(pattern);
  if (held !== undefined) {
    return held;
  }
  const open = pattern.indexOf("{");
  const close = open < 0 ? -1 : pattern.indexOf("}", open);
  if (close < 0) {
    return 1;
  }
  const after = pattern.slice(close + 1);
  let total = 0;
  for (const member of pattern.slice(open + 1, close).split(",")) {
    total += member.includes("{")
      ? expansions(member + after, counted)
      : expansions(after, counted);
    if (total > GLOB_MAX_EXPANSIONS) {
      break;
    }
  }
  counted.set(pattern, total);
  return total;
}

/**
 * A pattern with every brace list expanded into its alternatives; a lone `{` stands for itself.
 * `written` is the text its author wrote, before the caller rewrote it into `pattern`, and one
 * past the bound of `analysis.2` expands to none.
 */
export function braceExpanded(pattern: string, written = pattern): readonly string[] {
  // A directory a caller put in is read as glob text, so its brace lists could expand the
  // pattern past what was written: past the bound it expands to none, never without limit.
  return globOverBound(written) === undefined &&
    expansions(pattern, new Map()) <= GLOB_MAX_EXPANSIONS
    ? expanded(pattern)
    : [];
}

function expanded(pattern: string): readonly string[] {
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
    .flatMap((member) => expanded(before + member + after));
}

/** A compiled glob: whether it matches one path. */
export interface Glob {
  test(path: string): boolean;
}

/**
 * The matcher one whole-path pattern of the configured form denotes, and one matching no
 * path, not even the empty one, past the bound of `analysis.2`.
 */
export function globExpression(pattern: string): Glob {
  return compiled(pattern, pattern, "u");
}

/** The matcher of {@link globExpression} with case not compared. */
export function caselessGlobExpression(pattern: string): Glob {
  return compiled(pattern, pattern, "iu");
}

/**
 * The matcher of a glob the caller rewrote before it is compiled, by putting a `**` segment,
 * a directory or a `<rootDir>` path in it: `written` is the text its author wrote, which the
 * bound of `analysis.2` measures, and `pattern` the rewritten glob, which is compiled.
 */
export function rewrittenGlobExpression(written: string, pattern: string, caseless = false): Glob {
  return compiled(written, pattern, caseless ? "iu" : "u");
}

/** What a glob past the bound matches: no path. */
const NEVER: Glob = { test: () => false };

/**
 * Past this much source the expansions compile one expression each rather than one joined
 * expression: V8 refuses one of about 32,000 characters as too large.
 */
const JOINED_MAX = 16_384;

function compiled(written: string, pattern: string, flags: string): Glob {
  const sources = braceExpanded(pattern, written).map((one) => source(one, "configured"));
  const joined =
    sources.length > 0 && sources.reduce((total, one) => total + one.length + 1, 0) <= JOINED_MAX
      ? compiledNow(`^(?:${sources.join("|")})$`, flags)
      : undefined;
  if (joined !== undefined) {
    return joined;
  }
  const alternatives = sources.flatMap((one) => compiledNow(`^${one}$`, flags) ?? []);
  return alternatives.length === 0
    ? NEVER
    : { test: (path) => alternatives.some((one) => one.test(path)) };
}

/**
 * One regular expression compiled before it is used, and undefined where its source is not one
 * or V8 refuses it as too large. V8 compiles at the first match, apart for a Latin-1 subject and
 * a wider one, so a match of each here moves either refusal to construction. Within the bound of
 * `analysis.2` only a directory a caller puts in makes one that large, longer than any path the
 * host names (PATH_MAX, 4,096 bytes on Linux), so a caller reads it as matching no path.
 */
export function compiledNow(text: string, flags: string): RegExp | undefined {
  try {
    const expression = new RegExp(text, flags);
    expression.test("");
    expression.test("\u0100");
    return expression;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * The expression one `.gitignore` pattern denotes over a path below its file's directory.
 * `line` is the line the file writes, less the trailing spaces git ignores, which the bound
 * of `analysis.2` measures, and one past it matches nothing, as does one V8 cannot hold.
 * Git's form has no brace lists, so its braces count toward no expansion.
 */
export function gitignoreExpression(line: string, pattern: string): RegExp {
  return (
    (lengthOverBound(line) === undefined
      ? compiledNow(`^${source(pattern, "gitignore")}$`, "u")
      : undefined) ?? new RegExp(NOTHING, "u")
  );
}

const SEGMENTS = new Map<string, Glob>();

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
