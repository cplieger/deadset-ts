import { describe, expect, it } from "vitest";
import { commandsOf, scriptTokens, withoutComment } from "./shell.ts";

describe("scriptTokens", () => {
  it.each([
    ["node ./a.ts --flag", ["node", "./a.ts", "--flag"]],
    ["a&&b", ["a", "b"]],
    ["a||b", ["a", "b"]],
    ["a;b", ["a", "b"]],
    ["a|b", ["a", "b"]],
    ["a &&  b\tc", ["a", "b", "c"]],
    ['node "./a.ts"', ["node", "./a.ts"]],
    ["node './a.ts'", ["node", "./a.ts"]],
    ["node \"'./a.ts'\"", ["node", "'./a.ts'"]],
    ["node \"./a.ts'", ["node", "\"./a.ts'"]],
    ["vitest 'src/*.ts'", ["vitest"]],
  ])("splits %j into %j", (command, tokens) => {
    expect(scriptTokens(command)).toEqual(tokens);
  });
});

describe("commandsOf", () => {
  it("ends a command at a single & but not at the & of a redirection", () => {
    expect(commandsOf("node a.ts > log 2>&1 & node b.ts &>log")).toEqual([
      "node a.ts > log 2>&1 ",
      " node b.ts &>log",
    ]);
  });
});

describe("withoutComment", () => {
  it.each([
    ["node a.js # run it", "node a.js "],
    ["node 'a # b.js'", "node 'a # b.js'"],
    ['node "a \\" # b.js"', 'node "a \\" # b.js"'],
    ["node a#b.js", "node a#b.js"],
    ["# all of it", ""],
  ])("reads %j up to its comment as %j", (line, kept) => {
    expect(withoutComment(line)).toEqual(kept);
  });
});
