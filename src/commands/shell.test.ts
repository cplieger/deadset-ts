import { describe, expect, it } from "vitest";
import { shellLine } from "./shell.ts";

/** The values of each simple command's words, `undefined` for a dynamic one. */
function values(text: string): readonly (readonly (string | undefined)[])[] {
  return shellLine(text).flatMap((list) =>
    list.pipelines.flatMap((pipeline) =>
      pipeline.commands.map((words) => words.map((word) => word.value)),
    ),
  );
}

describe("shellLine", () => {
  it.each([
    [`node "./a b.js" 'c d.js' e\\ f.js`, [["node", "./a b.js", "c d.js", "e f.js"]]],
    [`node $'x\\ty.js'`, [["node", "x\ty.js"]]],
    ["node a.js # a comment b.js", [["node", "a.js"]]],
    ["node \\\n  a.js", [["node", "a.js"]]],
    ["node a.js&&tsx b.ts||c;d|e", [["node", "a.js"], ["tsx", "b.ts"], ["c"], ["d"], ["e"]]],
    [
      'echo "x || y" ; node b.js',
      [
        ["echo", "x || y"],
        ["node", "b.js"],
      ],
    ],
    [
      "node a.js & node b.js",
      [
        ["node", "a.js"],
        ["node", "b.js"],
      ],
    ],
  ])("reads %j as the simple commands %j", (text, commands) => {
    expect(values(text)).toEqual(commands);
  });

  it.each([
    ["node $X", 1],
    ["node ${DIR}/c.js", 1],
    ['node "$PWD/x.js"', 1],
    ["node $(pwd)/x.js", 1],
    ["node `pwd`/x.js", 1],
    ["node $((1+2)).js", 1],
    ["node src/*.js", 1],
    ["node a?.js", 1],
    ["node [ab].js", 1],
    ["node test/{a,b}.js", 1],
    ["node ~/x.js", 1],
    ["node ~", 1],
    ['node $"x.js"', 1],
    ["node <(echo a)", 1],
  ])("reads the word %j holds at %i as dynamic", (text, at) => {
    const command = shellLine(text)[0]?.pipelines[0]?.commands[0];

    expect(command?.[at]?.value).toBeUndefined();
    expect(command?.[at]?.text.length).toBeGreaterThan(0);
  });

  it.each([
    ["node '*.js' \"?.js\" '{a,b}' \\~", ["node", "*.js", "?.js", "{a,b}", "~"]],
    ["node 'a$b' x~", ["node", "a$b", "x~"]],
  ])("reads the quoted or escaped specials of %j as static", (text, words) => {
    expect(values(text)).toEqual([words]);
  });

  it("reads each and-or list, the operator before each pipeline, and a background list", () => {
    const lists = shellLine("cd a && b | c ; ! d || e &").map((list) => ({
      background: list.background,
      pipelines: list.pipelines.map(({ operator, negated, commands, alone, opaque }) => ({
        operator,
        negated,
        commands: commands.map((words) => words.map((word) => word.value)),
        alone,
        opaque,
      })),
    }));

    expect(lists).toEqual([
      {
        background: false,
        pipelines: [
          {
            operator: undefined,
            negated: false,
            commands: [["cd", "a"]],
            alone: true,
            opaque: false,
          },
          {
            operator: "&&",
            negated: false,
            commands: [["b"], ["c"]],
            alone: false,
            opaque: false,
          },
        ],
      },
      {
        background: true,
        pipelines: [
          { operator: undefined, negated: true, commands: [["d"]], alone: true, opaque: false },
          { operator: "||", negated: false, commands: [["e"]], alone: true, opaque: false },
        ],
      },
    ]);
  });

  it.each([
    ['V="$(node ./gen.ts)" node main.ts', ["node", "main.ts"]],
    ["NODE_OPTIONS='-r ./x.js' node m.js 2>&1 > out.log", ["node", "m.js"]],
    ["cat <<EOF\nnode hidden.js\nEOF", ["cat"]],
  ])("reads no assignment, redirection or here-document of %j as a word", (text, words) => {
    expect(values(text)).toEqual([words]);
  });

  it.each([
    ["if true; then cd a; fi", true],
    ["{ cd a; }", true],
    ["for f in a b; do cd $f; done", true],
    ["while false; do cd a; done", true],
    ["case x in x) cd a;; esac", true],
    ["f() { cd a; }", true],
    ["{ cd a; } > log", true],
    ["(cd srv && node a.js)", false],
    ["[[ -d a ]]", false],
    ["(( 1 ))", false],
    ["A=1", false],
    ["if true; then cd a; fi | cat", false],
  ])("reads %j as no simple command in the line's shell, opaque %s", (text, opaque) => {
    const [pipeline] = shellLine(text)[0]?.pipelines ?? [];

    expect(pipeline?.commands.filter((words) => words[0]?.value !== "cat")).toEqual([]);
    expect(pipeline?.opaque).toBe(opaque);
  });

  it.each([
    ["{ echo hi; } | cd x", [["cd", "x"]]],
    ["(true) | cd x", [["cd", "x"]]],
    ["X=1 | cd x", [["cd", "x"]]],
  ])(
    "reads %j as a pipeline of several members, of which only %j is a simple command",
    (text, commands) => {
      const [pipeline] = shellLine(text)[0]?.pipelines ?? [];

      expect(pipeline?.alone).toBe(false);
      expect(pipeline?.commands.map((words) => words.map((word) => word.value))).toEqual(commands);
    },
  );

  it.each([["node 'unterminated"], ['node "a.js'], ["node $(a.js"], ["node a.js |"]])(
    "reads no list of %j, which does not parse",
    (text) => {
      expect(shellLine(text)).toEqual([]);
    },
  );

  it("keeps each statement of several lines apart", () => {
    expect(values("node a.js\n\nnode b.js\n")).toEqual([
      ["node", "a.js"],
      ["node", "b.js"],
    ]);
  });
});
