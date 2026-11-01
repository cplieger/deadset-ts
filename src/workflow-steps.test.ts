import type { SourceFile } from "@typescript/native/ast";
import { describe, expect, it } from "vitest";
import { readCommands } from "./commands/read.ts";
import type { Host } from "./host.ts";
import type { SourceFiles } from "./source-files.ts";
import { spelledFiles } from "./text/named-files.ts";
import { commandFileTexts, workflowCommands, workflowEntries } from "./workflow-steps.ts";

/** A host holding one workflow file at `/repo/.github/workflows/ci.yml`. */
function hostWith(workflow: string): Host {
  return {
    workingDirectory: () => "/",
    readFile: (path) => {
      if (path === "/repo/.github/workflows/ci.yml") {
        return workflow;
      }
      throw new Error(`${path}: absent`);
    },
    readDirectory: (path) =>
      path === "/repo/.github/workflows" ? [{ name: "ci.yml", directory: false }] : [],
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

/** The own files at the given paths below `/repo`; only `fileName` is read. */
function filesAt(paths: readonly string[]): SourceFiles {
  const byPath = new Map(
    paths.map((path) => [path, { fileName: `/repo/${path}` } as unknown as SourceFile]),
  );
  return {
    byPath,
    byName: new Map([...byPath.values()].map((file) => [file.fileName, file])),
    named: (path) => [...byPath.values()].filter((file) => file.fileName === path),
    outputDirs: [],
    writtenAs: () => [],
    namedAsOutput: () => [],
  };
}

describe("workflowEntries", () => {
  it("names no file by a token holding a glob character, even where a file has that name", () => {
    const entries = workflowEntries(
      hostWith("    - run: node scripts/[id].ts && node ./scripts/check.ts\n"),
      "/repo",
      filesAt(["scripts/[id].ts", "scripts/check.ts"]),
    );

    expect(entries.map((one) => `${one.file.fileName} ${one.source}`)).toEqual([
      "/repo/scripts/check.ts ./scripts/check.ts",
    ]);
  });

  it.each([
    ['  - run: "node pkg/\\u0065sc.js"'],
    ['  - run: "node pkg/\\x65sc.js"'],
    ['  - run: "node pkg/\\U00000065sc.js"'],
    ['  - run: "node pkg\\/esc.js"'],
    ['  - run: "node \\"pkg/esc.js\\""'],
    ["  - run: 'node ''pkg/esc.js'''"],
    ['  - run: "node pkg/e\\\n      sc.js"'],
    ["  - run: node\n      pkg/esc.js"],
  ])("roots and holds the file the step %j names once YAML decodes it", (workflow) => {
    const host = hostWith(workflow);
    const held = workflowCommands(host, "/repo")
      .map(({ text, dir }) => readCommands(text, dir).held)
      .join("\n");

    expect(
      workflowEntries(host, "/repo", filesAt(["pkg/esc.js"])).map((one) => one.file.fileName),
    ).toEqual(["/repo/pkg/esc.js"]);
    expect(
      spelledFiles(held, "/repo", [{ file: "/repo/pkg/esc.js", paths: ["/repo/pkg/esc.js"] }]),
    ).toEqual(["/repo/pkg/esc.js"]);
  });
});

/**
 * The command strings `/repo`'s workflow file `workflow` holds, each with the directory below
 * `/repo` it runs in, `undefined` where the file does not state it.
 */
function stepsOf(workflow: string): readonly (readonly [string, string | undefined])[] {
  return workflowCommands(hostWith(workflow), "/repo").map(({ text, dir }) => [
    text,
    dir?.slice("/repo".length),
  ]);
}

describe("workflowCommands, the workflow run steps", () => {
  it("reads a single-line step after a sequence marker and as a mapping key", () => {
    expect(
      stepsOf(
        [
          "steps:",
          "  - run: node scripts/check.ts",
          "  - name: Lint",
          "    run: npm run lint",
        ].join("\n"),
      ),
    ).toEqual([
      ["node scripts/check.ts", ""],
      ["npm run lint", ""],
    ]);
  });

  it("removes one pair of enclosing quotes from a single-line command", () => {
    expect(stepsOf(`  - run: "node scripts/check.ts"`)).toEqual([["node scripts/check.ts", ""]]);
  });

  it("reads a literal block scalar's lines indented past the run key as one command line", () => {
    expect(
      stepsOf(
        [
          "      - name: Report",
          "        run: |-",
          "          node scripts/report.ts",
          "",
          "          ./scripts/release.ts",
          "        shell: bash",
          "          node scripts/after.ts",
        ].join("\n"),
      ),
    ).toEqual([["node scripts/report.ts\n\n./scripts/release.ts", ""]]);
  });

  it("folds a folded block scalar's lines, keeping a more indented one and a blank one", () => {
    expect(
      stepsOf(
        [
          "- run: >",
          "    node a.ts",
          "    b.ts",
          "",
          "    node c.ts",
          "      --flag",
          "- run: node d.ts",
        ].join("\r\n"),
      ),
    ).toEqual([
      ["node a.ts b.ts\nnode c.ts\n  --flag\n", ""],
      ["node d.ts", ""],
    ]);
  });

  it("ends a block scalar at the end of the file, and keeps a shallower blank line inside it", () => {
    expect(stepsOf(["    run: |", "      node a.ts", "  ", "      node b.ts"].join("\n"))).toEqual([
      ["node a.ts\n\nnode b.ts", ""],
    ]);
  });

  it("reads no key that only ends with run, and no run key that holds a mapping", () => {
    expect(
      stepsOf(
        ["dry-run: node x.ts", "rerun: node y.ts", "defaults:", "  run:", "    shell: bash"].join(
          "\n",
        ),
      ),
    ).toEqual([]);
  });

  it("runs each step in its own working-directory, else its job's defaults, else the workflow's", () => {
    expect(
      stepsOf(
        [
          "defaults:",
          "  run:",
          "    working-directory: top",
          "jobs:",
          "  one:",
          "    defaults:",
          "      run:",
          "        working-directory: 'tools/one'",
          "    steps:",
          "      - name: own",
          "        working-directory: tools/own",
          "        run: node .",
          "      - run: node a.js",
          "        working-directory: tools/after",
          "      - run: node b.js",
          "  two:",
          "    steps:",
          "      - run: node c.js",
        ].join("\n"),
      ),
    ).toEqual([
      ["node .", "/tools/own"],
      ["node a.js", "/tools/after"],
      ["node b.js", "/tools/one"],
      ["node c.js", "/top"],
    ]);
  });

  it.each([
    ["        working-directory: packages/${{ matrix.pkg }}", "packages/${{ matrix.pkg }}"],
    ['        working-directory: "${{ inputs.dir }}"', "${{ inputs.dir }}"],
  ])("states no directory for a step whose directory is %j", (line, written) => {
    const [command] = workflowCommands(
      hostWith(["    steps:", "      - run: node build.js", line].join("\n")),
      "/repo",
    );

    expect(command).toEqual({
      text: "node build.js",
      dir: undefined,
      writtenDirectory: written,
    });
  });

  it("states no directory for the steps a defaults directory holding an expression covers", () => {
    expect(
      stepsOf(
        [
          "    defaults:",
          "      run:",
          "        working-directory: ${{ matrix.dir }}",
          "    steps:",
          "      - run: node index.js",
        ].join("\n"),
      ),
    ).toEqual([["node index.js", undefined]]);
  });

  it.each([
    ['  - run: "node \\"pkg/esc.js\\""', [['node "pkg/esc.js"', ""]]],
    ["  - run: 'node ''pkg/esc.js'''", [["node 'pkg/esc.js'", ""]]],
    ['  - run: "node\\tpkg/\\u0065sc.js\\x20 "', [["node\tpkg/esc.js  ", ""]]],
    ['  - run: "node pkg/a.js  \n\n      pkg/b.js" # a comment', [["node pkg/a.js\npkg/b.js", ""]]],
    [
      "  - run: node pkg/a.js &&\n\n      node pkg/b.js # c.js",
      [["node pkg/a.js &&\nnode pkg/b.js", ""]],
    ],
    [
      "  - run: |+2 # a comment\n      node a.js\n\n  - run: x",
      [
        ["node a.js\n\n", ""],
        ["x", ""],
      ],
    ],
    ["  - run:\n      shell: bash", []],
    ["  - run: true", [["true", ""]]],
    ["  - run: 15", [["15", ""]]],
    ['  - { run: "node a.js\n\n      node b.js" }', [["node a.js\nnode b.js", ""]]],
  ])("reads %j as the commands YAML decodes, %j", (workflow, commands) => {
    expect(stepsOf(workflow)).toEqual(commands);
  });

  it.each([
    ['  - run: "node pkg/\\qesc.js"'],
    ['  - run: "node pkg/\\u00esc.js"'],
    ['  - run: "unclosed'],
    ['  - run: "node a.js" b.js'],
    ["  - run: node pkg/a.js &&\n\n      node pkg/b.js # c.js\n      d.js"],
    ['  - run: node build.js\n    working-directory: "tools\\qone"'],
  ])("reads no command of %j, which YAML does not decode, and holds its whole text", (workflow) => {
    const host = hostWith(workflow);

    expect(stepsOf(workflow)).toEqual([]);
    expect(commandFileTexts(host, "/repo")).toEqual([workflow]);
  });

  it("keeps the directory a step is written to run in as written", () => {
    const [command] = workflowCommands(
      hostWith(["      - run: make", "        working-directory: ./tools"].join("\n")),
      "/repo",
    );

    expect(command).toEqual({
      text: "make",
      dir: "/repo/tools",
      writtenDirectory: "./tools",
    });
  });
});

describe("workflowCommands, the YAML structures a workflow file writes", () => {
  it.each([
    [
      "an alias",
      "jobs:\n  a:\n    env:\n      COMMAND: &command node pkg/esc.js\n    steps:\n      - run: *command\n",
    ],
    ["a flow mapping", "jobs:\n  a:\n    steps:\n      - { run: node pkg/esc.js }\n"],
    [
      "a flow sequence of flow mappings",
      "jobs:\n  a:\n    steps: [{ name: x, run: 'node pkg/esc.js' }]\n",
    ],
    [
      "an anchored step and its alias",
      "jobs:\n  a:\n    steps:\n      - &step\n        run: node pkg/esc.js\n  b:\n    steps:\n      - *step\n",
    ],
    [
      "a comment-only key line, then a plain value",
      "jobs:\n  a:\n    steps:\n      - run: # run the script\n          node pkg/esc.js\n",
    ],
    [
      "a comment-only key line, then a quoted value",
      'jobs:\n  a:\n    steps:\n      - run: # c\n          "node pkg/esc.js"\n',
    ],
    [
      "more than one space after the sequence marker",
      "jobs:\n  a:\n    steps:\n      -   run: node pkg/esc.js\n",
    ],
  ])("roots the file a step written with %s runs", (_form, workflow) => {
    expect(
      workflowEntries(hostWith(workflow), "/repo", filesAt(["pkg/esc.js"])).map(
        (one) => one.file.fileName,
      ),
    ).toContain("/repo/pkg/esc.js");
  });

  it.each([
    [
      "a flow mapping",
      "jobs:\n  a:\n    steps:\n      - { run: node a.js, working-directory: app }\n",
    ],
    [
      "a comment-only key line",
      "jobs:\n  a:\n    steps:\n      - working-directory: # the app\n          app\n        run: node a.js\n",
    ],
    [
      "an alias",
      "jobs:\n  a:\n    env:\n      DIR: &dir app\n    steps:\n      - run: node a.js\n        working-directory: *dir\n",
    ],
  ])("runs a step in the working-directory written with %s", (_form, workflow) => {
    expect(stepsOf(workflow)).toEqual([["node a.js", "/app"]]);
  });

  it("reads a plain value's continuation line that starts with a hyphen as part of it", () => {
    expect(
      stepsOf("jobs:\n  a:\n    steps:\n      - run: echo\n          - node scripts/a.js\n"),
    ).toEqual([["echo - node scripts/a.js", ""]]);
  });

  it.each([
    ["a tag", "jobs:\n  a:\n    steps:\n      - run: !!str node pkg/esc.js\n"],
    [
      "an alias of no anchor",
      "jobs:\n  a:\n    steps:\n      - run: *nowhere\n      - run: node pkg/esc.js\n",
    ],
    ["an anchor on a key", "jobs:\n  a:\n    steps:\n      - &a run: node pkg/esc.js\n"],
    [
      "a complex key in a flow mapping",
      "jobs:\n  a:\n    steps:\n      - { ? run : node pkg/esc.js }\n",
    ],
    [
      "aliases of aliases eighteen levels deep",
      [
        "x0: &x0 { run: node pkg/esc.js }",
        ...Array.from({ length: 18 }, (_, at) => `x${at + 1}: &x${at + 1} [*x${at}, *x${at}]`),
        "jobs:\n  a:\n    steps: *x18\n",
      ].join("\n"),
    ],
  ])(
    "reads no command of a file written with %s, which is outside the YAML read, and holds its whole text",
    (_form, workflow) => {
      const host = hostWith(workflow);

      expect(workflowCommands(host, "/repo")).toEqual([]);
      expect(
        spelledFiles(commandFileTexts(host, "/repo").join("\n"), "/repo", [
          { file: "/repo/pkg/esc.js", paths: ["/repo/pkg/esc.js"] },
        ]),
      ).toEqual(["/repo/pkg/esc.js"]);
    },
  );
});
