import { describe, expect, it } from "vitest";
import { shellLine } from "./shell.ts";
import type { Word } from "./shell.ts";
import {
  configurationsOf,
  outputOf,
  preloadTarget,
  readBuiltin,
  readTool,
  testRun,
  type Preload,
  type Reading,
} from "./tools.ts";

/** The words of `text`'s first simple command. */
function wordsOf(text: string): readonly Word[] {
  return shellLine(text)[0]?.pipelines[0]?.commands[0] ?? [];
}

/** What the reader of the first word of `text`'s first command reads the rest as. */
function read(text: string): Reading | undefined {
  return readTool(wordsOf(text));
}

/** A preload read as `require` reads it. */
function required(specifier: string): Preload {
  return { specifier, resolution: "require" };
}

/** A preload read as an ECMAScript module. */
function imported(specifier: string): Preload {
  return { specifier, resolution: "import" };
}

/** A reading that runs `entry` with `preloads`, under `runtime`. */
function run(
  entry: string | undefined,
  preloads: readonly Preload[] = [],
  runtime: "node" | undefined = undefined,
): unknown {
  return { kind: "run", entry, preloads, runtime };
}

/** Either status in a directory the analysis does not know. */
const ELSEWHERE = [
  { dir: undefined, ok: true },
  { dir: undefined, ok: false },
];

/** A reading that hands the command `words` on, its program word one of the command read. */
function hands(words: readonly string[]): unknown {
  return {
    kind: "command",
    words: words.map((value) => expect.objectContaining({ value })),
    at: expect.any(Number),
  };
}

describe("readTool", () => {
  it.each([
    ["node main.js", run("main.js", [], "node")],
    ["node main.js --port 3 extra.js", run("main.js", [], "node")],
    ["node -r ./setup.js main.js", run("main.js", [required("./setup.js")], "node")],
    ["node --require=./setup.ts main.ts", run("main.ts", [required("./setup.ts")], "node")],
    [
      "node --import tsx --loader ts-node/esm main.ts",
      run("main.ts", [imported("tsx"), imported("ts-node/esm")], "node"),
    ],
    [
      "node --experimental-loader=./hooks.mjs main.mjs",
      run("main.mjs", [imported("./hooks.mjs")], "node"),
    ],
    [
      "node --import ./setup%20x.mjs main.mjs",
      run("main.mjs", [imported("./setup%20x.mjs")], "node"),
    ],
    ["node -- main.js -r x", run("main.js", [], "node")],
    ["node", run(undefined)],
    ["tsx src/main.ts", run("src/main.ts")],
    ["tsx watch --import ./env.ts src/main.ts a", run("src/main.ts", [imported("./env.ts")])],
    [
      "tsx -r ./a.cjs --require=./b.cjs x.ts",
      run("x.ts", [required("./a.cjs"), required("./b.cjs")]),
    ],
    [
      "ts-node -r tsconfig-paths/register --esm src/main.ts",
      run("src/main.ts", [required("tsconfig-paths/register")]),
    ],
    ["ts-node --require ./a.ts x.ts", run("x.ts", [required("./a.ts")])],
    ["./node_modules/.bin/ts-node x.ts", run("x.ts")],
    ["/usr/bin/node a.js", run("a.js", [], "node")],
    ["./bin/tsx a.ts", run("a.ts")],
    ["node.exe a.js", run("a.js", [], "node")],
    ['"$(npm root)/.bin/tsx" a.ts', run("a.ts")],
    ["bun scripts/a.ts", run("scripts/a.ts")],
    ["bun run --watch -r ./setup.ts a.ts", run("a.ts", [required("./setup.ts")])],
    ["bun --preload=./setup.ts run a.ts", run("a.ts", [required("./setup.ts")])],
    ["bun install", run(undefined)],
    ["bun test a.test.ts", run(undefined)],
    ["deno run main.ts --port 3", run("main.ts")],
    ["deno run --allow-net --watch main.ts", run("main.ts")],
    ["deno main.ts", run("main.ts")],
    ["deno serve server.ts", run("server.ts")],
    ["deno task build", run(undefined)],
    ["deno -A lint", run("lint")],
    ["deno --watch test.ts", run("test.ts")],
    ["deno -q lint", run(undefined)],
    ["bun --watch test", run(undefined)],
    ["deno run lint", run("lint")],
    ["bun run test", run("test")],
    ["node --run lint", run(undefined)],
    ["node -e 1 lint.js", run(undefined)],
    ["node --eval=1", run(undefined)],
    ["node -r ./setup.cjs -p 1", run(undefined, [required("./setup.cjs")])],
    ["node -e \"require('./setup(1).cjs')\"", run(undefined)],
    ["ts-node --print 1", run(undefined)],
    ["bun -e 1 lint.js", run(undefined)],
    ["node --enable-source-maps main.js", run("main.js", [], "node")],
    ["node --watch main.js", run("main.js", [], "node")],
    ["node --no-warnings --input-type=module a.mjs", run("a.mjs", [], "node")],
    ["node --max-old-space-size=4096 --inspect=9229 a.js", run("a.js", [], "node")],
    ["node --env-file .env -C development a.js", run("a.js", [], "node")],
    ["node --input-type=module -e \"import('./x.mjs')\"", run(undefined)],
    ["node --version", run(undefined)],
    ["node --test", run(undefined)],
    ['node --test --test-reporter=spec "smoke/*.check.js"', run(undefined)],
    ["tsx --tsconfig t.json --no-warnings a.ts", run("a.ts")],
  ])("reads the runtime command %j", (text, reading) => {
    expect(read(text)).toEqual(reading);
  });

  it.each([
    ["env node a.js", hands(["node", "a.js"])],
    [
      "env -i -u HOME --unset=PATH --unset LANG -uTERM -v --debug - -- A=1 node a.js",
      hands(["node", "a.js"]),
    ],
    ["env -u MY-VAR --unset=OTHER-VAR node a.js", hands(["node", "a.js"])],
    ["env -iv node a.js", hands(["node", "a.js"])],
    ["env -iuHOME -vu PATH node a.js", hands(["node", "a.js"])],
    ["c8 node a.js", hands(["node", "a.js"])],
    ["c8 --reporter=lcov -r text --all node a.js", hands(["node", "a.js"])],
    ["nyc --silent -r lcov tsx a.ts", hands(["tsx", "a.ts"])],
    ["dotenv -- node a.js", hands(["node", "a.js"])],
    ["dotenv -e .env.test -o -- node a.js", hands(["node", "a.js"])],
    ["dotenv -e .env node a.js", hands(["node", "a.js"])],
    ["env-cmd node a.js", hands(["node", "a.js"])],
    ["env-cmd -f .env.test -x node a.js", hands(["node", "a.js"])],
    ["env-cmd -e dev,test -- node a.js", hands(["node", "a.js"])],
    ["dotenvx run -f .env -- node a.js", hands(["node", "a.js"])],
    ["dotenvx run node a.js", hands(["node", "a.js"])],
    ["env -0 node a.js", hands(["node", "a.js"])],
    ["env --ignore-environment FOO-BAR=1 node a.js", hands(["node", "a.js"])],
    ["env cd srv", hands(["cd", "srv"])],
    ["env", run(undefined)],
    ["cross-env NODE_ENV=test API_URL= node a.js", hands(["node", "a.js"])],
    ["npx tsx a.ts", hands(["tsx", "a.ts"])],
    ["npx tsx@4.7.0 a.ts", hands(["tsx", "a.ts"])],
    ["npx --yes -p module-alias --package=x --package y node a.js", hands(["node", "a.js"])],
    ["npx -y --no -- ts-node a.ts --flag", hands(["ts-node", "a.ts", "--flag"])],
    ["npx @scope/tool@1 a.js", hands(["@scope/tool", "a.js"])],
    ["npm exec -- node -r ./p.cjs a.js", hands(["node", "-r", "./p.cjs", "a.js"])],
    ["npm x --package=tsx -- tsx a.ts", hands(["tsx", "a.ts"])],
    ["npm exec tsx a.ts", hands(["tsx", "a.ts"])],
    ["pnpm exec tsx a.ts --watch", hands(["tsx", "a.ts", "--watch"])],
    ["pnpm dlx --package=tsx --package typescript tsx a.ts", hands(["tsx", "a.ts"])],
    ["pnpm dlx create-vite@5 app", hands(["create-vite", "app"])],
    ["yarn dlx -p tsx -q tsx a.ts", hands(["tsx", "a.ts"])],
    ["yarn node a.js", hands(["node", "a.js"])],
    ["bunx -p tsx tsx a.ts", hands(["tsx", "a.ts"])],
    ["pnpx tsx@4 a.ts", hands(["tsx", "a.ts"])],
    ["pnpx --package=tsx tsx a.ts", hands(["tsx", "a.ts"])],
    ["bunx tsx@4 a.ts", hands(["tsx", "a.ts"])],
    ["bun x tsx@4 a.ts", hands(["tsx", "a.ts"])],
    ["npx.cmd tsx a.ts", hands(["tsx", "a.ts"])],
    ["cross-env A=$(x) node a.js", hands(["node", "a.js"])],
    ["cross-env NODE_ENV=$X node a.js", hands(["node", "a.js"])],
    ['env "FOO=$BAR" node a.js', hands(["node", "a.js"])],
    ["env -u HOME A=${X}y node a.js", hands(["node", "a.js"])],
    ["/usr/bin/env node a.js", hands(["node", "a.js"])],
  ])("reads the launcher %j as handing on a command", (text, reading) => {
    const words = wordsOf(text);
    const got = read(text);

    expect(got).toEqual(reading);
    // The command handed on stands at `at` of the command read, its program word as the reader reads it.
    expect(got?.kind === "command" && words.slice(got.at + 1)).toEqual(
      got?.kind === "command" && got.words.slice(1),
    );
  });

  it.each([
    ["npx -c 'node a.js && node b.js'", "node a.js && node b.js"],
    ["npx --call='node a.js'", "node a.js"],
    ["npm exec --call 'tsx a.ts'", "tsx a.ts"],
    ["env -S 'node a.js'", "env 'node' 'a.js'"],
    ["env -iS'node --no-warnings' a.js $X", "env 'node' '--no-warnings' a.js $X"],
    ["env -u HOME --split-string='-i node' \"a.js\"", "env '-i' 'node' \"a.js\""],
  ])("reads %j as running the command line %j", (text, line) => {
    expect(read(text)).toEqual({ kind: "line", text: line });
  });

  it.each([
    ["npm run build", run(undefined)],
    ["npm run-script build -- --watch x.js", run(undefined)],
    ["npm run build extra.js", run(undefined)],
  ])("reads %j as running another script of the same manifest", (text, reading) => {
    expect(read(text)).toEqual(reading);
  });

  it.each([
    ["cd srv", [{ dir: "/pkg/srv", ok: true }]],
    [
      "pushd tools",
      [
        { dir: "/pkg/tools", ok: true },
        { dir: "/pkg", ok: false },
      ],
    ],
    ["exit", []],
    ["exit 1 2", []],
    ["exit $CODE", []],
    ["exec node server.js", []],
    ["cd ../a b", ELSEWHERE],
    ["cd $DIR", ELSEWHERE],
    ["cd", ELSEWHERE],
    ["cd -", ELSEWHERE],
    ["pushd", ELSEWHERE],
    ["pushd +1", ELSEWHERE],
    ["popd", ELSEWHERE],
    ["return 0", ELSEWHERE],
    ["exec $COMMAND", ELSEWHERE],
    ["exec -a name node server.js", ELSEWHERE],
    [". ./env.sh", ELSEWHERE],
    ["source ./env.sh", ELSEWHERE],
    ["eval 'cd x'", ELSEWHERE],
    ["command cd x", ELSEWHERE],
    ["builtin exit", ELSEWHERE],
    ["command $X", ELSEWHERE],
    ["$X srv", ELSEWHERE],
  ])("reads the builtin %j, run in /pkg, as going on as %j", (text, outcomes) => {
    expect(readBuiltin(wordsOf(text), "/pkg")).toEqual(outcomes);
  });

  it.each([
    ["node a.js"],
    ["command -v node"],
    ["./node_modules/.bin/cd srv"],
    ["env cd srv"],
    ["exec > out.log"],
  ])("reads %j as leaving the shell as any command does", (text) => {
    expect(readBuiltin(wordsOf(text), "/pkg")).toBeUndefined();
  });

  it.each([
    ["/pkg", required("./setup%20x.js"), { path: "/pkg/setup%20x.js" }],
    ["/pkg", required("../b.js"), { path: "/b.js" }],
    ["/pkg", required("dotenv/config"), { package: "dotenv/config" }],
    ["/pkg", required("file:./x.js"), undefined],
    ["/pkg", imported("./setup%20x.mjs"), { path: "/pkg/setup x.mjs" }],
    ["/pkg", imported("./a%23b.mjs"), { path: "/pkg/a#b.mjs" }],
    ["/pkg", imported("./a.mjs?v=1#x"), { path: "/pkg/a.mjs" }],
    ["/pkg/sub", imported("file:./c.mjs"), { path: "/pkg/sub/c.mjs" }],
    ["/pkg", imported("file:///abs/x%20y.mjs"), { path: "/abs/x y.mjs" }],
    ["/pkg", imported("tsx"), { package: "tsx" }],
    ["/pkg", imported("./%2Fx.mjs"), undefined],
    ["/pkg", imported("./%E0%A4%A.mjs"), undefined],
    ["/pkg", imported("file://host/x.mjs"), undefined],
    ["/pkg", imported("data:text/javascript,1"), undefined],
    ["/pkg", imported("https://example.com/x.mjs"), undefined],
  ])("reads in %j the preload %j as %j", (dir, preload, target) => {
    expect(preloadTarget(preload, dir)).toEqual(target);
  });

  it.each([
    ["vite build --config tools/vite.ts", ["tools/vite.ts"]],
    ["eslint -c a.json --config=b.json", ["a.json", "b.json"]],
    ["node_modules/.bin/eslint -c a.json", ["a.json"]],
    ["eslint --config $C x.json", []],
    ["eslint -c", []],
    ["eslint --config=", []],
    ["eslint -- -c a.json", []],
    ["prettier -c x.json --config=p.json", ["p.json"]],
    ["stylelint -c s.json", ["s.json"]],
    ["jest --config=j.json", ["j.json"]],
    ["vitest run -c v.ts", ["v.ts"]],
    ["webpack build -c w.js", ["w.js"]],
    ["mocha -c x.json --config m.json", ["m.json"]],
    ["npx -c 'node a.js'", ["node a.js"]],
    ["npx --yes -p pkg -c ./runner.js", ["./runner.js"]],
    ["npx --package=pkg -c ./runner.js", ["./runner.js"]],
    ["npx --call 'node b.js' -c ./runner.js", ["./runner.js"]],
    ["npx $PKG -c ./runner.js", []],
    ["npx --version=false -c 'printf RAN' extra", ["printf RAN"]],
    ["npx eslint -c a.json", []],
    ["node -c scripts/check.js", []],
    ["lint -c a.json --config=b.json", []],
    ["toString -c a.json", []],
  ])("reads %j as naming the configuration files %j", (text, files) => {
    expect(configurationsOf(wordsOf(text))).toEqual(files);
  });

  it.each([
    // an option no reader handles
    ["tsx --test"],
    ["node --check a.js"],
    ["node --frobnicate a.js"],
    ["tsx watch --include src a.ts"],
    ["env -S 'node $1'"],
    ['env -S"$X" a.js'],
    ["env -C dir -S'node a.js'"],
    ["env -S'node \\c' a.js"],
    ["pnpm --frobnicate exec tsx a.ts"],
    ["pnpm exec --frobnicate tsx a.ts"],
    ["pnpx -s tsx a.ts"],
    ["node - < a.js"],
    ["node -e"],
    ["bun --hot=x a.ts"],
    ["deno run --allow-read=. main.ts"],
    ["node -rx main.js"],
    ["tsx watch --clear-screen=false a.ts"],
    ["ts-node -T a.ts"],
    ["c8 --frobnicate node a.js"],
    ["dotenv -o node a.js"],
    ["env-cmd -e dev node a.js"],
    ["env -C dir node a.js"],
    ["env --unse HOME node a.js"],
    ["env --frobnicate node a.js"],
    ["env =x node a.js"],
    ["cross-env a.b=1 node a.js"],
    ["cross-env"],
    ["npx --version node a.js"],
    ["npx --registry https://registry.example node a.js"],
    ["npx -w pkg tsx a.ts"],
    ["npx -c 'node a.js' extra"],
    ["npx"],
    ["npm exec -p node a.js"],
    ["npm exe -- node a.js"],
    ["npm exec tsx a.ts --watch"],
    ["npm -w a exec node a.js"],
    ["npm test"],
    ["npm run --if-present build"],
    ["npm run build --watch"],
    ["yarn exec node a.js"],
    ["pnpm exec -r tsx a.ts"],
    ["pnpm dlx -c 'tsx a.ts'"],
    ["pnpm tsx a.ts"],
    ["yarn tsx a.ts"],
    ["yarn run build"],
    ["bunx --bun tsx a.ts"],
    ["vite build"],
    // a dynamic word where the reader needs one
    ["node $ENTRY"],
    ['node "$PWD/a.js"'],
    ["node --require $PRELOAD a.js"],
    ["node $FLAG a.js"],
    ["tsx $(pwd)/a.ts"],
    ["ts-node -r $X a.ts"],
    ["env $X node a.js"],
    ["env -u $X node a.js"],
    // a form the tool itself rejects
    ["env -u= node a.js"],
    ["env --unset= node a.js"],
    ["env -u '' node a.js"],
    ["env -u A=B node a.js"],
    ["env --unset=A=B node a.js"],
    ["node --import data:text/javascript,1 a.js"],
    ["node --import ./%E0%A4%A.mjs a.js"],
    ["node -r file:./x.js a.js"],
    ["tsx --import https://example.com/x.mjs a.ts"],
    // a word that names an inherited property of a plain object
    ["npm toString"],
    ["npm constructor x"],
    ["pnpm __proto__ a"],
    ["yarn hasOwnProperty a.js"],
    ["constructor a.js"],
    ["__proto__ a.js"],
    // a shell builtin, which no tool reader reads
    ["cd srv"],
    ["./node_modules/.bin/cd srv"],
    ["npx $TOOL a.js"],
    ["npx -p $PKG node a.js"],
    ["npm exec -- $TOOL a.js"],
    ["npm run $SCRIPT"],
    ["pnpm exec $TOOL a.js"],
    ["yarn dlx -p $P tsx a.ts"],
    ["bunx $TOOL a.js"],
    ["$TOOL a.js"],
  ])("reads %j as not understood", (text) => {
    expect(read(text)).toBeUndefined();
  });
});

describe("testRun", () => {
  it.each([
    ["node --test", { patterns: [], stripped: true }],
    ["node --title app --preserve-symlinks --test", { patterns: [], stripped: true }],
    ["node --no-strip-types --test a.test.js", { patterns: ["a.test.js"], stripped: false }],
    [
      'node --test --test-reporter=spec "smoke/*.check.js"',
      { patterns: ["smoke/*.check.js"], stripped: true },
    ],
    ["node --test-only --test", { patterns: [], stripped: true }],
    ["node --test $X", undefined],
    ["node --frobnicate --test", undefined],
    ["node a.js", undefined],
    ["tsx --test", undefined],
    ["c8 node --test", undefined],
  ])("reads %j as the test run %j", (text, want) => {
    expect(testRun(wordsOf(text))).toEqual(want);
  });
});

describe("outputOf", () => {
  const none = { at: [], joined: [], texts: [], input: false };
  it.each([
    ["echo node lint", { ...none, joined: [[1, 3]] }],
    ["echo -n -E node lint", { ...none, joined: [[3, 5]] }],
    ["echo -x node", { ...none, joined: [[1, 3]] }],
    ["echo", { ...none, joined: [[1, 1]] }],
    ["echo -e node", undefined],
    ["echo -ne node", undefined],
    ["echo 'a\\nb'", undefined],
    ["printf 'node lint\\n'", { ...none, texts: ["node lint\n"] }],
    ["printf -- '100%% \\t\\\\'", { ...none, texts: ["100% \t\\"] }],
    ["printf 'node %s' lint", undefined],
    ["printf 'node lint' x", undefined],
    ["printf 'a\\101'", undefined],
    ["printf 'a\\'", undefined],
    ["printf 'a%'", undefined],
    ['printf "$X"', undefined],
    ["printf -v x 'node lint'", none],
    ["printf -x 'node lint'", undefined],
    ["cat a.sh -u b.sh", { ...none, at: [1, 3] }],
    ["cat", { ...none, input: true }],
    ["cat a.sh -", { ...none, at: [1], input: true }],
    ["tee log", undefined],
    ["node lint", undefined],
  ])("reads what %j writes as %j", (text, want) => {
    expect(outputOf(wordsOf(text))).toEqual(want);
  });
});

describe("readTool of a runtime given its standard input as a path", () => {
  it.each(["node /dev/stdin", "node /dev/fd/0 a", "node --no-warnings /dev/stdin"])(
    "reads %j as running no entry",
    (text) => {
      expect(read(text)).toEqual({
        kind: "run",
        entry: undefined,
        preloads: [],
        runtime: undefined,
      });
    },
  );
});
