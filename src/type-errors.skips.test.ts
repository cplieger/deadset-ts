import { rmSync } from "node:fs";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { TSCONFIG, writeProject } from "../__test-helpers__/projects.ts";
import { runAnalysis, runRoots } from "./analysis.ts";
import { resolve } from "./resolve.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine } from "./session.ts";

const LOAD_TIMEOUT = 60_000;

const APPLICATION = {
  target: { kind: "application" },
  analysis: { min_confidence: "possible" },
  ts: { entry_files: ["src/main.ts"] },
};

function target(files: Readonly<Record<string, string>>) {
  const root = writeProject(files);
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const host = nodeHost();
  const { config, provenance } = resolve({
    repository: JSON.stringify(APPLICATION),
    repositoryLabel: "deadset.json",
  });
  return { host, scope: scopeForDir(host, root), config, provenance };
}

function analyzed(files: Readonly<Record<string, string>>) {
  const { host, scope, config, provenance } = target(files);
  const analysis = runAnalysis(
    openEngine({ collectTiming: false }),
    host,
    scope,
    config,
    provenance,
    { production: true },
  );
  return {
    skips: analysis.run.typeErrorSkips,
    skipped: analysis.swept.skipped,
    findings: analysis.result.findings.map(
      (one) => `${one.code} ${one.symbol.ref} ${one.position.path}:${String(one.position.line)}`,
    ),
  };
}

function keptByTypeErrors(files: Readonly<Record<string, string>>): readonly string[] {
  const { host, scope, config, provenance } = target(files);
  return runRoots(openEngine({ collectTiming: false }), host, scope, config, provenance)
    .roots.filter((root) => root.kind === "type-error")
    .map((root) => root.ref);
}

describe("a type error in an own file", () => {
  it(
    "skips the top-level statement it is in, at the file's first character or right after another statement",
    () => {
      const got = analyzed({
        "src/main.ts": 'import "./first.js";\nimport "./after.js";\n',
        "src/first.ts": "wrong;\nexport const kept = 1;\n",
        "src/after.ts": "export const list = [\n  1,\n];missing;\n",
      });

      expect(got.skips).toEqual([
        { path: "src/after.ts", line: 3, message: "Cannot find name 'missing'." },
        { path: "src/first.ts", line: 1, message: "Cannot find name 'wrong'." },
      ]);
      expect(got.skipped).toEqual([
        { path: "src/after.ts", fromLine: 3, toLine: 3 },
        { path: "src/first.ts", fromLine: 1, toLine: 1 },
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "skips the member of a top-level class it is in, and the whole class where no member holds it",
    () => {
      const got = analyzed({
        "src/main.ts": 'import "./widget.js";\nimport "./gadget.js";\n',
        "src/widget.ts":
          "export class Widget {\n  shown = [\n    1];broken: string = 2;\n  after(): number {\n    return 1;\n  }\n}\n",
        "src/gadget.ts":
          "export class Gadget extends Missing {\n  run(): number {\n    return 1;\n  }\n}\n",
      });

      expect(got.skipped).toEqual([
        { path: "src/gadget.ts", fromLine: 1, toLine: 5 },
        { path: "src/widget.ts", fromLine: 3, toLine: 3 },
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "skips the innermost function holding it, so another function of the same statement is judged",
    () => {
      const got = analyzed({
        "src/main.ts": [
          "declare function suite(name: string, body: () => void): void;",
          "suite('s', () => {",
          "  suite('a', () => {",
          "    try { console.log(1); } catch (unread) { return; }",
          "  });",
          "  suite('b', () => {",
          '    const n: number = "x";',
          "    console.log(n);",
          "  });",
          "});",
          "",
        ].join("\n"),
      });

      expect(got.skipped).toEqual([{ path: "src/main.ts", fromLine: 6, toLine: 9 }]);
      expect(got.findings).toEqual(["DS1807 ts://./src/main.ts# src/main.ts:4"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is listed with the compiler's message on one line, each run of whitespace one space",
    () => {
      const got = analyzed({
        "src/main.ts": 'export const spaced: "a  b" = "c";\n',
      });

      expect(got.skips).toEqual([
        {
          path: "src/main.ts",
          line: 1,
          message: `Type '"c"' is not assignable to type '"a b"'.`,
        },
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is not one where the compiler marks the code unnecessary, which is reported as dead",
    () => {
      const got = analyzed({
        "tsconfig.json": TSCONFIG.replace(
          '"strict": true',
          '"strict": true, "noUnusedLocals": true',
        ),
        "src/main.ts":
          "export function compute(): number {\n  const unusedLocal = 4;\n  return 1;\n}\n",
      });

      expect(got.skips).toEqual([]);
      expect(got.findings).toEqual(["DS1807 ts://./src/main.ts#compute src/main.ts:2"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "withholds every finding on the skipped unit's lines, and none above or below it or in another file",
    () => {
      const got = analyzed({
        "src/main.ts":
          'import { broken } from "./broken.js";\nimport { other } from "./other.js";\nconsole.log(broken, other);\n',
        "src/broken.ts":
          "function deadAbove(): number {\n  return 1;\n}\nexport function broken(unused: number): string { return 1; }\nfunction deadBelow(): number {\n  return 1;\n}\n",
        "src/other.ts":
          "export function other(): void {}\n\n\nfunction deadInOther(): number {\n  return 1;\n}\n",
      });

      expect(got.skipped).toEqual([{ path: "src/broken.ts", fromLine: 4, toLine: 4 }]);
      expect(got.findings).toEqual([
        "DS1002 ts://./src/broken.ts#deadAbove src/broken.ts:1",
        "DS1002 ts://./src/broken.ts#deadBelow src/broken.ts:5",
        "DS1002 ts://./src/other.ts#deadInOther src/other.ts:4",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "keeps live what the skipped unit declares and every member of a type it selects an unresolved member on",
    () => {
      expect(
        keptByTypeErrors({
          "src/main.ts": 'import { broken } from "./broken.js";\nconsole.log(broken);\n',
          "src/parts.ts":
            "export class Widget {\n  shown(): number {\n    return 1;\n  }\n  hidden(): number {\n    return 2;\n  }\n}\nexport class Helper {\n  run(): number {\n    return 1;\n  }\n  idle(): number {\n    return 2;\n  }\n}\n",
          "src/broken.ts":
            'import { Helper, Widget } from "./parts.js";\nexport function broken(widget: Widget, helper: Helper): number {\n  helper.run();\n  return widget.missing;\n}\n',
        }),
      ).toEqual([
        "ts://./src/broken.ts#broken",
        "ts://./src/parts.ts#Widget.shown",
        "ts://./src/parts.ts#Widget.hidden",
      ]);
    },
    LOAD_TIMEOUT,
  );
});
