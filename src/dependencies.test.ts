import { describe, expect, it } from "vitest";
import {
  declarationKey,
  dependenciesOf,
  packageOfSpecifier,
  type Dependencies,
  type ProjectNeeds,
} from "./dependencies.ts";
import type { Host } from "./host.ts";

/** A host holding the given files and nothing else. */
function hostWith(files: Readonly<Record<string, string>>): Host {
  return {
    workingDirectory: () => "/",
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) {
        throw new Error(`${path}: absent`);
      }
      return text;
    },
    readDirectory: () => [],
    kindOf: () => "absent",
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

/** Each declared dependency of the manifest at `/repo/pkg`, as `name section line:column`. */
function declared(manifest: string): string[] {
  return dependenciesOf(
    hostWith({ "/repo/pkg/package.json": manifest }),
    "/repo/pkg",
    [],
    [],
  ).declared.map(
    (one) =>
      `${one.name} ${one.section} ${String(one.position.line)}:${String(one.position.column)}`,
  );
}

/** Each declared dependency a project needs or a command run uses, as `manifest name`. */
function used(found: Dependencies): string[] {
  return found.declared
    .filter((one) => found.needed.has(one.name) || found.ran.has(declarationKey(one)))
    .map((one) => `${one.position.path} ${one.name}`)
    .sort();
}

describe("dependenciesOf", () => {
  it("places each key at its opening quote, a CRLF and a lone CR each ending a line", () => {
    expect(
      declared('{\r\n  "dependencies": {\r\n    "a": "1",\r    "b": "1"\n  }\r\n}\r\n'),
    ).toEqual(["a dependency 3:5", "b dependency 4:5"]);
  });

  it("reads every section in the order the manifest writes them, past values holding braces and escapes", () => {
    const manifest = [
      "{",
      '  "peerDependencies": { "p": "1" },',
      '  "scripts": { "x": "echo \\"}{\\" ]" },',
      '  "devDependencies": { "d\\u0031": "1" },',
      '  "dependencies": { "@scope/r": "1" }',
      "}",
    ].join("\n");

    expect(declared(manifest)).toEqual([
      "p peer-dependency 2:25",
      "d1 dev-dependency 4:24",
      "@scope/r dependency 5:21",
    ]);
  });

  it("reads a section or a key written twice at its last occurrence, as the parser keeps it", () => {
    expect(
      declared('{ "dependencies": { "a": "1" },\n  "dependencies": { "b": "1", "b": "2" } }'),
    ).toEqual(["b dependency 2:31"]);
  });

  it("declares nothing for a manifest the parser refuses or a section that is not an object", () => {
    expect(declared('{ "dependencies": { "a": "1", } }')).toEqual([]);
    expect(declared('{ "dependencies": ["a"] }')).toEqual([]);
  });

  it("reads each command an installed copy's bin declares, from the nearest dependency directory at or above the target", () => {
    const host = hostWith({
      "/repo/pkg/package.json": JSON.stringify({
        scripts: { a: "t --watch", b: "single" },
        devDependencies: { tool: "1", "@scope/single": "1", plugin: "1" },
      }),
      "/repo/node_modules/tool/package.json": '{ "bin": { "tool": "./cli.js", "t": "./t.js" } }',
      "/repo/pkg/node_modules/@scope/single/package.json": '{ "bin": "./cli.js" }',
      "/repo/pkg/node_modules/plugin/package.json": '{ "bin": { "plugin": "./cli.js" } }',
    });

    expect(used(dependenciesOf(host, "/repo/pkg", [], []))).toEqual([
      "package.json @scope/single",
      "package.json tool",
    ]);
  });

  it("uses the declaration whose command a script of its own manifest or a workflow step runs, and nothing for a command no one runs or a required peer", () => {
    const host: Host = {
      ...hostWith({
        "/repo/package.json": JSON.stringify({
          scripts: { lint: "eslint . && run-in-ci" },
          devDependencies: {
            eslint: "1",
            ci: "1",
            idle: "1",
            host: "1",
            plugin: "1",
            vitest: "1",
            other: "1",
          },
        }),
        "/repo/member/package.json": JSON.stringify({
          scripts: { test: '"vitest" run' },
          devDependencies: { vitest: "1", other: "1", eslint: "1" },
        }),
        "/repo/node_modules/eslint/package.json": '{ "bin": { "eslint": "./bin.js" } }',
        "/repo/node_modules/ci/package.json": '{ "bin": { "run-in-ci": "./bin.js" } }',
        "/repo/node_modules/idle/package.json": '{ "bin": "./bin.js" }',
        "/repo/node_modules/host/package.json": "{}",
        "/repo/node_modules/plugin/package.json": '{ "peerDependencies": { "host": "1" } }',
        "/repo/node_modules/vitest/package.json": '{ "bin": { "vitest": "./bin.js" } }',
        "/repo/node_modules/other/package.json": '{ "bin": { "other": "./bin.js" } }',
        "/repo/.github/workflows/ci.yaml": "jobs:\n  a:\n    steps:\n      - run: npx other\n",
      }),
      readDirectory: (path) =>
        path === "/repo/.github/workflows" ? [{ name: "ci.yaml", directory: false }] : [],
    };
    const plugin: ProjectNeeds = {
      packages: new Set(["plugin"]),
      uses: new Map([["x.ts:1:1", new Set(["plugin"])]]),
      unanswered: [],
    };

    expect(used(dependenciesOf(host, "/repo", [plugin], [], ["/repo/member"]))).toEqual([
      "member/package.json vitest",
      "package.json ci",
      "package.json eslint",
      "package.json other",
      "package.json plugin",
    ]);
  });

  it("holds for an unanswered specifier only the dependencies a manifest at or above its file declares", () => {
    const host = hostWith({
      "/repo/package.json": '{ "dependencies": { "top": "1" } }',
      "/repo/a/package.json": '{ "dependencies": { "near": "1" } }',
      "/repo/b/package.json": '{ "dependencies": { "far": "1" } }',
    });
    const unanswered: ProjectNeeds = {
      packages: new Set(),
      uses: new Map(),
      unanswered: ["/repo/a/src/x.ts"],
    };

    expect(
      [...dependenciesOf(host, "/repo", [unanswered], [], ["/repo/a", "/repo/b"]).needed].sort(),
    ).toEqual(["near", "top"]);
  });

  it("names the manifests of members holding source only in configurations the run could not build", () => {
    const host = hostWith({
      "/repo/package.json": '{ "dependencies": { "top": "1" } }',
      "/repo/tools/package.json": '{ "dependencies": { "ghost": "1" } }',
    });

    const found = dependenciesOf(host, "/repo", [], [], [], ["/repo/tools"]);

    expect(found.declared.map((one) => one.name)).toEqual(["top", "ghost"]);
    expect([...found.unbuilt]).toEqual(["tools/package.json"]);
  });

  it("names a declared dependency only for the one declaration using it across every project", () => {
    const host = hostWith({
      "/repo/pkg/package.json": '{ "dependencies": { "a": "1", "b": "1" } }',
    });
    const project = (uses: Record<string, string[]>): ProjectNeeds => ({
      packages: new Set(Object.values(uses).flat()),
      uses: new Map(Object.entries(uses).map(([id, named]) => [id, new Set(named)])),
      unanswered: [],
    });
    const perProject = [
      project({ "x.ts:1:1": ["a", "b", "undeclared"] }),
      project({ "x.ts:1:1": ["a"], "y.test.ts:1:1": ["b"] }),
    ];

    expect(dependenciesOf(host, "/repo/pkg", perProject, ["x.ts:1:1"]).lastUses).toEqual(
      new Map([["x.ts:1:1", ["a"]]]),
    );
  });
});

describe("packageOfSpecifier", () => {
  it.each([
    ["lodash", "lodash"],
    ["lodash/fp", "lodash"],
    ["@scope/name/sub/path", "@scope/name"],
    ["@scope", undefined],
    ["./local", undefined],
    ["../up", undefined],
    ["/absolute", undefined],
    ["#internal", undefined],
    ["node:fs", undefined],
    ["https://example.com/x.js", undefined],
  ])("reads %s as %s", (specifier, named) => {
    expect(packageOfSpecifier(specifier)).toBe(named);
  });
});
