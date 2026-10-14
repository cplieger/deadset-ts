/**
 * The value of a YAML configuration document in the subset tool configurations write:
 * block mappings and sequences, flow mappings and sequences, and plain, single-quoted and
 * double-quoted scalars, with comments. A document using anything else, an anchor, an
 * alias, a tag, a block scalar, a complex key or a second document, has no value here,
 * as a JSON document that does not parse has none.
 */

/** One line of the document with its comment removed, by its indentation and its content. */
interface Line {
  readonly indent: number;
  readonly text: string;
}

/** A failure to read the document within the subset; it ends the whole reading. */
class Unsupported extends Error {}

/** The characters after which a quote opens a quoted scalar rather than standing in a plain one. */
const SCALAR_START = new Set(["", ":", "-", "[", "{", ","]);

/** The plain scalars YAML's core schema reads as something other than a string. */
const CORE: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ["true", true],
  ["True", true],
  ["TRUE", true],
  ["false", false],
  ["False", false],
  ["FALSE", false],
  ["null", null],
  ["Null", null],
  ["NULL", null],
  ["~", null],
  ["", null],
]);

const NUMBER = /^[-+]?(?:\d+|\d*\.\d+|\d+\.\d*)(?:[eE][-+]?\d+)?$/u;

/** The text of one line before its comment: a `#` at the line's start or after a blank, outside quotes. */
function withoutComment(line: string): string {
  let quote: string | undefined;
  let previous = "";
  for (let at = 0; at < line.length; at += 1) {
    const char = line.charAt(at);
    if (quote !== undefined) {
      if (quote === '"' && char === "\\") {
        at += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if ((char === "'" || char === '"') && SCALAR_START.has(previous)) {
      quote = char;
    } else if (char === "#" && (at === 0 || /\s/u.test(line.charAt(at - 1)))) {
      return line.slice(0, at);
    }
    if (!/\s/u.test(char)) {
      previous = char;
    }
  }
  return line;
}

/** The value one scalar's text denotes, quoted or plain. */
function scalar(text: string): unknown {
  const value = text.trim();
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new Unsupported();
    }
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new Unsupported();
    }
  }
  if (/^[&*!|>%@`?]/u.test(value) || value === "---" || value === "...") {
    throw new Unsupported();
  }
  if (/:(?:\s|$)/u.test(value)) {
    throw new Unsupported();
  }
  if (CORE.has(value)) {
    return CORE.get(value);
  }
  return NUMBER.test(value) ? Number(value) : value;
}

/** Reads one flow collection or flow scalar from `text` at `at`, answering the value and where it ends. */
function flow(text: string, start: number): { readonly value: unknown; readonly end: number } {
  let at = start;
  const skip = (): void => {
    while (at < text.length && /\s/u.test(text.charAt(at))) {
      at += 1;
    }
  };
  skip();
  const open = text.charAt(at);
  if (open === "[" || open === "{") {
    const close = open === "[" ? "]" : "}";
    const items: unknown[] = [];
    const object: Record<string, unknown> = {};
    at += 1;
    for (;;) {
      skip();
      if (text.charAt(at) === close) {
        return { value: open === "[" ? items : object, end: at + 1 };
      }
      const item = flow(text, at);
      at = item.end;
      skip();
      if (open === "{") {
        if (text.charAt(at) !== ":" || typeof item.value !== "string") {
          throw new Unsupported();
        }
        const held = flow(text, at + 1);
        object[item.value] = held.value;
        at = held.end;
        skip();
      } else {
        items.push(item.value);
      }
      if (text.charAt(at) === ",") {
        at += 1;
      } else if (text.charAt(at) !== close) {
        throw new Unsupported();
      }
    }
  }
  if (open === "'" || open === '"') {
    let end = at + 1;
    for (; end < text.length; end += 1) {
      const char = text.charAt(end);
      if (open === '"' && char === "\\") {
        end += 1;
      } else if (char === open && !(open === "'" && text.charAt(end + 1) === "'")) {
        break;
      } else if (char === open) {
        end += 1;
      }
    }
    if (end >= text.length) {
      throw new Unsupported();
    }
    return { value: scalar(text.slice(at, end + 1)), end: end + 1 };
  }
  let end = at;
  while (end < text.length && !",]}".includes(text.charAt(end))) {
    if (text.charAt(end) === ":" && /[\s,\]}]/u.test(text.charAt(end + 1) || " ")) {
      break;
    }
    end += 1;
  }
  return { value: scalar(text.slice(at, end)), end };
}

/** A value written on one or more lines of a block, read whole: a flow node, else one plain scalar. */
function flowValue(text: string): unknown {
  if (!/^["'[{]/u.test(text)) {
    return scalar(text);
  }
  const read = flow(text, 0);
  if (text.slice(read.end).trim() !== "") {
    throw new Unsupported();
  }
  return read.value;
}

/** The position of a mapping key's `:` in one line's content, or -1 where the content is no mapping entry. */
function keyEnd(text: string): number {
  let quote: string | undefined;
  for (let at = 0; at < text.length; at += 1) {
    const char = text.charAt(at);
    if (quote !== undefined) {
      if (quote === '"' && char === "\\") {
        at += 1;
      } else if (char === quote) {
        quote = undefined;
      }
    } else if (at === 0 && (char === "'" || char === '"')) {
      quote = char;
    } else if (char === "[" || char === "{") {
      return -1;
    } else if (char === ":" && (at + 1 === text.length || /\s/u.test(text.charAt(at + 1)))) {
      return at;
    }
  }
  return -1;
}

/** How many flow collections one text opens and leaves unclosed, quotes read through. */
function openCollections(text: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (let at = 0; at < text.length; at += 1) {
    const char = text.charAt(at);
    if (quote !== undefined) {
      if (quote === '"' && char === "\\") {
        at += 1;
      } else if (char === quote) {
        quote = undefined;
      }
    } else if (
      (char === "'" || char === '"') &&
      SCALAR_START.has(text.slice(0, at).trim().slice(-1))
    ) {
      quote = char;
    } else if (char === "[" || char === "{") {
      depth += 1;
    } else if (char === "]" || char === "}") {
      depth -= 1;
    }
  }
  return depth;
}

/** Whether one line's content is a block sequence item. */
function isItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

/** Reads the document's lines as one value. */
class Reader {
  private at = 0;
  private readonly lines: Line[];

  constructor(lines: Line[]) {
    this.lines = lines;
  }

  /** The whole document's value. */
  document(): unknown {
    const first = this.lines[0];
    if (first === undefined) {
      return null;
    }
    const value = this.block(first.indent);
    if (this.at < this.lines.length) {
      throw new Unsupported();
    }
    return value;
  }

  /** The block node whose first line is the next one, at `indent`. */
  private block(indent: number): unknown {
    const line = this.lines[this.at];
    if (line === undefined) {
      return null;
    }
    if (isItem(line.text)) {
      return this.sequence(indent);
    }
    if (keyEnd(line.text) >= 0) {
      return this.mapping(indent);
    }
    return this.multiline(indent);
  }

  /** A scalar or a flow collection whose text runs over the next lines indented deeper than `indent`. */
  private multiline(indent: number): unknown {
    const parts: string[] = [];
    for (
      let line = this.lines[this.at];
      line !== undefined && (parts.length === 0 || line.indent > indent);
      line = this.lines[this.at]
    ) {
      parts.push(line.text);
      this.at += 1;
    }
    return flowValue(parts.join(" "));
  }

  /** The value after a key or an item marker: inline text, else the deeper block below it. */
  private valueAfter(inline: string, indent: number, sequenceAtIndent: boolean): unknown {
    if (inline !== "") {
      const parts = [inline];
      // A flow collection's closing bracket may stand at the key's own column.
      for (
        let line = this.lines[this.at];
        line !== undefined && (line.indent > indent || openCollections(parts.join(" ")) > 0);
        line = this.lines[this.at]
      ) {
        parts.push(line.text);
        this.at += 1;
      }
      return flowValue(parts.join(" "));
    }
    const next = this.lines[this.at];
    if (next === undefined) {
      return null;
    }
    if (next.indent > indent || (sequenceAtIndent && next.indent === indent && isItem(next.text))) {
      return this.block(next.indent);
    }
    return null;
  }

  private mapping(indent: number): Record<string, unknown> {
    const object: Record<string, unknown> = {};
    for (let line = this.lines[this.at]; line?.indent === indent; line = this.lines[this.at]) {
      const end = keyEnd(line.text);
      if (end < 0) {
        throw new Unsupported();
      }
      const key = scalar(line.text.slice(0, end));
      if (typeof key === "object" && key !== null) {
        throw new Unsupported();
      }
      this.at += 1;
      object[String(key)] = this.valueAfter(line.text.slice(end + 1).trim(), indent, true);
    }
    const left = this.lines[this.at];
    if (left !== undefined && left.indent > indent) {
      throw new Unsupported();
    }
    return object;
  }

  private sequence(indent: number): unknown[] {
    const items: unknown[] = [];
    for (
      let line = this.lines[this.at];
      line?.indent === indent && isItem(line.text);
      line = this.lines[this.at]
    ) {
      const content = line.text.slice(1);
      const inline = content.trimStart();
      if (inline !== "" && (isItem(inline) || keyEnd(inline) >= 0)) {
        // A node on the item's own line continues at its own column: read it as a block there.
        const moved = { indent: indent + 1 + content.length - inline.length, text: inline };
        this.lines[this.at] = moved;
        items.push(this.block(moved.indent));
      } else {
        this.at += 1;
        items.push(this.valueAfter(inline, indent, false));
      }
    }
    const left = this.lines[this.at];
    if (left !== undefined && left.indent > indent) {
      throw new Unsupported();
    }
    return items;
  }
}

/** The JSON value one YAML document's text denotes, or undefined where it lies outside the subset. */
export function yamlDocument(text: string): unknown {
  const lines: Line[] = [];
  for (const raw of text.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    if (/^ *\t/u.test(raw)) {
      return undefined;
    }
    const content = withoutComment(raw).trimEnd();
    const trimmed = content.trimStart();
    if (trimmed === "") {
      continue;
    }
    if (trimmed === "---" && lines.length === 0) {
      continue;
    }
    if (trimmed.startsWith("%") || trimmed === "---" || trimmed === "...") {
      return undefined;
    }
    lines.push({ indent: content.length - trimmed.length, text: trimmed });
  }
  try {
    return new Reader(lines).document();
  } catch (error) {
    if (error instanceof Unsupported) {
      return undefined;
    }
    throw error;
  }
}
