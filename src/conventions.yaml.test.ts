import { afterAll, describe, expect, it } from "vitest";
import { CONVENTION_ROWS } from "./convention-rows.ts";
import { readConventions } from "./conventions.ts";
import type { DirectoryEntry, Host, PathKind } from "./host.ts";
import { openEngine } from "./session.ts";

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

/** The dependencies the legacy ESLint row uses beside one configuration file. */
function uses(files: Readonly<Record<string, string>>): readonly string[] {
  const installed = {
    eslint: "8.57.0",
    "@typescript-eslint/parser": "8.0.0",
    "@typescript-eslint/eslint-plugin": "8.0.0",
    "eslint-plugin-react": "7.0.0",
  };
  return readConventions(
    hostWith({
      "/repo/package.json": JSON.stringify({ devDependencies: installed }),
      "/repo/node_modules/eslint/package.json": JSON.stringify({ version: "8.57.0" }),
      ...files,
    }),
    parse,
    [{ dir: "/repo", path: "package.json" }],
    [],
    CONVENTION_ROWS.filter((one) => one.name === "eslint"),
  ).uses;
}

describe("a YAML configuration file", () => {
  const LEGACY = [
    "extends:",
    "  - 'eslint:recommended'",
    "  - 'plugin:@typescript-eslint/recommended'",
    "parser: '@typescript-eslint/parser'",
    "plugins: [react] # the JSX rules",
  ].join("\n");

  it.each([".eslintrc.yml", ".eslintrc.yaml"])("is read as the document it denotes: %s", (name) => {
    expect(uses({ [`/repo/${name}`]: LEGACY })).toEqual([
      "@typescript-eslint/eslint-plugin",
      "@typescript-eslint/parser",
      "eslint-plugin-react",
    ]);
  });

  it("outside the subset the reader takes holds no string", () => {
    expect(uses({ "/repo/.eslintrc.yml": `${LEGACY}\nsettings: &shared\n  a: 1` })).toEqual([]);
  });
});
