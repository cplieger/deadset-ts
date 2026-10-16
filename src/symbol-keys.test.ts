import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { emitterInputOf, findingsOf } from "../__test-helpers__/emitter-input.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { resolve } from "./resolve.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Each finding of an application rooted at `src/main.ts`, as its code, subject and line. */
function findings(files: Readonly<Record<string, string>>): string[] {
  const root = writeProject({
    "package.json": '{ "name": "@example/app", "type": "module", "main": "./src/main.ts" }\n',
    ...files,
  });
  roots.push(root);
  const { config } = resolve({
    repository: { text: '{ "target": { "kind": "application" } }', label: "deadset.json" },
  });
  return findingsOf(emitterInputOf(root, config)).map(
    ({ code, symbol, position }) => `${code} ${symbol.name} ${String(position.line)}`,
  );
}

describe("a member a unique symbol keys", () => {
  it("is written by an object-literal property whose computed name is that symbol", () => {
    expect(
      findings({
        "src/main.ts": [
          'const mark: unique symbol = Symbol("mark");',
          "interface Marked {",
          "  [mark]: true;",
          "  label: string;",
          "}",
          'const marked: Marked = { [mark]: true, label: "a" };',
          "console.log(marked.label);",
          "",
        ].join("\n"),
      }),
    ).toEqual(["DS1301 Marked.[mark] 3"]);
  });

  it("is read by an element access keyed by the constant, and written by a store through one", () => {
    expect(
      findings({
        "src/main.ts": [
          'const mark: unique symbol = Symbol("mark");',
          'const count: unique symbol = Symbol("count");',
          "class Keys {",
          '  static readonly tag: unique symbol = Symbol("tag");',
          "}",
          "interface Row {",
          "  [mark]: true;",
          "  [count]: number;",
          "  readonly [Keys.tag]: string;",
          "}",
          'const row: Row = { [mark]: true, [count]: 0, [Keys.tag]: "a" };',
          "row[count] = 1;",
          "console.log(row[mark], row[Keys.tag]);",
          "",
        ].join("\n"),
      }),
    ).toEqual(["DS1301 Row.[count] 8"]);
  });

  it("is selected only by its own symbol, not by another constant of the same name", () => {
    expect(
      findings({
        "src/a.ts": 'export const mark: unique symbol = Symbol("a");\n',
        "src/b.ts": 'export const mark: unique symbol = Symbol("b");\n',
        "src/main.ts": [
          'import * as a from "./a.ts";',
          'import * as b from "./b.ts";',
          "interface Both {",
          "  [a.mark]: true;",
          "  [b.mark]: true;",
          "}",
          "const both: Both = { [a.mark]: true, [b.mark]: true };",
          "console.log(both[a.mark]);",
          "",
        ].join("\n"),
      }),
    ).toEqual(["DS1301 Both.[b.mark] 5"]);
  });
});

describe("a member a well-known iteration symbol keys", () => {
  it("is read by a for-of statement, a spread and a for-await statement over a value of its type", () => {
    expect(
      findings({
        "src/main.ts": [
          "class Bag {",
          "  [Symbol.iterator](): Iterator<number> { return [1].values(); }",
          "  [Symbol.asyncIterator](): AsyncIterator<number> { return (async function* () { yield 1; })(); }",
          "}",
          "class Pair {",
          "  [Symbol.iterator](): Iterator<number> { return [1, 2].values(); }",
          "}",
          "interface Stream { [Symbol.asyncIterator](): AsyncIterator<number> }",
          "for (const n of new Bag()) console.log(n);",
          "console.log([...new Pair()]);",
          "export async function drain(s: Stream): Promise<void> { for await (const n of s) console.log(n); }",
          "",
        ].join("\n"),
      }),
    ).toEqual(["DS1003 Bag.[Symbol.asyncIterator] 3"]);
  });
});
