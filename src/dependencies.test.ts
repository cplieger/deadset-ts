import { describe, expect, it } from "vitest";
import { dependenciesOf, packageOfSpecifier, type ProjectNeeds } from "./dependencies.ts";
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

  it("reads an installed copy from the nearest dependency directory at or above the target", () => {
    const host = hostWith({
      "/repo/pkg/package.json": '{ "devDependencies": { "tool": "1", "plugin": "1" } }',
      "/repo/node_modules/tool/package.json": '{ "bin": { "tool": "./cli.js" } }',
      "/repo/pkg/node_modules/plugin/package.json": JSON.stringify({
        peerDependencies: { host: "1", maybe: "1" },
        peerDependenciesMeta: { maybe: { optional: true } },
      }),
    });

    expect([...dependenciesOf(host, "/repo/pkg", [], []).installed]).toEqual([
      ["tool", { command: true, peers: [] }],
      ["plugin", { command: false, peers: ["host"] }],
    ]);
  });

  it("names a declared dependency only for the one declaration using it across every project", () => {
    const host = hostWith({
      "/repo/pkg/package.json": '{ "dependencies": { "a": "1", "b": "1" } }',
    });
    const project = (uses: Record<string, string[]>): ProjectNeeds => ({
      packages: new Set(Object.values(uses).flat()),
      uses: new Map(Object.entries(uses).map(([id, named]) => [id, new Set(named)])),
      unanswered: false,
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
