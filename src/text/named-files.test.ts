import { describe, expect, it } from "vitest";
import { heldNames, spelledFiles } from "./named-files.ts";

/** The files of `files` that `text` names below `/pkg`, each spelled by its own path only. */
function namedIn(text: string, files: readonly string[]): readonly string[] {
  return spelledFiles(
    text,
    "/pkg",
    files.map((file) => ({ file, paths: [file] })),
  );
}

describe("spelledFiles", () => {
  it.each([
    ["node ./bin/run", ["/pkg/bin/run.ts"]],
    ["node lib", ["/pkg/lib/index.mjs"]],
    ["eslint .", ["/pkg/index.ts"]],
    ["node index.mjs", ["/pkg/index.mjs", "/pkg/node.mjs"]],
    ['mocha "./a b.js" c.js', ["/pkg/a b.js", "/pkg/c.js"]],
    ["node a b.js", ["/pkg/a b.js"]],
    ['concurrently "node ./my file.js" vite', ["/pkg/my file.js"]],
    ['node "--require=./a b.js" main.ts', ["/pkg/a b.js", "/pkg/main.ts"]],
    ['node "$PWD/dir with space/x.js"', ["/pkg/dir with space/x.js"]],
    ["node -e \"require('./setup(1).cjs')\"", ["/pkg/setup(1).cjs"]],
    ["npx -c 'node \\$(node ./gen.js) m.js'", ["/pkg/gen.js", "/pkg/m.js"]],
    ["esbuild main.ts --bundle --inject:./shim.js", ["/pkg/main.ts", "/pkg/shim.js"]],
    ["node $(pwd)/server.js", ["/pkg/server.js"]],
    ["node ${INIT_CWD}/c.js", ["/pkg/c.js"]],
    ["node -r./setup.js main.ts", ["/pkg/main.ts", "/pkg/setup.js"]],
    ["node --import file:./x.mjs m.ts", ["/pkg/m.ts", "/pkg/x.mjs"]],
    ["node @./c.js +./d.js", ["/pkg/c.js", "/pkg/d.js"]],
    ["node .\\scripts\\build.js", ["/pkg/scripts/build.js"]],
    ["node ./src/../lib/./a.js /pkg//b.js", ["/pkg/b.js", "/pkg/lib/a.js"]],
    ["node /elsewhere/../pkg/a.js", ["/pkg/a.js"]],
    ["node lib/zz/../a.js", ["/pkg/lib/a.js"]],
  ])("reads %j to name %j", (input, files) => {
    expect([...namedIn(input, files)].sort()).toEqual([...files].sort());
  });

  it.each([
    ["tsx --import=./src/shim.js main.ts", []],
    ["node dist/shim.js", ["/pkg/dist/shim.js"]],
    ["tsc && cp dist/shim.d.mts types", ["/pkg/dist/shim.d.mts"]],
    ["node dist", ["/pkg/dist/index.js"]],
  ])("reads %j to name a source by its own path or one it is written to", (input, written) => {
    const source =
      written[0]?.endsWith("index.js") === true ? "/pkg/src/index.ts" : "/pkg/src/shim.ts";
    const got = spelledFiles(input, "/pkg", [{ file: source, paths: [source, ...written] }]);

    expect(got).toEqual([source]);
  });

  it.each([
    ["cd srv && node .", ["/pkg/srv/index.js"]],
    ["node main.ts", ["/pkg/main.ts"]],
    ["node /pkg", ["/pkg/index.ts"]],
    ["node /pkg/", ["/pkg/index.ts"]],
  ])("reads %j to name %j, and no other file, through a directory's index file", (input, files) => {
    expect(namedIn(input, [...files, "/pkg/other.ts"])).toEqual(files);
  });

  it.each([
    ["node .ts", "/pkg", ["/pkg/.ts"], ["/pkg/.ts"]],
    ["", "/pkg", ["/pkg/.ts", "/pkg/.d.ts"], []],
    ["node main.js", "/pkg", ["/pkg/.d.mts", "/pkg/main.js"], ["/pkg/main.js"]],
    ["node main", "/", ["/index.ts", "/main.js"], ["/main.js"]],
    ["node .", "/", ["/index.ts"], ["/index.ts"]],
  ])(
    "reads %j below %j to name, of %j, %j: a file whose whole name is an extension is named by it, and no name is empty",
    (input, dir, files, named) => {
      const spelled = files.map((file) => ({ file, paths: [file] }));

      expect(spelledFiles(input, dir, spelled)).toEqual(named);
    },
  );

  it.each([
    ["node ../shared/a.js /elsewhere/b.js", ["/shared/a.js", "/elsewhere/b.js"]],
    ["node --test 'test/*.test.js'", ["/pkg/test/a.test.js"]],
    ['node g""en.js', ["/pkg/gen.js"]],
    ["NODE_ENV=production ./index.mjs", ["/pkg/node.mjs"]],
  ])(
    "reads %j to name none of %j: outside the package, a glob, a path only the shell assembles, or a name in another letter case",
    (input, files) => {
      expect(namedIn(input, files)).toEqual([]);
    },
  );

  it.each([
    ["delimiters", `${"x=".repeat(20_000)}file.js`],
    [
      "quoted options",
      `${Array.from({ length: 4000 }, (_, at) => `--opt${String(at)}="v a${String(at)}"`).join(" ")} file.js`,
    ],
    ["parent segments", `${"../".repeat(20_000)}pkg/file.js`],
    ["popped segments", `node ${"a/../".repeat(10_000)}file.js`],
    ["named segments", `node ${"lib/".repeat(10_000)}file.js`],
  ])("reads a long text of %s in time linear in its length", (_, input) => {
    const begun = performance.now();
    const found = namedIn(input, ["/pkg/file.js", "/pkg/lib/other.js"]);

    expect(performance.now() - begun).toBeLessThan(2000);
    expect(found).toEqual(["/pkg/file.js"]);
  });
});

describe("heldNames", () => {
  it.each([
    ["node -r module-alias/register a.js", ["module-alias"], ["module-alias"]],
    ["npx --version node --require newrelic main.ts", ["newrelic"], ["newrelic"]],
    ["env -S 'tsx@4 a.ts'", ["tsx"], ["tsx"]],
    ["echo @scope/pkg.", ["@scope/pkg"], ["@scope/pkg"]],
    ["node tsxx a.js", ["tsx"], []],
    ["node my-tsx a.js", ["tsx"], []],
    ["node tsx-cli a.js", ["tsx"], []],
    ["node a.tsx", ["tsx"], []],
    ["", [""], []],
  ])("reads %j to hold, of %j, %j", (text, names, held) => {
    expect([...heldNames(text, names)]).toEqual(held);
  });
});
