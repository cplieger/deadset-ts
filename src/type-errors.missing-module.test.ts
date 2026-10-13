import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { TSCONFIG, writeProject } from "../__test-helpers__/projects.ts";
import { runProjects } from "./analysis.ts";
import { resolve } from "./resolve.ts";
import { scopeForDir } from "./scope.ts";
import { SetupError, setupLine } from "./setup-failure.ts";
import { openEngine } from "./session.ts";

const LOAD_TIMEOUT = 60_000;

const GENERATE = "run the generator or the build that writes it";

const INSTALL = "that is not installed: run the package manager's install";

function setupFailures(files: Readonly<Record<string, string>>, target = "."): readonly string[] {
  const root = writeProject(files);
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const host = nodeHost();
  const { config } = resolve({
    repository: JSON.stringify({ target: { kind: "application" } }),
    repositoryLabel: "deadset.json",
  });
  try {
    runProjects(
      openEngine({ collectTiming: false }),
      host,
      scopeForDir(host, join(root, target)),
      config,
    );
  } catch (error) {
    if (error instanceof SetupError) {
      return error.failures.map(setupLine);
    }
    throw error;
  }
  return [];
}

function mapping(paths: Readonly<Record<string, readonly string[]>>): string {
  return TSCONFIG.replace('"noEmit": true', `"noEmit": true, "paths": ${JSON.stringify(paths)}`);
}

const PATHS = mapping({
  "gen-config": ["./gen/config.js"],
  "@gen/*": ["./gen/*"],
  "*.gen.js": ["./gen/*.js"],
  "generated*": ["./gen/generated*.js"],
  "gen/*/gen": ["./gen/*.js"],
});

describe("an import of a relative path nothing provides", () => {
  it(
    "is a missing module where the specifier follows its keyword with no space",
    () => {
      expect(setupFailures({ "src/main.ts": 'export*from"./generated.js";\n' })).toEqual([
        `setup failure: missing-module: src/main.ts:1: src/main.ts imports "./generated.js", which names no file of the target: ${GENERATE}`,
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is a missing module where the directory it names does not exist",
    () => {
      expect(
        setupFailures({
          "src/main.ts":
            'import { made } from "./gone/generated.js";\nexport const value = made;\n',
        }),
      ).toEqual([
        `setup failure: missing-module: src/main.ts:1: src/main.ts imports "./gone/generated.js", which names no file of the target: ${GENERATE}`,
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is a type error where a file of that name exists under another extension",
    () => {
      expect(
        setupFailures({
          "tsconfig.json": TSCONFIG.replace('"module": "NodeNext"', '"module": "ESNext"').replace(
            '"moduleResolution": "nodenext"',
            '"moduleResolution": "bundler"',
          ),
          "src/main.ts": 'import widget from "./widget";\nexport const value = widget;\n',
          "src/widget.vue": "<template></template>\n",
        }),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is not reported under a string an earlier statement holds where it sits in a doc comment",
    () => {
      const failures = setupFailures({
        "tsconfig.json": TSCONFIG.replace(
          '"strict": true',
          '"strict": true, "allowJs": true, "checkJs": true',
        ).replace('"**/*.ts"', '"**/*.ts", "**/*.js"'),
        "src/main.js":
          'export const label = "./nothing.js";\n/** @type {import("./missing.js").T} */\nexport let value;\n',
      });

      expect(failures.filter((line) => line.includes('"./nothing.js"'))).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});

describe("an import of a bare specifier nothing provides", () => {
  it(
    "is a missing module where the manifest's imports name it",
    () => {
      expect(
        setupFailures({
          "package.json": JSON.stringify({
            name: "@example/app",
            type: "module",
            imports: { "#generated": "./src/generated.js" },
          }),
          "src/main.ts": 'import { made } from "#generated";\nexport const value = made;\n',
        }),
      ).toEqual([
        `setup failure: missing-module: src/main.ts:1: src/main.ts imports "#generated", which the manifest's imports map to no file: ${GENERATE}`,
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is a missing module where a paths key maps it, exactly or around the key's one star",
    () => {
      const mapped = (path: string, specifier: string): string =>
        `setup failure: missing-module: ${path}:1: ${path} imports "${specifier}", which the compiler configuration's paths map to no file: ${GENERATE}`;

      expect(
        setupFailures({
          "tsconfig.json": PATHS,
          "src/exact.ts": 'export * from "gen-config";\n',
          "src/prefix.ts": 'export * from "@gen/made";\n',
          "src/suffix.ts": 'export * from "made.gen.js";\n',
          "src/whole.ts": 'export * from "generated";\n',
        }),
      ).toEqual([
        mapped("src/exact.ts", "gen-config"),
        mapped("src/prefix.ts", "@gen/made"),
        mapped("src/suffix.ts", "made.gen.js"),
        mapped("src/whole.ts", "generated"),
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is a type error where no paths key maps it: another exact key, another prefix, or too short to hold both ends",
    () => {
      expect(
        setupFailures({
          "tsconfig.json": PATHS,
          "src/exact.ts": 'export * from "other-config";\n',
          "src/prefix.ts": 'export * from "other-pkg";\n',
          "src/short.ts": 'export * from "gen/gen";\n',
        }),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is a missing module naming the nearest manifest at or above the importer that declares it, a workspace member's among them",
    () => {
      expect(
        setupFailures({
          "package.json": JSON.stringify({
            name: "@example/app",
            workspaces: ["src/member"],
            dependencies: { "dep-pkg": "1" },
          }),
          "src/main.ts": 'export * from "dep-pkg";\n',
          "src/member/package.json": JSON.stringify({
            name: "@example/member",
            devDependencies: { "member-pkg": "1" },
          }),
          "src/member/inner.ts": 'export * from "member-pkg";\nexport * from "dep-pkg";\n',
        }),
      ).toEqual([
        `setup failure: missing-module: src/main.ts:1: src/main.ts imports "dep-pkg", a dependency package.json declares ${INSTALL}`,
        `setup failure: missing-module: src/member/inner.ts:1: src/member/inner.ts imports "member-pkg", a dependency src/member/package.json declares ${INSTALL}`,
        `setup failure: missing-module: src/member/inner.ts:2: src/member/inner.ts imports "dep-pkg", a dependency package.json declares ${INSTALL}`,
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is a type error where the nearest manifest declaring it is a nested package's that no workspace names",
    () => {
      expect(
        setupFailures({
          "src/main.ts": 'export * from "./nested/inner.js";\n',
          "src/nested/package.json": JSON.stringify({
            name: "@example/nested",
            devDependencies: { "nested-pkg": "1" },
          }),
          "src/nested/inner.ts": 'export * from "nested-pkg";\n',
        }),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is a type error where only a manifest above the target root declares it",
    () => {
      expect(
        setupFailures(
          {
            "package.json": JSON.stringify({
              name: "@example/outer",
              dependencies: { "dep-pkg": "1" },
            }),
            "target/tsconfig.json": TSCONFIG,
            "target/package.json": JSON.stringify({ name: "@example/app" }),
            "target/src/main.ts": 'export * from "dep-pkg";\n',
          },
          "target",
        ),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is a type error for an own file outside the target root, whatever a manifest above both declares",
    () => {
      expect(
        setupFailures(
          {
            "package.json": JSON.stringify({
              name: "@example/outer",
              dependencies: { "dep-pkg": "1" },
            }),
            "target/tsconfig.json": TSCONFIG.replace(
              '"**/*.ts"',
              '"src/**/*.ts", "../shared/**/*.ts"',
            ),
            "target/src/main.ts": 'export * from "../../shared/shared.js";\n',
            "shared/shared.ts": 'export * from "dep-pkg";\n',
          },
          "target",
        ),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is a type error where no manifest declares it, a manifest that is not an object among them",
    () => {
      expect(
        setupFailures({
          "src/package.json": "null\n",
          "src/main.ts": 'export * from "undeclared-pkg";\n',
        }),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});
