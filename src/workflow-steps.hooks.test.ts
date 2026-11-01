import { describe, expect, it } from "vitest";
import type { Host } from "./host.ts";
import { readCommands } from "./commands/read.ts";
import { commandFileTexts, workflowCommands } from "./workflow-steps.ts";

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

/** Every static word of the commands the hooks below `/repo` hold. */
function workflowTokens(host: Host, root: string): readonly string[] {
  return workflowCommands(host, root).flatMap(({ text, dir }) =>
    readCommands(text, dir).commands.flatMap((command) =>
      command.words.flatMap((word) => word ?? []),
    ),
  );
}

describe("workflowCommands, the git hooks read", () => {
  it("reads every line of each file in .husky and .githooks, and no file of a directory below them", () => {
    const host = hostWith({
      ".husky/pre-commit": "#!/bin/sh\nnpx lint-staged\n",
      ".husky/_/husky.sh": "internal-tool\n",
      ".githooks/pre-push": "node scripts/check.ts && commitlint --edit\n",
    });

    expect(workflowTokens(host, "/repo")).toEqual([
      "npx",
      "lint-staged",
      "node",
      "scripts/check.ts",
      "commitlint",
      "--edit",
    ]);
  });

  it("runs nothing after a hook sources a script, which may move its directory, and holds it", () => {
    const hook = '#!/bin/sh\n. "$(dirname "$0")/_/husky.sh"\n\nnode scripts/check.js\n';
    const [command] = workflowCommands(hostWith({ ".husky/pre-commit": hook }), "/repo");
    const reading = readCommands(command?.text ?? "", command?.dir);

    expect([reading.runs, reading.held]).toEqual([[], hook]);
  });

  it("reads each hook file as one shell script, so no comment of it is a command", () => {
    const tokens = workflowTokens(
      hostWith({
        ".husky/pre-commit": '#!/bin/sh\n# lint-staged\neslint --rule "a # b" src#x # prettier\n',
      }),
      "/repo",
    );

    expect(tokens).toEqual(["eslint", "--rule", "a # b", "src#x"]);
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
          '        name: "run: not-a-command"',
          "",
        ].join("\n"),
        "lefthook.yml": "pre-commit:\n  commands:\n    types:\n      run: tsc --noEmit\n",
      }),
      "/repo",
    );

    expect(tokens).toEqual(["eslint", "--fix", "tsc", "--noEmit"]);
  });

  it("runs a lefthook command in its root", () => {
    const commands = workflowCommands(
      hostWith({
        "lefthook.yml": [
          "pre-commit:",
          "  commands:",
          "    publish:",
          '      root: "tools/publish/"',
          "      run: node .",
          "    lint:",
          "      run: eslint .",
          "",
        ].join("\n"),
      }),
      "/repo",
    );

    expect(commands).toEqual([
      {
        text: "node .",
        dir: "/repo/tools/publish",
        writtenDirectory: "tools/publish/",
      },
      { text: "eslint .", dir: "/repo", writtenDirectory: undefined },
    ]);
  });

  it("holds the whole text of a git hook file, its comments included, and of a hook manager's file", () => {
    const hook = "#!/bin/sh\n# never-run\nnpx staged-lint # never-run\ncat <<EOF\nbody.js\nEOF\n";
    const lefthook = "pre-commit:\n  commands:\n    lint:\n      run: eslint . # noted.js\n";
    const host = hostWith({ ".husky/pre-commit": hook, "lefthook.yml": lefthook });

    expect(
      workflowCommands(host, "/repo").map((one) => readCommands(one.text, one.dir).held),
    ).toEqual([hook, "eslint ."]);
    expect(commandFileTexts(host, "/repo")).toEqual([hook, lefthook]);
  });
});
