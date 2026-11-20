/**
 * A matcher for the expressions the Contract publishes and this analyzer writes in their
 * dialect: `test` answers what a `RegExp` with the `u` flag answers, in time linear in the
 * input and on a stack that does not grow with it. V8's engine pushes one entry per
 * repetition of a group and overflows past a few million, and a document under the
 * Contract's 16 MiB bound holds a string of 16 Mi characters. Any construct outside the
 * dialect is refused when the expression is compiled.
 */

/** Sorted, disjoint, inclusive code-point ranges, as pairs of a low and a high bound. */
type Ranges = readonly number[];

type Node =
  | { readonly kind: "set"; readonly ranges: Ranges }
  | { readonly kind: "start" }
  | { readonly kind: "end" }
  | { readonly kind: "sequence"; readonly items: readonly Node[] }
  | { readonly kind: "alternation"; readonly options: readonly Node[] }
  | { readonly kind: "repeat"; readonly body: Node; readonly min: number; readonly max: number };

const MAX_POINT = 0x10ffff;
/** Past this many states an expression is refused, as no published expression comes near. */
const MAX_STATES = 100_000;
/** Past this many cached automaton states a step is computed and not kept. */
const MAX_CACHED = 10_000;

const DIGITS: Ranges = [0x30, 0x39];
const WORD: Ranges = [0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a];
/** ECMAScript's WhiteSpace and LineTerminator, which `\s` denotes. */
const SPACE: Ranges = [
  ...[0x09, 0x0d, 0x20, 0x20, 0xa0, 0xa0, 0x1680, 0x1680, 0x2000, 0x200a],
  ...[0x2028, 0x2029, 0x202f, 0x202f, 0x205f, 0x205f, 0x3000, 0x3000, 0xfeff, 0xfeff],
];
/** What `.` admits without the `s` flag: every code point but a line terminator. */
const DOT: Ranges = complement([0x0a, 0x0a, 0x0d, 0x0d, 0x2028, 0x2029]);
const SYNTAX = "^$\\.*+?()[]{}|/";

function normalized(ranges: readonly number[]): number[] {
  const pairs: [number, number][] = [];
  for (let at = 0; at + 1 < ranges.length; at += 2) {
    pairs.push([ranges[at] ?? 0, ranges[at + 1] ?? 0]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  for (const [low, high] of pairs) {
    const last = out.length - 1;
    if (out.length > 0 && low <= (out[last] ?? 0) + 1) {
      out[last] = Math.max(out[last] ?? 0, high);
    } else {
      out.push(low, high);
    }
  }
  return out;
}

function complement(ranges: Ranges): number[] {
  const set = normalized(ranges);
  const out: number[] = [];
  let next = 0;
  for (let at = 0; at < set.length; at += 2) {
    if ((set[at] ?? 0) > next) {
      out.push(next, (set[at] ?? 0) - 1);
    }
    next = (set[at + 1] ?? 0) + 1;
  }
  if (next <= MAX_POINT) {
    out.push(next, MAX_POINT);
  }
  return out;
}

/** Reads one expression into its tree, refusing any construct outside the dialect. */
class Parser {
  private at = 0;
  private readonly points: readonly number[];
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
    this.points = Array.from(source, (character) => character.codePointAt(0) ?? 0);
  }

  parse(): Node {
    const node = this.alternation();
    if (this.at < this.points.length) {
      this.fail("an unmatched )");
    }
    return node;
  }

  private fail(what: string): never {
    throw new SyntaxError(`expression: ${what} at ${String(this.at)} in ${this.source}`);
  }

  private peek(offset = 0): number | undefined {
    return this.points[this.at + offset];
  }

  private eat(point: number): boolean {
    if (this.peek() === point) {
      this.at += 1;
      return true;
    }
    return false;
  }

  private alternation(): Node {
    const options = [this.sequence()];
    while (this.eat(0x7c)) {
      options.push(this.sequence());
    }
    const [only] = options;
    return options.length === 1 && only !== undefined ? only : { kind: "alternation", options };
  }

  private sequence(): Node {
    const items: Node[] = [];
    for (
      let point = this.peek();
      point !== undefined && point !== 0x7c && point !== 0x29;
      point = this.peek()
    ) {
      items.push(this.quantified(this.atom()));
    }
    return { kind: "sequence", items };
  }

  private atom(): Node {
    const point = this.peek() ?? 0;
    this.at += 1;
    switch (point) {
      case 0x5e:
        return { kind: "start" };
      case 0x24:
        return { kind: "end" };
      case 0x2e:
        return { kind: "set", ranges: DOT };
      case 0x5b:
        return { kind: "set", ranges: this.characterClass() };
      case 0x28:
        return this.group();
      case 0x5c:
        return { kind: "set", ranges: this.escape(false) };
      case 0x29:
      case 0x2a:
      case 0x2b:
      case 0x3f:
      case 0x7b:
      case 0x7d:
      case 0x5d:
        return this.fail(`a lone ${String.fromCodePoint(point)}`);
      default:
        return { kind: "set", ranges: [point, point] };
    }
  }

  private group(): Node {
    if (this.eat(0x3f)) {
      if (!this.eat(0x3a)) {
        this.fail("a group other than (?:");
      }
    }
    const inner = this.alternation();
    if (!this.eat(0x29)) {
      this.fail("an unclosed group");
    }
    return inner;
  }

  private quantified(node: Node): Node {
    let min: number;
    let max: number;
    const point = this.peek();
    if (point === 0x2a || point === 0x2b || point === 0x3f) {
      this.at += 1;
      [min, max] = point === 0x2a ? [0, Infinity] : point === 0x2b ? [1, Infinity] : [0, 1];
    } else if (point === 0x7b) {
      this.at += 1;
      min = this.number();
      max = min;
      if (this.eat(0x2c)) {
        max = this.peek() === 0x7d ? Infinity : this.number();
      }
      if (!this.eat(0x7d) || max < min) {
        this.fail("a malformed {n,m}");
      }
    } else {
      return node;
    }
    if (node.kind === "start" || node.kind === "end") {
      this.fail("a quantified assertion");
    }
    // A lazy quantifier matches the same strings; test asks only whether one exists.
    this.eat(0x3f);
    return { kind: "repeat", body: node, min, max };
  }

  private number(): number {
    let digits = "";
    for (
      let point = this.peek();
      point !== undefined && point >= 0x30 && point <= 0x39;
      point = this.peek()
    ) {
      digits += String.fromCodePoint(point);
      this.at += 1;
    }
    if (digits === "") {
      this.fail("a {n,m} with no number");
    }
    return Number(digits);
  }

  private characterClass(): number[] {
    const negated = this.eat(0x5e);
    const ranges: number[] = [];
    while (!this.eat(0x5d)) {
      if (this.peek() === undefined) {
        this.fail("an unclosed class");
      }
      const low = this.classAtom();
      if (this.peek() === 0x2d && this.peek(1) !== 0x5d && this.peek(1) !== undefined) {
        this.at += 1;
        const high = this.classAtom();
        if (low.length !== 2 || high.length !== 2 || low[0] !== low[1] || high[0] !== high[1]) {
          this.fail("a range bounded by a class escape");
        }
        if ((high[0] ?? 0) < (low[0] ?? 0)) {
          this.fail("a range out of order");
        }
        ranges.push(low[0] ?? 0, high[0] ?? 0);
      } else {
        ranges.push(...low);
      }
    }
    return negated ? complement(ranges) : normalized(ranges);
  }

  private classAtom(): readonly number[] {
    const point = this.peek() ?? 0;
    this.at += 1;
    if (point !== 0x5c) {
      return [point, point];
    }
    return this.escape(true);
  }

  /** One escape after its backslash, as the ranges it denotes. */
  private escape(inClass: boolean): readonly number[] {
    const point = this.peek();
    if (point === undefined) {
      return this.fail("a trailing backslash");
    }
    this.at += 1;
    const single = (value: number): readonly number[] => [value, value];
    switch (String.fromCodePoint(point)) {
      case "d":
        return DIGITS;
      case "D":
        return complement(DIGITS);
      case "w":
        return WORD;
      case "W":
        return complement(WORD);
      case "s":
        return normalized(SPACE);
      case "S":
        return complement(SPACE);
      case "t":
        return single(0x09);
      case "n":
        return single(0x0a);
      case "v":
        return single(0x0b);
      case "f":
        return single(0x0c);
      case "r":
        return single(0x0d);
      case "0":
        if (this.isDigit(this.peek())) {
          this.fail("an octal escape");
        }
        return single(0);
      case "x":
        return single(this.hex(2));
      case "u":
        return single(this.unicodeEscape());
      case "b":
        return inClass ? single(0x08) : this.fail("a word boundary");
      case "-":
        return inClass ? single(0x2d) : this.fail("an escaped - outside a class");
      default:
        return SYNTAX.includes(String.fromCodePoint(point))
          ? single(point)
          : this.fail("an escape outside the dialect");
    }
  }

  private isDigit(point: number | undefined): boolean {
    return point !== undefined && point >= 0x30 && point <= 0x39;
  }

  private hex(length: number): number {
    const digits = this.points.slice(this.at, this.at + length);
    if (digits.length !== length || !digits.every(isHexDigit)) {
      this.fail("a malformed hexadecimal escape");
    }
    this.at += length;
    return Number.parseInt(String.fromCodePoint(...digits), 16);
  }

  private unicodeEscape(): number {
    if (this.eat(0x7b)) {
      let digits = "";
      while (!this.eat(0x7d)) {
        const point = this.peek();
        if (point === undefined || !isHexDigit(point)) {
          this.fail("a malformed \\u{...}");
        }
        digits += String.fromCodePoint(point);
        this.at += 1;
      }
      const value = Number.parseInt(digits, 16);
      if (digits === "" || value > MAX_POINT) {
        this.fail("a \\u{...} past U+10FFFF");
      }
      return value;
    }
    const value = this.hex(4);
    // Under the u flag an escaped surrogate pair is the one code point it encodes.
    if (value >= 0xd800 && value <= 0xdbff && this.peek() === 0x5c && this.peek(1) === 0x75) {
      const at = this.at;
      this.at += 2;
      const digits = this.points.slice(this.at, this.at + 4);
      const low = digits.length === 4 && digits.every(isHexDigit) ? this.hex(4) : -1;
      if (low >= 0xdc00 && low <= 0xdfff) {
        return 0x10000 + ((value - 0xd800) << 10) + (low - 0xdc00);
      }
      this.at = at;
    }
    return value;
  }
}

const SET = 0;
const SPLIT = 1;
const START = 2;
const END = 3;
const MATCH = 4;
type Op = typeof SET | typeof SPLIT | typeof START | typeof END | typeof MATCH;

interface State {
  readonly op: Op;
  readonly ranges: Ranges;
  out: number;
  out1: number;
}

/** A Thompson automaton under construction: each fragment's start and its dangling exits. */
interface Fragment {
  readonly start: number;
  readonly exits: readonly (readonly [number, "out" | "out1"])[];
}

class Builder {
  readonly states: State[] = [];

  private add(op: Op, ranges: Ranges = [], out = -1, out1 = -1): number {
    if (this.states.length >= MAX_STATES) {
      throw new SyntaxError(`expression: more than ${String(MAX_STATES)} states`);
    }
    this.states.push({ op, ranges, out, out1 });
    return this.states.length - 1;
  }

  private patch(exits: Fragment["exits"], to: number): void {
    for (const [state, slot] of exits) {
      const held = this.states[state];
      if (held !== undefined) {
        held[slot] = to;
      }
    }
  }

  private empty(): Fragment {
    const state = this.add(SPLIT);
    return { start: state, exits: [[state, "out"]] };
  }

  fragment(node: Node): Fragment {
    switch (node.kind) {
      case "set": {
        const state = this.add(SET, node.ranges);
        return { start: state, exits: [[state, "out"]] };
      }
      case "start":
      case "end": {
        const state = this.add(node.kind === "start" ? START : END);
        return { start: state, exits: [[state, "out"]] };
      }
      case "sequence":
        return this.sequence(node.items.map((item) => () => this.fragment(item)));
      case "alternation": {
        const parts = node.options.map((option) => this.fragment(option));
        let joined = parts[0] ?? this.empty();
        for (const part of parts.slice(1)) {
          const split = this.add(SPLIT, [], joined.start, part.start);
          joined = { start: split, exits: [...joined.exits, ...part.exits] };
        }
        return joined;
      }
      case "repeat":
        return this.repeat(node);
    }
  }

  private sequence(parts: readonly (() => Fragment)[]): Fragment {
    const [head, ...rest] = parts;
    if (head === undefined) {
      return this.empty();
    }
    const first = head();
    let exits = first.exits;
    for (const part of rest) {
      const built = part();
      this.patch(exits, built.start);
      exits = built.exits;
    }
    return { start: first.start, exits };
  }

  private repeat(node: Extract<Node, { kind: "repeat" }>): Fragment {
    const parts: (() => Fragment)[] = [];
    for (let one = 0; one < node.min; one += 1) {
      parts.push(() => this.fragment(node.body));
    }
    if (node.max === Infinity) {
      parts.push(() => {
        const body = this.fragment(node.body);
        const split = this.add(SPLIT, [], body.start, -1);
        this.patch(body.exits, split);
        return { start: split, exits: [[split, "out1"]] };
      });
    } else {
      for (let one = node.min; one < node.max; one += 1) {
        parts.push(() => {
          const body = this.fragment(node.body);
          const split = this.add(SPLIT, [], body.start, -1);
          return { start: split, exits: [...body.exits, [split, "out1"]] };
        });
      }
    }
    return this.sequence(parts);
  }
}

interface AutomatonState {
  /** The automaton's states this one stands for, each a set state, the match or a pending `$`. */
  readonly kernel: readonly number[];
  readonly matched: boolean;
  matchedAtEnd: boolean | undefined;
  readonly next: (AutomatonState | undefined)[];
}

/** One compiled expression; `test` answers what `RegExp.prototype.test` answers under `u`. */
export class Expression {
  private readonly states: readonly State[];
  private readonly start: number;
  private readonly cuts: readonly number[];
  private readonly ascii: Uint16Array;
  /** For each set state, whether it admits each class of code points. */
  private readonly admits: readonly (readonly boolean[] | undefined)[];
  private readonly restarts: boolean;
  private readonly cache = new Map<string, AutomatonState>();
  private readonly initial: AutomatonState;
  readonly source: string;

  constructor(source: string) {
    this.source = source;
    const builder = new Builder();
    const root = builder.fragment(new Parser(source).parse());
    const match = builder.states.length;
    builder.states.push({ op: MATCH, ranges: [], out: -1, out1: -1 });
    for (const [state, slot] of root.exits) {
      const held = builder.states[state];
      if (held !== undefined) {
        held[slot] = match;
      }
    }
    this.states = builder.states;
    this.start = root.start;
    const cuts = new Set<number>();
    for (const state of this.states) {
      for (let at = 0; at < state.ranges.length; at += 2) {
        cuts.add(state.ranges[at] ?? 0);
        cuts.add((state.ranges[at + 1] ?? 0) + 1);
      }
    }
    this.cuts = [...cuts].filter((cut) => cut > 0 && cut <= MAX_POINT).sort((a, b) => a - b);
    this.ascii = Uint16Array.from({ length: 0x80 }, (_, point) => this.classAt(point));
    const lows = [0, ...this.cuts];
    this.admits = this.states.map((state) =>
      state.op === SET ? lows.map((low) => contains(state.ranges, low)) : undefined,
    );
    this.restarts = this.closure([this.start], false, false).length > 0;
    this.initial = this.state(this.closure([this.start], true, false));
  }

  /** Whether some part of `value` matches, as `RegExp.prototype.test` with the `u` flag answers. */
  test(value: string): boolean {
    if (value === "") {
      return this.closure([this.start], true, true).includes(this.states.length - 1);
    }
    let current = this.initial;
    for (let at = 0; at < value.length;) {
      if (current.matched) {
        return true;
      }
      const point = value.codePointAt(at) ?? 0;
      at += point > 0xffff ? 2 : 1;
      const index = point < 0x80 ? (this.ascii[point] ?? 0) : this.classAt(point);
      current = current.next[index] ?? this.step(current, index);
      if (current.kernel.length === 0) {
        return false;
      }
    }
    if (current.matched) {
      return true;
    }
    current.matchedAtEnd ??= this.closure(current.kernel, false, true).includes(
      this.states.length - 1,
    );
    return current.matchedAtEnd;
  }

  private classAt(point: number): number {
    let low = 0;
    let high = this.cuts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((this.cuts[middle] ?? 0) <= point) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  private step(from: AutomatonState, index: number): AutomatonState {
    const reached: number[] = [];
    for (const state of from.kernel) {
      if (this.admits[state]?.[index] === true) {
        reached.push(this.states[state]?.out ?? -1);
      }
    }
    if (this.restarts) {
      reached.push(this.start);
    }
    const next = this.state(this.closure(reached, false, false));
    if (this.cache.size < MAX_CACHED) {
      from.next[index] = next;
    }
    return next;
  }

  private state(kernel: readonly number[]): AutomatonState {
    const key = kernel.join(",");
    const held = this.cache.get(key);
    if (held !== undefined) {
      return held;
    }
    const made: AutomatonState = {
      kernel,
      matched: kernel.includes(this.states.length - 1),
      matchedAtEnd: undefined,
      next: Array.from<AutomatonState | undefined>({ length: this.cuts.length + 1 }),
    };
    if (this.cache.size < MAX_CACHED) {
      this.cache.set(key, made);
    }
    return made;
  }

  /**
   * The states reachable from `from` through no character: a `^` passes only at the
   * start, a `$` only at the end, and one that cannot pass yet is kept, pending.
   */
  private closure(from: readonly number[], atStart: boolean, atEnd: boolean): number[] {
    const seen = new Set<number>();
    const kept: number[] = [];
    const stack = [...from];
    while (stack.length > 0) {
      const id = stack.pop() ?? -1;
      const state = this.states[id];
      if (state === undefined || seen.has(id)) {
        continue;
      }
      seen.add(id);
      switch (state.op) {
        case SPLIT:
          stack.push(state.out);
          if (state.out1 >= 0) {
            stack.push(state.out1);
          }
          break;
        case START:
          if (atStart) {
            stack.push(state.out);
          }
          break;
        case END:
          if (atEnd) {
            stack.push(state.out);
          } else {
            kept.push(id);
          }
          break;
        default:
          kept.push(id);
      }
    }
    return kept.sort((a, b) => a - b);
  }
}

function isHexDigit(point: number): boolean {
  return (
    (point >= 0x30 && point <= 0x39) ||
    (point >= 0x41 && point <= 0x46) ||
    (point >= 0x61 && point <= 0x66)
  );
}

function contains(ranges: Ranges, point: number): boolean {
  for (let at = 0; at < ranges.length; at += 2) {
    if ((ranges[at] ?? 0) <= point && point <= (ranges[at + 1] ?? 0)) {
      return true;
    }
  }
  return false;
}

const compiled = new Map<string, Expression>();

/** The compiled expression of one source, compiled once. */
export function expression(source: string): Expression {
  let held = compiled.get(source);
  if (held === undefined) {
    held = new Expression(source);
    compiled.set(source, held);
  }
  return held;
}
