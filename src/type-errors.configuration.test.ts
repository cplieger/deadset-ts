import { rmSync } from "node:fs";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { runAnalysis } from "./analysis.ts";
import { resolve } from "./resolve.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine } from "./session.ts";

const LOAD_TIMEOUT = 60_000;

/** The type-error skips and the findings of one application run over `files`. */
function analyzed(files: Readonly<Record<string, string>>) {
  const root = writeProject(files);
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const host = nodeHost();
  const { config, provenance } = resolve({
    repository: JSON.stringify({
      target: { kind: "application" },
      analysis: { min_confidence: "possible" },
      ts: { entry_files: ["app/main.ts"] },
    }),
    repositoryLabel: "deadset.json",
  });
  const analysis = runAnalysis(
    openEngine({ collectTiming: false }),
    host,
    scopeForDir(host, root),
    config,
    provenance,
    { production: true },
  );
  return {
    skips: analysis.run.typeErrorSkips,
    findings: analysis.result.findings.map((one) => `${one.code} ${one.symbol.name}`).sort(),
  };
}

describe("a diagnostic about where the configuration places a file", () => {
  it(
    "skips no statement, so a file outside rootDir is judged as any other",
    () => {
      const got = analyzed({
        "package.json": '{ "name": "app", "private": true, "type": "module" }\n',
        "tsconfig.json":
          '{ "compilerOptions": { "strict": true, "module": "esnext", "moduleResolution": "bundler", "rootDir": "app", "outDir": "out" }, "include": ["app"] }\n',
        "app/main.ts": 'import { run } from "../lib/run.js";\n\nrun();\n',
        "lib/run.ts":
          'import { two, spare } from "./values.js";\n\nexport function run(): number {\n  return two;\n}\n',
        "lib/values.ts": "export const two = 2;\nexport const spare = 3;\n",
      });

      expect(got.skips).toEqual([]);
      expect(got.findings).toContain("DS1004 spare");
    },
    LOAD_TIMEOUT,
  );
});
