import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { writeProject } from "../../__test-helpers__/projects.ts";
import type { Host } from "../host.ts";
import { run, type Writer } from "../run.ts";

const LOAD_TIMEOUT = 60_000;

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

const CLEAN_APPLICATION = {
  "deadset.json":
    '{ "target": { "kind": "application" }, "ts": { "entry_files": ["src/main.ts"] } }\n',
  "package.json": '{ "name": "@example/clean", "private": true, "type": "module" }\n',
  "src/main.ts": 'import { helper } from "./internal.js";\n\nconsole.log(helper());\n',
  "src/internal.ts": "export function helper(): number {\n  return 1;\n}\n",
};

function project(files: Readonly<Record<string, string>>): string {
  const root = writeProject(files);
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function analyze(
  files: Readonly<Record<string, string>>,
  args: readonly string[],
  host: Partial<Host> = {},
): { code: number; err: string; written: readonly string[] } {
  const target = project(files);
  const dir = mkdtempSync(join(tmpdir(), "deadset-ts-invocation-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const err = new MemoryWriter();
  const code = run(
    [
      "analyze",
      `--target=${target}`,
      ...(args.some((arg) => arg.startsWith("--report="))
        ? []
        : [`--report=${join(dir, "report.json")}`]),
      ...args,
    ],
    new MemoryWriter(),
    err,
    { ...nodeHost(), workingDirectory: () => tmpdir(), analyzerVersion: () => "0.0.0", ...host },
  );
  return { code, err: err.text, written: readdirSync(dir).sort() };
}

const FAILING_TO_LOAD = {
  ...CLEAN_APPLICATION,
  "src/broken.ts": 'export { made } from "./generated.js";\n',
};

describe("an analyze invocation", () => {
  it("is refused when --report names an empty path", () => {
    const got = analyze(FAILING_TO_LOAD, ["--report="]);

    expect(got.code).toBe(2);
    expect(got.err).toContain("and no path was named");
  });

  it("names every format it renders, in ascending order, when refusing one it does not", () => {
    const got = analyze(FAILING_TO_LOAD, ["--format=html"]);

    expect(got.code).toBe(2);
    expect(got.err).toContain(
      '"html" is not a format this analyzer renders: the formats are github, json, sarif, template, text\n',
    );
  });

  it("refuses the template format the configuration names with no template named, the invocation naming no format", () => {
    const got = analyze(
      {
        ...FAILING_TO_LOAD,
        "deadset.json":
          '{ "target": { "kind": "application" }, "reporters": { "formats": ["template"] } }\n',
      },
      [],
    );

    expect(got.code).toBe(2);
    expect(got.err).toContain("the template format renders the template --template names");
    expect(got.written).toEqual([]);
  });

  it("reads an empty --template as naming no template", () => {
    const got = analyze(FAILING_TO_LOAD, ["--format=template", "--template="]);

    expect(got.code).toBe(2);
    expect(got.err).toContain("and none was named");
  });

  it("ends with the run failure product-fault naming why the analyzer's version cannot be read", () => {
    const got = analyze(CLEAN_APPLICATION, [], {
      analyzerVersion: () => {
        throw new Error("the package manifest cannot be read");
      },
    });

    expect(got).toEqual({
      code: 3,
      err: "run failure: product-fault: deadset-ts cannot read its own version: the package manifest cannot be read: reinstall deadset-ts, and report the fault to its maintainers if a reinstalled deadset-ts fails the same way\n",
      written: [],
    });
  });

  it(
    "counts one stale suppression in the singular",
    () => {
      const got = analyze(
        {
          ...CLEAN_APPLICATION,
          "src/internal.ts":
            "// deadset:ignore DS1001 -- kept for a plugin\nexport function helper(): number {\n  return 1;\n}\n",
        },
        [],
      );

      expect(got.code).toBe(1);
      expect(got.err).toBe("deadset-ts: 1 stale suppression\n");
    },
    LOAD_TIMEOUT,
  );

  it(
    "names no verdict under --exit-code=off for a clean run, and writes the configuration's default rendering",
    () => {
      const got = analyze(CLEAN_APPLICATION, ["--exit-code=off"]);

      expect(got).toEqual({ code: 0, err: "", written: ["report.json", "report.json.txt"] });
    },
    LOAD_TIMEOUT,
  );
});
