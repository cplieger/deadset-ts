import { describe, expect, it } from "vitest";
import type { Host } from "./host.ts";
import { packageScope } from "./inventory.ts";

const ROOT = "/target";

/** A filesystem holding only the given files below the root, recording every read. */
function hostOf(files: Readonly<Record<string, string>>, reads: string[] = []): Host {
  const refused = (): never => {
    throw new Error("not read by a package scope");
  };
  return {
    workingDirectory: () => ROOT,
    readFile: (path) => {
      reads.push(path);
      const text = files[path.slice(ROOT.length + 1)];
      if (text === undefined) {
        throw new Error(`${path}: no such file`);
      }
      return text;
    },
    readDirectory: refused,
    kindOf: refused,
    realPath: refused,
    analyzerVersion: refused,
    writeDocument: refused,
    temporaryDirectory: refused,
    componentMapperCommand: refused,
  };
}

describe("a file's package scope", () => {
  it.each([
    { manifest: "null", form: "null" },
    { manifest: "7", form: "a number" },
    { manifest: '"inner"', form: "a string" },
    { manifest: "{", form: "no JSON" },
    { manifest: '{ "name": "" }', form: "an empty name" },
    { manifest: '{ "name": 7 }', form: "a name that is no string" },
  ])("passes over a manifest that is $form to the next one up", ({ manifest }) => {
    const scope = packageScope(
      hostOf({ "package.json": '{ "name": "@example/outer" }', "inner/package.json": manifest }),
      ROOT,
    );

    expect(scope("inner/src/unit.ts")).toEqual({
      package: "@example/outer",
      path: "inner/src/unit.ts",
    });
  });

  it("is the nearest manifest's name and the path below it", () => {
    const scope = packageScope(
      hostOf({
        "package.json": '{ "name": "@example/outer" }',
        "inner/package.json": '{ "name": "@example/inner" }',
      }),
      ROOT,
    );

    expect(scope("inner/src/unit.ts")).toEqual({ package: "@example/inner", path: "src/unit.ts" });
    expect(scope("src/unit.ts")).toEqual({ package: "@example/outer", path: "src/unit.ts" });
  });

  it("reads each directory's manifest once, however many files the directory holds", () => {
    const reads: string[] = [];
    const scope = packageScope(
      hostOf({ "package.json": '{ "name": "@example/outer" }' }, reads),
      ROOT,
    );

    for (const path of ["a/b/one.ts", "a/b/two.ts", "a/three.ts", "four.ts"]) {
      expect(scope(path).package, path).toBe("@example/outer");
    }
    expect(reads).toEqual([
      "/target/a/b/package.json",
      "/target/a/package.json",
      "/target/package.json",
    ]);
  });
});
