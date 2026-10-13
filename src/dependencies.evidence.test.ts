import { describe, expect, it } from "vitest";
import { configurationNeeds, dependenciesOf, type ProjectNeeds } from "./dependencies.ts";
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

/** What one project needs: per declaration id, the packages used inside it. */
function needs(
  uses: Readonly<Record<string, readonly string[]>>,
  unanswered: string[] = [],
): ProjectNeeds {
  return {
    uses: new Map(Object.entries(uses).map(([id, named]) => [id, new Set(named)])),
    at: new Map([
      [
        "",
        new Map(
          Object.values(uses)
            .flat()
            .map((one) => [one, new Set([""])]),
        ),
      ],
    ]),
    unanswered,
  };
}

describe("the manifests a run reads", () => {
  it("reads past a value nesting objects and arrays to the sections after it", () => {
    const manifest = [
      "{",
      '  "config": { "outer": { "inner": [[1], { "deep": true }] }, "after": 1 },',
      '  "dependencies": { "a": "1" }',
      "}",
    ].join("\n");
    const host = hostWith({ "/repo/package.json": manifest });

    expect(
      dependenciesOf(host, "/repo", [], []).declared.map(
        (one) => `${one.name} ${String(one.position.line)}:${String(one.position.column)}`,
      ),
    ).toEqual(["a 3:21"]);
  });

  it("reads no member directory outside the target root, and the root's manifest once as the root's", () => {
    const host = hostWith({
      "/repo/pkg/package.json": '{ "dependencies": { "own": "1" } }',
      "/repo/other/package.json": '{ "dependencies": { "outside": "1" } }',
    });

    expect(
      dependenciesOf(host, "/repo/pkg", [], [], ["/repo/other", "/repo/pkg"]).declared.map(
        (one) => `${one.position.path} ${one.name}`,
      ),
    ).toEqual(["package.json own"]);
  });
});

describe("the last uses a deletion candidate holds", () => {
  it("are every declared dependency only it uses, sorted bytewise", () => {
    const host = hostWith({
      "/repo/package.json": '{ "dependencies": { "c": "1", "a": "1", "b": "1", "shared": "1" } }',
    });
    const perProject = [needs({ "x.ts:1:1": ["c", "a", "b", "shared"], "y.ts:1:1": ["shared"] })];

    expect(dependenciesOf(host, "/repo", perProject, ["x.ts:1:1"]).lastUses).toEqual(
      new Map([["x.ts:1:1", ["a", "b", "c"]]]),
    );
  });

  it("are no entry for a candidate holding none", () => {
    const host = hostWith({ "/repo/package.json": '{ "dependencies": { "shared": "1" } }' });
    const perProject = [needs({ "x.ts:1:1": ["shared"], "y.ts:1:1": ["shared"] })];

    expect(dependenciesOf(host, "/repo", perProject, ["x.ts:1:1", "z.ts:1:1"]).lastUses).toEqual(
      new Map(),
    );
  });

  it("leave out a dependency an unanswered specifier may also use", () => {
    const host = hostWith({
      "/repo/package.json": '{ "dependencies": { "kept": "1", "sole": "1" } }',
    });
    const perProject = [
      needs({ "x.ts:1:1": ["kept", "sole"] }),
      needs({}, ["/repo/src/unknown.ts"]),
    ];

    expect(dependenciesOf(host, "/repo", perProject, ["x.ts:1:1"]).lastUses).toEqual(new Map());
  });

  it("leave out a dependency a configuration's own reading also uses", () => {
    const host = hostWith({
      "/repo/package.json": '{ "dependencies": { "helpers": "1", "sole": "1" } }',
    });
    const perProject = [
      needs({ "x.ts:1:1": ["helpers", "sole"] }),
      configurationNeeds(["helpers"]),
    ];

    expect(dependenciesOf(host, "/repo", perProject, ["x.ts:1:1"]).lastUses).toEqual(
      new Map([["x.ts:1:1", ["sole"]]]),
    );
  });
});
