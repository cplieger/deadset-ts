import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { TSCONFIG, writeProject } from "../__test-helpers__/projects.ts";
import { runRoots, runSweep, unansweredCounts, type RunAnalysis } from "./analysis.ts";
import { resolve } from "./resolve.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine } from "./session.ts";

describe("the projects a run composes", () => {
  it("are the ones the matrix declares, each named by its declared identifier", () => {
    // A derived run would open the second project too, so naming one configuration shows
    // the run reads the declared matrix.
    const root = writeProject({
      "tsconfig.json": TSCONFIG.replace('"**/*.ts"', '"src/**/*.ts"'),
      "src/main.ts": "export const value = 1;\n",
      "broken/tsconfig.json": TSCONFIG,
      "broken/broken.ts": "export const wrong: number = 'text';\n",
    });
    try {
      const { config, provenance } = resolve({
        repository: JSON.stringify({
          target: { kind: "application" },
          analysis: { configurations: [{ id: "app", project: "tsconfig.json" }] },
        }),
        repositoryLabel: "deadset.json",
      });
      const host = nodeHost();
      const scope = scopeForDir(host, root);
      const rooted = runRoots(
        openEngine({ collectTiming: false }),
        host,
        scope,
        config,
        provenance,
      );
      const swept = runSweep(openEngine({ collectTiming: false }), host, scope, config, {
        marked: [],
        mode: { production: true },
      });

      expect(rooted.configurations, "the root set's configurations").toEqual(["app"]);
      expect(swept.matrix.configurations, "the sweep's configurations").toEqual(["app"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skip the statement a type error is in and analyze every project", () => {
    const root = writeProject({
      "tsconfig.json": TSCONFIG.replace('"**/*.ts"', '"src/**/*.ts"'),
      "src/main.ts": "export const value = 1;\n",
      "broken/tsconfig.json": TSCONFIG,
      "broken/broken.ts": "export const wrong: number = 'text';\n",
    });
    try {
      const { config } = resolve({
        repository: JSON.stringify({
          target: { kind: "application" },
          analysis: {
            configurations: [
              { id: "app", project: "tsconfig.json" },
              { id: "broken", project: "broken/tsconfig.json" },
            ],
          },
        }),
        repositoryLabel: "deadset.json",
      });
      const host = nodeHost();
      const swept = runSweep(
        openEngine({ collectTiming: false }),
        host,
        scopeForDir(host, root),
        config,
        { marked: [], mode: { production: true } },
      );
      const dead = swept.sweep.candidates.map(
        (candidate) => swept.matrix.union.symbols[swept.matrix.union.at(candidate.id)]?.name,
      );

      expect(swept.matrix.configurations).toEqual(["app", "broken"]);
      expect(dead).toEqual(["value"]);
      expect(swept.skipped).toEqual([{ path: "broken/broken.ts", fromLine: 1, toLine: 1 }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the unanswered-question counts of a run", () => {
  it("are one per configuration the checker failed in, counting its questions and its own held declarations", () => {
    const symbol = (id: string): { id: string } => ({ id });
    // A fake of the slice of a run the counts read: two projects, questions in one of them.
    const analysis = {
      run: {
        projects: [
          { id: "app", configFile: "/t/tsconfig.json" },
          { id: "tools", configFile: "/t/tools/tsconfig.json" },
        ],
        unanswered: [
          { configFile: "/t/tsconfig.json", accessor: "typeAt", location: "a.ts:1" },
          { configFile: "/t/tsconfig.json", accessor: "symbolAt", location: "a.ts:9" },
        ],
      },
      swept: { heldByUnanswered: ["a#held", "a#also", "tools#held"] },
      configured: [
        { configuration: "app", symbols: [symbol("a#held"), symbol("a#also"), symbol("a#free")] },
        { configuration: "tools", symbols: [symbol("tools#held")] },
      ],
    } as unknown as RunAnalysis;

    expect(unansweredCounts(analysis)).toEqual([
      { configuration: "app", questions: 2, declarations: 2 },
    ]);
  });
});
