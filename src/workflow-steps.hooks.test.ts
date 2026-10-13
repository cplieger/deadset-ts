import { describe, expect, it } from "vitest";
import type { Host } from "./host.ts";
import { workflowTokens } from "./workflow-steps.ts";

/** A host holding `files` below `/repo`, each directory listing the files directly in it. */
function hostWith(files: Readonly<Record<string, string>>): Host {
  const paths = Object.keys(files).map((path) => `/repo/${path}`);
  return {
    workingDirectory: () => "/",
    readFile: (path) => {
      const text = files[path.slice("/repo/".length)];
      if (text === undefined) {
        throw new Error(`${path}: absent`);
      }
      return text;
    },
    readDirectory: (dir) => {
      const below = paths.filter((path) => path.startsWith(`${dir}/`));
      const names = new Set(below.map((path) => path.slice(dir.length + 1).split("/")[0] ?? ""));
      return [...names].map((name) => ({
        name,
        directory: !below.includes(`${dir}/${name}`),
      }));
    },
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

describe("workflowTokens, the git hooks read", () => {
  it("reads every line of each file in .husky and .githooks, and no file of a directory below them", () => {
    const tokens = workflowTokens(
      hostWith({
        ".husky/pre-commit": '#!/bin/sh\n. "$(dirname "$0")/_/husky.sh"\n\nnpx lint-staged\n',
        ".husky/_/husky.sh": "internal-tool\n",
        ".githooks/pre-push": "node scripts/check.ts && commitlint --edit\n",
      }),
      "/repo",
    );

    expect(tokens).toEqual(
      expect.arrayContaining(["lint-staged", "scripts/check.ts", "commitlint"]),
    );
    expect(tokens).not.toContain("internal-tool");
  });

  it("reads no shell comment of a hook, and a hash inside quotes or a word", () => {
    const tokens = workflowTokens(
      hostWith({
        ".husky/pre-commit": '#!/bin/sh\n# lint-staged\neslint --rule "a # b" src#x # prettier\n',
      }),
      "/repo",
    );

    expect(tokens).toEqual(["eslint", "--rule", '"a', "#", 'b"', "src#x"]);
  });

  it("reads the entry commands of .pre-commit-config.yaml and the run commands of a lefthook file", () => {
    const tokens = workflowTokens(
      hostWith({
        ".pre-commit-config.yaml": [
          "repos:",
          "  - repo: local",
          "    hooks:",
          "      - id: lint",
          "        entry: eslint --fix",
          "        name: run: not-a-command",
          "",
        ].join("\n"),
        "lefthook.yml": "pre-commit:\n  commands:\n    types:\n      run: tsc --noEmit\n",
      }),
      "/repo",
    );

    expect(tokens).toEqual(["eslint", "--fix", "tsc", "--noEmit"]);
  });
});
