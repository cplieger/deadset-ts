import { afterAll, describe, expect, it } from "vitest";
import { CONVENTION_ROWS } from "./convention-rows.ts";
import { generatedFiles, readConventions, type Conventions } from "./conventions.ts";
import type { DirectoryEntry, Host, PathKind } from "./host.ts";
import { openEngine } from "./session.ts";
import type { SourceFiles } from "./source-files.ts";

const engine = openEngine({ collectTiming: false });
afterAll(() => {
  engine.close();
});
const parse = (fileName: string, text: string) => engine.parseSourceFile(fileName, text);

/** A host over an in-memory tree of absolute paths. */
function hostWith(files: Readonly<Record<string, string>>): Host {
  const kindOf = (path: string): PathKind => {
    if (Object.hasOwn(files, path)) {
      return "file";
    }
    return Object.keys(files).some((one) => one.startsWith(`${path}/`)) ? "directory" : "absent";
  };
  const readDirectory = (dir: string): readonly DirectoryEntry[] => {
    const names = new Map<string, boolean>();
    for (const path of Object.keys(files)) {
      if (path.startsWith(`${dir}/`)) {
        const [name = "", ...rest] = path.slice(dir.length + 1).split("/");
        names.set(name, rest.length > 0);
      }
    }
    return [...names].map(([name, directory]) => ({ name, directory }));
  };
  return {
    workingDirectory: () => "/",
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) {
        throw new Error(`${path}: absent`);
      }
      return text;
    },
    readDirectory,
    kindOf,
    realPath: (path) => path,
    analyzerVersion: () => "0.0.0",
    temporaryDirectory: () => {
      throw new Error("no temporary directory");
    },
    componentMapperCommand: () => [],
    writeDocument: (path) => {
      throw new Error(`${path}: this host writes nothing`);
    },
  };
}

/** What the rows of one name decide over `/repo`, whose manifest declares and installs `installed`. */
function decide(
  row: string,
  installed: Readonly<Record<string, string>>,
  files: Readonly<Record<string, string>>,
): Conventions {
  return readConventions(
    hostWith({
      "/repo/package.json": JSON.stringify({ devDependencies: installed }),
      ...Object.fromEntries(
        Object.entries(installed).map(([name, version]) => [
          `/repo/node_modules/${name}/package.json`,
          JSON.stringify({ version }),
        ]),
      ),
      ...files,
    }),
    parse,
    [{ dir: "/repo", path: "package.json" }],
    [],
    CONVENTION_ROWS.filter((one) => one.name === row),
  );
}

/** The paths among `paths` an applied row's globs root. */
function rooted(conventions: Conventions, paths: readonly string[]): readonly string[] {
  return paths.filter((path) =>
    conventions.globs.some(
      (glob) => glob.expression.test(path) && !glob.excludes.some((one) => one.test(path)),
    ),
  );
}

/** The paths among `paths` an applied row names as generated, each an own file at `/repo/<path>`. */
function generated(conventions: Conventions, paths: readonly string[]): readonly string[] {
  const byPath = new Map(paths.map((path) => [path, { fileName: `/repo/${path}` }]));
  return [...generatedFiles(conventions, { byPath } as unknown as SourceFiles).keys()];
}

describe("the code generator rows", () => {
  const PATHS = ["styled-system/types/csstype.d.ts", "src/css/tokens.ts", "src/a.tsx"];

  it("make every file below Panda CSS's default output directory generated", () => {
    const decided = decide("panda", { "@pandacss/dev": "1.4.3" }, {});

    expect(decided.applied.map((one) => one.name)).toEqual(["panda"]);
    expect(generated(decided, PATHS)).toEqual(["styled-system/types/csstype.d.ts"]);
  });

  it("read the output directory Panda CSS's configuration moves", () => {
    const decided = decide(
      "panda",
      { "@pandacss/dev": "0.40.0" },
      {
        "/repo/panda.config.ts":
          'import { defineConfig } from "@pandacss/dev";\n' +
          'export default defineConfig({ include: ["./src/**/*.tsx"], outdir: "src/css" });\n',
      },
    );

    expect(generated(decided, PATHS)).toEqual(["src/css/tokens.ts"]);
  });
});

describe("the react-scripts row", () => {
  it("roots the entry, the proxy setup and the test setup Create React App loads by name", () => {
    const decided = decide("react-scripts", { "react-scripts": "5.0.1" }, {});

    expect(
      rooted(decided, [
        "src/index.tsx",
        "src/index.js",
        "src/setupProxy.js",
        "src/setupTests.ts",
        "src/App.tsx",
        "index.tsx",
      ]),
    ).toEqual(["src/index.tsx", "src/index.js", "src/setupProxy.js", "src/setupTests.ts"]);
  });
});

describe("the legacy ESLint row", () => {
  it("uses the parser package a configuration names, at the top or nested", () => {
    const decided = decide(
      "eslint",
      {
        eslint: "8.57.0",
        "@typescript-eslint/parser": "8.0.0",
        "vue-eslint-parser": "9.0.0",
        "unnamed-parser": "1.0.0",
      },
      {
        "/repo/.eslintrc.json": JSON.stringify({
          parser: "vue-eslint-parser",
          parserOptions: { parser: "@typescript-eslint/parser" },
        }),
      },
    );

    expect(decided.uses).toEqual(["@typescript-eslint/parser", "vue-eslint-parser"]);
  });
});
