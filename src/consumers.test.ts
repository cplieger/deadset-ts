import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { TSCONFIG } from "../__test-helpers__/projects.ts";
import type { Host } from "./host.ts";
import { run, type Writer } from "./run.ts";
import { EXIT_CLEAN, EXIT_FAILURE, EXIT_FINDINGS } from "./verbs/verb.ts";

/** The bound on one case, each of which loads a target and its consumers. */
const LOAD_TIMEOUT = 60_000;

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

/** A manifest naming one package, which is the name a report gives its module. */
function manifest(name: string, main?: string): string {
  return `${JSON.stringify({
    name,
    private: true,
    version: "0.0.0",
    type: "module",
    ...(main === undefined ? {} : { main }),
  })}\n`;
}

/** A target library at `target/` and the files beside it, written below a fresh directory. */
function workspace(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "deadset-ts-consumers-"));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const written: Record<string, string> = {
    "target/tsconfig.json": TSCONFIG,
    "target/package.json": manifest("@example/target", "./lib.ts"),
    "target/deadset.json": '{ "target": { "kind": "library" } }\n',
    "consumer/tsconfig.json": TSCONFIG,
    "consumer/package.json": manifest("@example/consumer"),
    ...files,
  };
  for (const [path, text] of Object.entries(written)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** One finished run: its exit code, its error stream, and the report it wrote, if any. */
interface Analyzed {
  readonly code: number;
  readonly err: string;
  readonly report: Record<string, unknown> | undefined;
}

/** Runs `analyze` from the workspace root over the scope naming `target` and its consumers. */
function analyze(root: string, consumers: readonly string[] = ["consumer"]): Analyzed {
  writeFileSync(
    join(root, "scope.json"),
    JSON.stringify({ target: { path: "target" }, consumers: consumers.map((path) => ({ path })) }),
  );
  const host: Host = {
    ...nodeHost(),
    workingDirectory: () => root,
    analyzerVersion: () => "0.0.0",
  };
  const err = new MemoryWriter();
  const reportPath = join(root, "report.json");
  const code = run(
    ["analyze", "--target=target", "--scope=scope.json", `--report=${reportPath}`],
    new MemoryWriter(),
    err,
    host,
  );
  const report = existsSync(reportPath)
    ? (JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>)
    : undefined;
  return { code, err: err.text, report };
}

/** Each finding as its code, its subject's name and its confidence. */
function claims(report: Record<string, unknown> | undefined): string[] {
  const findings = (report?.["findings"] ?? []) as {
    readonly code: string;
    readonly symbol: { readonly name: string };
    readonly confidence: string;
  }[];
  return findings.map((one) => `${one.code} ${one.symbol.name} ${one.confidence}`);
}

describe("a consumer the scope declares", () => {
  it(
    "keeps the export it references live and classes the one nothing references certain",
    () => {
      const root = workspace({
        "target/lib.ts":
          "export function dead(): number {\n  return 1;\n}\n\nexport function used(): number {\n  return 2;\n}\n",
        "consumer/main.ts": 'import { used } from "../target/lib.js";\n\nused();\n',
      });

      const analyzed = analyze(root);

      expect(analyzed.code).toBe(EXIT_FINDINGS);
      expect(claims(analyzed.report)).toEqual(["DS1001 dead certain"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is named in every finding and in the report's consumer set, by its package name and directory",
    () => {
      const root = workspace({
        "target/lib.ts": "export function dead(): number {\n  return 1;\n}\n",
        "consumer/main.ts": 'import "../target/lib.js";\n',
      });

      const { report } = analyze(root);
      const findings = (report?.["findings"] ?? []) as { readonly consumers_loaded: string[] }[];

      expect(findings.map((one) => one.consumers_loaded)).toEqual([["@example/consumer"]]);
      expect(report?.["consumers"]).toEqual({
        declared: 1,
        loaded: [{ id: "@example/consumer", role: "consumer", path: "consumer" }],
        unavailable: [],
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "reaches on from what it references, through a file no manifest export reaches",
    () => {
      const root = workspace({
        "target/lib.ts": "export const version = 1;\n",
        "target/extra.ts":
          "export function entry(): number {\n  return helper();\n}\n\nfunction helper(): number {\n  return 1;\n}\n",
        "consumer/main.ts":
          'import { version } from "../target/lib.js";\nimport { entry } from "../target/extra.js";\n\nentry();\nconsole.log(version);\n',
      });

      const analyzed = analyze(root);

      expect(claims(analyzed.report)).toEqual([]);
      expect(analyzed.code).toBe(EXIT_CLEAN);
    },
    LOAD_TIMEOUT,
  );

  it(
    "keeps the file whose namespace it reads, and reaches on through what that module exports",
    () => {
      const root = workspace({
        "target/lib.ts": "export const version = 1;\n",
        "target/extra.ts":
          "export function entry(): number {\n  return helper();\n}\n\nfunction helper(): number {\n  return 1;\n}\n",
        "consumer/main.ts":
          'import { version } from "../target/lib.js";\nimport * as extra from "../target/extra.js";\n\nconsole.log(version, extra);\n',
      });

      // A namespace read references no export by name, so the export itself counts no
      // reference, as a namespace read inside the target counts none.
      expect(claims(analyze(root).report)).toEqual(["DS1001 entry certain"]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "counts none of the target's own files as its own when its directory holds the target",
    () => {
      const root = workspace({
        "tsconfig.json": TSCONFIG,
        "package.json": manifest("@example/workspace"),
        "target/lib.ts": "export const version = 1;\n",
        "target/extra.ts":
          "export function dead(): number {\n  return deadCaller();\n}\n\nfunction deadCaller(): number {\n  return 1;\n}\n",
        "main.ts":
          'import { version } from "./target/lib.js";\nimport "./target/extra.js";\n\nconsole.log(version);\n',
        "consumer/main.ts": "export const unrelated = 1;\n",
      });

      expect(claims(analyze(root, ["."]).report)).toEqual([
        "DS1001 dead certain",
        "DS1002 deadCaller certain",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "counts a reference from its test file as a test reference, which holds nothing it calls live",
    () => {
      const root = workspace({
        "target/lib.ts": "export const version = 1;\n",
        "target/extra.ts":
          "export function onlyTested(): number {\n  return helper();\n}\n\nfunction helper(): number {\n  return 1;\n}\n",
        "consumer/main.ts":
          'import { version } from "../target/lib.js";\n\nconsole.log(version);\n',
        "consumer/extra.test.ts":
          'import { onlyTested } from "../target/extra.js";\n\nonlyTested();\n',
      });

      expect(claims(analyze(root).report)).toEqual([
        "DS1004 onlyTested certain",
        "DS1002 helper certain",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "counts a reference from its test file as a production one where the configuration says so",
    () => {
      const root = workspace({
        "target/deadset.json":
          '{ "target": { "kind": "library" }, "analysis": { "consumer_tests": "production" } }\n',
        "target/lib.ts": "export function onlyTested(): number {\n  return 1;\n}\n",
        "consumer/lib.test.ts": 'import { onlyTested } from "../target/lib.js";\n\nonlyTested();\n',
      });

      expect(claims(analyze(root).report)).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "keeps a member it writes from the write-only kind, whose write positions a report names in the target alone",
    () => {
      const root = workspace({
        "target/lib.ts": "export class Settings {\n  level?: number;\n}\n",
        "consumer/main.ts":
          'import { Settings } from "../target/lib.js";\n\nnew Settings().level = 3;\n',
      });

      expect(claims(analyze(root).report)).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a consumer the run cannot load", () => {
  it(
    "ends the run with the failure code naming a path that does not exist, and writes no report",
    () => {
      const root = workspace({ "target/lib.ts": "export const used = 1;\n" });

      const analyzed = analyze(root, ["missing"]);

      expect(analyzed.code).toBe(EXIT_FAILURE);
      expect(analyzed.err).toMatch(
        new RegExp(`^setup failure: missing-consumer: .*${join(root, "missing")}`, "mu"),
      );
      expect(analyzed.report).toBeUndefined();
    },
    LOAD_TIMEOUT,
  );

  it(
    "ends the run with the failure code when the consumer holds no compiler configuration",
    () => {
      const root = workspace({ "target/lib.ts": "export const used = 1;\n" });
      rmSync(join(root, "consumer", "tsconfig.json"));

      const analyzed = analyze(root);

      expect(analyzed.code).toBe(EXIT_FAILURE);
      expect(analyzed.err).toContain("holds no compiler configuration");
      expect(analyzed.report).toBeUndefined();
    },
    LOAD_TIMEOUT,
  );

  it(
    "ends the run with the failure code naming the consumer whose dependencies are not installed",
    () => {
      const root = workspace({
        "target/lib.ts": "export const used = 1;\n",
        "consumer/package.json": `${JSON.stringify({
          name: "@example/consumer",
          private: true,
          type: "module",
          dependencies: { "@example/absent": "1.0.0" },
        })}\n`,
        "consumer/main.ts":
          'import { used } from "../target/lib.js";\nimport { pad } from "@example/absent";\n\nconsole.log(pad(used));\n',
      });

      const analyzed = analyze(root);

      expect(analyzed.code).toBe(EXIT_FAILURE);
      expect(analyzed.err).toMatch(
        new RegExp(
          `^setup failure: missing-consumer: .*${join(root, "consumer")}.*@example/absent`,
          "mu",
        ),
      );
      expect(analyzed.report).toBeUndefined();
    },
    LOAD_TIMEOUT,
  );

  it(
    "counts the references of a consumer whose program carries a type error",
    () => {
      const root = workspace({
        "target/lib.ts": "export const used = 1;\n",
        "consumer/main.ts": 'import { used } from "../target/lib.js";\n\nconst n: string = used;\n',
      });

      const analyzed = analyze(root);

      expect(analyzed.code).toBe(EXIT_CLEAN);
      expect(claims(analyzed.report)).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});
