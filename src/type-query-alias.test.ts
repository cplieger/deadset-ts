import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { emitterInputOf } from "../__test-helpers__/emitter-input.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { runRoots } from "./analysis.ts";
import { findingsOf } from "./findings/emitters.ts";
import { resolve } from "./resolve.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine } from "./session.ts";

const TARGET = fixture("projects", "type-query-alias");

const CONFIG = ((): ReturnType<typeof resolve> => {
  const document = join(TARGET, "deadset.json");
  return resolve({ repository: readFileSync(document, "utf8"), repositoryLabel: document });
})();

/** Every finding of the fixture's production sweep, as `code path:line name`. */
const FINDINGS = findingsOf(emitterInputOf(TARGET, CONFIG.config)).map(
  (finding) =>
    `${finding.code} ${finding.position.path}:${String(finding.position.line)} ${finding.symbol.name}`,
);

/** Every root of the fixture, as `ref kind`. */
const ROOTS = ((): string[] => {
  const host = nodeHost();
  return runRoots(
    openEngine({ collectTiming: false }),
    host,
    scopeForDir(host, TARGET),
    CONFIG.config,
    CONFIG.provenance,
  ).roots.map((root) => `${root.ref.replace(/^.*\//u, "")} ${root.kind}`);
})();

describe("a global a declaration file declares as an alias of a module's export", () => {
  it("is used where the global is, through the indexed and the qualified form alike", () => {
    expect(
      FINDINGS.filter((line) => / (useIndexed|useQualified|useScript|useAugmented)$/u.test(line)),
    ).toEqual([]);
  });

  it("is used through every link of a re-export chain the alias names", () => {
    expect(FINDINGS.filter((line) => / (viaReexport|inner)$/u.test(line))).toEqual([]);
  });

  it("is not used by the alias's own type query, in either form", () => {
    expect(FINDINGS.filter((line) => line.startsWith("DS1001 counter.ts"))).toEqual([
      "DS1001 counter.ts:13 unusedIndexed",
      "DS1001 counter.ts:17 unusedQualified",
      "DS1001 counter.ts:21 useInSource",
    ]);
  });

  it("is reported by nothing, nor is a module declaration around it", () => {
    expect(FINDINGS.filter((line) => / ([a-z-]*globals|augment)\.d\.ts:/u.test(line))).toEqual([]);
  });

  it("is a root with every module declaration around it, at a script's top level too", () => {
    expect([...new Set(ROOTS.filter((line) => line.endsWith(" type-query-alias")))]).toEqual([
      "augment.d.ts#'example-ambient' type-query-alias",
      "augment.d.ts#'example-ambient'.global type-query-alias",
      "augment.d.ts#'example-ambient'.global.useAugmented type-query-alias",
      "globals.d.ts#global type-query-alias",
      "globals.d.ts#global.useIndexed type-query-alias",
      "globals.d.ts#global.useQualified type-query-alias",
      "globals.d.ts#global.viaReexport type-query-alias",
      "globals.d.ts#global.unusedIndexed type-query-alias",
      "globals.d.ts#global.unusedQualified type-query-alias",
      "script-globals.d.ts#useScript type-query-alias",
    ]);
  });

  it("is no alias when a source file that is no declaration file declares it", () => {
    expect(ROOTS.filter((line) => line.startsWith("source-globals.ts"))).toEqual([]);
    expect(FINDINGS).toContain("DS1001 counter.ts:21 useInSource");
  });
});
