import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { writeProject } from "../../__test-helpers__/projects.ts";
import type { Host } from "../host.ts";
import { run, type Writer } from "../run.ts";

const LOAD_TIMEOUT = 60_000;

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

/** A JavaScript package declaring `runner` at `version`, installed, with `extra` in its manifest. */
function declaring(
  runner: string | undefined,
  version: string,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, string> {
  return {
    "package.json": `${JSON.stringify({
      name: "@example/app",
      private: true,
      type: "module",
      main: "lib/index.js",
      ...(runner === undefined ? {} : { devDependencies: { [runner]: version } }),
      ...extra,
    })}\n`,
    ...(runner === undefined
      ? {}
      : {
          [`node_modules/${runner}/package.json`]: `${JSON.stringify({ name: runner, version })}\n`,
        }),
    "lib/index.js": "export const main = 1;\n",
  };
}

/** The files a test runner runs in one written package, by path, read through `host`. */
function testFiles(files: Readonly<Record<string, string>>, host: Host = nodeHost()): string[] {
  const root = writeProject({
    "deadset.json": `${JSON.stringify({ target: { kind: "application" }, ts: { test_files: ["**/*.never"] } })}\n`,
    ...files,
  });
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const out = new MemoryWriter();
  const err = new MemoryWriter();
  expect(run(["print-roots", `--target=${root}`], out, err, host), err.text).toBe(0);
  return [
    ...new Set(
      out.text
        .split("\n")
        .filter((line) => line.split("\t")[1] === "test-runner")
        .map((line) => (line.split("\t")[0] ?? "").replace(/^ts:\/\/@example\/app\/|#.*$/gu, "")),
    ),
  ].sort();
}

const TEST = 'console.log("test");\n';

/** 257 extensions, `js` the last, which a runner reads as a list and never as a glob of its own. */
const MANY_EXTENSIONS = [...Array.from({ length: 256 }, (_, index) => `e${String(index)}`), "js"];

/** Four directories of 200 characters each, a path segment's length well within a file system's. */
const DEEP = Array.from({ length: 4 }, (_, index) => String(index).repeat(200)).join("/");

describe("the files mocha runs", () => {
  it.each<[string, Record<string, string>, string[]]>([
    [
      "./test with no spec, its own files with mocha's extensions and no hidden name",
      {
        ...declaring("mocha", "11.7.5"),
        "test/a.js": TEST,
        "test/b.cjs": TEST,
        "test/c.ts": TEST,
        "test/.hidden.js": TEST,
        "test/sub/d.js": TEST,
      },
      ["test/a.js", "test/b.cjs"],
    ],
    [
      "a directory spec at any depth where the configuration file sets recursive",
      {
        ...declaring("mocha", "11.7.5"),
        ".mocharc.yml": "recursive: true\nspec: spec\n",
        "spec/a.js": TEST,
        "spec/sub/b.mjs": TEST,
        "test/x.js": TEST,
      },
      ["spec/a.js", "spec/sub/b.mjs"],
    ],
    [
      "the configuration --config names in place of the nearest one, and the nearest one with no option",
      {
        ...declaring("mocha", "11.7.5", { scripts: { test: "mocha --config conf/m.json" } }),
        ".mocharc.json": '{ "spec": "near/*.js" }\n',
        "conf/m.json": '{ "spec": ["checks/*.js"] }\n',
        "checks/a.js": TEST,
        "near/b.js": TEST,
      },
      ["checks/a.js", "near/b.js"],
    ],
    [
      "a directory spec's files with any of 257 extensions, the list counting toward no bound",
      {
        ...declaring("mocha", "11.7.5"),
        ".mocharc.json": `${JSON.stringify({ spec: "spec", extension: MANY_EXTENSIONS })}\n`,
        "spec/a.js": TEST,
        "spec/b.cjs": TEST,
      },
      ["spec/a.js"],
    ],
    [
      "a spec that names no path with each of 257 extensions appended",
      {
        ...declaring("mocha", "11.7.5"),
        ".mocharc.json": `${JSON.stringify({ spec: "lib/only", extension: MANY_EXTENSIONS })}\n`,
        "lib/only.js": TEST,
        "lib/only.cjs": TEST,
      },
      ["lib/only.js"],
    ],
    [
      "a spec that names no path with each extension appended",
      {
        ...declaring("mocha", "11.7.5", { scripts: { test: "mocha lib/only --extension mjs" } }),
        "lib/only.mjs": TEST,
        "lib/only.js": TEST,
      },
      ["lib/only.mjs"],
    ],
    [
      "the specs of every source joined, the manifest's mocha member among them",
      {
        ...declaring("mocha", "11.7.5", { mocha: { spec: "m/*.js" } }),
        ".mocharc.json": '{ "spec": "c/*.js" }\n',
        "m/a.js": TEST,
        "c/b.js": TEST,
      },
      ["c/b.js", "m/a.js"],
    ],
    [
      "nothing from a command holding an option mocha does not name, and ./test without one",
      {
        ...declaring("mocha", "11.7.5", { scripts: { test: "mocha --weird spec2/*.js" } }),
        "spec2/a.js": TEST,
        "test/b.js": TEST,
      },
      ["test/b.js"],
    ],
    [
      "nothing from a configuration file whose spec is not written out",
      {
        ...declaring("mocha", "11.7.5"),
        ".mocharc.cjs": "module.exports = { spec: process.env.SPEC };\n",
        "test/b.js": TEST,
      },
      [],
    ],
    [
      "the mocha member of the file --package names in place of the manifest's",
      {
        ...declaring("mocha", "11.7.5", {
          scripts: { test: "mocha --package ./other/package.json" },
          mocha: { spec: "m/*.js" },
        }),
        "other/package.json": '{ "mocha": { "spec": "o/*.js" } }\n',
        "o/a.js": TEST,
        "m/b.js": TEST,
      },
      ["m/b.js", "o/a.js"],
    ],
    [
      "nothing from a command whose --package file is missing, nor the manifest's member under --no-package, the last of the two deciding",
      {
        ...declaring("mocha", "11.7.5", {
          scripts: {
            test: "mocha --package missing.json x/a.js",
            other: "mocha --no-package",
            late: "mocha --no-package --package other.json",
          },
          mocha: { spec: "m/*.js" },
        }),
        "other.json": '{ "mocha": { "spec": "late/*.js" } }\n',
        "late/d.js": TEST,
        "x/a.js": TEST,
        "m/b.js": TEST,
        "test/c.js": TEST,
      },
      ["late/d.js", "m/b.js", "test/c.js"],
    ],
    [
      "the manifest's mocha member where the last --package names no file",
      {
        ...declaring("mocha", "11.7.5", {
          scripts: { test: "mocha --package= x/a.js", other: "mocha --package '' y/a.js" },
          mocha: { spec: "m/*.js" },
        }),
        "x/a.js": TEST,
        "y/a.js": TEST,
        "m/b.js": TEST,
      },
      ["m/b.js", "x/a.js", "y/a.js"],
    ],
    [
      "the mocha member of the package.json nearest a command's directory",
      {
        ...declaring("mocha", "11.7.5", { scripts: { test: "cd sub && mocha" } }),
        "sub/package.json": '{ "mocha": { "spec": "s/*.js" } }\n',
        "sub/s/a.js": TEST,
      },
      ["sub/s/a.js"],
    ],
    [
      "no .mocharc.mjs before mocha 12",
      {
        ...declaring("mocha", "11.7.5"),
        ".mocharc.mjs": 'export default { spec: "e/*.js" };\n',
        "e/a.js": TEST,
        "test/b.js": TEST,
      },
      ["test/b.js"],
    ],
    [
      "the .mocharc.mjs of mocha 12",
      {
        ...declaring("mocha", "12.0.3"),
        ".mocharc.mjs": 'export default { spec: "e/*.js" };\n',
        "e/a.js": TEST,
        "test/b.js": TEST,
      },
      ["e/a.js"],
    ],
  ])(
    "are %s",
    (_label, files, want) => {
      expect(testFiles(files)).toEqual(want);
    },
    LOAD_TIMEOUT,
  );
});

describe("the files mocha runs beside a package.json", () => {
  const base = nodeHost();
  const host: Host = {
    ...base,
    readFile: (path, limit) => {
      if (path.endsWith("/sub/package.json")) {
        throw new Error(`EACCES: permission denied, open '${path}'`);
      }
      return base.readFile(path, limit);
    },
  };
  it.each<[string, string, string[]]>([
    [
      "a command's own where the nearest one cannot be read",
      "cd sub && mocha spec/a.js",
      ["sub/spec/a.js"],
    ],
    [
      "none where the one --package names cannot be read",
      "mocha --package sub/package.json t/a.js",
      [],
    ],
    ["none where the nearest one does not parse", "cd bad && mocha b/a.js", []],
    [
      "none where the nearest one is null, whose mocha member mocha cannot read",
      "cd nul && mocha n/a.js",
      [],
    ],
  ])(
    "are %s",
    (_label, test, want) => {
      const files = {
        ...declaring("mocha", "11.7.5", { scripts: { test } }),
        "sub/package.json": '{ "mocha": { "spec": "never/*.js" } }\n',
        "sub/spec/a.js": TEST,
        "sub/never/a.js": TEST,
        "t/a.js": TEST,
        "bad/package.json": "{\n",
        "bad/b/a.js": TEST,
        "nul/package.json": "null\n",
        "nul/n/a.js": TEST,
      };

      expect(testFiles(files, host)).toEqual(want);
    },
    LOAD_TIMEOUT,
  );
});

describe("the files Jest runs", () => {
  it.each<[string, Record<string, string>, string[]]>([
    [
      "its default testMatch below the root directory",
      {
        ...declaring("jest", "29.7.0"),
        "__tests__/a.js": TEST,
        "lib/x.test.js": TEST,
        "lib/y.spec.cjs": TEST,
        "lib/z.js": TEST,
      },
      ["__tests__/a.js", "lib/x.test.js"],
    ],
    [
      "its default testMatch from Jest 30, .mjs and .cjs tests among them",
      {
        ...declaring("jest", "30.0.0"),
        "__tests__/a.mjs": TEST,
        "lib/y.spec.cjs": TEST,
        "lib/z.js": TEST,
      },
      ["__tests__/a.mjs", "lib/y.spec.cjs"],
    ],
    [
      "none with an extension Jest 29's default moduleFileExtensions leaves out",
      {
        ...declaring("jest", "29.7.0"),
        "tsconfig.json": '{ "compilerOptions": { "allowJs": true, "module": "nodenext" } }\n',
        "jest.config.js": 'export default { testMatch: ["**/*.test.mts"] };\n',
        "a.test.mts": TEST,
      },
      [],
    ],
    [
      "those with an extension Jest 30's default moduleFileExtensions lists",
      {
        ...declaring("jest", "30.0.0"),
        "tsconfig.json": '{ "compilerOptions": { "allowJs": true, "module": "nodenext" } }\n',
        "jest.config.js": 'export default { testMatch: ["**/*.test.mts"] };\n',
        "a.test.mts": TEST,
      },
      ["a.test.mts"],
    ],
    [
      "none with an extension the configuration's moduleFileExtensions leaves out",
      {
        ...declaring("jest", "29.7.0"),
        "jest.config.js":
          'export default { testMatch: ["**/*.test.cjs"], moduleFileExtensions: ["js"] };\n',
        "a.test.cjs": TEST,
      },
      [],
    ],
    [
      "those of a configured testMatch with an extension Jest 29's defaults list",
      {
        ...declaring("jest", "29.7.0"),
        "jest.config.js": 'export default { testMatch: ["**/*.test.cjs"] };\n',
        "a.test.cjs": TEST,
      },
      ["a.test.cjs"],
    ],
    [
      "its testRegex over the whole path",
      {
        ...declaring("jest", "29.7.0"),
        "jest.config.js": 'export default { testRegex: "/checks/.*\\\\.js$" };\n',
        "checks/a.js": TEST,
        "lib/x.test.js": TEST,
      },
      ["checks/a.js"],
    ],
    [
      "those of a testMatch of 1,024 characters as written, its <rootDir> counting as written",
      {
        ...declaring("jest", "29.7.0"),
        "jest.config.js": `export default { testMatch: [${JSON.stringify(`<rootDir>/${DEEP}/${"t".repeat(202)}.test.js`)}] };\n`,
        [`${DEEP}/${"t".repeat(202)}.test.js`]: TEST,
        "lib/x.test.js": TEST,
      },
      [`${DEEP}/${"t".repeat(202)}.test.js`],
    ],
    [
      "none of a testMatch of 1,025 characters as written",
      {
        ...declaring("jest", "29.7.0"),
        "jest.config.js": `export default { testMatch: [${JSON.stringify(`<rootDir>/${DEEP}/${"t".repeat(203)}.test.js`)}] };\n`,
        [`${DEEP}/${"t".repeat(203)}.test.js`]: TEST,
      },
      [],
    ],
    [
      "none where a configuration writes both testMatch and testRegex",
      {
        ...declaring("jest", "29.7.0"),
        "jest.config.js": 'export default { testMatch: ["**/*.js"], testRegex: "x" };\n',
        "lib/x.test.js": TEST,
      },
      [],
    ],
    [
      "those of the file the manifest's jest string names, read against its rootDir",
      {
        ...declaring("jest", "29.7.0", { jest: "./cfg/jest.json" }),
        "cfg/jest.json": '{ "rootDir": "..", "testMatch": ["**/*.it.js"] }\n',
        "a.it.js": TEST,
      },
      ["a.it.js"],
    ],
    [
      "those of each inline project",
      {
        ...declaring("jest", "29.7.0"),
        "jest.config.js":
          'export default { projects: [{ rootDir: "<rootDir>/pkg", testMatch: ["**/*.check.js"] }] };\n',
        "pkg/a.check.js": TEST,
        "lib/x.test.js": TEST,
      },
      ["pkg/a.check.js"],
    ],
    [
      "none where a configuration file and the manifest's jest member both configure it",
      {
        ...declaring("jest", "29.7.0", { jest: { testMatch: ["**/*.js"] } }),
        "jest.config.js": "export default {};\n",
        "lib/x.test.js": TEST,
      },
      [],
    ],
    [
      "those of a jest.config.mts from Jest 30",
      {
        ...declaring("jest", "30.0.0"),
        "jest.config.mts": 'export default { testMatch: ["**/*.check.js"] };\n',
        "a.check.js": TEST,
      },
      ["a.check.js"],
    ],
  ])(
    "are %s",
    (_label, files, want) => {
      expect(testFiles(files)).toEqual(want);
    },
    LOAD_TIMEOUT,
  );

  it.each([
    ["none for a testMatch V8 cannot compile", { testMatch: ["<rootDir>/*.test.js"] }, false],
    [
      "none for a testPathIgnorePatterns entry V8 cannot compile",
      { testPathIgnorePatterns: ["<rootDir>/.*x"] },
      false,
    ],
    [
      "those a testPathIgnorePatterns entry of literal text leaves, which V8 compiles at any length",
      { testPathIgnorePatterns: ["<rootDir>/x"] },
      true,
    ],
  ])(
    "are %s below a long rootDir, and the run does not fault",
    (_label, options, found) => {
      const root = writeProject({
        ...declaring("jest", "29.7.0"),
        "lib/x.test.js": TEST,
      });
      onTestFinished(() => {
        rmSync(root, { recursive: true, force: true });
      });
      writeFileSync(
        join(root, "package.json"),
        `${JSON.stringify({
          name: "@example/app",
          private: true,
          type: "module",
          main: "lib/index.js",
          devDependencies: { jest: "29.7.0" },
          scripts: { test: "jest" },
          jest: { rootDir: "a".repeat(40_000), roots: [join(root, "lib")], ...options },
        })}\n`,
      );
      writeFileSync(
        join(root, "deadset.json"),
        `${JSON.stringify({ target: { kind: "application" }, ts: { test_files: ["**/*.never"] } })}\n`,
      );
      const out = new MemoryWriter();
      const err = new MemoryWriter();

      expect(run(["print-roots", `--target=${root}`], out, err, nodeHost()), err.text).toBe(0);
      expect(
        out.text
          .split("\n")
          .filter((line) => line.split("\t")[1] === "test-runner")
          .map((line) => line.split("#")[0]),
      ).toEqual(found ? ["ts://@example/app/lib/x.test.js"] : []);
    },
    LOAD_TIMEOUT,
  );
});

describe("the files AVA runs", () => {
  it.each<[string, Record<string, string>, string[]]>([
    [
      "its defaults, with a files list of exclusions only joined to them",
      {
        ...declaring("ava", "6.4.0"),
        "ava.config.js": 'export default { files: ["!tests/slow/**"] };\n',
        "tests/a.js": TEST,
        "tests/slow/b.js": TEST,
      },
      ["tests/a.js"],
    ],
    [
      "its defaults with any of 257 extensions, the list counting toward no bound",
      {
        ...declaring("ava", "6.4.0"),
        "ava.config.js": `export default { extensions: ${JSON.stringify(MANY_EXTENSIONS)} };\n`,
        "tests/a.js": TEST,
        "tests/c.mjs": TEST,
      },
      ["tests/a.js"],
    ],
    [
      "those with the extensions an object names",
      {
        ...declaring("ava", "6.4.0"),
        "ava.config.js": "export default { extensions: { jsx: true } };\n",
        "tests/a.jsx": TEST,
        "tests/b.js": TEST,
      },
      ["tests/a.jsx"],
    ],
    [
      "a .cjs test before AVA 8",
      { ...declaring("ava", "6.4.0"), "tests/a.cjs": TEST },
      ["tests/a.cjs"],
    ],
    ["no .cjs test from AVA 8", { ...declaring("ava", "8.3.0"), "tests/a.cjs": TEST }, []],
    [
      "none where a configuration file and the manifest's ava member both configure it",
      {
        ...declaring("ava", "6.4.0", { ava: {} }),
        "ava.config.js": "export default {};\n",
        "tests/a.js": TEST,
      },
      [],
    ],
  ])(
    "are %s",
    (_label, files, want) => {
      expect(testFiles(files)).toEqual(want);
    },
    LOAD_TIMEOUT,
  );
});

describe("the files node --test runs", () => {
  it.each<[string, Record<string, string>, string[]]>([
    [
      "its JavaScript defaults alone with --no-strip-types",
      {
        ...declaring(undefined, "", { scripts: { test: "node --test --no-strip-types" } }),
        "a.test.js": TEST,
        "b.test.ts": TEST,
      },
      ["a.test.js"],
    ],
    ...["--title app", "--preserve-symlinks", "--no-deprecation", "--title=app"].map(
      (option): [string, Record<string, string>, string[]] => [
        `its defaults after ${option}, an option Node's table reads`,
        {
          ...declaring(undefined, "", { scripts: { test: `node ${option} --test` } }),
          "a.test.js": TEST,
        },
        ["a.test.js"],
      ],
    ),
    [
      "its defaults behind c8, in the directory a cd moves to",
      {
        ...declaring(undefined, "", { scripts: { test: "cd sub && c8 node --test" } }),
        "sub/a.test.js": TEST,
      },
      ["sub/a.test.js"],
    ],
    [
      "none for a command holding an option the reader does not name",
      {
        ...declaring(undefined, "", { scripts: { test: "node --frobnicate --test" } }),
        "a.test.js": TEST,
      },
      [],
    ],
  ])(
    "are %s",
    (_label, files, want) => {
      expect(testFiles(files)).toEqual(want);
    },
    LOAD_TIMEOUT,
  );
});
