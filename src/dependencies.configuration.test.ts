import { describe, expect, it } from "vitest";
import { LOAD_TIMEOUT, needsOf } from "../__test-helpers__/project-needs.ts";
import { TSCONFIG } from "../__test-helpers__/projects.ts";

/** An installed package that declares a type and nothing else. */
function installed(name: string): Record<string, string> {
  return {
    [`node_modules/${name}/package.json`]: JSON.stringify({ name, types: "index.d.ts" }),
    [`node_modules/${name}/index.d.ts`]: "export declare const value: number;\n",
  };
}

/** The default compiler configuration with more compiler options and more top-level keys. */
function tsconfig(
  options: Readonly<Record<string, unknown>>,
  rest: Readonly<Record<string, unknown>> = {},
): string {
  const base = JSON.parse(TSCONFIG) as { compilerOptions: Record<string, unknown> };
  return `${JSON.stringify({
    ...base,
    compilerOptions: { ...base.compilerOptions, ...options },
    ...rest,
  })}\n`;
}

const MAIN = { "src/main.ts": "export const one = 1;\n" };

describe("what one project's compiler configuration needs", () => {
  it(
    "holds the package each type entry reads, the type package where the program holds one, else the package named",
    () => {
      const files = {
        ...installed("@types/globals"),
        ...installed("@types/scope__lib"),
        ...installed("@types/direct"),
        ...installed("only-named"),
        "local/index.d.ts": "declare const shown: number;\n",
        "tsconfig.json": tsconfig({
          types: ["globals", "@scope/lib", "@types/direct", "only-named", "./local"],
        }),
        ...MAIN,
      };
      const named = ["@types/direct", "@types/globals", "@types/scope__lib", "only-named"];

      expect(needsOf(files)).toEqual({
        uses: { "": named },
        at: { "tsconfig.json": named },
        unanswered: [],
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds the JSX import source, the helper library and each named plugin",
    () => {
      const files = {
        "tsconfig.json": tsconfig({
          jsxImportSource: "preact",
          importHelpers: true,
          plugins: [{ name: "ts-plugin" }, { transform: "./local.js" }],
        }),
        ...MAIN,
      };
      const named = ["preact", "ts-plugin", "tslib"];

      expect(needsOf(files)).toEqual({
        uses: { "": named },
        at: { "tsconfig.json": named },
        unanswered: [],
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "holds the package a configuration extends, through each local configuration it extends",
    () => {
      const files = {
        "node_modules/@tsconfig/strictest/package.json": '{ "name": "@tsconfig/strictest" }\n',
        "node_modules/@tsconfig/strictest/tsconfig.json": '{ "compilerOptions": {} }\n',
        "configs/base.json": '{ "extends": ["@tsconfig/strictest/tsconfig.json", "./inner"] }\n',
        "configs/inner.json": "{}\n",
        "tsconfig.json": tsconfig({}, { extends: "./configs/base.json" }),
        ...MAIN,
      };

      expect(needsOf(files)).toEqual({
        uses: { "": ["@tsconfig/strictest"] },
        at: { "tsconfig.json": ["@tsconfig/strictest"] },
        unanswered: [],
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "reads the extends of a configuration written with comments and trailing commas, as the compiler does",
    () => {
      const files = {
        "node_modules/@tsconfig/strictest/package.json": '{ "name": "@tsconfig/strictest" }\n',
        "node_modules/@tsconfig/strictest/tsconfig.json": '{ "compilerOptions": {} }\n',
        "configs/base.json":
          '{\n  // shared\n  "extends": "@tsconfig/strictest/tsconfig.json",\n}\n',
        "tsconfig.json": [
          "{",
          "  /* the base */",
          '  "extends": "./configs/base.json",',
          `  "compilerOptions": ${JSON.stringify((JSON.parse(TSCONFIG) as { compilerOptions: unknown }).compilerOptions)},`,
          '  "include": ["src"],',
          "}",
          "",
        ].join("\n"),
        ...MAIN,
      };

      expect(needsOf(files).uses).toEqual({ "": ["@tsconfig/strictest"] });
    },
    LOAD_TIMEOUT,
  );
});

describe("what the configuration files a tool loads need", () => {
  it(
    "holds a dependency a configuration module of the program spells by its declaration, and one a JSON configuration file or a module outside the program spells by the configuration",
    () => {
      const files = {
        "package.json": JSON.stringify({
          name: "app",
          private: true,
          devDependencies: { "vite-plugin": "1", "babel-preset": "1", "eslint-plugin": "1" },
        }),
        "vite.config.ts": 'export default { plugins: ["vite-plugin"] };\n',
        ".babelrc": JSON.stringify({ presets: ["babel-preset"] }),
        "eslint.config.mjs": 'export default ["eslint-plugin"];\n',
        ...MAIN,
      };

      expect(needsOf(files)).toEqual({
        uses: { "vite.config.ts:1:8": ["vite-plugin"], "": ["babel-preset", "eslint-plugin"] },
        at: {
          "vite.config.ts": ["vite-plugin"],
          "package.json": ["babel-preset", "eslint-plugin"],
        },
        unanswered: [],
      });
    },
    LOAD_TIMEOUT,
  );
});
