/**
 * The value of a YAML document, the one reader of YAML the analysis has, in the subset
 * configurations and workflow files write: block and flow mappings and sequences, plain,
 * quoted and block scalars as [YAML 1.2](https://yaml.org/spec/1.2.2/) decodes them, the core
 * schema's scalars as {@link CORE} and {@link NUMBER} read them, anchors, aliases and comments.
 * A document using anything else, a tag, a complex key, an anchor on a key or a second
 * document, or whose aliases grow it past {@link ALIAS_BUDGET}, has no value here.
 */

import { isRecord } from "../json-document.ts";

/** One line of the document with its comment removed, by its indentation, its content and its row. */
interface Line {
  readonly indent: number;
  readonly text: string;
  /** Its index among the document's lines, blank and comment lines included. */
  readonly row: number;
  /** Whether a tab stands in its indentation, which YAML forbids. */
  readonly tabbed: boolean;
  /** Whether a comment ends it, which ends a plain scalar. */
  readonly commented: boolean;
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

/**
 * The core schema's integers and floats, https://yaml.org/spec/1.2.2/#1032-tag-resolution, but
 * `.inf` and `.nan`, which JSON has no value for, so they stay strings.
 */
const NUMBER = /^(?:[-+]?(?:\d+|\d*\.\d+|\d+\.\d*)(?:[eE][-+]?\d+)?|0o[0-7]+|0x[\da-fA-F]+)$/u;

/**
 * The size, in nodes and characters, a document's aliases may add to its value. Aliases share
 * the value they name, but a consumer walking or serializing it expands each one, and an alias
 * of a collection of aliases doubles that work at each level; eemeli/yaml's `maxAliasCount`
 * bounds the same: https://eemeli.org/yaml/#options
 */
const ALIAS_BUDGET = 100_000;

/** The escapes of a double-quoted scalar: https://yaml.org/spec/1.2.2/#57-escaped-characters */
const ESCAPES: ReadonlyMap<string, string> = new Map([
  ["0", "\0"],
  ["a", "\x07"],
  ["b", "\b"],
  ["t", "\t"],
  ["\t", "\t"],
  ["n", "\n"],
  ["v", "\v"],
  ["f", "\f"],
  ["r", "\r"],
  ["e", "\x1b"],
  [" ", " "],
  ['"', '"'],
  ["/", "/"],
  ["\\", "\\"],
  ["N", "\x85"],
  ["_", "\xa0"],
  ["L", "\u2028"],
  ["P", "\u2029"],
]);

/** The escapes of a double-quoted scalar that a code point's hexadecimal digits follow, with their count. */
const CODE_ESCAPES: ReadonlyMap<string, number> = new Map([
  ["x", 2],
  ["u", 4],
  ["U", 8],
]);

/** A block scalar's header, its comment removed: https://yaml.org/spec/1.2.2/#81-block-scalar-styles */
const BLOCK_HEADER = /^([|>])(?:([1-9])([+-]?)|([+-]?)([1-9]?))$/u;

/** An anchor before a node, and the white space after it: https://yaml.org/spec/1.2.2/#692-node-anchors */
const ANCHOR = /^&([^\s,[\]{}]+)(?:\s+|$)/u;

/** An alias node: https://yaml.org/spec/1.2.2/#71-alias-nodes */
const ALIAS = /^\*([^\s,[\]{}]+)/u;

/** The match of `pattern`, written from `^`, at index `at` of `text`, which it does not copy. */
function matchAt(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  const sticky = new RegExp(pattern.source.slice(1), "uy");
  sticky.lastIndex = at;
  return sticky.exec(text);
}

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

/** The number of spaces a line starts with. */
function spacesOf(line: string): number {
  return line.length - line.replace(/^ +/u, "").length;
}

function afterBlanks(text: string, at: number): number {
  let end = at;
  while (text[end] === " " || text[end] === "\t") {
    end += 1;
  }
  return end;
}

/** The text one escape of a double-quoted scalar stands for, from its letter on, and its length. */
function escaped(text: string, at: number): { text: string; length: number } | undefined {
  const letter = text.charAt(at);
  const digits = CODE_ESCAPES.get(letter);
  if (digits === undefined) {
    const one = ESCAPES.get(letter);
    return one === undefined ? undefined : { text: one, length: 1 };
  }
  const code = text.slice(at + 1, at + 1 + digits);
  const point = /^[\da-f]+$/iu.test(code) ? Number.parseInt(code, 16) : Number.NaN;
  return code.length === digits && point <= 0x10ffff
    ? { text: String.fromCodePoint(point), length: 1 + digits }
    : undefined;
}

/**
 * The value of the quoted scalar whose opening quote is at `start` of `text`, and the index
 * after its closing quote, or `undefined` where it does not close or holds an escape YAML does
 * not define. A line break folds as YAML folds it, after the white space before it, which an
 * escape keeps: https://yaml.org/spec/1.2.2/#73-flow-scalar-styles
 */
function quotedScalar(text: string, start: number): { value: string; end: number } | undefined {
  const quote = text[start];
  let value = "";
  let kept = 0;
  let at = start + 1;
  while (at < text.length) {
    const char = text[at] ?? "";
    if (char === "\n") {
      value = value.slice(0, kept) + value.slice(kept).replace(/[ \t]+$/u, "");
      let breaks = 0;
      for (; text[at] === "\n"; breaks += 1) {
        at = afterBlanks(text, at + 1);
      }
      value += breaks === 1 ? " " : "\n".repeat(breaks - 1);
    } else if (char === quote && !(quote === "'" && text[at + 1] === "'")) {
      return { value, end: at + 1 };
    } else if (char === "'" && quote === "'") {
      value += "'";
      at += 2;
    } else if (char === "\\" && quote === '"' && text[at + 1] === "\n") {
      at = afterBlanks(text, at + 2);
    } else if (char === "\\" && quote === '"') {
      const escape = escaped(text, at + 1);
      if (escape === undefined) {
        return undefined;
      }
      value += escape.text;
      at += 1 + escape.length;
    } else {
      value += char;
      at += 1;
      continue;
    }
    kept = value.length;
  }
  return undefined;
}

/**
 * The value of a scalar's lines, each without its indentation, a blank one empty: a literal
 * block's, `|`, joined by `\n`, and a folded block's, `>`, or a plain one's with each line
 * break folded: https://yaml.org/spec/1.2.2/#813-folded-style
 */
function foldedLines(lines: readonly string[], kind: "|" | ">" | "plain"): string {
  let value = "";
  let previous: string | undefined;
  let empty = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      empty += previous === undefined && kind === "plain" ? 0 : 1;
      continue;
    }
    const folds =
      kind !== "|" && previous !== undefined && !/^[ \t]/u.test(previous) && !/^[ \t]/u.test(line);
    value +=
      previous === undefined
        ? "\n".repeat(empty)
        : folds && empty === 0
          ? " "
          : "\n".repeat(empty + (folds ? 0 : 1));
    value += line;
    previous = line;
    empty = 0;
  }
  return value;
}

/** The value one scalar's text on one line denotes, quoted or plain. */
function scalar(text: string): unknown {
  const value = text.trim();
  if (value.startsWith("'") || value.startsWith('"')) {
    const read = quotedScalar(value, 0);
    if (read?.end !== value.length) {
      throw new Unsupported();
    }
    return read.value;
  }
  if (/^[&*!|>%@`?#]/u.test(value) || value === "---" || value === "...") {
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

/** Sets `key` of `object` as an own member, so a key such as `__proto__` changes no prototype. */
function setMember(object: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** The size of a value once every value it shares is expanded, each node 1 and each string its length more. */
function sizeOf(value: unknown, sizes: WeakMap<object, number>): number {
  if (typeof value === "string") {
    return 1 + value.length;
  }
  if (typeof value !== "object" || value === null) {
    return 1;
  }
  const known = sizes.get(value);
  if (known !== undefined) {
    return known;
  }
  const children = Array.isArray(value) ? value : Object.entries(value).flat();
  const size = children.reduce<number>((sum, child) => sum + sizeOf(child, sizes), 1);
  sizes.set(value, size);
  return size;
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

/** Whether one line's content is a block sequence item. */
function isItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

/** Whether one line's content opens a block collection: a sequence item or a mapping key. */
function opensCollection(text: string): boolean {
  return isItem(text) || keyEnd(text) >= 0;
}

/** Reads the document's lines as one value. */
class Reader {
  private at = 0;
  private readonly lines: Line[];
  /** Every line of the document, as written. */
  private readonly raw: readonly string[];
  /** The whole document, its lines joined by `\n`, and where each line starts in it. */
  private readonly text: string;
  private readonly starts: readonly number[];
  /** Whether a line break ends the document's last line. */
  private readonly broken: boolean;
  private readonly anchors = new Map<string, unknown>();
  /** The size the aliases read so far add, against {@link ALIAS_BUDGET}. */
  private expanded = 0;
  private readonly sizes = new WeakMap<object, number>();

  constructor(lines: Line[], raw: readonly string[], broken: boolean) {
    this.lines = lines;
    this.raw = raw;
    this.broken = broken;
    this.text = raw.join("\n");
    let start = 0;
    this.starts = raw.map((line) => {
      const here = start;
      start += line.length + 1;
      return here;
    });
  }

  /** The whole document's value. */
  document(): unknown {
    const first = this.peek();
    if (first === undefined) {
      return null;
    }
    const value = this.block(first.indent);
    if (this.at < this.lines.length) {
      throw new Unsupported();
    }
    return value;
  }

  /** The next line to read; one indented with a tab is outside the subset. */
  private peek(): Line | undefined {
    const line = this.lines[this.at];
    if (line?.tabbed === true) {
      throw new Unsupported();
    }
    return line;
  }

  /** The value the anchor `name` names, its size counted against {@link ALIAS_BUDGET}. */
  private alias(name: string): unknown {
    if (!this.anchors.has(name)) {
      throw new Unsupported();
    }
    const value = this.anchors.get(name);
    this.expanded += sizeOf(value, this.sizes);
    if (this.expanded > ALIAS_BUDGET) {
      throw new Unsupported();
    }
    return value;
  }

  /** Moves past every line before row `end`. */
  private skipTo(end: number): void {
    while ((this.lines[this.at]?.row ?? end) < end) {
      this.at += 1;
    }
  }

  /** The block node whose first line is the next one, at `indent`. */
  private block(indent: number): unknown {
    const line = this.peek();
    if (line === undefined) {
      return null;
    }
    if (isItem(line.text)) {
      return this.sequence(indent);
    }
    if (keyEnd(line.text) >= 0) {
      return this.mapping(indent);
    }
    this.at += 1;
    return this.value(line, line.indent, line.text, indent - 1, false);
  }

  /** The node below a key or an item marker with nothing after it: the deeper block, else null. */
  private below(indent: number, sequenceAtIndent: boolean): unknown {
    const next = this.peek();
    if (
      next === undefined ||
      !(next.indent > indent || (sequenceAtIndent && next.indent === indent && isItem(next.text)))
    ) {
      return null;
    }
    if (opensCollection(next.text)) {
      return this.block(next.indent);
    }
    this.at += 1;
    return this.value(next, next.indent, next.text, indent, false);
  }

  /**
   * The node `text` starts, at column `column` of `line`, which is read, after a key or an item
   * marker at `indent`: an alias, a node an anchor names, a block scalar, a quoted scalar, or a
   * flow collection or plain scalar whose text runs over the next lines indented deeper.
   */
  private value(
    line: Line,
    column: number,
    text: string,
    indent: number,
    sequenceAtIndent: boolean,
  ): unknown {
    const alias = ALIAS.exec(text);
    if (alias !== null) {
      const [whole, name = ""] = alias;
      if (whole !== text) {
        throw new Unsupported();
      }
      return this.alias(name);
    }
    const anchor = ANCHOR.exec(text);
    if (anchor !== null) {
      const rest = text.slice(anchor[0].length);
      if (opensCollection(rest)) {
        throw new Unsupported();
      }
      const value =
        rest === ""
          ? this.below(indent, sequenceAtIndent)
          : this.value(line, column + anchor[0].length, rest, indent, sequenceAtIndent);
      this.anchors.set(anchor[1] ?? "", value);
      return value;
    }
    const header = BLOCK_HEADER.exec(text);
    if (header !== null) {
      return this.blockScalar(header, line.row, indent);
    }
    if (/^['"[{]/u.test(text)) {
      const start = (this.starts[line.row] ?? 0) + column;
      const read = this.flow(start);
      this.close(line.row, start, read.end);
      return read.value;
    }
    const parts = [line];
    for (let next = this.peek(); next !== undefined && next.indent > indent; next = this.peek()) {
      parts.push(next);
      this.at += 1;
    }
    const texts = [text, ...parts.slice(1).map((one) => one.text)];
    const lines = parts.flatMap((part, at) => {
      const after = parts[at + 1];
      const between = after === undefined ? [] : this.raw.slice(part.row + 1, after.row);
      // A comment ends a plain scalar, so a line of it after one is outside YAML.
      if (after !== undefined && (part.commented || between.some((one) => one.trim() !== ""))) {
        throw new Unsupported();
      }
      return [texts[at] ?? "", ...between.map(() => "")];
    });
    return scalar(foldedLines(lines, "plain"));
  }

  /**
   * The block scalar whose header is on row `row`, under a node at `indent`: its lines are those
   * after it that are blank or indented to its content's indentation, the indentation indicator's
   * or else its first line's that is not blank, with its chomping read as YAML reads it.
   */
  private blockScalar(header: RegExpExecArray, row: number, indent: number): string {
    const [, style] = header;
    const digit = header[2] ?? header[5] ?? "";
    const chomp = header[3] ?? header[4] ?? "";
    const first = this.raw.slice(row + 1).find((one) => one.trim() !== "");
    const content =
      digit === ""
        ? first === undefined || spacesOf(first) <= indent
          ? Number.POSITIVE_INFINITY
          : spacesOf(first)
        : Math.max(indent, 0) + Number(digit);
    let end = row + 1;
    while (
      end < this.raw.length &&
      ((this.raw[end] ?? "").trim() === "" || spacesOf(this.raw[end] ?? "") >= content)
    ) {
      end += 1;
    }
    this.skipTo(end);
    const body = this.raw
      .slice(row + 1, end)
      .map((one) => one.slice(Math.min(content, spacesOf(one))));
    const value = foldedLines(body, style === ">" ? ">" : "|");
    const unbroken = end === this.raw.length && !this.broken ? 1 : 0;
    const last = body.findLastIndex((one) => one.trim() !== "");
    const breaks = Math.max(body.length - Math.max(last, 0) - unbroken, 0);
    const kept = chomp === "+" ? breaks : chomp === "-" || value === "" ? 0 : Math.min(breaks, 1);
    return `${value}${"\n".repeat(kept)}`;
  }

  /**
   * Reads one flow node of the document's text from `start`, answering its value and where it
   * ends: a flow collection, whose lines and comments it reads through, an alias, a node an
   * anchor names, a quoted scalar, or a plain scalar, its line breaks folded.
   */
  private flow(start: number): { readonly value: unknown; readonly end: number } {
    const text = this.text;
    let at = start;
    const skip = (): void => {
      for (;;) {
        while (at < text.length && /\s/u.test(text.charAt(at))) {
          at += 1;
        }
        if (text.charAt(at) !== "#" || !/\s/u.test(text.charAt(at - 1))) {
          return;
        }
        const lineEnd = text.indexOf("\n", at);
        at = lineEnd < 0 ? text.length : lineEnd;
      }
    };
    skip();
    const open = text.charAt(at);
    const alias = open === "*" ? matchAt(ALIAS, text, at) : null;
    if (alias !== null) {
      const [whole, name = ""] = alias;
      return { value: this.alias(name), end: at + whole.length };
    }
    const anchor = open === "&" ? matchAt(ANCHOR, text, at) : null;
    if (anchor !== null) {
      const read = this.flow(at + anchor[0].length);
      this.anchors.set(anchor[1] ?? "", read.value);
      return read;
    }
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
        const item = this.flow(at);
        at = item.end;
        skip();
        if (open === "{") {
          if (text.charAt(at) !== ":" || typeof item.value !== "string") {
            throw new Unsupported();
          }
          const held = this.flow(at + 1);
          setMember(object, item.value, held.value);
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
      const read = quotedScalar(text, at);
      if (read === undefined) {
        throw new Unsupported();
      }
      return read;
    }
    let end = at;
    while (
      end < text.length &&
      !",]}".includes(text.charAt(end)) &&
      !(text.charAt(end) === ":" && /[\s,\]}]/u.test(text.charAt(end + 1) || " ")) &&
      !(text.charAt(end) === "#" && /\s/u.test(text.charAt(end - 1)))
    ) {
      end += 1;
    }
    const lines = text
      .slice(at, end)
      .split("\n")
      .map((one) => one.trim());
    return { value: scalar(foldedLines(lines, "plain")), end };
  }

  /**
   * Ends the flow node read from `start`, on row `row`, to `end`: the rest of its last line must
   * be blank or a comment, and every line it runs over is read.
   */
  private close(row: number, start: number, end: number): void {
    const lineEnd = this.text.indexOf("\n", end);
    const tail = this.text.slice(end, lineEnd < 0 ? this.text.length : lineEnd);
    if (!/^(?:\s*$|\s+#)/u.test(tail)) {
      throw new Unsupported();
    }
    this.skipTo(row + (this.text.slice(start, end).match(/\n/gu)?.length ?? 0) + 1);
  }

  private mapping(indent: number): Record<string, unknown> {
    const object: Record<string, unknown> = {};
    for (let line = this.peek(); line?.indent === indent; line = this.peek()) {
      const end = keyEnd(line.text);
      if (end < 0) {
        throw new Unsupported();
      }
      const key = scalar(line.text.slice(0, end));
      if (typeof key === "object" && key !== null) {
        throw new Unsupported();
      }
      this.at += 1;
      const after = line.text.slice(end + 1);
      const inline = after.trim();
      const column = line.indent + end + 1 + after.length - after.trimStart().length;
      setMember(
        object,
        String(key),
        inline === "" ? this.below(indent, true) : this.value(line, column, inline, indent, true),
      );
    }
    const left = this.peek();
    if (left !== undefined && left.indent > indent) {
      throw new Unsupported();
    }
    return object;
  }

  private sequence(indent: number): unknown[] {
    const items: unknown[] = [];
    for (let line = this.peek(); line?.indent === indent && isItem(line.text); line = this.peek()) {
      const content = line.text.slice(1);
      const inline = content.trimStart();
      const column = indent + 1 + content.length - inline.length;
      if (opensCollection(inline)) {
        // A node on the item's own line continues at its own column: read it as a block there.
        this.lines[this.at] = { ...line, indent: column, text: inline };
        items.push(this.block(column));
      } else {
        this.at += 1;
        items.push(
          inline === ""
            ? this.below(indent, false)
            : this.value(line, column, inline, indent, false),
        );
      }
    }
    const left = this.peek();
    if (left !== undefined && left.indent > indent) {
      throw new Unsupported();
    }
    return items;
  }
}

/** The JSON value one YAML document's text denotes, or undefined where it lies outside the subset. */
export function yamlDocument(text: string): unknown {
  const raw = text.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  const broken = raw.length > 1 && raw.at(-1) === "";
  if (broken) {
    raw.pop();
  }
  const lines: Line[] = [];
  for (const [row, line] of raw.entries()) {
    const content = withoutComment(line).trimEnd();
    if (/^(?:---|\.\.\.)(?:\s|$)/u.test(content) || content.startsWith("%")) {
      if (content === "---" && lines.length === 0) {
        continue;
      }
      return undefined;
    }
    const trimmed = content.trimStart();
    if (trimmed !== "") {
      lines.push({
        indent: content.length - trimmed.length,
        text: trimmed,
        row,
        tabbed: /^ *\t/u.test(line),
        commented: content !== line.trimEnd(),
      });
    }
  }
  try {
    return new Reader(lines, raw, broken).document();
  } catch (error) {
    if (error instanceof Unsupported) {
      return undefined;
    }
    throw error;
  }
}

/** What one top-level key of a YAML document holds, read by {@link yamlKey}. */
type YamlKey =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "absent" }
  | { readonly kind: "refused"; readonly reason: string };

/** The key one line of the document's top-level mapping opens, or undefined where it opens none. */
function topLevelKey(raw: string): string | undefined {
  const content = withoutComment(raw).trimEnd();
  const end = /^\s/u.test(content) ? -1 : keyEnd(content);
  if (end < 0) {
    return undefined;
  }
  try {
    const key = scalar(content.slice(0, end));
    return typeof key === "object" && key !== null ? undefined : String(key);
  } catch {
    return undefined;
  }
}

/**
 * The value of one key of a document's top-level block mapping, read from that key's lines
 * alone, so a document whose other keys lie outside the subset still yields it. A key
 * declared twice, or one whose own lines lie outside the subset or name an anchor written
 * under another key, is refused.
 */
export function yamlKey(text: string, key: string): YamlKey {
  const lines = text.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  const starts = lines.flatMap((line, at) => (topLevelKey(line) === undefined ? [] : [at]));
  const named = starts.filter((at) => topLevelKey(lines[at] ?? "") === key);
  const [start] = named;
  if (start === undefined) {
    return { kind: "absent" };
  }
  if (named.length > 1) {
    return { kind: "refused", reason: `the ${key} key is declared more than once` };
  }
  const end = starts.find((at) => at > start) ?? lines.length;
  const value = yamlDocument(lines.slice(start, end).join("\n"));
  return isRecord(value)
    ? { kind: "value", value: value[key] }
    : { kind: "refused", reason: `the value of ${key} is outside the YAML subset read here` };
}
