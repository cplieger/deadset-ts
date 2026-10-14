import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { run, type Writer } from "./run.ts";

const DISCARD: Writer = { write: () => undefined };

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Analyzed {
  readonly findings: readonly { code: string; symbol: { name: string }; confidence: string }[];
  readonly notes: readonly unknown[];
}

/**
 * The report of an application with `ts.roots_complete` set whose entry loads a module by
 * `load`, after `preamble`, beside a file nothing imports holding a function only a dead one calls.
 */
function analyzed(load: string, preamble = ""): Analyzed {
  const root = writeProject({
    "package.json": JSON.stringify({ name: "@example/app", private: true, main: "./src/main.ts" }),
    "deadset.json": JSON.stringify({
      target: { kind: "application" },
      ts: { roots_complete: true },
    }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, module: "esnext", target: "es2022" },
      include: ["src"],
    }),
    "src/main.ts": `${preamble}export async function start(name: string): Promise<unknown> {\n  return ${load};\n}\n\nvoid start("a");\n`,
    "src/commands/a.ts": "export const command = 1;\n",
    "src/dead.ts":
      "export function outer(): number {\n  return inner();\n}\n\nfunction inner(): number {\n  return 2;\n}\n",
  });
  roots.push(root);
  const dir = mkdtempSync(join(tmpdir(), "deadset-ts-unseen-loads-"));
  roots.push(dir);
  const report = join(dir, "report.json");
  run(
    ["analyze", "--target=.", "--min-confidence=possible", `--report=${report}`],
    DISCARD,
    DISCARD,
    { ...nodeHost(), workingDirectory: () => root },
  );
  return JSON.parse(readFileSync(report, "utf8")) as Analyzed;
}

/** The confidence of the finding about `name`. */
function confidenceOf(report: Analyzed, name: string): string | undefined {
  return report.findings.find((finding) => finding.symbol.name === name)?.confidence;
}

describe("a load whose target the analysis cannot resolve", () => {
  it("caps what only dead code reaches at probable although the roots are declared complete", () => {
    const report = analyzed("import(`./${name}`)");

    expect(confidenceOf(report, "inner")).toBe("probable");
    expect(confidenceOf(report, "outer")).toBe("certain");
  });

  it("is noted at its site", () => {
    expect(analyzed("import(name)").notes).toEqual([
      {
        kind: "computed-load",
        path: "src",
        message:
          "src/main.ts:2:10 loads a module by a computed path the analysis cannot resolve, so the configurations compiling it report what no root reaches at probable at most, whatever ts.roots_complete says",
      },
    ]);
  });

  it("lowers nothing where its literal start names a directory the entry rules root", () => {
    const report = analyzed("import(`./commands/${name}`)");

    expect(confidenceOf(report, "inner")).toBe("certain");
    expect(report.notes).toEqual([]);
  });

  it("lowers nothing where its literal start names a package", () => {
    const report = analyzed("import(`@example/plugin-${name}`)");

    expect(confidenceOf(report, "inner")).toBe("certain");
    expect(report.notes).toEqual([]);
  });

  it("lowers nothing where `require` is a function of the project's own", () => {
    const report = analyzed(
      "require(name)",
      "function require(path: string): string {\n  return path;\n}\n\n",
    );

    expect(confidenceOf(report, "inner")).toBe("certain");
    expect(report.notes).toEqual([]);
  });

  it("caps what only dead code reaches where `require` is no declaration of the project's", () => {
    const report = analyzed("require(name)");

    expect(confidenceOf(report, "inner")).toBe("probable");
  });
});
