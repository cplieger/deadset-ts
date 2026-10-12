import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { TSCONFIG, writeProject } from "../../__test-helpers__/projects.ts";
import { run, type Writer } from "../run.ts";

const LOAD_TIMEOUT = 60_000;

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

function explain(
  target: string,
  ...args: readonly string[]
): { code: number; out: string; err: string } {
  const out = new MemoryWriter();
  const err = new MemoryWriter();
  const code = run(["explain", `--target=${target}`, ...args], out, err, {
    ...nodeHost(),
    workingDirectory: () => tmpdir(),
  });
  return { code, out: out.text, err: err.text };
}

const COUNTED = Array.from(
  { length: 21 },
  (_, i) =>
    `export function counted${String(i).padStart(2, "0")}(): number {\n  return ${String(i)};\n}\n`,
).join("\n");

function library(): string {
  const root = writeProject({
    "tsconfig.json": TSCONFIG,
    "package.json":
      '{ "name": "@example/subjects", "private": true, "type": "module", "main": "./lib.ts" }\n',
    "deadset.json":
      '{ "target": { "kind": "library" }, "severity": { "DS1002": "allow", "DS1502": "allow" } }\n',
    "lib.ts": "export default function renderPanel(): number {\n  return 2;\n}\n",
    "w.ts":
      "function gammaWidget(): number {\n  return 1;\n}\n\nfunction alphaWidget(): number {\n  return 2;\n}\n\nfunction betaWidget(): number {\n  return 3;\n}\n",
    "h1.ts": "function helper(): number {\n  return 1;\n}\n",
    "h2.ts": "function helper(): number {\n  return 2;\n}\n",
    "h3.ts": "function helperTwo(): number {\n  return 3;\n}\n",
    "many.ts": COUNTED,
  });
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

describe("the symbol an explain request names", () => {
  it("is refused as none where the one option naming it is empty", () => {
    const got = explain(`${tmpdir()}/deadset-ts-no-such-target`, "--why=");

    expect(got.code).toBe(2);
    expect(got.err).toContain(
      "explain explains the symbol --why, --why-live or --why-not names, and none was named",
    );
  });

  it(
    "is read by the part of its reference after the separator where that differs from its name",
    () => {
      const got = explain(library(), "--why=default");

      expect(got.code).toBe(0);
      expect(got.out).toMatch(
        /^symbol: ts:\/\/@example\/subjects\/lib\.ts#default\ndeclaration: function renderPanel\n/u,
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "is no one symbol where two declarations bear it, which are named in site order",
    () => {
      expect(explain(library(), "--why=helper")).toEqual({
        code: 2,
        out: "",
        err: [
          'deadset-ts: "helper" names no one symbol of the target',
          "  ts://@example/subjects/h1.ts#helper\th1.ts:1:10",
          "  ts://@example/subjects/h2.ts#helper\th2.ts:1:10",
          "",
        ].join("\n"),
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "names the declarations a request partially matches in ascending order",
    () => {
      expect(explain(library(), "--why=widget").err).toBe(
        [
          'deadset-ts: "widget" names no one symbol of the target',
          "  ts://@example/subjects/w.ts#alphaWidget\tw.ts:5:10",
          "  ts://@example/subjects/w.ts#betaWidget\tw.ts:9:10",
          "  ts://@example/subjects/w.ts#gammaWidget\tw.ts:1:10",
          "",
        ].join("\n"),
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "partially matches by the reference alone and by the name alone",
    () => {
      const tree = library();

      expect(explain(tree, "--why=subjects/w.ts#").err).toBe(
        [
          'deadset-ts: "subjects/w.ts#" names no one symbol of the target',
          "  ts://@example/subjects/w.ts#\tw.ts:1:1",
          "  ts://@example/subjects/w.ts#alphaWidget\tw.ts:5:10",
          "  ts://@example/subjects/w.ts#betaWidget\tw.ts:9:10",
          "  ts://@example/subjects/w.ts#gammaWidget\tw.ts:1:10",
          "",
        ].join("\n"),
      );
      expect(explain(tree, "--why=RenderP").err).toBe(
        [
          'deadset-ts: "RenderP" names no one symbol of the target',
          "  ts://@example/subjects/lib.ts#default\tlib.ts:1:25",
          "",
        ].join("\n"),
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "names at most twenty partial matches, the first in ascending order",
    () => {
      const lines = explain(library(), "--why=counted").err.split("\n").slice(1, -1);

      expect(lines).toEqual(
        Array.from({ length: 20 }, (_, i) => {
          const n = String(i).padStart(2, "0");
          return `  ts://@example/subjects/many.ts#counted${n}\tmany.ts:${String(4 * i + 1)}:17`;
        }),
      );
    },
    LOAD_TIMEOUT,
  );
});
