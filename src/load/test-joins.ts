/**
 * The test files a derived matrix holds although no configuration's file list names them.
 * The test runner compiles such a file with the options of the nearest compiler
 * configuration at or above it, so the file joins that configuration's program as a file
 * its list names, unless a `package.json` below that configuration's directory makes the
 * file another package's, which its own test runner compiles.
 */

import { sourcePaths } from "../file-facts.ts";
import type { Host } from "../host.ts";
import { ancestors, dirnamePath, joinPath } from "../paths.ts";
import { bytewise } from "../text/compare.ts";
import { holdsManifest } from "../fs/manifest.ts";
import type { Configuration } from "./discover.ts";
import type { ProgramPlan } from "./plan.ts";

const PREFERRED = "/tsconfig.json";

/** The configurations of one directory in the order a file joins them: `tsconfig.json` first. */
function byPreference(a: string, b: string): number {
  const first = a.endsWith(PREFERRED) ? 0 : 1;
  const second = b.endsWith(PREFERRED) ? 0 : 1;
  return first - second || bytewise(a, b);
}

/**
 * Per configuration of `configurations`, the absolute paths of the test files that join it:
 * each file below `root` a pattern of `patterns` names, that no configuration's file list
 * holds, joins the configuration nearest at or above its directory when no `package.json`
 * sits between them.
 */
export function joinedTestFiles(
  host: Host,
  root: string,
  configurations: readonly Configuration[],
  patterns: readonly RegExp[],
): ReadonlyMap<string, readonly string[]> {
  const listed = new Set<string>();
  const byDir = new Map<string, string[]>();
  for (const { configFile, parsed } of configurations) {
    parsed.fileNames.forEach((name) => listed.add(name));
    const dir = dirnamePath(configFile);
    byDir.set(dir, [...(byDir.get(dir) ?? []), configFile].sort(byPreference));
  }
  const joins = new Map<string, string[]>();
  for (const path of sourcePaths(host, root)) {
    const file = joinPath(root, path);
    if (listed.has(file) || !patterns.some((pattern) => pattern.test(path))) {
      continue;
    }
    for (const dir of ancestors(dirnamePath(file), root)) {
      const [nearest] = byDir.get(dir) ?? [];
      if (nearest !== undefined) {
        joins.set(nearest, [...(joins.get(nearest) ?? []), file]);
        break;
      }
      if (holdsManifest(host, dir)) {
        break;
      }
    }
  }
  return joins;
}

/**
 * The plans with each joined test file added to the configuration it joins: to a described
 * program's root files, or to the file list of a configuration only the snapshot holds, which
 * lists every file the configuration lists and the joined ones.
 */
export function joinedTests(
  plans: readonly ProgramPlan[],
  joins: ReadonlyMap<string, readonly string[]>,
): readonly ProgramPlan[] {
  return plans.map((plan): ProgramPlan => {
    const files = joins.get(plan.configFile);
    const { build } = plan;
    if (files === undefined) {
      return plan;
    }
    if (build.kind === "program") {
      return {
        ...plan,
        build: {
          kind: "program",
          params: { ...build.params, rootFiles: [...(build.params.rootFiles ?? []), ...files] },
        },
      };
    }
    const written = build.kind === "configuration" ? build.value : { extends: plan.configFile };
    return {
      ...plan,
      build: {
        kind: "configuration",
        value: { ...written, files: [...plan.parsed.fileNames, ...files], include: [] },
      },
    };
  });
}
