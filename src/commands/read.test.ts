import { describe, expect, it } from "vitest";
import { readFixture } from "../../__test-helpers__/fixtures.ts";
import { resolvePath } from "../paths.ts";
import { heldNames, spelledFiles } from "../text/named-files.ts";
import { loadsOf, pathsNamed, preloadedPackages, readCommands } from "./read.ts";

const INPUTS = JSON.parse(readFixture("commands", "inputs.json")) as readonly {
  readonly input: string;
  readonly files: readonly string[];
}[];

/**
 * What commit 53965c2, before layers 1 and 2 existed, observed of each input run in `/pkg`:
 * the files its whole text held of those tried, each token's path, which it rooted, the files
 * its configuration flags named, its tokens, each a use of the dependency whose command it is,
 * and the packages it preloaded. The reading must make every one of these observations still.
 */
const OBSERVED_BEFORE = JSON.parse(readFixture("commands", "observed.json")) as readonly {
  readonly input: string;
  readonly files: readonly string[];
  readonly held: readonly string[];
  readonly roots: readonly string[];
  readonly configurations: readonly string[];
  readonly commands: readonly string[];
  readonly preloads: readonly string[];
}[];

/**
 * What the reading of `input` in `/pkg` misses of what was observed before. A path a token
 * rooted counts where a word or a run names it, or the held text holds it; a token or a preload
 * counts where a word or a run uses it, or the held text names it.
 */
function missed(before: (typeof OBSERVED_BEFORE)[number]): Record<string, readonly string[]> {
  const reading = readCommands(before.input, "/pkg");
  const holds = (file: string): boolean =>
    spelledFiles(reading.held, "/pkg", [{ file, paths: [file] }]).length > 0;
  const named = new Set(pathsNamed(reading).map((one) => one.path));
  const configurations = new Set(
    reading.configurations.map((one) => resolvePath(one.dir, one.written)),
  );
  const words = new Set(
    reading.commands.flatMap(({ words: all }) => all.flatMap((one) => one ?? [])),
  );
  const preloads = new Set(reading.runs.flatMap(preloadedPackages));
  const spelled = (name: string): boolean => heldNames(reading.held, [name]).size > 0;
  return {
    held: before.held.filter((file) => !holds(file)),
    roots: before.roots.filter((path) => !named.has(path) && !holds(path)),
    configurations: before.configurations.filter((path) => !configurations.has(path)),
    commands: before.commands.filter((token) => !words.has(token) && !spelled(token)),
    preloads: before.preloads.filter((name) => !preloads.has(name) && !spelled(name)),
  };
}

/** The rows whose table names a file the command does not run, with the file it runs instead. */
const RUNS_INSTEAD: ReadonlyMap<string, readonly string[]> = new Map([
  ["cd srv && node index.js", ["srv/index.js"]],
]);

/** The file one written path names in the test package: itself, or with `.js` where it has no extension. */
function fileOf(path: string): string {
  const absolute = `/pkg/${path.replace(/^\.\//u, "")}`;
  return /\.[cm]?[jt]sx?$/u.test(absolute) ? absolute : `${absolute}.js`;
}

/** How `text` run in `/pkg` reaches `file`: a word or a run names it, the held text names it, or neither. */
function reach(text: string, file: string): "word" | "run" | "held" | undefined {
  const reading = readCommands(text, "/pkg");
  if (
    reading.commands.some(({ dir, words }) =>
      words.some((word) => word !== undefined && resolvePath(dir, word) === file),
    )
  ) {
    return "word";
  }
  if (reading.runs.some((run) => loadsOf(run).some((load) => load.paths.includes(file)))) {
    return "run";
  }
  const held = spelledFiles(reading.held, "/pkg", [{ file, paths: [file] }]);
  return held.length > 0 ? "held" : undefined;
}

/** The runs `text` run in `/pkg` reads, each preload by its specifier. */
function runsOf(text: string): readonly unknown[] {
  return readCommands(text, "/pkg").runs.map((run) => ({
    dir: run.dir,
    entry: run.entry,
    preloads: run.preloads.map((one) => one.specifier),
    runtime: run.runtime,
  }));
}

/** A run in `dir` below `/pkg` of `entry` under Node, with no preload. */
function nodeRun(dir: string, entry: string): unknown {
  return { dir: `/pkg${dir}`, entry, preloads: [], runtime: "node" };
}

describe("readCommands", () => {
  it.each(OBSERVED_BEFORE.map((one) => [one.input, one] as const))(
    "makes of %j every observation made before",
    (_, before) => {
      expect(missed(before)).toEqual({
        held: [],
        roots: [],
        configurations: [],
        commands: [],
        preloads: [],
      });
    },
  );

  it.each(INPUTS.map((one) => [one.input] as const))("holds all of %j", (input) => {
    expect(readCommands(input, "/pkg").held).toBe(input);
  });

  it.each(
    INPUTS.flatMap((one) =>
      (RUNS_INSTEAD.get(one.input) ?? one.files).map((file) => [one.input, fileOf(file)] as const),
    ),
  )("reads or holds the file %j names, %j", (input, file) => {
    expect(reach(input, file)).toBeDefined();
  });

  it.each([
    [
      "node --require=./setup.ts main.ts",
      [{ dir: "/pkg", entry: "main.ts", preloads: ["./setup.ts"], runtime: "node" }],
    ],
    [
      "env -- node --loader ts-node/esm main.ts",
      [{ dir: "/pkg", entry: "main.ts", preloads: ["ts-node/esm"], runtime: "node" }],
    ],
    [
      "env -u DEBUG node --require dotenv/config main.ts",
      [{ dir: "/pkg", entry: "main.ts", preloads: ["dotenv/config"], runtime: "node" }],
    ],
    [
      "cross-env APP=app node --import tsx main.ts",
      [{ dir: "/pkg", entry: "main.ts", preloads: ["tsx"], runtime: "node" }],
    ],
    [
      "npx -c 'node --require source-map-support/register main.ts'",
      [
        {
          dir: "/pkg",
          entry: "main.ts",
          preloads: ["source-map-support/register"],
          runtime: "node",
        },
      ],
    ],
    [
      "npx --yes -p module-alias node --require module-alias/register main.ts",
      [{ dir: "/pkg", entry: "main.ts", preloads: ["module-alias/register"], runtime: "node" }],
    ],
    [
      "npx -c 'node --require global-agent/bootstrap main.ts && echo done'",
      [{ dir: "/pkg", entry: "main.ts", preloads: ["global-agent/bootstrap"], runtime: "node" }],
    ],
    ["NODE_ENV=production node index.js", [nodeRun("", "index.js")]],
    [
      "cd srv && node . && cd ../web && tsx main.ts",
      [
        nodeRun("/srv", "."),
        { dir: "/pkg/web", entry: "main.ts", preloads: [], runtime: undefined },
      ],
    ],
    ["cd srv | node a.js; cd lib & node b.js", [nodeRun("", "a.js"), nodeRun("", "b.js")]],
    ["npx -c 'cd srv && node a.js' && node b.js", [nodeRun("/srv", "a.js"), nodeRun("", "b.js")]],
    [
      "npx cross-env A=1 npx tsx --import ./env.ts a.ts",
      [{ dir: "/pkg", entry: "a.ts", preloads: ["./env.ts"], runtime: undefined }],
    ],
    ["npm run build && npm run test -- --watch", []],
    [
      "cd api && node server.js & cd web && node b.js",
      [nodeRun("/api", "server.js"), nodeRun("/web", "b.js")],
    ],
    ["cd x & node y.js", [nodeRun("", "y.js")]],
    ["cd x; node a.js", [nodeRun("/x", "a.js")]],
    ["cd x || exit 1; node a.js", [nodeRun("/x", "a.js")]],
    ["! cd x; node a.js", [nodeRun("/x", "a.js")]],
    ["(cd x && node a.js); node b.js", [nodeRun("", "b.js")]],
    ["false && cd srv; node index.js", []],
    ["true || cd srv; node index.js", []],
    ["npm ci && cd x; node b.js", []],
    ["cd x || node a.js", []],
    ["cd x && node a.js || node b.js", [nodeRun("/x", "a.js"), nodeRun("/x", "b.js")]],
    ["test -f a || node a.js", [nodeRun("", "a.js")]],
    ["env cd srv; node index.js", [nodeRun("", "index.js")]],
    ["./node_modules/.bin/cd srv; node index.js", [nodeRun("", "index.js")]],
    ["npx cd srv; node index.js", [nodeRun("", "index.js")]],
    ["pushd tools && node gen.js && popd && node b.js", [nodeRun("/tools", "gen.js")]],
    ["if [ -d x ]; then cd x; fi; node b.js", []],
    ["{ cd x; } && node a.js", []],
    ["source ./env.sh && node d.js", []],
    ['eval "$SETUP"; node a.js', []],
    ["f() { cd x; }; f; node a.js", []],
    ["command cd x; node a.js", []],
    ["$CD x; node a.js", []],
    ["cd $DIR && node main.js", []],
    ["pushd /absent || node fallback.js; node after.js", [nodeRun("", "fallback.js")]],
    ["pushd x > /dev/null && node a.js", [nodeRun("/x", "a.js")]],
    ["pushd x; node a.js", []],
    ["pushd x || exit 1; node a.js", [nodeRun("/x", "a.js")]],
    ["! pushd x || node a.js", [nodeRun("/x", "a.js")]],
    ["exit 0 && node dead.js; node after.js", []],
    ["node a.js; exit; node b.js", [nodeRun("", "a.js")]],
    ["false && exit; node a.js", [nodeRun("", "a.js")]],
    ["test -f x || exit 1 && node a.js; node b.js", [nodeRun("", "a.js"), nodeRun("", "b.js")]],
    ["exec node server.js; node after.js", []],
    ["exit | cat; node a.js", [nodeRun("", "a.js")]],
    ["(exit 1); node a.js", [nodeRun("", "a.js")]],
    ["exit & node a.js", [nodeRun("", "a.js")]],
    ["npx -c 'exit 0' && node a.js", [nodeRun("", "a.js")]],
    ["return; node a.js", []],
    ["{ echo hi; } | cd x; node a.js", [nodeRun("", "a.js")]],
    ["(true) | cd x; node a.js", [nodeRun("", "a.js")]],
    ["X=1 | cd x; node a.js", [nodeRun("", "a.js")]],
  ])("reads %j as the runs %j", (text, runs) => {
    expect(runsOf(text)).toEqual(runs);
  });

  it.each([
    ["false && cd srv; node index.js", "/pkg/index.js"],
    ["exit 0 && node dead.js; node after.js", "/pkg/after.js"],
    ["pushd /absent || node fallback.js; node after.js", "/pkg/after.js"],
    ["if [ -d x ]; then cd x; fi; node b.js", "/pkg/x/b.js"],
    ["pushd tools && node gen.js && popd && node b.js", "/pkg/b.js"],
  ])("holds from %j the file %j a run it does not read may load", (text, file) => {
    const reading = readCommands(text, "/pkg");

    expect([
      reading.runs.some((run) => loadsOf(run).some((load) => load.paths.includes(file))),
      spelledFiles(reading.held, "/pkg", [{ file, paths: [file] }]),
    ]).toEqual([false, [file]]);
  });

  it("reads no command of a string whose directory it does not know, and holds all of it", () => {
    const reading = readCommands("node a.js && cd b && node c.js", undefined);

    expect([reading.runs, reading.commands, reading.held]).toEqual([
      [],
      [],
      "node a.js && cd b && node c.js",
    ]);
  });

  it.each([
    ["node", "node.ts"],
    ["node main.js", "node.js"],
    ["env -u HOME node main.js", "env.js"],
    ["npx tsx main.ts", "npx.ts"],
    ["node --require=./setup.js main.js", "require.js"],
    ["npm run build", "build.ts"],
    ["vite build", "vite.ts"],
  ])(
    "reads %j to run no file %j, a program, an option or a script name, and holds it",
    (text, file) => {
      expect(reach(text, `/pkg/${file}`)).toBe("held");
    },
  );

  it.each([
    ["node main.js extra.js", "/pkg/extra.js", "word"],
    ["node main.js task", "/pkg/task.js", "held"],
    ["npm run build -- tools/gen", "/pkg/tools/gen.ts", "held"],
    ["NODE_OPTIONS='-r ./hook.cjs' node main.js", "/pkg/hook.cjs", "held"],
    ["node main.js > out/report.js", "/pkg/out/report.js", "held"],
    ["cd $DIR && node main.js", "/pkg/main.js", "word"],
    ["cd $DIR && node x", "/pkg/x.js", "held"],
    ["vite build --config tools/vite.ts", "/pkg/tools/vite.ts", "word"],
    ["node $(pwd)/server.js", "/pkg/server.js", "held"],
    ["if true; then node a.js; fi", "/pkg/a.js", "held"],
    ["node 'unterminated b.js", "/pkg/b.js", "held"],
    ["./bin/node a.js", "/pkg/bin/node.js", "held"],
    ["vite build", "/pkg/build.js", "held"],
    ["node --import ./setup%20x.mjs main.mjs", "/pkg/setup x.mjs", "run"],
  ])("reads %j to reach %j as a %s", (text, file, how) => {
    expect(reach(text, file)).toBe(how);
  });

  it("reads each preload as a path or a package's name", () => {
    const [run] = readCommands(
      "node -r ./a -r ../b.js --import file:./c.mjs -r /d.cjs -r dotenv/config -r @s/p/x m.js",
      "/pkg/sub",
    ).runs;

    expect(run === undefined ? [] : preloadedPackages(run)).toEqual(["dotenv/config", "@s/p/x"]);
    expect(run === undefined ? [] : loadsOf(run).flatMap((load) => load.paths)).toEqual(
      expect.arrayContaining([
        "/pkg/sub/m.js",
        "/pkg/sub/a.ts",
        "/pkg/sub/a/index.js",
        "/pkg/b.js",
        "/pkg/sub/c.mjs",
        "/d.cjs",
      ]),
    );
  });

  it.each([
    ["node --import ./setup%20x.mjs main.mjs", "/pkg/setup x.mjs", "/pkg/setup%20x.mjs"],
    ["node -r ./setup%20x.js main.js", "/pkg/setup%20x.js", "/pkg/setup x.js"],
  ])("reads %j to load %j, not %j", (text, file, not) => {
    const paths = readCommands(text, "/pkg")
      .runs.flatMap(loadsOf)
      .flatMap((one) => one.paths);

    expect([paths.includes(file), paths.includes(not)]).toEqual([true, false]);
  });

  it.each([
    ["vite build --config tools/vite.ts", [{ dir: "/pkg", written: "tools/vite.ts" }]],
    ["npx eslint -c lint.json .", [{ dir: "/pkg", written: "lint.json" }]],
    [
      "cd app && eslint --config=a.json",
      [
        { dir: "/pkg/app", written: "a.json" },
        { dir: "/pkg", written: "a.json" },
      ],
    ],
    ["npx -c ./runner.js", [{ dir: "/pkg", written: "./runner.js" }]],
    [
      "npx -c 'eslint -c inner.json'",
      [
        { dir: "/pkg", written: "inner.json" },
        { dir: "/pkg", written: "eslint -c inner.json" },
      ],
    ],
    ["exit; eslint -c after.json", [{ dir: "/pkg", written: "after.json" }]],
    ["node -c scripts/check.js", []],
    ["node a.js -c b.json", []],
    ["node node_modules/.bin/jest -c jest.ci.js", []],
    ["tsx s.ts --config c.ts", []],
    ["npm run lint -- -c x.json", []],
    ["yarn node ./node_modules/eslint/bin/eslint.js --config=lint.ci.json .", []],
    ["cd app && lint --config=a.json", []],
  ])("reads %j as naming the configuration files %j", (text, configurations) => {
    expect(readCommands(text, "/pkg").configurations).toEqual(configurations);
  });
});
