import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { TSCONFIG, writeProject } from "../__test-helpers__/projects.ts";
import { runRoots, runSweeps } from "./analysis.ts";
import { resolve } from "./resolve.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine } from "./session.ts";

describe("the projects a run composes", () => {
  it("are the ones the matrix declares, each named by its declared identifier", () => {
    // A project that does not type-check fails the run if anything opens it, so the
    // run reads the declared matrix or it fails.
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
      const swept = runSweeps(openEngine({ collectTiming: false }), host, scope, config, {
        marked: [],
        mode: { production: true },
      });

      expect(rooted.configurations, "the root set's configurations").toEqual(["app"]);
      expect(
        swept.map((one) => one.configuration),
        "the sweeps' configurations",
      ).toEqual(["app"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
