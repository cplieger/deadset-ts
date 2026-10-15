import { describe, expect, it } from "vitest";
import { declarationKey, dependenciesOf } from "./dependencies.ts";
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
    readDirectory: (path) =>
      Object.keys(files)
        .filter((one) => one.startsWith(`${path}/`) && !one.slice(path.length + 1).includes("/"))
        .map((one) => ({ name: one.slice(path.length + 1), directory: false })),
    kindOf: (path) =>
      files[path] !== undefined
        ? "file"
        : Object.keys(files).some((one) => one.startsWith(`${path}/`))
          ? "directory"
          : "absent",
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

describe("a module a script preloads by a runtime flag", () => {
  it("runs the declared dependency its bare specifier names, in each flag's form, only where the command's program passes the flag to the runtime", () => {
    const manifest = {
      scripts: {
        esm: "node --loader ts-node/esm src/a.ts",
        imports: "node --import=tsx/esm src/b.ts",
        requires: "node -r dotenv/config src/c.js && node --require @scope/hook src/d.js",
        experimental: "node --experimental-loader=@scope/loader src/e.js",
        relative: "node --import ./register.js src/f.js",
        unflagged: "node unflagged src/g.js",
        assigned: "TEST_REGEN=1 node --no-warnings --loader @scope/assigned test/setup.ts",
        runner: "mocha -r @scope/register 'test/**/*.ts'",
        echoed: "echo --loader echoed",
        copied: "cp -r assets dist",
        argument: "node src/h.js --require after-script",
      },
      devDependencies: Object.fromEntries(
        [
          "ts-node",
          "tsx",
          "dotenv",
          "@scope/hook",
          "@scope/loader",
          "unflagged",
          "@scope/assigned",
          "@scope/register",
          "echoed",
          "assets",
          "after-script",
        ].map((name) => [name, "1.0.0"]),
      ),
    };
    const found = dependenciesOf(
      hostWith({ "/repo/package.json": JSON.stringify(manifest) }),
      "/repo",
      [],
      [],
    );

    expect(
      found.declared
        .filter((one) => found.ran.has(declarationKey(one)))
        .map((one) => one.name)
        .sort(),
    ).toEqual([
      "@scope/assigned",
      "@scope/hook",
      "@scope/loader",
      "@scope/register",
      "dotenv",
      "ts-node",
      "tsx",
    ]);
  });

  it("runs the declared dependency a flag names in nodemon's exec command, a workflow step or a makefile recipe", () => {
    const names = ["ts-node", "tsx", "dotenv", "@scope/recipe", "unflagged"];
    const declared = { devDependencies: Object.fromEntries(names.map((name) => [name, "1.0.0"])) };
    const ran = (files: Readonly<Record<string, string>>): readonly string[] => {
      const found = dependenciesOf(hostWith(files), "/repo", [], []);
      return found.declared
        .filter((one) => found.ran.has(declarationKey(one)))
        .map((one) => one.name)
        .sort();
    };

    expect(
      ran({
        "/repo/package.json": JSON.stringify({
          ...declared,
          nodemonConfig: { exec: "node --no-warnings --loader ts-node/esm" },
        }),
      }),
      "nodemonConfig.exec",
    ).toEqual(["ts-node"]);
    expect(
      ran({
        "/repo/package.json": JSON.stringify(declared),
        "/repo/nodemon.json": JSON.stringify({ exec: "node --import tsx" }),
      }),
      "nodemon.json exec",
    ).toEqual(["tsx"]);
    expect(
      ran({
        "/repo/package.json": JSON.stringify(declared),
        "/repo/.github/workflows/ci.yaml":
          "jobs:\n  test:\n    steps:\n      - run: node -r dotenv/config src/main.js unflagged\n",
        "/repo/Makefile": "check:\n\tnode --require @scope/recipe src/check.js\n",
      }),
      "a workflow step and a recipe line",
    ).toEqual(["@scope/recipe", "dotenv"]);
  });
});
