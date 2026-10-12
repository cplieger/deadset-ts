import { describe, expect, it } from "vitest";
import { analyzeProject, type AnalyzeOptions } from "../__test-helpers__/projects.ts";

const LOAD_TIMEOUT = 60_000;

const NO_CONFIGURED = { patterns: [], entryFiles: [], testFiles: [], publishedAPI: false };

function rootSet(
  files: Readonly<Record<string, string>>,
  options: AnalyzeOptions,
): { roots: string[]; unmatched: readonly string[]; unanswered: string[] } {
  const analyzed = analyzeProject(files, options);
  const refs = new Map(
    (analyzed.inventories[0]?.symbols ?? []).map((symbol) => [
      symbol.id,
      symbol.ref.replace("ts://@example/app/", ""),
    ]),
  );
  const [rooted] = analyzed.roots;
  return {
    roots: (rooted?.liveUnderReachability ?? []).map((root) =>
      [refs.get(root.id) ?? root.id, root.kind, root.source].join(" ").trimEnd(),
    ),
    unmatched: rooted?.unmatched ?? [],
    unanswered: (rooted?.unanswered ?? []).map((id) => refs.get(id) ?? id),
  };
}

function manifest(fields: Readonly<Record<string, unknown>> = {}): string {
  return `${JSON.stringify({ name: "@example/app", private: true, type: "module", main: "./src/main.ts", ...fields })}\n`;
}

describe("the root set of a project", () => {
  it(
    "orders the roots of one declaration by kind and then by the string that named it",
    () => {
      const set = rootSet(
        { "package.json": manifest(), "src/main.ts": "export const main = 1;\n" },
        {
          roots: {
            ...NO_CONFIGURED,
            patterns: ["ts://@example/app/src/main.ts#main", "*#main", "ts://@example/app/gone#x"],
            entryFiles: ["src/*.ts", "**/main.ts"],
          },
        },
      );

      expect(set.roots).toEqual([
        "src/main.ts# entry-file **/main.ts",
        "src/main.ts# entry-file src/*.ts",
        "src/main.ts# manifest-entry main",
        "src/main.ts#main configured ts://@example/app/src/main.ts#main",
        "src/main.ts#main entry-file **/main.ts",
        "src/main.ts#main entry-file src/*.ts",
        "src/main.ts#main manifest-entry main",
        "src/main.ts#main pattern *#main",
      ]);
      expect(set.unmatched).toEqual(["ts://@example/app/gone#x"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "roots a script entry by its file alone",
    () => {
      expect(
        rootSet(
          {
            "package.json": `${JSON.stringify({ name: "@example/app", private: true, main: "./src/main.ts" })}\n`,
            "tsconfig.json": `${JSON.stringify({
              compilerOptions: {
                strict: true,
                module: "NodeNext",
                moduleDetection: "auto",
                noEmit: true,
              },
              include: ["**/*.ts"],
            })}\n`,
            "src/main.ts": "const started = 1;\nconsole.log(started);\n",
          },
          { roots: NO_CONFIGURED },
        ).roots,
      ).toEqual(["src/main.ts# manifest-entry main"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "roots every top-level declaration of an entry whose export table the checker leaves unanswered, and calls every declaration unanswered",
    () => {
      const set = rootSet(
        {
          "package.json": manifest(),
          "src/main.ts": [
            "export const one = 1;",
            "export class Kept {",
            "  member = 1;",
            "}",
            "export namespace Space {",
            "  export const inner = 1;",
            "}",
            "const local = 2;",
            "void local;",
            "",
          ].join("\n"),
        },
        {
          roots: NO_CONFIGURED,
          panicsOn: (accessor, locations) =>
            accessor === "getExportsOfModule" &&
            locations.some((location) => location.includes("/src/main")),
        },
      );

      expect(set.roots).toEqual([
        "src/main.ts# manifest-entry main",
        "src/main.ts#one manifest-entry main",
        "src/main.ts#Kept manifest-entry main",
        "src/main.ts#Space manifest-entry main",
        "src/main.ts#local manifest-entry main",
      ]);
      expect(set.unanswered).toEqual([
        "src/main.ts#",
        "src/main.ts#one",
        "src/main.ts#Kept",
        "src/main.ts#Kept.member",
        "src/main.ts#Space",
        "src/main.ts#Space.inner",
        "src/main.ts#local",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "does not ask for the export table of a file it roots without its exports",
    () => {
      const set = rootSet(
        {
          "package.json": manifest(),
          "src/main.ts": "export const main = 1;\n",
          "src/app.test.ts": "export const helper = 1;\n",
        },
        {
          roots: { ...NO_CONFIGURED, testFiles: ["src/**/*.test.ts"] },
          panicsOn: (accessor, locations) =>
            accessor === "getExportsOfModule" &&
            locations.some((location) => location.includes("/src/app.test")),
        },
      );

      expect(set.roots.filter((line) => line.startsWith("src/app.test.ts"))).toEqual([
        "src/app.test.ts# test-runner src/**/*.test.ts",
      ]);
      expect(set.unanswered).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "roots a global a declaration file declares as an alias of an export, with the declarations around it",
    () => {
      expect(
        rootSet(
          {
            "package.json": manifest(),
            "tsconfig.json": `${JSON.stringify({
              compilerOptions: {
                strict: true,
                module: "NodeNext",
                noEmit: true,
                allowImportingTsExtensions: true,
                types: [],
              },
              include: ["**/*.ts"],
            })}\n`,
            "src/main.ts": "export const main = 1;\n",
            "src/counter.ts": "export function useCount(): number {\n  return 1;\n}\n",
            "src/globals.d.ts": [
              "export {};",
              "declare global {",
              "  const useCount: typeof import(",
              '    "./counter.ts"',
              '  )["useCount"];',
              "}",
              "",
            ].join("\n"),
          },
          { roots: NO_CONFIGURED },
        ).roots.filter((line) => line.includes(" type-query-alias ")),
      ).toEqual([
        'src/globals.d.ts#global type-query-alias typeof import( "./counter.ts" )["useCount"]',
        'src/globals.d.ts#global.useCount type-query-alias typeof import( "./counter.ts" )["useCount"]',
      ]);
    },
    LOAD_TIMEOUT,
  );
});
