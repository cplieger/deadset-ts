import { describe, expect, it } from "vitest";
import { heldWords, type HeldText } from "./held.ts";
import { PART } from "./shell.ts";

/** The words layer 3 reads of `texts`, each part as `*`, with whether it may write the file a command runs. */
function wordsOf(...texts: readonly HeldText[]): readonly string[] {
  return heldWords(texts).map(
    (word) => `${word.text.replaceAll(PART, "*")}${word.runs ? " runs" : ""}`,
  );
}

describe("heldWords", () => {
  it.each([
    ["node scripts/lint.js", ["node", "scripts/lint.js runs"]],
    ["node scripts/{lint,check}.js", ["node", "scripts/lint.js runs", "scripts/check.js runs"]],
    ["node scripts/{1..3}.js", ["node", "scripts/*.js runs"]],
    ['node scripts/"$T".js', ["node", "scripts/*.js runs"]],
    ["node scripts/'$T'.js", ["node", "scripts/$T.js runs"]],
    ["node scripts/${{ matrix.tool }}", ["node", "scripts/* runs"]],
    ["cat ~/x.js", ["cat", "*/x.js"]],
    ["X=lib/a.js cat", ["lib/a.js", "cat"]],
    ["cat < in.txt > out/a.js", ["cat", "in.txt", "out/a.js"]],
  ])("reads %j as the words %j", (text, words) => {
    expect(wordsOf({ text, shell: true })).toEqual(words);
  });

  it.each([
    ["node $(echo scripts/$T.js)", ["node", "* runs", "echo", "scripts/*.js"]],
    ["sh -c 'node $1'", ["sh", "-c", "node $1", "node", "* runs"]],
    ["cat <<EOF\nnode scripts/lint.js\nEOF", ["cat", "node", "scripts/lint.js runs"]],
    ["for f in scripts/*.js; do node $f; done", ["f", "scripts/*.js", "node", "* runs"]],
  ])("reads %j, a command another command or text holds, as the words %j", (text, words) => {
    expect(wordsOf({ text, shell: true })).toEqual(words);
  });

  it.each([
    ["node scripts\\lint.js", ["node", "scriptslint.js runs", "node", "scripts/lint.js runs"]],
  ])("reads %j a second time with \\ as /, as PowerShell reads a path: %j", (text, words) => {
    expect(wordsOf({ text, shell: true })).toEqual(words);
  });

  it.each([
    [
      "node 'unclosed scripts/$T.js",
      ["node 'unclosed scripts/*.js", "node", "unclosed", "scripts/*.js"],
    ],
    ["echo $(node ./$(echo x).js", ["echo *", "node", "echo", "x", "./*"]],
  ])("reads %j, which does not parse, a token at a time: %j", (text, words) => {
    expect(wordsOf({ text, shell: true }).filter((word) => !word.endsWith(" runs"))).toEqual(
      expect.arrayContaining(words),
    );
  });

  it.each([
    [{ text: "actions/checkout@v4", shell: false, key: "uses" }, []],
    [
      { text: "./tools/notify", shell: false, key: "uses" },
      ["./tools/notify", "./tools/notify", "./tools/notify"],
    ],
    [
      { text: "actions/checkout@v4", shell: false, key: "name" },
      ["actions/checkout@v4", "actions/checkout@v4", "actions/checkout@v4"],
    ],
    [{ text: "scripts/$1", shell: false }, ["scripts/*", "scripts/*", "scripts/*"]],
  ])(
    "reads the value %j as the words %j: the line, its tokens as written and with their expansions as parts, none of which runs a file",
    (text, words) => {
      expect(wordsOf(text)).toEqual(words);
    },
  );

  it.each([
    [{ text: "node $1", shell: false, key: "start" }, ["node *", "node", "*", "node", "* runs"]],
    [{ text: "$CMD lint", shell: false }, ["* lint", "*", "lint", "*", "lint"]],
  ])(
    "reads the value %j as the words %j: a runtime's entry may write the file it runs, and a value has no program word",
    (text, words) => {
      expect(wordsOf(text)).toEqual(words);
    },
  );

  it.each([
    ["xargs -n1 node", true],
    ["find . -exec node {} ;", true],
    ["command -v node", false],
    ["node", false],
  ])("reads %j to run a file no word writes: %j", (text, unwritten) => {
    expect(heldWords([{ text, shell: true }]).some((word) => word.text === PART && word.runs)).toBe(
      unwritten,
    );
  });
});
