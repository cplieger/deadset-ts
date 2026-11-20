import type { Position } from "./position.ts";

/** A place inside a document: each member name a string, each array index a number. */
export type Place = readonly (string | number)[];

/**
 * A text that is not one strict JSON document: a syntax error, data after the value, a
 * member one object writes twice, or nesting past {@link MAX_DEPTH}. `place` is the
 * value the fault is in, followed by the member written twice.
 */
export class StrictJSONError extends Error {
  readonly offset: number;
  readonly place: Place;

  constructor(reason: string, offset: number, place: Place) {
    super(reason);
    this.name = "StrictJSONError";
    this.offset = offset;
    this.place = place;
  }
}

/** One strict JSON document, read whole. */
interface StrictDocument {
  readonly value: unknown;
  /**
   * The text of every number written with a fraction or an exponent, by its JSON
   * Pointer: a value reads `100.0` as the integer 100, so only the text tells them apart.
   */
  readonly fractions: ReadonlyMap<string, string>;
  /**
   * The offset of each value inside the top-level member a read names, by its index or
   * its member name, in document order.
   */
  readonly starts: ReadonlyMap<string | number, number>;
}

/**
 * How deep values may nest. A document this analyzer reads nests a few levels, and a
 * bound turns a document built to exhaust the stack into a refusal.
 */
const MAX_DEPTH = 1000;

/** The characters JSON reads as whitespace between tokens: space, tab, LF, CR. */
const WHITESPACE: ReadonlySet<number> = new Set([0x20, 0x09, 0x0a, 0x0d]);
/** What follows a backslash in a string token as a one-character escape: `"`, `\`, `/`, b, f, n, r, t. */
const SHORT_ESCAPES: ReadonlySet<number> = new Set([
  0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74,
]);
const HEX_DIGITS = /^[0-9A-Fa-f]{4}$/u;
const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/uy;
const LITERALS: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ["true", true],
  ["false", false],
  ["null", null],
]);

/** One member name spelled as a JSON Pointer token. */
const escaped = (name: string): string => name.replaceAll("~", "~0").replaceAll("/", "~1");

/** The member names and indexes a JSON Pointer holds, unescaped. */
export function pointerSegments(pointer: string): string[] {
  return pointer === ""
    ? []
    : pointer
        .slice(1)
        .split("/")
        .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** The JSON Pointer of a place written as segments. */
export function pointerOf(segments: readonly string[]): string {
  return segments.map((segment) => `/${escaped(segment)}`).join("");
}

/**
 * The place a JSON Pointer names inside `value`, followed by `member` where it is not
 * empty: a pointer's text does not say whether a segment of digits is an index, so the
 * value it points into does.
 */
export function placeIn(value: unknown, pointer: string, member = ""): (string | number)[] {
  const place: (string | number)[] = [];
  let held = value;
  for (const segment of pointerSegments(pointer)) {
    if (Array.isArray(held)) {
      place.push(Number(segment));
      held = held[Number(segment)];
    } else {
      place.push(segment);
      held = isRecord(held) ? held[segment] : undefined;
    }
  }
  return member === "" ? place : [...place, member];
}

/**
 * A place as a refusal names it: member names joined by full stops and an index in
 * square brackets, as `ts.serializers[0].returns`.
 */
export function dotted(place: Place): string {
  let path = "";
  for (const segment of place) {
    path +=
      typeof segment === "number" ? `[${String(segment)}]` : path === "" ? segment : `.${segment}`;
  }
  return path;
}

class Reader {
  private at = 0;
  private readonly path: (string | number)[] = [];
  readonly fractions = new Map<string, string>();
  readonly starts = new Map<string | number, number>();
  private readonly text: string;
  private readonly records: string | undefined;

  constructor(text: string, records: string | undefined) {
    this.text = text;
    this.records = records;
  }

  read(): unknown {
    const value = this.value(0);
    this.skipSpace();
    if (this.at < this.text.length) {
      this.fail("data follows the document's value");
    }
    return value;
  }

  private fail(reason: string, offset = this.at, member = ""): never {
    throw new StrictJSONError(
      reason,
      offset,
      member === "" ? [...this.path] : [...this.path, member],
    );
  }

  /**
   * The string token at the reader's place, read past, or undefined where none starts
   * there: scanned by hand, because a backtracking expression's stack grows with the
   * token's length and a document under the Contract's bound holds one of 16 Mi units.
   */
  private string(): string | undefined {
    const start = this.at;
    if (this.text.charCodeAt(start) !== 0x22) {
      return undefined;
    }
    for (let at = start + 1; at < this.text.length;) {
      const unit = this.text.charCodeAt(at);
      if (unit === 0x22) {
        this.at = at + 1;
        return this.text.slice(start, this.at);
      }
      if (unit < 0x20) {
        return undefined;
      }
      if (unit !== 0x5c) {
        at += 1;
      } else if (SHORT_ESCAPES.has(this.text.charCodeAt(at + 1))) {
        at += 2;
      } else if (this.text[at + 1] === "u" && HEX_DIGITS.test(this.text.slice(at + 2, at + 6))) {
        at += 6;
      } else {
        return undefined;
      }
    }
    return undefined;
  }

  /** Moves the reader past the run of JSON whitespace at its place: space, tab, LF and CR. */
  private skipSpace(): void {
    for (let unit = this.text.charCodeAt(this.at); WHITESPACE.has(unit);) {
      this.at += 1;
      unit = this.text.charCodeAt(this.at);
    }
  }

  private expect(char: string, what: string): void {
    this.skipSpace();
    if (this.text[this.at] !== char) {
      this.fail(`${what} is expected`);
    }
    this.at += 1;
  }

  private value(depth: number): unknown {
    this.skipSpace();
    if (depth > MAX_DEPTH) {
      this.fail(`values nest deeper than ${String(MAX_DEPTH)} levels`);
    }
    const char = this.text[this.at];
    if (char === "{") {
      return this.object(depth);
    }
    if (char === "[") {
      return this.array(depth);
    }
    const string = this.string();
    if (string !== undefined) {
      return JSON.parse(string) as string;
    }
    NUMBER.lastIndex = this.at;
    const number = NUMBER.exec(this.text);
    if (number !== null) {
      this.at = NUMBER.lastIndex;
      if (number[1] !== undefined || number[2] !== undefined) {
        this.fractions.set(pointerOf(this.path.map(String)), number[0]);
      }
      return Number(number[0]);
    }
    for (const [literal, held] of LITERALS) {
      if (this.text.startsWith(literal, this.at)) {
        this.at += literal.length;
        return held;
      }
    }
    return this.fail(
      char === undefined ? "the document ends where a value is expected" : "a value is expected",
    );
  }

  private object(depth: number): Record<string, unknown> {
    const held: Record<string, unknown> = {};
    this.at += 1;
    this.skipSpace();
    if (this.text[this.at] === "}") {
      this.at += 1;
      return held;
    }
    for (;;) {
      this.skipSpace();
      const offset = this.at;
      const spelled = this.string();
      if (spelled === undefined) {
        return this.fail("a member name is expected");
      }
      const name = JSON.parse(spelled) as string;
      if (Object.hasOwn(held, name)) {
        this.fail(
          `the member ${JSON.stringify(name)} is written twice, so neither value is chosen`,
          offset,
          name,
        );
      }
      this.expect(":", "a colon after the member name");
      if (depth === 1 && this.path[0] === this.records) {
        this.skipSpace();
        this.starts.set(name, this.at);
      }
      this.path.push(name);
      Object.defineProperty(held, name, {
        value: this.value(depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.path.pop();
      this.skipSpace();
      const next = this.text[this.at];
      this.at += 1;
      if (next === "}") {
        return held;
      }
      if (next !== ",") {
        this.at -= 1;
        this.fail("a comma or a closing brace is expected");
      }
    }
  }

  private array(depth: number): unknown[] {
    const held: unknown[] = [];
    const records = depth === 1 && this.path[0] === this.records;
    this.at += 1;
    this.skipSpace();
    if (this.text[this.at] === "]") {
      this.at += 1;
      return held;
    }
    for (;;) {
      this.skipSpace();
      if (records) {
        this.starts.set(held.length, this.at);
      }
      this.path.push(held.length);
      held.push(this.value(depth + 1));
      this.path.pop();
      this.skipSpace();
      const next = this.text[this.at];
      this.at += 1;
      if (next === "]") {
        return held;
      }
      if (next !== ",") {
        this.at -= 1;
        this.fail("a comma or a closing bracket is expected");
      }
    }
  }
}

/**
 * Reads `text` as one strict JSON document, or throws a {@link StrictJSONError}.
 * `records` names the top-level member whose values' offsets the read keeps.
 */
export function readStrict(text: string, records?: string): StrictDocument {
  const reader = new Reader(text, records);
  const value = reader.read();
  return { value, fractions: reader.fractions, starts: reader.starts };
}

/**
 * One offset of a document as a finding carries it: the line counted from one, and the
 * column counted from one in UTF-16 code units.
 */
export function positionAt(text: string, file: string, offset: number): Position {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { path: file, line: before.split("\n").length, column: offset - lineStart + 1 };
}

/** A strict read's fault with the line and column it is at, as a refusal states it. */
export function locatedFault(text: string, error: StrictJSONError): string {
  const { line, column } = positionAt(text, "", error.offset);
  return `line ${String(line)}, column ${String(column)}: ${error.message}`;
}

/** Whether a decoded JSON value is an object: not `null` and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
