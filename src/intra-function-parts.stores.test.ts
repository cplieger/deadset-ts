import { describe, expect, it } from "vitest";
import { LOAD_TIMEOUT, partsOf, tsconfigWith } from "../__test-helpers__/intra-function-parts.ts";

describe("a local whose writes are judged", () => {
  it(
    "is a var of a nested block, whose write another one overwrites in the block before any read",
    () => {
      expect(
        partsOf([
          "function hoisted(flag: boolean): number | undefined {",
          "  if (flag) {",
          "    var value: number | undefined = 1;",
          "    value = 2;",
          "  }",
          "  return value;",
          "}",
          "",
          "function captured(flag: boolean): () => number | undefined {",
          "  if (flag) {",
          "    var held: number | undefined = 1;",
          "    held = 2;",
          "  }",
          "  return () => held;",
          "}",
          "",
          "console.log(hoisted(true), captured(true));",
        ]),
      ).toEqual(["DS1404 value src/main.ts:3"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "keeps the last write of a var of a nested block, read past the block's end, and is no using or await using declaration, which disposal reads",
    () => {
      expect(
        partsOf(
          [
            "function open(): Disposable {",
            "  return { [Symbol.dispose]() {} };",
            "}",
            "",
            "function openLater(): AsyncDisposable {",
            "  return { async [Symbol.asyncDispose]() {} };",
            "}",
            "",
            "function hoisted(flag: boolean): number | undefined {",
            "  if (flag) {",
            "    var value: number | undefined = 1;",
            "  }",
            "  return value;",
            "}",
            "",
            "function disposed(): number {",
            "  using handle = open();",
            "  return 1;",
            "}",
            "",
            "async function disposedLater(): Promise<number> {",
            "  await using handle = openLater();",
            "  return 1;",
            "}",
            "",
            "console.log(hoisted(true), disposed(), disposedLater());",
          ],
          { files: { "tsconfig.json": tsconfigWith({ lib: ["ESNext", "ESNext.Disposable"] }) } },
        ),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is written by no declaration that initializes nothing",
    () => {
      expect(
        partsOf([
          "function later(): number {",
          "  let value: number;",
          "  value = 1;",
          "  return value;",
          "}",
          "",
          "console.log(later());",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a read of a local", () => {
  it(
    "is no shorthand property of another local's name",
    () => {
      expect(
        partsOf([
          "function packed(): object {",
          "  const other = 3;",
          "  let value = 1;",
          "  console.log({ other });",
          "  value = 2;",
          "  return { value };",
          "}",
          "",
          "console.log(packed());",
        ]),
      ).toEqual(["DS1404 value src/main.ts:3"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is no name a nested block's own declaration binds",
    () => {
      expect(
        partsOf([
          "function shadowed(): number {",
          "  let value = 1;",
          "  {",
          "    const value = 2;",
          "    console.log(value);",
          "  }",
          "  value = 3;",
          "  return value;",
          "}",
          "",
          "console.log(shadowed());",
        ]),
      ).toEqual(["DS1404 value src/main.ts:2"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is a compound assignment, and the value of the next plain write",
    () => {
      expect(
        partsOf([
          "function compound(): number {",
          "  let value = 1;",
          "  value += 2;",
          "  return value;",
          "}",
          "",
          "function incremented(): number {",
          "  let value = 1;",
          "  value = value + 1;",
          "  return value;",
          "}",
          "",
          "console.log(compound(), incremented());",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is a later declarator of the statement that declares the local",
    () => {
      expect(
        partsOf([
          "function copied(): number {",
          "  let value = 1,",
          "    copy = value;",
          "  value = 2;",
          "  return copy + value;",
          "}",
          "",
          "console.log(copied());",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a write to a local no read reaches", () => {
  it(
    "is a plain assignment no later statement of the block reads",
    () => {
      expect(
        partsOf([
          "function discarded(): number {",
          "  let value = 1;",
          "  console.log(value);",
          "  value = 2;",
          "  return 0;",
          "}",
          "",
          "console.log(discarded());",
        ]),
      ).toEqual(["DS1404 value src/main.ts:4"]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a local a declaration's pattern, a loop or the function's body declares", () => {
  it(
    "is each name of an object pattern but one beside a rest element or with a default",
    () => {
      expect(
        partsOf([
          "function pick(meta: { request: number; response: number; extra: number }): number {",
          "  const { request, response } = meta;",
          "  const { request: first, ...rest } = meta;",
          "  const { extra = 1, response: second } = meta;",
          "  return request + rest.response + second;",
          "}",
          "",
          "console.log(pick({ request: 1, response: 2, extra: 3 }));",
        ]),
      ).toEqual(["DS1404 response src/main.ts:2"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is a for-of or for-in variable the loop body never reads, written at each iteration, unless its name starts with an underscore",
    () => {
      expect(
        partsOf([
          "function sum(map: Map<string, number>, obj: Record<string, number>): number {",
          "  let total = 0;",
          "  for (const [key, value] of map) total += value;",
          "  for (const k in obj) total += 1;",
          "  for (const name in obj) total += obj[name] ?? 0;",
          "  for (const _ of map) total += 1;",
          "  return total;",
          "}",
          "",
          "console.log(sum(new Map(), {}));",
        ]),
      ).toEqual(["DS1404 key src/main.ts:3", "DS1404 k src/main.ts:4"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is a var of the function's own body, judged as a let is",
    () => {
      expect(
        partsOf([
          "function hoisted(): number {",
          "  var value = 1;",
          "  value = 2;",
          "  return value;",
          "}",
          "",
          "console.log(hoisted());",
        ]),
      ).toEqual(["DS1404 value src/main.ts:2"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is a local only nested functions name, each write of which is dead where nothing reads it",
    () => {
      expect(
        partsOf([
          "function setup(): () => void {",
          "  let seen: number;",
          "  let read = 0;",
          "  const later = (): void => {",
          "    seen = 1;",
          "    read = 2;",
          "  };",
          "  return () => {",
          "    later();",
          "    console.log(read);",
          "  };",
          "}",
          "",
          "setup()();",
        ]),
      ).toEqual(["DS1404 seen src/main.ts:5"]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a local that nothing reads and nothing initializes", () => {
  it(
    "is a dead store at its name, and only the writes are where it is written later",
    () => {
      expect(
        partsOf([
          "function bare(): number {",
          "  var never;",
          "  let assigned;",
          "  assigned = 2;",
          "  return 1;",
          "}",
          "",
          "console.log(bare());",
        ]),
      ).toEqual(["DS1404 never src/main.ts:2", "DS1404 assigned src/main.ts:4"]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a function declaration of a function's body", () => {
  it(
    "is a dead store at its name where nothing but its own body reads it, and kept by a read before or after it",
    () => {
      expect(
        partsOf([
          "function outer(n: number): number {",
          "  function unused(): number {",
          "    return 1;",
          "  }",
          "  function recursive(k: number): number {",
          "    return k > 0 ? recursive(k - 1) : 0;",
          "  }",
          "  function later(): number {",
          "    return 2;",
          "  }",
          "  return n + later() + earlier();",
          "  function earlier(): number {",
          "    return 3;",
          "  }",
          "}",
          "",
          "console.log(outer(1));",
        ]),
      ).toEqual(["DS1404 unused src/main.ts:2", "DS1404 recursive src/main.ts:5"]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a local typed never", () => {
  it(
    "is no subject, written in a default arm or initialized past a narrowing, beside a local that is one",
    () => {
      expect(
        partsOf([
          'type Key = "a" | "b";',
          "",
          "function assigned(key: Key): number {",
          "  let check: never;",
          "  switch (key) {",
          '    case "a":',
          "      return 1;",
          '    case "b":',
          "      return 2;",
          "    default:",
          "      check = key;",
          "      return 0;",
          "  }",
          "}",
          "",
          "function initialized(key: Key): number {",
          '  if (key === "a" || key === "b") {',
          "    return 1;",
          "  }",
          "  const unreached: never = key;",
          "  const other: string = key;",
          "  return 0;",
          "}",
          "",
          'console.log(assigned("a"), initialized("b"));',
        ]),
      ).toEqual(["DS1404 other src/main.ts:21"]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a write the next write overwrites on every path", () => {
  it(
    "is dead across both branches of an if statement, and kept by a branch that reads it or leaves it",
    () => {
      expect(
        partsOf([
          "function branched(flag: boolean): number {",
          "  let value = 1;",
          "  if (flag) {",
          "    value = 2;",
          "  } else {",
          "    value = 3;",
          "  }",
          "  return value;",
          "}",
          "",
          "function thenOnly(flag: boolean): number {",
          "  let value = 1;",
          "  if (flag) {",
          "    value = 2;",
          "  }",
          "  return value;",
          "}",
          "",
          "function readFirst(flag: boolean): number {",
          "  let value = 1;",
          "  if (flag) {",
          "    console.log(value);",
          "    value = 2;",
          "  } else {",
          "    value = 3;",
          "  }",
          "  return value;",
          "}",
          "",
          "console.log(branched(true), thenOnly(true), readFirst(true));",
        ]),
      ).toEqual(["DS1404 value src/main.ts:2"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is dead in a loop body the next iteration and the code after the loop overwrite, and kept by a read the next iteration makes",
    () => {
      expect(
        partsOf([
          "function last(items: readonly number[]): number {",
          "  let value = 0;",
          "  for (const item of items) {",
          "    value = item;",
          "  }",
          "  value = -1;",
          "  return value;",
          "}",
          "",
          "function carried(items: readonly number[]): number {",
          "  let total = 0;",
          "  let previous = 0;",
          "  for (const item of items) {",
          "    total += item - previous;",
          "    previous = item;",
          "  }",
          "  return total;",
          "}",
          "",
          "function polled(next: () => boolean): number {",
          "  let tries = 0;",
          "  while (next()) {",
          "    tries = tries + 1;",
          "  }",
          "  do {",
          "    tries = 5;",
          "  } while (tries < 3);",
          "  for (let at = 0; at < tries; at++) {",
          "    tries = at;",
          "  }",
          "  return tries;",
          "}",
          "",
          "console.log(last([1]), carried([1]), polled(() => false));",
        ]),
      ).toEqual(["DS1404 value src/main.ts:2", "DS1404 value src/main.ts:4"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is dead where every clause of a switch with a default overwrites it, and through a clause that falls into an overwrite",
    () => {
      expect(
        partsOf([
          "function named(kind: number): string {",
          '  let label = "";',
          "  switch (kind) {",
          "    case 1:",
          '      label = "one";',
          "    case 2:",
          '      label = "two";',
          "      break;",
          "    default:",
          '      label = "other";',
          "  }",
          "  return label;",
          "}",
          "",
          "function partial(kind: number): string {",
          '  let label = "";',
          "  switch (kind) {",
          "    case 1:",
          '      label = "one";',
          "      break;",
          "  }",
          "  return label;",
          "}",
          "",
          "console.log(named(1), partial(1));",
        ]),
      ).toEqual(["DS1404 label src/main.ts:2", "DS1404 label src/main.ts:5"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is kept where a labelled break or a continue carries it to a read",
    () => {
      expect(
        partsOf([
          "function labelled(flag: boolean): number {",
          "  let value = 1;",
          "  block: {",
          "    if (flag) {",
          "      break block;",
          "    }",
          "    value = 2;",
          "  }",
          "  return value;",
          "}",
          "",
          "function skipped(items: readonly number[]): number {",
          "  let value = 0;",
          "  outer: for (const item of items) {",
          "    for (const other of items) {",
          "      if (item < other) {",
          "        value = item;",
          "        continue outer;",
          "      }",
          "    }",
          "    value = 1;",
          "  }",
          "  return value;",
          "}",
          "",
          "console.log(labelled(true), skipped([1]));",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is kept where a jump names any label of a chain that labels its loop",
    () => {
      expect(
        partsOf([
          "function continued(more: () => boolean): number {",
          "  let value = 0;",
          "  outer: inner: while (more()) {",
          "    if (value > 0) break inner;",
          "    value = 1;",
          "    continue outer;",
          "  }",
          "  return 0;",
          "}",
          "",
          "function left(more: () => boolean): number {",
          "  let value = 0;",
          "  outer: inner: for (; more(); ) {",
          "    value = 1;",
          "    break outer;",
          "  }",
          "  return value;",
          "}",
          "",
          "console.log(continued(() => false), left(() => false));",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is written by a loop's head, a for statement's initializer and incrementor, and the name a for...of assigns",
    () => {
      expect(
        partsOf([
          "function initialized(limit: number): number {",
          "  let value = 1;",
          "  for (value = 2; value < limit; value++) return value;",
          "  return 0;",
          "}",
          "",
          "function commas(limit: number): number {",
          "  let index = 0;",
          "  for (index = 1, index = 2; index < limit; index++) {}",
          "  return index;",
          "}",
          "",
          "function incremented(more: () => boolean): number {",
          "  let value = 0;",
          "  for (; more(); value = 3) {",
          "    value = 4;",
          "    console.log(value);",
          "  }",
          "  return 0;",
          "}",
          "",
          "function iterated(items: readonly number[]): number {",
          "  let value = 1;",
          "  for (value of items) {",
          "    console.log(value);",
          "  }",
          "  return 0;",
          "}",
          "",
          "function failed(items: Iterable<number>): number {",
          "  let value = 1;",
          "  try {",
          "    for (value of items) {",
          "      value = 2;",
          "    }",
          "  } catch {",
          "    return value;",
          "  }",
          "  return 0;",
          "}",
          "",
          "console.log(initialized(1), commas(1), incremented(() => false), iterated([]), failed([]));",
        ]),
      ).toEqual([
        "DS1404 value src/main.ts:2",
        "DS1404 index src/main.ts:8",
        "DS1404 index src/main.ts:9",
        "DS1404 value src/main.ts:14",
        "DS1404 value src/main.ts:15",
        "DS1404 value src/main.ts:23",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is dead where a loop or a branch the compiler always takes overwrites it, by a missing or constant condition",
    () => {
      expect(
        partsOf([
          "function endless(): number {",
          "  let value = 1;",
          "  for (;;) {",
          "    value = 2;",
          "    break;",
          "  }",
          "  return value;",
          "}",
          "",
          "function always(): number {",
          "  let value = 1;",
          "  while (true) {",
          "    value = 2;",
          "    break;",
          "  }",
          "  return value;",
          "}",
          "",
          "function literal(): number {",
          "  let value = 1;",
          "  for (; true; ) {",
          "    value = 2;",
          "    break;",
          "  }",
          "  return value;",
          "}",
          "",
          "function compound(more: () => boolean): number {",
          "  let value = 1;",
          "  while (!(more() && false)) {",
          "    value = 2;",
          "    break;",
          "  }",
          "  return value;",
          "}",
          "",
          "function once(): number {",
          "  let value = 0;",
          "  do {",
          "    console.log(value);",
          "    value = 2;",
          "  } while (false);",
          "  return 0;",
          "}",
          "",
          "function taken(): number {",
          "  let value = 1;",
          "  if (true) {",
          "    value = 2;",
          "  } else {",
          "    console.log(value);",
          "  }",
          "  return value;",
          "}",
          "",
          "console.log(endless(), always(), literal(), compound(() => false), once(), taken());",
        ]),
      ).toEqual([
        "DS1404 value src/main.ts:2",
        "DS1404 value src/main.ts:11",
        "DS1404 value src/main.ts:20",
        "DS1404 value src/main.ts:29",
        "DS1404 value src/main.ts:41",
        "DS1404 value src/main.ts:47",
        "DS1405 statement src/main.ts:51",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is dead where only a constant loop test, which cannot throw, stands between it and the next write, and kept where the test runs a call",
    () => {
      expect(
        partsOf([
          "function literal(more: () => boolean): number {",
          "  let value = 0;",
          "  try {",
          "    for (; more(); value = 2) {",
          "      for (value = 1; false; ) console.log(0);",
          "    }",
          "  } finally {",
          "    console.log(value);",
          "  }",
          "  return 0;",
          "}",
          "",
          "function once(more: () => boolean): number {",
          "  let value = 0;",
          "  try {",
          "    for (; more(); value = 2) {",
          "      do {",
          "        value = 1;",
          "      } while (false);",
          "    }",
          "  } finally {",
          "    console.log(value);",
          "  }",
          "  return 0;",
          "}",
          "",
          "function called(more: () => boolean): number {",
          "  let value = 0;",
          "  try {",
          "    for (; more(); value = 2) {",
          "      for (value = 1; more(); ) console.log(0);",
          "    }",
          "  } finally {",
          "    console.log(value);",
          "  }",
          "  return 0;",
          "}",
          "",
          "console.log(literal(() => false), once(() => false), called(() => false));",
        ]),
      ).toEqual([
        "DS1404 value src/main.ts:5",
        "DS1405 statement src/main.ts:5",
        "DS1404 value src/main.ts:18",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is kept where a loop's incrementor may throw to a finally that reads it, whatever the condition",
    () => {
      expect(
        partsOf([
          "declare function tick(): void;",
          "declare function more(): boolean;",
          "",
          "function ended(): void {",
          "  let x = 0;",
          "  try {",
          "    for (x = 7; ; tick()) {}",
          "  } finally {",
          "    console.log(x);",
          "  }",
          "}",
          "",
          "function always(): void {",
          "  let y = 0;",
          "  try {",
          "    for (y = 7; true; tick()) {}",
          "  } finally {",
          "    console.log(y);",
          "  }",
          "}",
          "",
          "function tested(): void {",
          "  let z = 0;",
          "  try {",
          "    for (z = 7; more(); tick()) {}",
          "  } finally {",
          "    console.log(z);",
          "  }",
          "}",
          "",
          "ended();",
          "always();",
          "tested();",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is dead where a loop's condition short-circuits past every call, and kept where a call it runs may throw",
    () => {
      const forever = (name: string, condition: string): string[] => [
        `function ${name}(): void {`,
        "  let value = 1;",
        "  try {",
        `    for (value = 2; ${condition}; ) {}`,
        "  } finally {",
        "    console.log(value);",
        "  }",
        "}",
        "",
      ];
      const never = (name: string, condition: string, refused = false): string[] => [
        `function ${name}(): number {`,
        "  let value = 1;",
        "  try {",
        ...(refused ? ["    // @ts-expect-error"] : []),
        `    for (value = 2; ${condition}; ) {}`,
        "  } catch {",
        "    return value;",
        "  }",
        "  return 0;",
        "}",
        "",
      ];
      expect(
        partsOf([
          "declare function c(): boolean;",
          "",
          ...forever("either", "true || c()"),
          ...forever("both", "true && true"),
          ...never("neither", "false && c()"),
          ...never("contradicted", "true && false"),
          ...never("coalesced", "false ?? c()", true),
          ...never("called", "true && c()"),
          ...forever("calledFirst", "c() || true"),
          "either();",
          "both();",
          "console.log(neither(), contradicted(), coalesced(), called());",
          "calledFirst();",
        ]),
      ).toEqual([
        "DS1404 value src/main.ts:6",
        "DS1404 value src/main.ts:15",
        "DS1404 value src/main.ts:24",
        "DS1404 value src/main.ts:34",
        "DS1404 value src/main.ts:45",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is dead where a ?: condition takes only branches that cannot throw, and kept where one it may take runs a call",
    () => {
      const caught = (name: string, condition: string): string[] => [
        `function ${name}(): number {`,
        "  let value = 1;",
        "  try {",
        `    for (value = 2; ${condition}; ) {}`,
        "  } catch {",
        "    return value;",
        "  }",
        "  return 0;",
        "}",
        "",
      ];
      expect(
        partsOf([
          "declare function c(): boolean;",
          "",
          ...caught("chosen", "true ? true : c()"),
          ...caught("other", "false ? true : c()"),
          ...caught("tested", "c() ? true : false"),
          ...caught("branches", "(true ? false : c()) || (false ? c() : true)"),
          "console.log(chosen(), other(), tested(), branches());",
        ]),
      ).toEqual(["DS1404 value src/main.ts:6", "DS1404 value src/main.ts:36"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is kept where a falsy left operand of ?? leaves the condition false, as the compiler's flow graph does not",
    () => {
      expect(
        partsOf([
          "declare function c(): boolean;",
          "",
          "function coalesced(): number {",
          "  let value = 2;",
          "  if (c() ?? (c() || true)) {",
          "    value = 3;",
          "  }",
          "  return value;",
          "}",
          "",
          "console.log(coalesced());",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is kept where a loop's condition may be false: a call, a parenthesized true or a negated false, which the compiler does not fold",
    () => {
      expect(
        partsOf([
          "function maybe(more: () => boolean): number {",
          "  let value = 1;",
          "  for (; more(); ) {",
          "    value = 2;",
          "    break;",
          "  }",
          "  return value;",
          "}",
          "",
          "function wrapped(): number {",
          "  let value = 1;",
          "  while ((true)) {",
          "    value = 2;",
          "    break;",
          "  }",
          "  return value;",
          "}",
          "",
          "function negated(): number {",
          "  let value = 1;",
          "  while (!false) {",
          "    value = 2;",
          "    break;",
          "  }",
          "  return value;",
          "}",
          "",
          "console.log(maybe(() => false), wrapped(), negated());",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is kept by a catch or a finally that may read it, and dead where a finally overwrites it on every path",
    () => {
      expect(
        partsOf([
          "function caught(risky: () => void): number {",
          "  let value = 1;",
          "  try {",
          "    value = 2;",
          "    risky();",
          "    value = 3;",
          "  } catch {",
          "    return value;",
          "  }",
          "  return value;",
          "}",
          "",
          "function cleaned(risky: () => void): number {",
          "  let value = 1;",
          "  try {",
          "    risky();",
          "  } finally {",
          "    value = 2;",
          "  }",
          "  return value;",
          "}",
          "",
          "function logged(risky: () => number): number {",
          "  let status = 0;",
          "  try {",
          "    status = 1;",
          "    return risky();",
          "  } finally {",
          "    console.log(status);",
          "  }",
          "}",
          "",
          "console.log(caught(() => {}), cleaned(() => {}), logged(() => 1));",
        ]),
      ).toEqual(["DS1404 value src/main.ts:14"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is kept by a catch after a try block that runs nothing, which the compiler enters from the state before the try",
    () => {
      expect(
        partsOf([
          "declare function use(value: number): void;",
          "",
          "function empty(): void {",
          "  let value: number = 0;",
          "  try {",
          "  } catch {",
          "    use(value);",
          "  }",
          "  value = 1;",
          "  use(value);",
          "}",
          "",
          "function block(): void {",
          "  let value: number = 0;",
          "  try {",
          "    {}",
          "  } catch {",
          "    use(value);",
          "  }",
          "  value = 1;",
          "  use(value);",
          "}",
          "",
          "function nested(): void {",
          "  let value: number = 0;",
          "  try {",
          "    {",
          "      {}",
          "    }",
          "  } catch {",
          "    use(value);",
          "  }",
          "  value = 1;",
          "  use(value);",
          "}",
          "",
          "empty();",
          "block();",
          "nested();",
        ]),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});
