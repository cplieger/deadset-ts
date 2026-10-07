import type { SourceFile } from "@typescript/native/unstable/ast";
import { describe, expect, it } from "vitest";
import type { Host } from "./host.ts";
import type { SourceFiles } from "./source-files.ts";
import { runCommands, workflowEntries } from "./workflow-steps.ts";

describe("runCommands", () => {
  it("reads a single-line step after a sequence marker and as a mapping key", () => {
    expect(
      runCommands(
        [
          "steps:",
          "  - run: node scripts/check.ts",
          "  - name: Lint",
          "    run: npm run lint",
        ].join("\n"),
      ),
    ).toEqual(["node scripts/check.ts", "npm run lint"]);
  });

  it("removes one pair of enclosing quotes from a single-line command", () => {
    expect(runCommands(`  - run: "node scripts/check.ts"`)).toEqual(["node scripts/check.ts"]);
  });

  it("reads a block scalar's lines indented past the run key, blank lines included", () => {
    expect(
      runCommands(
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
    ).toEqual(["          node scripts/report.ts", "", "          ./scripts/release.ts"]);
  });

  it("reads a folded block scalar the same way", () => {
    expect(runCommands(["- run: >", "    node a.ts", "- run: node b.ts"].join("\r\n"))).toEqual([
      "    node a.ts",
      "node b.ts",
    ]);
  });

  it("reads no key that only ends with run", () => {
    expect(
      runCommands(["  dry-run: node x.ts", "  rerun: node y.ts", "  - - run: z"].join("\n")),
    ).toEqual([]);
  });
});

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
    named: () => [],
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
});
