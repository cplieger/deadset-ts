import { describe, expect, it } from "vitest";
import { heldWords } from "../commands/held.ts";
import { heldNames, spelledFiles } from "./named-files.ts";

/** What the words of `text`, a command string, name below `/pkg`, each file spelled by its own path only. */
function readIn(
  text: string,
  files: readonly string[],
  tested = false,
): { readonly files: readonly string[]; readonly unwritten: boolean } {
  return spelledFiles(
    heldWords([{ text, shell: true, tested }]),
    "/pkg",
    "/pkg",
    files.map((file) => ({ file, paths: [file] })),
  );
}

/** The files of `files` that the words of `text`, a command string, name below `/pkg`. */
function namedIn(text: string, files: readonly string[]): readonly string[] {
  return readIn(text, files).files;
}

describe("spelledFiles", () => {
  it.each([
    ["node ./bin/run", ["/pkg/bin/run.ts"]],
    ["node lib/", ["/pkg/lib/index.mjs"]],
    ["eslint .", ["/pkg/index.ts"]],
    ["node index.mjs", ["/pkg/index.mjs"]],
    ['mocha "./a b.js" c.js', ["/pkg/a b.js", "/pkg/c.js"]],
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
    ["node ./dist", ["/pkg/dist/index.js"]],
  ])("reads %j to name a source by its own path or one it is written to", (input, written) => {
    const source =
      written[0]?.endsWith("index.js") === true ? "/pkg/src/index.ts" : "/pkg/src/shim.ts";
    const got = spelledFiles(heldWords([{ text: input, shell: true }]), "/pkg", "/pkg", [
      { file: source, paths: [source, ...written] },
    ]).files;

    expect(got).toEqual([source]);
  });

  it.each([
    ["cd ./srv && node .", ["/pkg/srv/index.js"]],
    ["node main.ts", ["/pkg/main.ts"]],
    ["node /pkg", ["/pkg/index.ts"]],
    ["node /pkg/", ["/pkg/index.ts"]],
  ])("reads %j to name %j, and no other file, through a directory's index file", (input, files) => {
    expect(namedIn(input, [...files, "/pkg/other.ts"])).toEqual(files);
  });

  it.each([
    ["node ./.ts", "/pkg", ["/pkg/.ts"], ["/pkg/.ts"]],
    ["cat .ts a.ts", "/pkg", ["/pkg/.ts"], []],
    ["node .ts", "/pkg", ["/pkg/.ts"], ["/pkg/.ts"]],
    ["", "/pkg", ["/pkg/.ts", "/pkg/.d.ts"], []],
    ["node main.js", "/pkg", ["/pkg/.d.mts", "/pkg/main.js"], ["/pkg/main.js"]],
    ["node ./main", "/", ["/index.ts", "/main.js"], ["/main.js"]],
    ["node .", "/", ["/index.ts"], ["/index.ts"]],
  ])(
    "reads %j below %j to name, of %j, %j: a file whose whole name is an extension is named by it as a path, and no name is empty",
    (input, dir, files, named) => {
      const spelled = files.map((file) => ({ file, paths: [file] }));

      expect(
        spelledFiles(heldWords([{ text: input, shell: true }]), dir, dir, spelled).files,
      ).toEqual(named);
    },
  );

  it.each([
    ["node ../shared/a.js /elsewhere/b.js", ["/shared/a.js", "/elsewhere/b.js"]],
    ["node --test 'test/*.test.js'", ["/pkg/test/a.test.js"]],
    ["node a b.js", ["/pkg/a b.js"]],
    ["NODE_ENV=production ./index.mjs", ["/pkg/node.mjs"]],
    ["node index.mjs", ["/pkg/node.mjs"]],
  ])(
    "reads %j to name none of %j: outside the package, a glob, a name the shell splits into two words, or a name in another letter case",
    (input, files) => {
      expect(namedIn(input, files)).toEqual([]);
    },
  );

  it.each([
    ["# re-tags the newest builds under fresh pre-release versions", ["/pkg/src/versions.ts"]],
    ["jobs:\n  notify:\n    runs-on: ubuntu-latest", ["/pkg/static-src/notify.ts"]],
    ["name: review", ["/pkg/src/toast/view.ts"]],
    ["lib", ["/pkg/lib/index.mjs"]],
    ["vitest run src/versions.test.ts src/versions.json", ["/pkg/src/versions.ts"]],
    ["uses: actions/checkout@v4", ["/pkg/checkout.ts", "/pkg/actions/index.ts"]],
    ["- uses: github/codeql-action/init@v3", ["/pkg/codeql-action/index.ts", "/pkg/init.ts"]],
    ["uses: actions/checkout@v4 # then scripts/notify.ts", ["/pkg/scripts/notify.ts"]],
    ["node gen.js # see scripts/notify.ts", ["/pkg/scripts/notify.ts"]],
    ["  uses:\n    actions/cache/save@v4", ["/pkg/save.ts"]],
    ["uses: docker://ghcr.io/acme/notify:1.2", ["/pkg/notify.ts"]],
    ["image: docker://alpine/notify", ["/pkg/notify/index.ts"]],
    [
      "uses: docker://ghcr.io/lib/${{ inputs.tool }}",
      ["/pkg/lib/index.ts", "/pkg/ghcr.io/lib/x.ts"],
    ],
    ["see actions/setup-node@v4 for the cache", ["/pkg/actions/index.ts"]],
    [
      "run-url: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
      ["/pkg/actions/index.ts", "/pkg/actions/runs.ts"],
    ],
    ['"@cplieger/actions": "4.0.0"', ["/pkg/actions/index.ts"]],
    ["node -r @babel/register main.js", ["/pkg/register.ts"]],
    ["npx @scope/notify@^2.1", ["/pkg/notify.ts"]],
    ["see src/toast/view.ts", ["/pkg/src/toast/index.ts"]],
    ["path: .github/workflows/release.yaml", ["/pkg/release.ts"]],
    ["see src/versions/ and my-versions.ts", ["/pkg/src/versions.ts"]],
    [
      "image: docker://${{ env.IMAGE }}/notify:latest",
      ["/pkg/notify/index.ts", "/pkg/src/notify.ts"],
    ],
  ])(
    "reads %j to name none of %j: a word, a key, a bare name, a comment, or a longer segment or path",
    (input, files) => {
      expect(namedIn(input, files)).toEqual([]);
    },
  );

  it.each([
    ["versions.ts", "/pkg/versions.ts"],
    ["./versions", "/pkg/versions.ts"],
    ["src/versions", "/pkg/src/versions.ts"],
    ["static-src/notify.js", "/pkg/static-src/notify.ts"],
    ["src\\versions", "/pkg/src/versions.ts"],
    ["@/versions", "/pkg/src/versions.ts"],
    ['"src/versions.ts"', "/pkg/src/versions.ts"],
    ["src/versions.ts:12", "/pkg/src/versions.ts"],
    ["see src/versions.", "/pkg/src/versions.ts"],
    ["src/toast/", "/pkg/src/toast/index.ts"],
    ["App.vue", "/pkg/src/App.vue"],
  ])("reads %j to name %j: a name a separator or an extension makes a path", (input, file) => {
    expect(namedIn(input, [file])).toEqual([file]);
  });

  it.each([
    ['eval "$RUNNER apps/web/@app/main.js"', "/pkg/apps/web/@app/main.js"],
    ["node ./@app/main", "/pkg/@app/main.ts"],
    ["node @app/main.js", "/pkg/@app/main.js"],
    ["node @tools/run/main.js", "/pkg/@tools/run/main.js"],
    ["      - uses: ./tools/notify", "/pkg/tools/notify/index.js"],
    ["- uses: .github/actions/x", "/pkg/.github/actions/x/index.js"],
    ['  uses: "./.github/actions/setup"', "/pkg/.github/actions/setup/index.js"],
    ['node g""en.js', "/pkg/gen.js"],
    ["node ${DIR}@app/main", "/pkg/@app/main.ts"],
    ["node $@app/main", "/pkg/app/main.ts"],
    ["calldocker://scripts/lint.ts", "/pkg/scripts/lint.ts"],
    ["node scripts/lint//", "/pkg/scripts/lint/index.ts"],
    ["node .\\\\", "/pkg/index.ts"],
  ])(
    "reads %j to name %j: an `@` past a token's start, a local action, a word the shell removes quotes from, a docker: inside a longer word and a doubled separator are paths",
    (input, file) => {
      expect(namedIn(input, [file])).toEqual([file]);
    },
  );

  it.each([
    [
      "node scripts/${{ matrix.tool }}.ts",
      ["/pkg/scripts/lint.ts", "/pkg/scripts/sub/x.ts"],
      ["/pkg/scripts/lint.js", "/pkg/lint.ts"],
    ],
    [
      "node scripts/$TOOL.ts",
      ["/pkg/scripts/lint.ts", "/pkg/scripts/sub/x.ts"],
      ["/pkg/scripts/lint.js", "/pkg/lint.ts"],
    ],
    [
      'node ".\\tools\\lint-${NAME}"',
      ["/pkg/tools/lint-a.ts", "/pkg/tools/lint-run/index.ts"],
      ["/pkg/tools/run/x.ts", "/pkg/tools/lint.ts"],
    ],
    ["node $DIR/lint-$X", ["/pkg/lint-a.ts", "/pkg/scripts/lint-b.ts"], ["/pkg/scripts/b.ts"]],
    ["node $(dirname $0)/lint.ts", ["/pkg/scripts/lint.ts", "/pkg/tools/lint.ts"], []],
    ["node ${{ github.workspace }}/scripts", ["/pkg/scripts/index.ts"], ["/pkg/scripts/x.ts"]],
    ["node $NAME.ts", ["/pkg/lint.ts", "/pkg/scripts/lint.ts"], ["/pkg/scripts/lint.js"]],
    [
      "node scripts/${{ matrix.tool }}",
      ["/pkg/scripts/lint.js", "/pkg/scripts/sub/index.ts", "/pkg/scripts/build/web.js"],
      ["/pkg/lint.js", "/pkg/tools/lint.js"],
    ],
    [
      "node scripts/$1",
      ["/pkg/scripts/lint.js", "/pkg/tools/scripts/check.ts", "/pkg/scripts/sub/x.js"],
      ["/pkg/lint.js"],
    ],
    ["node ./scripts/$(echo lint)", ["/pkg/scripts/lint.js"], ["/pkg/lint.js"]],
    [
      "node scripts/$TOOL/",
      ["/pkg/scripts/sub/index.ts", "/pkg/lib/index.mjs"],
      ["/pkg/scripts/sub/x.js", "/pkg/scripts/lint.ts"],
    ],
    [
      "node scripts/$TOOL//",
      ["/pkg/scripts/sub/index.ts", "/pkg/lib/index.mjs"],
      ["/pkg/scripts/sub/x.js", "/pkg/scripts/lint.ts"],
    ],
    [
      "node scripts\\$TOOL\\\\",
      ["/pkg/scripts/sub/index.ts", "/pkg/lib/index.mjs"],
      ["/pkg/scripts/sub/x.js", "/pkg/scripts/lint.ts"],
    ],
    [
      "working-directory: packages/${{ matrix.pkg }}",
      ["/pkg/packages/a/index.js", "/pkg/packages/a/stray.js"],
      ["/pkg/lib/stray.js"],
    ],
    ["@scope/$X/run.js", ["/pkg/@scope/a/run.js"], []],
    [
      "node @tools/build-${{ matrix.target }}.mjs",
      ["/pkg/@tools/build-web.mjs"],
      ["/pkg/@tools/run.mjs", "/pkg/build-web.mjs"],
    ],
    ["node @app/main-$1.js", ["/pkg/@app/main-lint.js"], ["/pkg/@app/other.js"]],
    [
      "node scripts/lint$X",
      ["/pkg/scripts/lint.ts", "/pkg/scripts/lint-fast.js"],
      ["/pkg/lint.ts", "/pkg/tools/lint.ts"],
    ],
    [
      "node scripts/${X}lint.ts",
      ["/pkg/scripts/lint.ts", "/pkg/scripts/eslint.ts"],
      ["/pkg/lint.ts", "/pkg/scripts/lint.js"],
    ],
    ["node lib/$X/", ["/pkg/lib/index.mjs", "/pkg/lib/a/index.ts"], ["/pkg/lib/a.ts"]],
    ["node src/$X/deep", ["/pkg/src/a/deep.ts"], ["/pkg/src/index.ts"]],
    [
      "node scripts/$X/lint-$Y",
      ["/pkg/scripts/a/lint-b.ts", "/pkg/lint-c.ts"],
      ["/pkg/scripts/a/check.ts"],
    ],
    ["node scripts/./$1", ["/pkg/scripts/lint.js"], ["/pkg/lint.js"]],
    ["node /pkg/scripts/$1", ["/pkg/scripts/lint.js"], ["/pkg/lint.js"]],
    ["cd sub && node ../pkg/scripts/$1", ["/pkg/scripts/lint.js"], ["/pkg/lint.js"]],
    ["node zz/scripts/$1", [], ["/pkg/scripts/lint.js"]],
  ])(
    "reads %j to name %j, which a word with a part only its run knows may write, any text with separators standing for the part, and none of %j",
    (input, named, others) => {
      expect([...namedIn(input, [...named, ...others, "/pkg/notes.md"])].sort()).toEqual(
        [...named].sort(),
      );
    },
  );

  it.each([
    ["run: ${{ matrix.cmd }}"],
    ["echo $GITHUB_SHA ${HOME} $(date)"],
    ["tar czf $NAME.tgz"],
    ["costs $5 and $"],
    ['d="${work}/${repo}/${tag}"'],
    ['rel="$dir/$name"'],
    ['cp "$SRC/$F" dist/'],
    ["go run ./$d"],
    ['echo "wiregen: go run ./$d"'],
    ['docker push "${REGISTRY}/${IMAGE_NAME}"'],
    ["docker push docker.io/${IMAGE_NAME}:${VERSION}"],
    ["- uses: ${{ inputs.owner }}/lint@v1"],
  ])(
    "reads %j to name no file and cap nothing: a word with a part only its run knows writes no part of a path the files have, outside the file a command runs",
    (input) => {
      expect(
        readIn(input, [
          "/pkg/scripts/lint.ts",
          "/pkg/lib/index.ts",
          "/pkg/packages/a/index.js",
          "/pkg/packages/a/stray.js",
        ]),
      ).toEqual({ files: [], unwritten: false });
    },
  );

  it.each([
    ["node $1"],
    ["node ./${{ matrix.tool }}"],
    ["node ./$1"],
    ["cd tools && node ../$1"],
    ['rel="$dir/$name" && node ./$d'],
    ["node ../$e/"],
    ["node ./$X//"],
    ["node $X/"],
    ["node $dir/$name"],
    ['node "$DIR"/"$NAME"'],
    ["node -r $PRELOAD main.mjs"],
    ["tsx watch $ENTRY"],
    ["npx -c 'node $1'"],
    ['sh -c "node $1"'],
  ])(
    "reads %j to name no file but cap the package's file findings: a word that a runtime runs or loads, or an argument of a dynamic program, writes no path text",
    (input) => {
      expect(
        readIn(input, [
          "/pkg/lint.js",
          "/pkg/index.ts",
          "/pkg/tools/x/check.ts",
          "/pkg/lib/index.mjs",
        ]),
      ).toEqual({ files: [], unwritten: true });
    },
  );

  it.each([
    ["node -C development $1"],
    ["node --watch-path src $1"],
    ["tsx --tsconfig tsconfig.json $1"],
    ["ts-node -P tsconfig.json $SCRIPT"],
    ["npx tsx@4 $1"],
    ["npx node@20 $1"],
    ["pnpm dlx tsx@latest $1"],
    ["/usr/bin/node $1"],
    ["$1"],
    ['"$@"'],
    ["$CMD --verbose"],
    ['exec "$@"'],
    ["cross-env A=1 $RUN"],
    ["ls | xargs node -C development"],
    ['bash -c "$CMD"'],
    ['sh -ec "${{ inputs.run }}"'],
    ['eval "$CMD"'],
    ['concurrently --names a "npm:lint" "$CMD"'],
    ["npm $SUB $TOOL"],
    ["yarn ${{ matrix.task }}"],
  ])(
    "reads %j to name no file but cap the package's file findings: the runtime's reader gives the entry, every later word where it does not read the options, and a dynamic program word may run a file",
    (input) => {
      expect(readIn(input, ["/pkg/scripts/lint.js"])).toEqual({ files: [], unwritten: true });
    },
  );

  it.each([
    ["node -C development lint", ["/pkg/lint.js"], false],
    ["tsx --tsconfig tsconfig.json lint", ["/pkg/lint.js"], false],
    ["nohup node lint", ["/pkg/lint.js"], false],
    ["node versions --check", ["/pkg/versions.ts"], false],
    ["node lib", ["/pkg/lib/index.mjs"], false],
    ["$CMD lint", ["/pkg/lint.js"], true],
    ["cat lint", [], false],
    ["lint --fix", [], false],
    ["node -r lint main.js", [], false],
  ])(
    "reads %j to name %j: a static word where a runtime may take its entry names what the runtime may run, and caps: %j",
    (input, named, unwritten) => {
      expect(
        readIn(input, [
          "/pkg/lint.js",
          "/pkg/versions.ts",
          "/pkg/lib/index.mjs",
          "/pkg/scripts/check.js",
        ]),
      ).toEqual({ files: named, unwritten });
    },
  );

  it.each([
    ["cross-env NODE_ENV=$X node scripts/check.js"],
    ['env "FOO=$BAR" node scripts/check.js'],
    ["env -u HOME A=$X node scripts/check.js"],
    ["npx --yes -- tsx scripts/check.js $1"],
    ["timeout 5m node scripts/check.js"],
    ["bash scripts/check.js.sh $1 && node scripts/check.js"],
    ["npm run $SCRIPT -- scripts/check.js"],
    ["sh -c 'node scripts/check.js'"],
    ["find . -name '*.js' -exec node scripts/check.js {} \\;"],
  ])(
    "reads %j to cap nothing: a launcher's reader gives the program word, and an argument after the entry runs nothing",
    (input) => {
      expect(readIn(input, ["/pkg/scripts/check.js"])).toEqual({
        files: ["/pkg/scripts/check.js"],
        unwritten: false,
      });
    },
  );

  it.each([
    ["for f in scripts/*.js; do node $f; done", ["/pkg/scripts/lint.js"], true],
    ["node scripts/*.js", ["/pkg/scripts/lint.js"], false],
    ["node scripts/?int.js", ["/pkg/scripts/lint.js"], false],
    ["node scripts/[l]int.js", ["/pkg/scripts/lint.js"], false],
    [
      "node scripts/{lint,check}.js",
      ["/pkg/scripts/lint.js", "/pkg/lint.js", "/pkg/tools/check.mjs"],
      false,
    ],
    ["node tools/{check,other}.mjs", ["/pkg/tools/check.mjs"], false],
    ['node scripts/"${{ matrix.tool }}"', ["/pkg/scripts/lint.js"], false],
    ['node scripts/"$T".js', ["/pkg/scripts/lint.js"], false],
    ["node scripts/'$T'.js", [], false],
    ['node "$DIR/$NAME".js', ["/pkg/scripts/lint.js", "/pkg/lint.js"], false],
    ["node $(echo scripts/$T.js)", ["/pkg/scripts/lint.js"], true],
    ["files=$(ls scripts/$P*.js)", ["/pkg/scripts/lint.js"], false],
    ['node "$(realpath scripts/$1)"', ["/pkg/scripts/lint.js"], true],
    ["node $(dirname $0)/lint.js", ["/pkg/scripts/lint.js", "/pkg/lint.js"], false],
    ["node ${X:-scripts/lint.js}", ["/pkg/scripts/lint.js", "/pkg/lint.js"], true],
    ["cat <<EOF\nnode scripts/$T.js\nEOF", ["/pkg/scripts/lint.js"], false],
    ["node ~/pkg/scripts/lint.js", ["/pkg/scripts/lint.js", "/pkg/lint.js"], false],
    ["node scripts\\$T.js", ["/pkg/scripts/lint.js"], false],
    [
      "node .\\$1",
      ["/pkg/scripts/lint.js", "/pkg/lint.js", "/pkg/tools/check.mjs"].slice(0, 0),
      true,
    ],
    ["env node scripts/$T.js", ["/pkg/scripts/lint.js"], false],
    ["exec $RUNNER lint.mjs", ["/pkg/scripts/lint.js", "/pkg/lint.js"], true],
    ["for f in tools/*; do node $f; done", ["/pkg/tools/check.mjs"], true],
    ["ls scripts/*.js | xargs -n1 node", ["/pkg/scripts/lint.js"], true],
    ["find scripts -name '*.js' -exec node {} \\;", [], true],
    ["timeout 5 $CMD $1", [], true],
    ["npx eslint $FILES", [], false],
    ["echo 'unclosed && node scripts/$T.js", ["/pkg/scripts/lint.js"], false],
  ])(
    "reads %j to name %j, the shell's words with their globs, braces, quotes and substitutions, and caps the file findings: %j",
    (input, named, unwritten) => {
      expect(
        readIn(input, [
          "/pkg/scripts/lint.js",
          "/pkg/lint.js",
          "/pkg/tools/check.mjs",
          "/pkg/notes.md",
        ]),
      ).toEqual({ files: named, unwritten });
    },
  );

  it.each([
    ["uses", "actions/checkout@v4", []],
    ["uses", "owner/repo@feature/x", []],
    ["uses", "github/codeql-action/init@v3", []],
    ["uses", "actions/cache/save@v4", []],
    ["uses", "${{ inputs.owner }}/lint@v1", []],
    ["uses", "./tools/notify", ["/pkg/notify/index.ts", "/pkg/tools/notify/index.ts"]],
    [
      "uses",
      ".github/actions/x",
      ["/pkg/x.ts", "/pkg/.github/actions/x/index.ts", "/pkg/scripts/x.ts"],
    ],
    ["image", "docker://alpine/notify", []],
    ["REPORT", "scripts/x.ts", ["/pkg/x.ts", "/pkg/scripts/x.ts"]],
    ["working-directory", "packages/${{ matrix.pkg }}", ["/pkg/packages/a/stray.js"]],
    ["TOOL", "$1", []],
  ])(
    "reads the value under the key %j, %j, to name %j and cap nothing: a value has no program word",
    (key, text, named) => {
      const files = [
        "/pkg/x.ts",
        "/pkg/repo/index.ts",
        "/pkg/init.ts",
        "/pkg/save.ts",
        "/pkg/lint.ts",
        "/pkg/notify/index.ts",
        "/pkg/tools/notify/index.ts",
        "/pkg/.github/actions/x/index.ts",
        "/pkg/scripts/x.ts",
        "/pkg/packages/a/stray.js",
      ];

      expect(
        spelledFiles(
          heldWords([{ text, shell: false, key }]),
          "/pkg",
          "/pkg",
          files.map((file) => ({ file, paths: [file] })),
        ),
      ).toEqual({ files: named, unwritten: false });
    },
  );

  it.each([
    ["start", "node ${{ inputs.entry }}", true],
    ["command", "npx tsx $SCRIPT", true],
    [undefined, "lint: ; node $(SCRIPT)", true],
    ["TOOL", "$1", false],
    ["run-name", "$CMD lint", false],
  ])(
    "reads the value under the key %j, %j, as a quoted text is, a runtime's entry and no program word, and caps: %j",
    (key, text, unwritten) => {
      expect(
        spelledFiles(
          heldWords([{ text, shell: false, ...(key === undefined ? {} : { key }) }]),
          "/pkg",
          "/pkg",
          [{ file: "/pkg/scripts/lint.js", paths: ["/pkg/scripts/lint.js"] }],
        ),
      ).toEqual({ files: [], unwritten });
    },
  );

  /** The package the rows below read a command in, with what `$RUNNER lint` holds and caps in it. */
  const LAUNCHED = ["/pkg/lint.js", "/pkg/scripts/lint.js", "/pkg/scripts/sub/x.js"];
  const RUNS_LINT = { files: ["/pkg/lint.js", "/pkg/scripts/lint.js"], unwritten: true };
  const NOTHING = { files: [], unwritten: false };
  const CAPS = { files: [], unwritten: true };
  /** What `node lint` holds in this package. */
  const LINT = { files: ["/pkg/lint.js", "/pkg/scripts/lint.js"], unwritten: false };
  const BELOW_SCRIPTS = {
    files: ["/pkg/scripts/lint.js", "/pkg/scripts/sub/x.js"],
    unwritten: false,
  };

  it.each([
    ["$RUNNER lint", RUNS_LINT],
    ["sh -c '$RUNNER lint'", RUNS_LINT],
    ["bash -c '$RUNNER lint'", RUNS_LINT],
    ["bash -o pipefail -ec '$RUNNER lint' name", RUNS_LINT],
    ["eval '$RUNNER lint'", RUNS_LINT],
    ['eval "$RUNNER" lint', RUNS_LINT],
    ["npx -c '$RUNNER lint'", RUNS_LINT],
    ["npx --call='$RUNNER lint'", RUNS_LINT],
    ["npm exec -c '$RUNNER lint'", RUNS_LINT],
    ["npm exec --call='node $X'", CAPS],
    ["env -S'$RUNNER lint'", CAPS],
    ["env --split-string='$RUNNER lint'", CAPS],
    ["pnpm exec --shell-mode '$RUNNER lint'", RUNS_LINT],
    ["concurrently -n a,b '$RUNNER lint' 'vite'", RUNS_LINT],
    ["sh -c 'exec $RUNNER lint'", RUNS_LINT],
    ["sh -c 'npx $T lint'", RUNS_LINT],
    ["sudo -E sh -c '$RUNNER lint'", RUNS_LINT],
    ["xargs sh -c '$RUNNER lint'", RUNS_LINT],
    ["env -S '$RUNNER lint'", CAPS],
    ["bash <<'EOF'\n$RUNNER lint\nEOF", RUNS_LINT],
    ["sh -s <<EOF\n$RUNNER lint\nEOF", RUNS_LINT],
    ["sh <<< '$RUNNER lint'", RUNS_LINT],
    ["echo '$RUNNER lint' | sh", RUNS_LINT],
    ["cat <<EOF | bash\n$RUNNER lint\nEOF", RUNS_LINT],
    ["pnpm -r exec -c '$RUNNER lint'", RUNS_LINT],
    ["pnpm -c exec '$RUNNER lint'", RUNS_LINT],
    ["pnpm --shell-mode exec '$RUNNER lint'", RUNS_LINT],
    ["pnpm --filter web exec -c '$RUNNER lint'", RUNS_LINT],
    ["pnpm -F web --parallel dlx --shell-mode '$RUNNER lint'", RUNS_LINT],
    ["pnpm --frobnicate exec -c '$RUNNER lint'", RUNS_LINT],
    ["npm -w web exec -c '$RUNNER lint'", RUNS_LINT],
    ["npm --workspaces exec --call='$RUNNER lint'", RUNS_LINT],
    ["npm --prefix sub x -c '$RUNNER lint'", RUNS_LINT],
    ["pnpm -r exec echo '$RUNNER lint'", NOTHING],
    ["parallel '$RUNNER lint' ::: a", RUNS_LINT],
    ["parallel 'cd sub && $RUNNER lint' ::: a", RUNS_LINT],
    ["ls | parallel '$RUNNER lint'", RUNS_LINT],
    ["parallel -j4 '$RUNNER' lint ::: a", RUNS_LINT],
    ["parallel echo '$RUNNER' lint ::: a", NOTHING],
    ["parallel cp {} dist/ ::: a", NOTHING],
    ['env -S"$RUNNER lint"', CAPS],
    ['env -S"node $X"', CAPS],
    ['npx --call="$RUNNER lint"', RUNS_LINT],
    ["sh -c '$RUNNER'", CAPS],
    ["echo '$RUNNER lint'", NOTHING],
    ["echo '$RUNNER lint' | cat", NOTHING],
    ["cat <<EOF\n$RUNNER lint\nEOF", NOTHING],
    ["bash scripts/run.sh <<EOF\n$RUNNER lint\nEOF", NOTHING],
    ["sh -c 'echo $1' '$RUNNER lint'", NOTHING],
  ])(
    "reads %j, whose quoted text a command may hand on as a command line, with the program-word rule there only: %j",
    (input, read) => {
      expect(readIn(input, LAUNCHED)).toEqual(read);
    },
  );

  it.each([
    ['bash $FLAGS "$CMD"', CAPS],
    ["sh $FLAGS '$RUNNER lint'", RUNS_LINT],
    ["bash scripts/x.sh $1", NOTHING],
    ["bash -e scripts/x.sh $1", NOTHING],
    ['bash "$CI_TOOLS/run.sh" "$1"', NOTHING],
    ["bash ${DIR}/lint.sh $1", NOTHING],
    ["bash -$MODE '$RUNNER lint'", RUNS_LINT],
    ["bash $SHELL_FLAGS -e '$RUNNER lint'", RUNS_LINT],
  ])(
    "reads %j, where a dynamic word before a shell's first operand may be an option holding c: %j",
    (input, read) => {
      expect(readIn(input, LAUNCHED)).toEqual(read);
    },
  );

  it.each([
    ['bash -- "$CMD"', CAPS],
    ['sh -- "$SCRIPT"', CAPS],
    ["bash -euo pipefail -- $1", CAPS],
    ["bash -o pipefail -- $1", CAPS],
    ["dash -- ${{ inputs.script }}", CAPS],
    ['sh - "$1"', CAPS],
    ["xargs -I % bash -- %", CAPS],
    ["find . -exec bash -- {} \\;", CAPS],
    ["ls | xargs bash", CAPS],
    ["ls | xargs -n1 sh --", CAPS],
    [
      "bash -- scripts/lint.js",
      { files: ["/pkg/lint.js", "/pkg/scripts/lint.js"], unwritten: false },
    ],
    ["bash -- scripts/$X", BELOW_SCRIPTS],
    ['bash -- "$DIR/x.sh"', NOTHING],
    ['bash -s -- "$1"', NOTHING],
    ["echo x | bash", NOTHING],
  ])("reads %j, where a shell's first operand is the script it runs: %j", (input, read) => {
    expect(readIn(input, LAUNCHED)).toEqual(read);
  });

  it.each([
    ['sh -s < "$F"', CAPS],
    ["bash < $SCRIPT", CAPS],
    ["bash -e < ${{ inputs.script }}", CAPS],
    ["bash 0< $F", CAPS],
    ["node < $F", CAPS],
    ["node - < $F", CAPS],
    [
      "bash < scripts/lint.js",
      { files: ["/pkg/lint.js", "/pkg/scripts/lint.js"], unwritten: false },
    ],
    ['bash < "$DIR/x.sh"', NOTHING],
    ["bash scripts/x.sh < $F", NOTHING],
    ["bash -c 'echo' < $F", NOTHING],
    ["bash 2< $F", NOTHING],
    ["cat < $F", NOTHING],
    ["node -e 1 < $F", NOTHING],
    ["node lint < $F", { files: ["/pkg/lint.js", "/pkg/scripts/lint.js"], unwritten: false }],
    ['node --no-warnings < "$F"', CAPS],
    ['node --input-type=module < "$F"', CAPS],
    ['node --input-type=module - < "$F"', CAPS],
    ['c8 node --no-warnings < "$F"', CAPS],
    ['cat "$F" | node --no-warnings', CAPS],
    ['cat "$F" | node', CAPS],
    ["{ bash; } < $F", CAPS],
    ["(bash) < $F", CAPS],
    ["while read -r x; do bash; done < $F", CAPS],
    ['cat "$F" | (bash)', CAPS],
    ["bash <> $F", CAPS],
    ["{ bash; } <<'EOF'\n$RUNNER lint\nEOF", RUNS_LINT],
    ["{ bash scripts/x.sh; } < $F", NOTHING],
    ["{ cat; } < $F", NOTHING],
    ["{ bash; } 2< $F", NOTHING],
    ["node <<'EOF'\nconsole.log(`${x}`)\nEOF", NOTHING],
    ["cat <<'EOF' | node\nconsole.log(`${x}`)\nEOF", NOTHING],
    ["node <<< '$RUNNER lint'", NOTHING],
    ['tsx < "$F"', CAPS],
    ['npx tsx < "$F"', CAPS],
    ['pnpm exec tsx < "$F"', CAPS],
    ["tsx <<'EOF'\nconst x: number = 1\nEOF", NOTHING],
    ['cat < "$F" | node', CAPS],
    ['cat - < "$F" | node', CAPS],
    ['curl -fsSL "$URL" | bash', CAPS],
    ["node --version | node", CAPS],
    ['node <&3 3< "$F"', CAPS],
    ["cat scripts/lint.js | node", LINT],
    ["cat <<'EOF' | bash\n$RUNNER lint\nEOF", RUNS_LINT],
  ])("reads %j, where a command that runs its standard input is fed a file: %j", (input, read) => {
    expect(readIn(input, LAUNCHED)).toEqual(read);
  });

  it.each([
    ["sh -c 'bash -e' <<'EOF'\n$RUNNER lint\nEOF", RUNS_LINT],
    ["env -S'bash' <<'EOF'\n$RUNNER lint\nEOF", RUNS_LINT],
    ["npx -c 'bash -e' <<'EOF'\n$RUNNER lint\nEOF", RUNS_LINT],
    ["eval 'bash' <<'EOF'\n$RUNNER lint\nEOF", RUNS_LINT],
    ["echo '$RUNNER lint' | sh -c 'bash -e'", RUNS_LINT],
    ["echo '$RUNNER lint' | env -S'bash -e'", RUNS_LINT],
    ["sh -c 'bash -e' <<< '$RUNNER lint'", RUNS_LINT],
    ["sh -c 'bash -e' < \"$F\"", CAPS],
    ["env -S'bash -e' < \"$F\"", CAPS],
    ["bash -c 'node --no-warnings' < \"$F\"", CAPS],
    ["npx -c 'node --no-warnings' < \"$F\"", CAPS],
    ["env -S'node' < \"$F\"", CAPS],
    ["cat \"$F\" | bash -c 'node --no-warnings'", CAPS],
    ["cat \"$F\" | env -S'node'", CAPS],
    ["eval 'node' < \"$F\"", CAPS],
    ["sh -c 'node' <<'EOF'\nconsole.log(`${x}`)\nEOF", NOTHING],
    ["sh -c 'node lint' < \"$F\"", LINT],
    ["sh -c 'cat' < \"$F\"", NOTHING],
  ])(
    "reads %j, where a command that hands a command line on hands it its standard input too: %j",
    (input, read) => {
      expect(readIn(input, LAUNCHED)).toEqual(read);
    },
  );

  it.each([
    ["echo node lint | bash", LINT],
    ["echo node lint | sh", LINT],
    ["echo node lint | (bash)", LINT],
    ["echo node lint | env -S'bash -e'", LINT],
    ["echo node lint | sh -c 'bash'", LINT],
    ['echo "node" "lint" | bash', LINT],
    ["echo -n node lint | bash", LINT],
    ["echo node {lint,x} | bash", LINT],
    ["printf 'node %s\\n' lint | sh", CAPS],
    ["printf 'node lint\\n' | sh", LINT],
    ["printf -- 'node lint 100%%\\n' | sh", LINT],
    ["printf 'node lint\\101' | sh", CAPS],
    ['printf "$X" | bash', CAPS],
    ["printf -v x 'node lint' | bash", LINT],
    ["echo -e 'node lint' | bash", RUNS_LINT],
    ["echo 'node lint\\c' | bash", CAPS],
    ['echo "$X" | bash', CAPS],
    ["echo node lint | cat", NOTHING],
    ["echo node | bash", NOTHING],
  ])(
    "reads %j, where echo writes its operands joined by blanks as one line and printf its format: %j",
    (input, read) => {
      expect(readIn(input, LAUNCHED)).toEqual(read);
    },
  );

  it.each([
    ['concurrently -P "node {@}" -- lint', CAPS],
    ['concurrently --passthrough-arguments "node {1}" -- lint', CAPS],
    ['concurrently -P "node {1}" --', CAPS],
    ['concurrently "node {*}"', CAPS],
    ['concurrently -P "node {1}" -- scripts/lint.js', RUNS_LINT],
    ['concurrently -n a,b "node lint" "npm:x"', LINT],
    ['concurrently "node lint" -k -s first vite', LINT],
    ['concurrently --names=a "npm:x" -- "node lint"', LINT],
    ['concurrently --teardown "node lint" vite', LINT],
    ['concurrently --teardown="$CMD" vite', CAPS],
    ['concurrently --frobnicate "node lint"', RUNS_LINT],
    ['concurrently -nweb "node lint"', RUNS_LINT],
    ["eval node lint", LINT],
    ["eval -- node lint", LINT],
    ["eval node '$X'", CAPS],
    ["find . $A node {} \\;", CAPS],
    ['find . -name "$P" -exec node lint \\;', LINT],
    ['find "$D" -newermt "$T" -exec node lint \\;', LINT],
    ['source "$F"', CAPS],
    ['. "$F"', CAPS],
    ["source -p x.sh", CAPS],
    ['node /dev/stdin < "$F"', CAPS],
    ['node /dev/fd/0 < "$F"', CAPS],
    ['cat "$F" | node /dev/stdin', CAPS],
    ["node /dev/stdin < scripts/lint.js", LINT],
    ["node scripts/lint.js", LINT],
  ])(
    "reads %j by its tool's documented grammar, an option or construct it does not list making the command unread: %j",
    (input, read) => {
      expect(readIn(input, LAUNCHED)).toEqual(read);
    },
  );

  it("reads the script source runs as the file it names, as a shell's script", () => {
    expect(readIn("source scripts/x.sh", [...LAUNCHED, "/pkg/scripts/x.sh"])).toEqual({
      files: ["/pkg/scripts/x.sh"],
      unwritten: false,
    });
  });

  it.each([
    ['if [ x ]; then node < "$F"; fi; )', CAPS],
    ['cat "$F" | node --no-warnings )', CAPS],
    ["node lint )", LINT],
    ["(node lint", LINT],
    ["then node lint )", LINT],
    ['node -e 1 < "$F" )', NOTHING],
    ['bash scripts/x.sh < "$F" )', NOTHING],
  ])(
    "reads %j, a line that does not parse, its redirects and pipes read token by token: %j",
    (input, read) => {
      expect(readIn(input, LAUNCHED)).toEqual(read);
    },
  );

  /** `text` handed to `sh -c` `levels` times, each level double-quoted. */
  const nested = (text: string, levels: number): string =>
    levels === 0 ? text : nested(`sh -c "${text.replaceAll(/[\\"$`]/gu, "\\$&")}"`, levels - 1);

  it.each([
    [3, { files: ["/pkg/scripts/lint.js"], unwritten: false }],
    [4, { files: ["/pkg/scripts/lint.js"], unwritten: false }],
    [7, CAPS],
    [8, CAPS],
  ])(
    "reads node scripts/lint nested in %j quoted command lines, past the depth it reads as running a file no word writes: %j",
    (levels, read) => {
      expect(readIn(nested("node scripts/lint", levels), ["/pkg/scripts/lint.js"])).toEqual(read);
    },
  );

  it.each([
    ["node --test", NOTHING],
    ["node --title=app --test", NOTHING],
    ["node --title app --test", NOTHING],
    ["node --preserve-symlinks --test", NOTHING],
    ["node --no-deprecation --test", NOTHING],
    ["c8 node --test", NOTHING],
    ["cd sub && node --test", NOTHING],
    ["node --test scripts/lint.js", LINT],
    ["node --test $X", CAPS],
    ["node --frobnicate --test", CAPS],
    ["sh -c 'node --test'", CAPS],
  ])(
    "reads %j, a manifest's script, where tests.1 roots the files node --test runs: %j",
    (input, read) => {
      expect(readIn(input, LAUNCHED, true)).toEqual(read);
    },
  );

  it.each([
    ["node --preserve-symlinks --test", CAPS],
    ["node --title app --test", CAPS],
    ["node --no-deprecation --test", CAPS],
    ["sh -c 'node --test'", CAPS],
    ["node --test 'test/*.test.js'", CAPS],
    ["node --test scripts/lint.js", LINT],
  ])(
    "reads %j outside a manifest's script, where no reader roots the files node --test runs: %j",
    (input, read) => {
      expect(readIn(input, LAUNCHED)).toEqual(read);
    },
  );

  it.each([
    ["env -iS'$RUNNER lint'", CAPS],
    ['env -iS"$RUNNER lint"', CAPS],
    ["env -vS '$RUNNER lint'", CAPS],
    ["env -ivS'$RUNNER lint'", CAPS],
    ["env -iu HOME -S '$RUNNER lint'", CAPS],
    ["env --frobnicate -S '$RUNNER lint'", CAPS],
    ["npx -yc '$RUNNER lint'", RUNS_LINT],
    ["pnpm exec -rc '$RUNNER lint'", RUNS_LINT],
    ["pnpm exec -cr '$RUNNER lint'", RUNS_LINT],
    ["pnpm dlx -sc '$RUNNER lint'", RUNS_LINT],
    // node's `-c`, `--check`, is no option of its table.
    ["pnpm exec node -c '$RUNNER lint'", CAPS],
    ["env -iv node $1", CAPS],
    ["env -iuHOME node $1", CAPS],
  ])("reads %j, a cluster of one-letter options as getopt reads it: %j", (input, read) => {
    expect(readIn(input, LAUNCHED)).toEqual(read);
  });

  it.each([
    ["c8 node lint", { files: ["/pkg/lint.js", "/pkg/scripts/lint.js"], unwritten: false }],
    [
      "c8 --reporter=lcov -r text node lint",
      { files: ["/pkg/lint.js", "/pkg/scripts/lint.js"], unwritten: false },
    ],
    ["c8 node $1", CAPS],
    ["c8 tsx $1", CAPS],
    ["nyc node $1", CAPS],
    ["nyc --silent -r lcov node $1", CAPS],
    ["dotenv -- node $1", CAPS],
    ["dotenv -e .env.test -- node $1", CAPS],
    ["env-cmd node lint", { files: ["/pkg/lint.js", "/pkg/scripts/lint.js"], unwritten: false }],
    ["env-cmd -f .env node $1", CAPS],
    ["env-cmd --use-shell '$RUNNER lint'", RUNS_LINT],
    ["cross-env-shell '$RUNNER lint'", RUNS_LINT],
    ["cross-env-shell A=1 '$RUNNER lint'", RUNS_LINT],
    ["dotenvx run -- node $1", CAPS],
    ["echo c8 node lint", NOTHING],
    ["c8 --frobnicate node $1", CAPS],
    ["pnpx tsx lint", { files: ["/pkg/lint.js", "/pkg/scripts/lint.js"], unwritten: false }],
    ["pnpx tsx $1", CAPS],
    ["pnpx --shell-mode '$RUNNER lint'", RUNS_LINT],
    [
      "dotenv -e .env node lint",
      { files: ["/pkg/lint.js", "/pkg/scripts/lint.js"], unwritten: false },
    ],
    ["dotenv -o node lint", { files: ["/pkg/lint.js", "/pkg/scripts/lint.js"], unwritten: true }],
  ])("reads %j, a wrapper that runs the command after its options: %j", (input, read) => {
    expect(readIn(input, LAUNCHED)).toEqual(read);
  });

  it.each([
    ["echo node lint", NOTHING],
    ["echo see node lint for details", NOTHING],
    ["echo node $1", NOTHING],
    ["echo using node $NODE_VERSION", NOTHING],
    ["echo node ${{ matrix.node }}", NOTHING],
    ["curl https://example.com/node $1", NOTHING],
    ["grep -r tsx $PATTERN", NOTHING],
    ["printf '%s' deno $1", NOTHING],
    ["echo 'node $1'", CAPS],
    ["node lint", LINT],
    ["node $1", CAPS],
    ["sudo node lint", LINT],
    ["sudo -u root node lint", LINT],
    ["sudo node $1", CAPS],
    ["nice -n 5 node lint", LINT],
    ["time node lint", LINT],
    ["exec node lint", LINT],
    ["pnpm node lint", LINT],
    ["pnpm -r exec node lint", LINT],
    ["npm -w web exec node lint", LINT],
    ["npm --frobnicate exec node lint", { ...LINT, unwritten: true }],
  ])(
    "reads %j, where only a program word names a runtime, the second layer placing it: %j",
    (input, read) => {
      expect(readIn(input, LAUNCHED)).toEqual(read);
    },
  );

  /** What `node lint` holds where a word before it is one its table does not model. */
  const LINT_CAPPED = { ...LINT, unwritten: true };

  it.each([
    ["node --frobnicate lint", LINT_CAPPED],
    ["tsx --zz lint", LINT_CAPPED],
    ["c8 --frobnicate node lint", LINT_CAPPED],
    ["npx --frobnicate tsx lint", LINT_CAPPED],
    ["npm exec tsx --frobnicate lint", LINT_CAPPED],
    ["pnpm --frobnicate exec tsx lint", LINT_CAPPED],
    ["pnpm exec --frobnicate tsx lint", LINT_CAPPED],
    ["pnpm dlx --frobnicate tsx lint", LINT_CAPPED],
    ["yarn dlx --frobnicate tsx lint", LINT_CAPPED],
    ["bunx --frobnicate tsx lint", LINT_CAPPED],
    ["env -C sub node lint", LINT_CAPPED],
    ["env --frobnicate node lint", LINT_CAPPED],
    ["xargs --frobnicate node", CAPS],
    ["xargs --frobnicate rm", CAPS],
    ["parallel --frobnicate node ::: lint", CAPS],
    ["bash --frobnicate x.sh", CAPS],
    ["sh -Z x.sh", CAPS],
    ["parallel node '{= s/$/.js/ =}' ::: lint", CAPS],
    ["parallel node {= s/$/.js/ =} ::: lint", CAPS],
    ["parallel 'node {= s/$/.js/ =}' ::: lint", CAPS],
    ["parallel node scripts/'{= s/x/y/ =}' ::: lint", CAPS],
    ["parallel node {=s/$/.js/=} ::: lint", CAPS],
    ["parallel node '{''= s/$/.js/ =}' ::: lint", CAPS],
    ['parallel node "{"= s/x/y/ =} ::: lint', CAPS],
    ["node --no-warnings --enable-source-maps lint", LINT],
    ["node --max-old-space-size=4096 --inspect lint", LINT],
    ["node --env-file .env lint", LINT],
    ["tsx --tsconfig tsconfig.json --no-warnings lint", LINT],
    ["node --version", NOTHING],
    ["node --test", CAPS],
    ["node --test --test-reporter spec", CAPS],
    ["tsx --test", CAPS],
    ["bash --login -eo pipefail scripts/x.sh", NOTHING],
    ["echo node --frobnicate lint", NOTHING],
    ["parallel node scripts/{} ::: lint", BELOW_SCRIPTS],
  ])(
    "reads %j, where a word its tool's table does not model makes every later word a run place and caps the package: %j",
    (input, read) => {
      expect(readIn(input, LAUNCHED)).toEqual(read);
    },
  );

  it.each([
    ["env -S'node --no-warnings' lint", LINT],
    ["env -S 'node --no-warnings' lint", LINT],
    ["env -S '-i node lint'", LINT],
    ["env -S'node' lint", LINT],
    ["env -vS'node' lint", LINT],
    ["env -iS 'npx tsx' lint", LINT],
    ["env --split-string='-u HOME node' lint", LINT],
    ["env -S'-S node' lint", LINT],
    ["env -S'node' --frobnicate lint", LINT_CAPPED],
    ["env -S '-i -C/tmp A=B node lint'", LINT_CAPPED],
    ["env -S '-u FOO node $1'", CAPS],
    ['env -S"$FLAGS" lint', LINT_CAPPED],
    ["env -S'tsx' $1", CAPS],
    ["env -S'node \\c' lint", CAPS],
    ["env -S'echo node' lint", NOTHING],
  ])(
    "reads %j, where GNU env splits its -S value in place, before its later words, and reads its options again: %j",
    (input, read) => {
      expect(readIn(input, LAUNCHED)).toEqual(read);
    },
  );

  it.each([
    ['"$(go env GOPATH)/bin/gorelease" -base="$prev"', NOTHING],
    ['"$DIR"/node $1', CAPS],
    ["$DIR/$TOOL $1", CAPS],
    ['echo "digest \\`${DIGEST}\\`"', NOTHING],
    ["node .\\$1", CAPS],
  ])(
    "reads %j, where a program word the run computes writes its last segment and a `\\` escapes a quote: %j",
    (input, read) => {
      expect(readIn(input, LAUNCHED)).toEqual(read);
    },
  );

  it.each([
    ["xargs -I % node %", CAPS],
    ["xargs -I% node ./%", CAPS],
    ["xargs -i node {}", CAPS],
    ["xargs --replace=@ node @", CAPS],
    ["xargs -0 -n1 node", CAPS],
    ["parallel -I % node %", CAPS],
    ["parallel node {.}", CAPS],
    ["parallel -j4 node ::: lint", CAPS],
    ["find . -name '*.js' -exec node {} \\;", CAPS],
    ["find . -exec node ./{} +", CAPS],
    ["find . -exec echo {} \\; -execdir node {} \\;", CAPS],
    ["xargs -I % sh -c 'node %'", CAPS],
    ["xargs -i% node %", CAPS],
    ["xargs -iX node X", CAPS],
    ["xargs -i% node scripts/%", BELOW_SCRIPTS],
    ["xargs --replace node {}", CAPS],
    ["xargs -I % node scripts/%", BELOW_SCRIPTS],
    ["xargs -I FILE node scripts/FILE.js", BELOW_SCRIPTS],
    ["find . -exec node scripts/{} \\;", BELOW_SCRIPTS],
    ["xargs -I FILE node scripts/%", NOTHING],
    ["xargs -I % cp % dist/", NOTHING],
    ["find $DIR -name '*.js' -exec cp {} dist/ \\;", NOTHING],
    ["find . -name '*.js' -delete", NOTHING],
    ["xargs node lint", { files: ["/pkg/lint.js", "/pkg/scripts/lint.js"], unwritten: false }],
    ["xargs -I % % lint", RUNS_LINT],
    [
      "xargs --frobnicate node lint",
      { files: ["/pkg/lint.js", "/pkg/scripts/lint.js"], unwritten: true },
    ],
    ["parallel ::: '$RUNNER lint' vite", RUNS_LINT],
    ["parallel <<EOF\n$RUNNER lint\nEOF", RUNS_LINT],
  ])(
    "reads %j, where each text an appending tool replaces with a path it finds is a part only the run knows: %j",
    (input, read) => {
      expect(readIn(input, LAUNCHED)).toEqual(read);
    },
  );

  it.each([
    ["bun $1", CAPS],
    ["bun run $1", CAPS],
    ["bun run scripts/$1", BELOW_SCRIPTS],
    ["bun lint", { files: ["/pkg/lint.js", "/pkg/scripts/lint.js"], unwritten: false }],
    ["bun install", NOTHING],
    ["bun x $T lint", RUNS_LINT],
    ["deno run -A $1", CAPS],
    ["deno $1", CAPS],
    ["deno task lint", NOTHING],
    ["deno -A lint", { files: ["/pkg/lint.js", "/pkg/scripts/lint.js"], unwritten: false }],
    ["deno --quiet lint", NOTHING],
    ["deno run -A lint", { files: ["/pkg/lint.js", "/pkg/scripts/lint.js"], unwritten: false }],
    ["node.exe $1", CAPS],
    ["C:\\nodejs\\node.exe $1", CAPS],
    ["npx.cmd tsx $1", CAPS],
  ])("reads %j, a runtime the second layer has a row for: %j", (input, read) => {
    expect(readIn(input, LAUNCHED)).toEqual(read);
  });

  it.each([
    ["node --run lint", NOTHING],
    ["node -e x lint", NOTHING],
    ["node --eval=x lint", NOTHING],
    ["node --print 1 lint", NOTHING],
    ["ts-node -e x lint", NOTHING],
    ["node -r ./setup.cjs --run lint -- $1", NOTHING],
    ["node --run $1", CAPS],
  ])(
    "reads %j, whose option runs its value in the entry's place, as running no entry: %j",
    (input, read) => {
      expect(readIn(input, LAUNCHED)).toEqual(read);
    },
  );

  it.each([
    ["node deadset/$X", [], false],
    ["node $DIR/deadset/$X", [], false],
    ["node scripts/$X", ["scripts/lint.js", "scripts/sub/x.js"], false],
    ["node $DIR/scripts/$X", ["scripts/lint.js", "scripts/sub/x.js"], false],
    ["node ../deadset/scripts/$X", ["scripts/lint.js", "scripts/sub/x.js"], false],
    ["node ../../work/deadset/scripts/$X", ["scripts/lint.js", "scripts/sub/x.js"], false],
    ["node ../deadset/$X", [], true],
    ["node ../deadset/lint", ["lint.js", "scripts/lint.js"], false],
    ["node /work/deadset/scripts/$X", ["scripts/lint.js", "scripts/sub/x.js"], true],
    ["node /home/runner/work/x/x/scripts/$X", ["scripts/lint.js", "scripts/sub/x.js"], true],
    ["node /app/scripts/sub/$X", ["scripts/sub/x.js"], true],
    ["node /app/$X.js", ["lint.js", "scripts/lint.js", "scripts/sub/x.js"], false],
    ["node /app/scripts/$X/", [], false],
    ["node /usr/local/bin/$X", [], true],
    ["node /$X", [], true],
    ["cat /tmp/$X", [], false],
    ["node /home/$USER/scripts/$X", ["scripts/lint.js", "scripts/sub/x.js"], false],
  ])(
    "reads %j to name, of each checkout of a repository, the same files below its root, %j, capping: %j",
    (input, named, unwritten) => {
      for (const root of ["/work/deadset", "/home/runner/work/x/x", "/src/deadset/clone"]) {
        const files = LAUNCHED.map((file) => `${root}${file.slice("/pkg".length)}`);
        const got = spelledFiles(
          heldWords([{ text: input, shell: true }]),
          root,
          root,
          files.map((file) => ({ file, paths: [file] })),
        );

        expect({ root, ...got }).toEqual({
          root,
          files: named.map((file) => `${root}/${file}`),
          unwritten,
        });
      }
    },
  );

  it.each([
    ["node ../a/scripts/$X", ["/r/packages/a/scripts/x.js"]],
    ["node ../../packages/a/scripts/$X", ["/r/packages/a/scripts/x.js"]],
    ["node ../../../r/packages/a/scripts/$X", ["/r/packages/a/scripts/x.js"]],
    ["node ../../../elsewhere/packages/a/scripts/$X", ["/r/packages/a/scripts/x.js"]],
  ])(
    "reads %j in /r/packages/a, a package below the root /r, to name %j, a word that climbs past the root writing the root's own directories there",
    (input, named) => {
      const files = ["/r/packages/a/scripts/x.js", "/r/packages/a/lib/y.js"];
      expect(
        spelledFiles(
          heldWords([{ text: input, shell: true }]),
          "/r/packages/a",
          "/r",
          files.map((file) => ({ file, paths: [file] })),
        ).files,
      ).toEqual(named);
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
    ["parts only a run knows", `node ${"$A/".repeat(10_000)}file.js`],
    ["words with parts only a run knows", `${"node $A/x.js ".repeat(5_000)}file.js`],
    ["parts inside a word's directories", `node a/${"$A/".repeat(10_000)}x$B file.js`],
    ["docker values", `${"docker://$A/".repeat(5_000)} file.js`],
    ["separators after a name", `node lib/other${"/".repeat(20_000)} file.js`],
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
