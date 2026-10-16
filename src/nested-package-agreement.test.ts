import { cpSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { runAnalysis } from "./analysis.ts";
import { resolve } from "./resolve.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine } from "./session.ts";

/** A copy of the corpus tree whose root holds no manifest and whose packages are nested. */
const root = mkdtempSync(join(tmpdir(), "deadset-ts-nested-"));
cpSync(fixture("corpus", "nested-package-without-root-manifest", "ts"), root, { recursive: true });
renameSync(join(root, "installed"), join(root, "node_modules"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Each finding of one run at `dir`, as its path below `under`, its line, code and confidence. */
function findingsAt(dir: string, under: string): string[] {
  const host = nodeHost();
  const { config, provenance } = resolve({
    repository: {
      text: JSON.stringify({
        target: { kind: "application" },
        analysis: { min_confidence: "possible" },
      }),
      label: "deadset.json",
    },
  });
  const target = join(root, "target", dir);
  const { result, run } = runAnalysis(
    openEngine({ collectTiming: false }),
    host,
    scopeForDir(host, target),
    config,
    provenance,
    { production: true },
  );
  const prefix = under === "" ? "" : `${under}/`;
  return [
    ...result.findings
      .filter((one) => one.position.path.startsWith(prefix))
      .map(
        (one) =>
          `${one.position.path.slice(prefix.length)}:${String(one.position.line)} ${one.code} ${one.confidence}`,
      ),
    ...run.conventionsApplied
      .filter((one) => one.manifest.startsWith(prefix))
      .map((one) => `${one.manifest.slice(prefix.length)} applies ${one.name}`),
  ].sort();
}

/** The bound on one case, which analyses a whole fixture target. */
const LOAD_TIMEOUT = 60_000;

describe("a nested package", () => {
  const atRoot = findingsAt("", "web");

  it(
    "gets every row and finding at the root that a run at the package gets",
    { timeout: LOAD_TIMEOUT },
    () => {
      expect(atRoot).toEqual(findingsAt("web", ""));
      expect(atRoot).toContain("package.json:11 DS1701 certain");
      expect(atRoot).toContain("package.json applies vitest");
    },
  );

  it(
    "differs only by what the root alone holds: a workflow step running a package's tool",
    { timeout: LOAD_TIMEOUT },
    () => {
      expect(findingsAt("", "tools")).toEqual([]);
      expect(findingsAt("tools", "")).toEqual(["package.json:8 DS1701 certain"]);
    },
  );
});
