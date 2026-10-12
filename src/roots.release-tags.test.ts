import { rmSync } from "node:fs";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { run, type Writer } from "./run.ts";

const LOAD_TIMEOUT = 60_000;

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

/** What `src/extra.ts` publishes: the export path is `src/index.ts`, which does not re-export it. */
function publishedBeside(extra: string): string[] {
  const root = writeProject({
    "package.json": `${JSON.stringify({
      name: "@example/lib",
      type: "module",
      exports: { ".": "./src/index.ts" },
    })}\n`,
    "deadset.json": `${JSON.stringify({ target: { kind: "library" } })}\n`,
    "src/index.ts": "export const main = 1;\n",
    "src/extra.ts": extra,
  });
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const out = new MemoryWriter();
  const err = new MemoryWriter();
  expect(run(["print-roots", `--target=${root}`], out, err, nodeHost()), err.text).toBe(0);
  const prefix = "ts://@example/lib/src/extra.ts#";
  return out.text
    .split("\n")
    .filter((line) => line.startsWith(prefix) && line.endsWith("\tpublished-api"))
    .map((line) => line.slice(prefix.length, -"\tpublished-api".length));
}

describe("a release tag in a documentation comment", () => {
  it(
    "publishes the exported statement the comment documents",
    () => {
      expect(
        publishedBeside(
          [
            "/** @public */",
            "export const first = 1;",
            "/** Counted. @beta */",
            "export const second = 1;",
            "/* generated */ /** @alpha */ export const afterComment = 1;",
            "",
          ].join("\n"),
        ),
      ).toEqual(["first", "second", "afterComment"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "publishes nothing a comment of another shape or place marks",
    () => {
      expect(
        publishedBeside(
          [
            "export const untagged = 1;",
            "/** Plain. */",
            "export const plain = 1;",
            "/* @public */",
            "export const blockComment = 1;",
            "// @public",
            "export const lineComment = 1;",
            "/** @public */",
            "// between",
            "export const commentBetween = 1;",
            "/* @public */",
            "/** Plain. */",
            "export const lastPlain = 1;",
            "/** @public */",
            "const unexported = 1;",
            "export const last = unexported;",
            "/** @public */",
            "",
          ].join("\n"),
        ),
      ).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});
