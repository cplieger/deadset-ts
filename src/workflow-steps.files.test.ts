import type { SourceFile } from "@typescript/native/ast";
import { describe, expect, it } from "vitest";
import type { Host } from "./host.ts";
import type { SourceFiles } from "./source-files.ts";
import { workflowEntries } from "./workflow-steps.ts";

const WORKFLOWS = "/repo/.github/workflows";

/** A host whose workflow directory lists `listed` in that order; `texts` are the files it can read. */
function hostListing(
  listed: readonly { readonly name: string; readonly directory: boolean }[],
  texts: Readonly<Record<string, string>>,
): Host {
  return {
    workingDirectory: () => "/",
    readFile: (path) => {
      const text = texts[path.slice(WORKFLOWS.length + 1)];
      if (path.startsWith(`${WORKFLOWS}/`) && text !== undefined) {
        return text;
      }
      throw new Error(`${path}: absent`);
    },
    readDirectory: (path) => (path === WORKFLOWS ? listed : []),
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
    outputDirs: [],
    writtenAs: () => [],
    namedAsOutput: () => [],
  };
}

describe("workflowEntries, the workflow files read", () => {
  it("reads every .yml and .yaml file in name order, and no other entry", () => {
    const host = hostListing(
      [
        { name: "release.yaml", directory: false },
        { name: "ci.yml", directory: false },
        { name: "README.md", directory: false },
        { name: "ci.yml.disabled", directory: false },
        { name: "nested.yml", directory: true },
      ],
      {
        "release.yaml": "      - run: node scripts/release.ts\n",
        "ci.yml": "      - run: node scripts/ci.ts\n",
        "README.md": "      - run: node scripts/readme.ts\n",
        "ci.yml.disabled": "      - run: node scripts/disabled.ts\n",
      },
    );

    const entries = workflowEntries(
      host,
      "/repo",
      filesAt(["scripts/release.ts", "scripts/ci.ts", "scripts/readme.ts", "scripts/disabled.ts"]),
    );

    expect(entries.map((one) => one.source)).toEqual(["scripts/ci.ts", "scripts/release.ts"]);
  });
});
