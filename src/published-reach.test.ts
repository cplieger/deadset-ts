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

/** The report one `analyze` run over `files` writes, every finding at `possible` shown. */
function analyzed(files: Readonly<Record<string, string>>): {
  findings: { code: string; symbol: { name: string }; confidence: string }[];
  unanswered_questions: unknown[];
} {
  const root = writeProject(files);
  roots.push(root);
  const dir = mkdtempSync(join(tmpdir(), "deadset-ts-published-reach-"));
  roots.push(dir);
  const report = join(dir, "report.json");
  run(
    ["analyze", "--target=.", "--min-confidence=possible", `--report=${report}`],
    DISCARD,
    DISCARD,
    {
      ...nodeHost(),
      workingDirectory: () => root,
    },
  );
  return JSON.parse(readFileSync(report, "utf8")) as ReturnType<typeof analyzed>;
}

/** Each finding as `code name confidence`. */
function lines(report: ReturnType<typeof analyzed>): string[] {
  return report.findings.map((one) => `${one.code} ${one.symbol.name} ${one.confidence}`);
}

describe("the types a library's published API reaches without writing them", () => {
  it("reaches the type the compiler infers for a published function's result and a published variable", () => {
    const report = analyzed({
      "package.json": JSON.stringify({
        name: "@example/lib",
        type: "module",
        exports: "./src/index.ts",
      }),
      "deadset.json": JSON.stringify({ target: { kind: "library" } }),
      "src/index.ts": [
        "class Made {",
        "  spare = 1;",
        "}",
        "class Held {",
        "  idle = 2;",
        "}",
        "export function make() {",
        "  return [new Made()];",
        "}",
        "export const held = new Held();",
        "",
      ].join("\n"),
    });

    expect(lines(report)).toEqual([
      "DS1003 Made.spare possible",
      "DS1003 Held.idle possible",
      "DS1001 make possible",
      "DS1001 held possible",
    ]);
  });
});

describe("the default a dynamic import of a module that assigns its export carries", () => {
  it("is resolved through the alias the checker synthesizes, leaving no question unanswered", () => {
    const report = analyzed({
      "package.json": JSON.stringify({
        name: "@example/app",
        type: "module",
        main: "./src/main.ts",
        dependencies: { prompts: "1.0.0" },
      }),
      "deadset.json": JSON.stringify({ target: { kind: "application" } }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          module: "ESNext",
          moduleResolution: "Bundler",
          esModuleInterop: true,
          noEmit: true,
        },
        include: ["src"],
      }),
      "node_modules/prompts/package.json": JSON.stringify({ name: "prompts", types: "index.d.ts" }),
      "node_modules/prompts/index.d.ts": [
        "declare function prompts(question: string): Promise<string>;",
        "declare namespace prompts {",
        "  const version: string;",
        "}",
        "export = prompts;",
        "",
      ].join("\n"),
      "src/main.ts":
        'const prompts = await import("prompts");\n\nawait prompts.default("name?");\n',
    });

    expect(report.unanswered_questions).toEqual([]);
    expect(lines(report)).toEqual([]);
  });
});
