/**
 * A user's template in a subset of Go's `text/template` action grammar, over the report
 * document by its JSON member names. Text, comments, trim markers, pipelines, variables,
 * `if`, `else if`, `with`, and `range` with `break` and `continue` are implemented; so are
 * `and`, `or`, `not`, `len`, `index`, `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `print`, `printf`
 * and `println`. Any other function, `define`, `template` and `block` are refused at parse,
 * and a member the document does not carry fails the rendering.
 */

import { CHUNK_LENGTH } from "../json-chunks.ts";
import { RenderError } from "./reporter.ts";
import { utf8Bytes } from "./sha256.ts";

/** A template that does not parse, which refuses the invocation before any analysis. */
export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

/** One value of the document, as a JSON decode produces it. */
type Value = null | boolean | number | string | readonly Value[] | ValueObject;

/** A JSON object. */
interface ValueObject {
  readonly [key: string]: Value;
}

type Arg =
  | { readonly k: "dot" }
  | { readonly k: "var"; readonly name: string }
  | { readonly k: "lit"; readonly value: Value }
  | { readonly k: "func"; readonly name: string }
  | { readonly k: "pipe"; readonly pipe: Pipeline }
  | { readonly k: "field"; readonly recv: Arg | undefined; readonly names: readonly string[] };

interface Pipeline {
  /** The variables the pipeline declares or assigns, and which of the two it does. */
  readonly vars: readonly string[];
  readonly assign: boolean;
  readonly commands: readonly (readonly Arg[])[];
}

/** An `if`, `with` or `range`: its pipeline, its body, and its `else` body. */
interface Control {
  readonly k: "if" | "with" | "range";
  readonly pipe: Pipeline;
  readonly list: readonly Node[];
  readonly otherwise: readonly Node[];
}

type Node =
  | { readonly k: "text"; readonly text: string }
  | { readonly k: "action"; readonly pipe: Pipeline }
  | { readonly k: "break" }
  | { readonly k: "continue" }
  | Control;

/** A parsed template, ready to render a report. */
export interface Template {
  readonly nodes: readonly Node[];
}

const LEFT = "{{";
const RIGHT = "}}";
const TRIM_SPACE = new Set([" ", "\t", "\r", "\n"]);
const FUNCTIONS = new Set([
  "and",
  "or",
  "not",
  "len",
  "index",
  "eq",
  "ne",
  "lt",
  "le",
  "gt",
  "ge",
  "print",
  "printf",
  "println",
]);
const REFUSED_KEYWORDS = new Set(["define", "template", "block"]);

type Token =
  | { readonly t: "word"; readonly text: string }
  /** A field, attached where nothing separates it from the operand before it. */
  | { readonly t: "field"; readonly name: string; readonly attached: boolean }
  | { readonly t: "var"; readonly name: string }
  | { readonly t: "lit"; readonly value: Value }
  | { readonly t: "punct"; readonly text: "(" | ")" | "|" | ":=" | "=" | "," };

/** One action's source, its tokens, and where it starts, for a message that names it. */
interface Action {
  readonly tokens: readonly Token[];
  readonly line: number;
}

type Piece =
  { readonly k: "text"; readonly text: string } | { readonly k: "action"; readonly action: Action };

const ESCAPES: Readonly<Record<string, string>> = {
  a: "\u0007",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  '"': '"',
};

/** The number of hexadecimal digits each numeric escape takes. */
const ESCAPE_WIDTHS: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/uy;
/** A number as the lexer reads one, before the subset decides whether it is a decimal integer. */
const NUMBER = /[+-]?[0-9][0-9A-Za-z_.]*/uy;

/** The one number form the subset admits: a decimal integer with no leading zero. */
const DECIMAL_INTEGER = /^[+-]?(?:0|[1-9][0-9]*)$/u;

function lineOf(source: string, at: number): number {
  let line = 1;
  for (let i = 0; i < at; i += 1) {
    if (source[i] === "\n") {
      line += 1;
    }
  }
  return line;
}

/** The interpreted string literal starting at `at`, and the index after its closing quote. */
function quoted(source: string, at: number, line: number): { value: string; end: number } {
  let value = "";
  for (let i = at + 1; i < source.length; i += 1) {
    const char = source[i] ?? "";
    if (char === '"') {
      return { value, end: i + 1 };
    }
    if (char === "\n") {
      break;
    }
    if (char !== "\\") {
      value += char;
      continue;
    }
    const next = source[i + 1] ?? "";
    const simple = ESCAPES[next];
    if (simple !== undefined) {
      value += simple;
      i += 1;
      continue;
    }
    const width = Object.hasOwn(ESCAPE_WIDTHS, next) ? ESCAPE_WIDTHS[next] : undefined;
    const digits = width === undefined ? "" : source.slice(i + 2, i + 2 + width);
    if (width === undefined || !/^[0-9A-Fa-f]+$/u.test(digits) || digits.length !== width) {
      throw new TemplateError(`line ${String(line)}: the escape \\${next} is not supported`);
    }
    value += String.fromCodePoint(Number.parseInt(digits, 16));
    i += 1 + width;
  }
  throw new TemplateError(`line ${String(line)}: unterminated quoted string`);
}

/** The tokens of one action, from `at` to its closing delimiter, and the index after it. */
function lexAction(
  source: string,
  at: number,
  line: number,
): { tokens: Token[]; end: number; trimRight: boolean } {
  const tokens: Token[] = [];
  let i = at;
  for (;;) {
    const char = source[i];
    if (char === undefined) {
      throw new TemplateError(`line ${String(line)}: unclosed action`);
    }
    if (TRIM_SPACE.has(char) && source.startsWith(`-${RIGHT}`, i + 1)) {
      return { tokens, end: i + 2 + RIGHT.length, trimRight: true };
    }
    if (source.startsWith(RIGHT, i)) {
      return { tokens, end: i + RIGHT.length, trimRight: false };
    }
    if (TRIM_SPACE.has(char)) {
      i += 1;
      continue;
    }
    if (char === '"') {
      const { value, end } = quoted(source, i, line);
      tokens.push({ t: "lit", value });
      i = end;
      continue;
    }
    if (char === "`") {
      const end = source.indexOf("`", i + 1);
      if (end < 0) {
        throw new TemplateError(`line ${String(line)}: unterminated raw quoted string`);
      }
      tokens.push({ t: "lit", value: source.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (source.startsWith(":=", i)) {
      tokens.push({ t: "punct", text: ":=" });
      i += 2;
      continue;
    }
    if (char === "(" || char === ")" || char === "|" || char === "=" || char === ",") {
      tokens.push({ t: "punct", text: char });
      i += 1;
      continue;
    }
    if (char === "." || char === "$") {
      IDENTIFIER.lastIndex = i + 1;
      const name = IDENTIFIER.exec(source)?.[0] ?? "";
      if (char === "$") {
        tokens.push({ t: "var", name: `$${name}` });
      } else if (name === "" && /[0-9]/u.test(source[i + 1] ?? "")) {
        throw new TemplateError(`line ${String(line)}: a number is written with a leading digit`);
      } else {
        tokens.push({ t: "field", name, attached: i > at && !TRIM_SPACE.has(source[i - 1] ?? "") });
      }
      i += 1 + name.length;
      continue;
    }
    NUMBER.lastIndex = i;
    const number = NUMBER.exec(source)?.[0];
    if (number !== undefined) {
      if (!DECIMAL_INTEGER.test(number)) {
        throw new TemplateError(
          `line ${String(line)}: ${JSON.stringify(number)} is not a decimal integer`,
        );
      }
      tokens.push({ t: "lit", value: Number(number) });
      i += number.length;
      continue;
    }
    IDENTIFIER.lastIndex = i;
    const word = IDENTIFIER.exec(source)?.[0];
    if (word !== undefined) {
      const literal: Readonly<Record<string, Value>> = { true: true, false: false, nil: null };
      tokens.push(
        Object.hasOwn(literal, word)
          ? { t: "lit", value: literal[word] ?? null }
          : { t: "word", text: word },
      );
      i += word.length;
      continue;
    }
    throw new TemplateError(
      `line ${String(line)}: unexpected ${JSON.stringify(char)} in an action`,
    );
  }
}

/** The template split into text and actions, trim markers and comments applied. */
function lex(source: string): Piece[] {
  const pieces: Piece[] = [];
  let i = 0;
  let trimNext = false;
  while (i < source.length) {
    const open = source.indexOf(LEFT, i);
    let text = source.slice(i, open < 0 ? source.length : open);
    if (trimNext) {
      text = text.replace(/^[ \t\r\n]+/u, "");
    }
    if (open < 0) {
      pieces.push({ k: "text", text });
      break;
    }
    const line = lineOf(source, open);
    let at = open + LEFT.length;
    if (source[at] === "-" && TRIM_SPACE.has(source[at + 1] ?? "")) {
      text = text.replace(/[ \t\r\n]+$/u, "");
      at += 2;
    }
    pieces.push({ k: "text", text });
    if (source.startsWith("/*", at)) {
      const close = source.indexOf("*/", at + 2);
      if (close < 0) {
        throw new TemplateError(`line ${String(line)}: unclosed comment`);
      }
      const after = close + 2;
      if (source.startsWith(RIGHT, after)) {
        i = after + RIGHT.length;
        trimNext = false;
      } else if (source.startsWith(` -${RIGHT}`, after)) {
        i = after + 2 + RIGHT.length;
        trimNext = true;
      } else {
        throw new TemplateError(`line ${String(line)}: a comment ends the action it is written in`);
      }
      continue;
    }
    const lexed = lexAction(source, at, line);
    pieces.push({ k: "action", action: { tokens: lexed.tokens, line } });
    i = lexed.end;
    trimNext = lexed.trimRight;
  }
  return pieces.filter((piece) => piece.k !== "text" || piece.text !== "");
}

/** The parser over one template's pieces, with the variables in scope at each point. */
class Parser {
  private at = 0;
  private readonly scopes: Set<string>[] = [new Set(["$"])];
  private ranges = 0;
  private readonly pieces: readonly Piece[];

  constructor(pieces: readonly Piece[]) {
    this.pieces = pieces;
  }

  parse(): Node[] {
    const { list, ended } = this.list();
    if (ended !== undefined) {
      throw new TemplateError(`line ${String(ended.line)}: unexpected {{${ended.word}}}`);
    }
    return list;
  }

  /** Nodes up to the end of the template or to an `else` or `end`, which it returns. */
  private list(): {
    list: Node[];
    ended: { word: string; action: Action; line: number } | undefined;
  } {
    const list: Node[] = [];
    while (this.at < this.pieces.length) {
      const piece = this.pieces[this.at];
      this.at += 1;
      if (piece === undefined) {
        break;
      }
      if (piece.k === "text") {
        list.push({ k: "text", text: piece.text });
        continue;
      }
      const action = piece.action;
      const first = action.tokens[0];
      const word = first?.t === "word" ? first.text : undefined;
      if (word === "end" || word === "else") {
        return { list, ended: { word, action, line: action.line } };
      }
      list.push(this.node(action, word));
    }
    return { list, ended: undefined };
  }

  private node(action: Action, word: string | undefined): Node {
    const line = action.line;
    if (word === "if" || word === "with" || word === "range") {
      return this.control(word, action.tokens.slice(1), line);
    }
    if (word === "break" || word === "continue") {
      if (action.tokens.length !== 1) {
        throw new TemplateError(`line ${String(line)}: {{${word}}} takes nothing`);
      }
      if (this.ranges === 0) {
        throw new TemplateError(`line ${String(line)}: {{${word}}} outside {{range}}`);
      }
      return { k: word };
    }
    if (word !== undefined && REFUSED_KEYWORDS.has(word)) {
      throw new TemplateError(`line ${String(line)}: {{${word}}} is not supported`);
    }
    return { k: "action", pipe: this.pipeline(action.tokens, line, "action") };
  }

  private control(word: "if" | "with" | "range", tokens: readonly Token[], line: number): Node {
    this.scopes.push(new Set());
    try {
      if (word === "range") {
        this.ranges += 1;
      }
      const pipe = this.pipeline(tokens, line, word);
      const body = this.list();
      if (word === "range") {
        this.ranges -= 1;
      }
      const ended = body.ended;
      if (ended === undefined) {
        throw new TemplateError(`line ${String(line)}: {{${word}}} has no {{end}}`);
      }
      const rest = ended.action.tokens.slice(1);
      if (ended.word === "end") {
        if (rest.length > 0) {
          throw new TemplateError(`line ${String(ended.line)}: unexpected tokens after {{end}}`);
        }
        return { k: word, pipe, list: body.list, otherwise: [] };
      }
      const chained = rest[0];
      if (word !== "range" && chained?.t === "word" && chained.text === word) {
        const otherwise = [this.control(word, rest.slice(1), ended.line)];
        return { k: word, pipe, list: body.list, otherwise };
      }
      if (rest.length > 0) {
        throw new TemplateError(`line ${String(ended.line)}: unexpected tokens after {{else}}`);
      }
      const tail = this.list();
      if (tail.ended?.word !== "end" || tail.ended.action.tokens.length !== 1) {
        throw new TemplateError(
          `line ${String(line)}: {{${word}}} has no {{end}} after its {{else}}`,
        );
      }
      return { k: word, pipe, list: body.list, otherwise: tail.list };
    } finally {
      this.scopes.pop();
    }
  }

  private declared(name: string): boolean {
    return this.scopes.some((scope) => scope.has(name));
  }

  private pipeline(tokens: readonly Token[], line: number, context: string): Pipeline {
    let rest = tokens;
    let vars: string[] = [];
    let assign = false;
    const declaration = rest.findIndex(
      (token) => token.t === "punct" && (token.text === ":=" || token.text === "="),
    );
    if (declaration > 0) {
      const head = rest.slice(0, declaration);
      const names = head.filter((_token, i) => i % 2 === 0);
      const commas = head.filter((_token, i) => i % 2 === 1);
      const valid =
        names.every((token) => token.t === "var" && token.name !== "$") &&
        commas.every((token) => token.t === "punct" && token.text === ",") &&
        names.length <= (context === "range" ? 2 : 1);
      if (valid) {
        vars = names.map((token) => (token.t === "var" ? token.name : ""));
        const operator = rest[declaration];
        assign = operator?.t === "punct" && operator.text === "=";
        rest = rest.slice(declaration + 1);
      }
    }
    const commands = this.commands(rest, line);
    if (commands.length === 0) {
      throw new TemplateError(`line ${String(line)}: missing value for ${context}`);
    }
    for (const name of vars) {
      if (assign) {
        if (!this.declared(name)) {
          throw new TemplateError(`line ${String(line)}: undefined variable ${name}`);
        }
      } else {
        this.scopes.at(-1)?.add(name);
      }
    }
    return { vars, assign, commands };
  }

  private commands(tokens: readonly Token[], line: number): Arg[][] {
    const commands: Arg[][] = [];
    let current: Arg[] = [];
    let i = 0;
    const finish = (): void => {
      if (current.length === 0) {
        throw new TemplateError(`line ${String(line)}: missing command in a pipeline`);
      }
      commands.push(current);
      current = [];
    };
    while (i < tokens.length) {
      const token = tokens[i];
      if (token?.t === "punct" && token.text === "|") {
        finish();
        i += 1;
        continue;
      }
      const { arg, next } = this.operand(tokens, i, line);
      current.push(arg);
      i = next;
    }
    if (current.length > 0 || commands.length > 0) {
      finish();
    }
    return commands;
  }

  /** One operand starting at token `i`, its field chain included, and the index after it. */
  private operand(tokens: readonly Token[], i: number, line: number): { arg: Arg; next: number } {
    const token = tokens[i];
    let arg: Arg;
    let next = i + 1;
    if (token === undefined) {
      throw new TemplateError(`line ${String(line)}: missing operand`);
    }
    switch (token.t) {
      case "lit":
        arg = { k: "lit", value: token.value };
        break;
      case "word":
        if (!FUNCTIONS.has(token.text)) {
          throw new TemplateError(
            `line ${String(line)}: function ${JSON.stringify(token.text)} not defined`,
          );
        }
        return { arg: { k: "func", name: token.text }, next };
      case "var":
        if (!this.declared(token.name)) {
          throw new TemplateError(`line ${String(line)}: undefined variable ${token.name}`);
        }
        arg = { k: "var", name: token.name };
        break;
      case "field":
        if (token.name === "") {
          arg = { k: "dot" };
          break;
        }
        arg = { k: "field", recv: undefined, names: [token.name] };
        break;
      case "punct": {
        if (token.text !== "(") {
          throw new TemplateError(`line ${String(line)}: unexpected ${token.text} in an operand`);
        }
        let depth = 1;
        let close = i + 1;
        for (; close < tokens.length; close += 1) {
          const inner = tokens[close];
          if (inner?.t === "punct" && inner.text === "(") {
            depth += 1;
          } else if (inner?.t === "punct" && inner.text === ")") {
            depth -= 1;
            if (depth === 0) {
              break;
            }
          }
        }
        if (depth !== 0) {
          throw new TemplateError(`line ${String(line)}: unclosed left parenthesis`);
        }
        arg = {
          k: "pipe",
          pipe: this.pipeline(tokens.slice(i + 1, close), line, "parenthesized pipeline"),
        };
        next = close + 1;
        break;
      }
    }
    const names: string[] = [];
    for (
      let chained = tokens[next];
      chained?.t === "field" && chained.attached && chained.name !== "";
      chained = tokens[next]
    ) {
      names.push(chained.name);
      next += 1;
    }
    if (names.length > 0) {
      if (arg.k === "lit") {
        throw new TemplateError(`line ${String(line)}: a literal has no field`);
      }
      arg =
        arg.k === "field" && arg.recv === undefined
          ? { k: "field", recv: undefined, names: [...arg.names, ...names] }
          : { k: "field", recv: arg, names };
    }
    return { arg, next };
  }
}

/** Parses a template, or throws a {@link TemplateError} naming the line it fails at. */
export function parseTemplate(source: string): Template {
  return { nodes: new Parser(lex(source)).parse() };
}

/** The stop a `break` or a `continue` raises out of the body of its `range`. */
class LoopStop extends Error {
  readonly kind: "break" | "continue";

  constructor(kind: "break" | "continue") {
    super(kind);
    this.kind = kind;
  }
}

function isList(value: Value): value is readonly Value[] {
  return Array.isArray(value);
}

function isObject(value: Value): value is ValueObject {
  return typeof value === "object" && value !== null && !isList(value);
}

function truthy(value: Value): boolean {
  if (value === null) {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string" || isList(value)) {
    return value.length > 0;
  }
  return Object.keys(value).length > 0;
}

/** One value as an operand prints it: nested lists and objects in the bracketed form. */
function formatted(value: Value, nested: boolean): string {
  if (value === null) {
    return nested ? "<nil>" : "<no value>";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (isList(value)) {
    return `[${value.map((one) => formatted(one, true)).join(" ")}]`;
  }
  const object: ValueObject = value;
  const entries = Object.keys(object)
    .sort()
    .map((key) => `${key}:${formatted(object[key] ?? null, true)}`);
  return `map[${entries.join(" ")}]`;
}

function kindOf(value: Value): string {
  if (value === null) {
    return "nil";
  }
  if (isList(value)) {
    return "list";
  }
  return typeof value === "object" ? "object" : typeof value;
}

function compareBasic(name: string, a: Value, b: Value): number {
  const kind = kindOf(a);
  if (kind !== kindOf(b) || (kind !== "number" && kind !== "string" && kind !== "boolean")) {
    throw new RenderError(
      `${name}: incompatible types for comparison: ${kindOf(a)} and ${kindOf(b)}`,
    );
  }
  if (a === b) {
    return 0;
  }
  if (kind === "boolean") {
    return Number.NaN;
  }
  if (kind === "string") {
    return byCodePoints(a as string, b as string);
  }
  return (a as number) < (b as number) ? -1 : 1;
}

/**
 * Two strings ordered by the bytes of their UTF-8 encodings, which is the order of their
 * code points: the order of their UTF-16 code units differs above U+FFFF.
 */
function byCodePoints(a: string, b: string): number {
  let at = 0;
  while (at < a.length && at < b.length) {
    const x = a.codePointAt(at) ?? 0;
    const y = b.codePointAt(at) ?? 0;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
    at += x > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

/** The escapes `%q` writes for the control characters that have one of their own. */
const QUOTED_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  "\\": "\\\\",
  "\u0007": "\\a",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\v": "\\v",
};

/**
 * The text `%q` writes: double quotes around the text, a quote and a backslash escaped,
 * each control character with an escape of its own written as it, every other character
 * below U+0020 and U+007F written as `\x` and two lowercase hexadecimal digits, and every
 * other character as itself.
 */
function goQuoted(text: string): string {
  let out = '"';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (Object.hasOwn(QUOTED_ESCAPES, char)) {
      out += QUOTED_ESCAPES[char] ?? "";
    } else if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      out += char;
    }
  }
  return `${out}"`;
}

/** `printf`'s verbs, each over one operand. */
function printf(format: string, args: readonly Value[]): string {
  let out = "";
  let next = 0;
  for (let i = 0; i < format.length; i += 1) {
    const char = format[i];
    if (char !== "%") {
      out += char ?? "";
      continue;
    }
    const verb = format[i + 1] ?? "";
    i += 1;
    if (verb === "%") {
      out += "%";
      continue;
    }
    if (next >= args.length) {
      throw new RenderError(`printf: %${verb} has no operand`);
    }
    const arg = args[next] ?? null;
    next += 1;
    switch (verb) {
      case "v":
      case "s":
        out += formatted(arg, true);
        break;
      case "q":
        out += goQuoted(formatted(arg, true));
        break;
      case "d":
        if (typeof arg !== "number" || !Number.isInteger(arg)) {
          throw new RenderError(`printf: %d over a ${kindOf(arg)}`);
        }
        out += String(arg);
        break;
      case "t":
        if (typeof arg !== "boolean") {
          throw new RenderError(`printf: %t over a ${kindOf(arg)}`);
        }
        out += String(arg);
        break;
      default:
        throw new RenderError(`printf: the verb %${verb} is not supported`);
    }
  }
  if (next < args.length) {
    throw new RenderError(`printf: ${String(args.length - next)} operand(s) left over`);
  }
  return out;
}

function ordered(name: "lt" | "le" | "gt" | "ge", order: number): boolean {
  switch (name) {
    case "lt":
      return order < 0;
    case "le":
      return order <= 0;
    case "gt":
      return order > 0;
    case "ge":
      return order >= 0;
  }
}

/** The functions a command calls, each over its evaluated operands. */
function call(name: string, args: readonly Value[]): Value {
  const [first = null, second = null] = args;
  const arity = (count: number): void => {
    if (args.length !== count) {
      throw new RenderError(
        `${name} takes ${String(count)} operand(s), and ${String(args.length)} were given`,
      );
    }
  };
  switch (name) {
    case "not":
      arity(1);
      return !truthy(first);
    case "len":
      arity(1);
      if (typeof first === "string") {
        return utf8Bytes(first).length;
      }
      if (isList(first)) {
        return first.length;
      }
      if (isObject(first)) {
        return Object.keys(first).length;
      }
      throw new RenderError(`len of a ${kindOf(first)}`);
    case "index": {
      let value = first;
      for (const key of args.slice(1)) {
        if (isList(value) && typeof key === "number" && Number.isInteger(key)) {
          if (key < 0 || key >= value.length) {
            throw new RenderError(`index out of range: ${String(key)}`);
          }
          value = value[key] ?? null;
        } else if (isObject(value) && typeof key === "string" && Object.hasOwn(value, key)) {
          value = value[key] ?? null;
        } else {
          throw new RenderError(`index of ${formatted(key, false)} into a ${kindOf(value)}`);
        }
      }
      return value;
    }
    case "eq":
      if (args.length < 2) {
        throw new RenderError("eq takes at least two operands");
      }
      return args.slice(1).some((other) => compareBasic(name, first, other) === 0);
    case "ne":
      arity(2);
      return compareBasic(name, first, second) !== 0;
    case "lt":
    case "le":
    case "gt":
    case "ge": {
      arity(2);
      const order = compareBasic(name, first, second);
      if (Number.isNaN(order)) {
        throw new RenderError(`${name}: booleans have no order`);
      }
      return ordered(name, order);
    }
    case "print":
      return args
        .map((arg, i) => {
          const spaced = i > 0 && typeof arg !== "string" && typeof args[i - 1] !== "string";
          return `${spaced ? " " : ""}${formatted(arg, true)}`;
        })
        .join("");
    case "println":
      return `${args.map((arg) => formatted(arg, true)).join(" ")}\n`;
    case "printf":
      if (typeof first !== "string") {
        throw new RenderError("printf takes a format string first");
      }
      return printf(first, args.slice(1));
    default:
      throw new RenderError(`function ${JSON.stringify(name)} not defined`);
  }
}

/** One execution of a template over a document. */
class Execution {
  private readonly scopes: Map<string, Value>[];
  /** The rendering so far, in pieces of about {@link CHUNK_LENGTH}, the last still growing. */
  readonly pieces: string[] = [""];

  constructor(root: Value) {
    this.scopes = [new Map([["$", root]])];
  }

  private write(text: string): void {
    const last = this.pieces.length - 1;
    const held = (this.pieces[last] ?? "") + text;
    if (held.length >= CHUNK_LENGTH) {
      this.pieces[last] = held;
      this.pieces.push("");
    } else {
      this.pieces[last] = held;
    }
  }

  private lookup(name: string): Value {
    for (let i = this.scopes.length - 1; i >= 0; i -= 1) {
      const scope = this.scopes[i];
      if (scope?.has(name) === true) {
        return scope.get(name) ?? null;
      }
    }
    throw new RenderError(`undefined variable ${name}`);
  }

  private assign(name: string, value: Value): void {
    for (let i = this.scopes.length - 1; i >= 0; i -= 1) {
      const scope = this.scopes[i];
      if (scope?.has(name) === true) {
        scope.set(name, value);
        return;
      }
    }
    throw new RenderError(`undefined variable ${name}`);
  }

  private field(value: Value, names: readonly string[]): Value {
    let held = value;
    for (const name of names) {
      if (!isObject(held)) {
        throw new RenderError(`cannot evaluate field ${name} in a ${kindOf(held)}`);
      }
      if (!Object.hasOwn(held, name)) {
        throw new RenderError(`the document has no member ${JSON.stringify(name)} here`);
      }
      held = held[name] ?? null;
    }
    return held;
  }

  private arg(arg: Arg, dot: Value): Value {
    switch (arg.k) {
      case "dot":
        return dot;
      case "var":
        return this.lookup(arg.name);
      case "lit":
        return arg.value;
      case "pipe":
        return this.pipeline(arg.pipe, dot, false);
      case "field":
        return this.field(arg.recv === undefined ? dot : this.arg(arg.recv, dot), arg.names);
      case "func":
        return call(arg.name, []);
    }
  }

  private command(command: readonly Arg[], dot: Value, piped: Value | undefined): Value {
    const [head, ...rest] = command;
    if (head === undefined) {
      throw new RenderError("empty command");
    }
    if (head.k !== "func") {
      if (rest.length > 0 || piped !== undefined) {
        throw new RenderError("cannot give an argument to a non-function");
      }
      return this.arg(head, dot);
    }
    const operands = (): Value[] => {
      const values = rest.map((one) => this.arg(one, dot));
      return piped === undefined ? values : [...values, piped];
    };
    if (head.name === "and" || head.name === "or") {
      const all = [
        ...rest.map((one) => (): Value => this.arg(one, dot)),
        ...(piped === undefined ? [] : [(): Value => piped]),
      ];
      if (all.length === 0) {
        throw new RenderError(`${head.name} takes at least one operand`);
      }
      let value: Value = null;
      for (const operand of all) {
        value = operand();
        if (truthy(value) === (head.name === "or")) {
          return value;
        }
      }
      return value;
    }
    return call(head.name, operands());
  }

  private pipeline(pipe: Pipeline, dot: Value, declares: boolean): Value {
    let value: Value | undefined;
    for (const command of pipe.commands) {
      value = this.command(command, dot, value);
    }
    const result = value ?? null;
    const [only] = pipe.vars;
    if (only !== undefined && (declares || pipe.assign)) {
      if (pipe.assign) {
        this.assign(only, result);
      } else {
        this.scopes.at(-1)?.set(only, result);
      }
    }
    return result;
  }

  run(nodes: readonly Node[], dot: Value): void {
    for (const node of nodes) {
      switch (node.k) {
        case "text":
          this.write(node.text);
          break;
        case "action": {
          const value = this.pipeline(node.pipe, dot, true);
          if (node.pipe.vars.length === 0) {
            this.write(formatted(value, false));
          }
          break;
        }
        case "break":
        case "continue":
          throw new LoopStop(node.k);
        case "if":
        case "with": {
          this.scopes.push(new Map());
          try {
            const value = this.pipeline(node.pipe, dot, true);
            const taken = truthy(value);
            this.run(taken ? node.list : node.otherwise, taken && node.k === "with" ? value : dot);
          } finally {
            this.scopes.pop();
          }
          break;
        }
        case "range":
          this.range(node, dot);
          break;
      }
    }
  }

  private range(node: Control, dot: Value): void {
    this.scopes.push(new Map());
    try {
      const value = this.pipeline({ ...node.pipe, vars: [] }, dot, false);
      let entries: [Value, Value][];
      if (value === null) {
        entries = [];
      } else if (isList(value)) {
        entries = value.map((one, i) => [i, one]);
      } else if (isObject(value)) {
        entries = Object.keys(value)
          .sort()
          .map((key) => [key, value[key] ?? null]);
      } else {
        throw new RenderError(`range cannot iterate over a ${kindOf(value)}`);
      }
      if (entries.length === 0) {
        this.run(node.otherwise, dot);
        return;
      }
      const [first, second] = node.pipe.vars;
      for (const [key, element] of entries) {
        const scope = this.scopes.at(-1);
        if (second !== undefined && first !== undefined) {
          scope?.set(first, key);
          scope?.set(second, element);
        } else if (first !== undefined) {
          scope?.set(first, element);
        }
        try {
          this.run(node.list, element);
        } catch (stop: unknown) {
          if (!(stop instanceof LoopStop)) {
            throw stop;
          }
          if (stop.kind === "break") {
            break;
          }
        }
      }
    } finally {
      this.scopes.pop();
    }
  }
}

/**
 * One document as the JSON value it encodes: what `JSON.stringify` would write for it,
 * read back, without writing it. A member holding nothing is left out, and an array
 * element holding nothing, like a number that is not finite, is null.
 */
function plainOf(value: unknown): Value | undefined {
  if (Array.isArray(value)) {
    return value.map((element: unknown) => plainOf(element) ?? null);
  }
  if (typeof value === "object" && value !== null) {
    const held: Record<string, Value> = {};
    for (const [key, member] of Object.entries(value)) {
      const plain = plainOf(member);
      if (plain !== undefined) {
        held[key] = plain;
      }
    }
    return held;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" || typeof value === "boolean" || value === null) {
    return value;
  }
  return undefined;
}

/**
 * The template's rendering of one document, in pieces of about {@link CHUNK_LENGTH}.
 * The rendering is complete before it is answered, so a template that fails partway
 * renders nothing, and the failure names what it could not evaluate.
 */
export function renderTemplate(template: Template, document: unknown): readonly string[] {
  const root = plainOf(document) ?? null;
  const execution = new Execution(root);
  execution.run(template.nodes, root);
  return execution.pieces.filter((piece) => piece !== "");
}
