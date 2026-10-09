/**
 * The test files a derived matrix holds although no configuration's file list names them.
 * The test runner compiles such a file with the options of the nearest compiler
 * configuration at or above it, so the file joins that configuration's program as a file
 * its list names, unless a `package.json` below that configuration's directory makes the
 * file another package's, which its own test runner compiles.
 */

import { sourcePaths } from "./file-facts.ts";
import type { Host } from "./host.ts";
import { dirnamePath, joinPath, relativePath } from "./paths.ts";
import type { Engine } from "./session.ts";
import { writtenPath, type WorkspaceProgram } from "./workspace-programs.ts";

const PREFERRED = "/tsconfig.json";

/** The configurations of one directory in the order a file joins them: `tsconfig.json` first. */
function byPreference(a: string, b: string): number {
  const first = a.endsWith(PREFERRED) ? 0 : 1;
  const second = b.endsWith(PREFERRED) ? 0 : 1;
  return first - second || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Per configuration of `configFiles`, the absolute paths of the test files that join it:
 * each file below `root` a pattern of `patterns` names, that no configuration's file list
 * holds, joins the configuration nearest at or above its directory when no `package.json`
 * sits between them. A configuration the compiler cannot read lists nothing and is joined
 * by nothing.
 */
export function joinedTestFiles(
  engine: Engine,
  host: Host,
  root: string,
  configFiles: readonly string[],
  patterns: readonly RegExp[],
): ReadonlyMap<string, readonly string[]> {
  const listed = new Set<string>();
  const byDir = new Map<string, string[]>();
  for (const configFile of configFiles) {
    let fileNames: readonly string[];
    try {
      fileNames = engine.parseConfigFile(configFile).fileNames;
    } catch {
      continue;
    }
    fileNames.forEach((name) => listed.add(name));
    const dir = dirnamePath(configFile);
    byDir.set(dir, [...(byDir.get(dir) ?? []), configFile].sort(byPreference));
  }
  const joins = new Map<string, string[]>();
  for (const path of sourcePaths(host, root)) {
    const file = joinPath(root, path);
    if (listed.has(file) || !patterns.some((pattern) => pattern.test(path))) {
      continue;
    }
    for (let dir = dirnamePath(file); ; dir = dirnamePath(dir)) {
      const [nearest] = byDir.get(dir) ?? [];
      if (nearest !== undefined) {
        joins.set(nearest, [...(joins.get(nearest) ?? []), file]);
        break;
      }
      if (
        host.kindOf(joinPath(dir, "package.json")) === "file" ||
        dir === root ||
        relativePath(root, dir) === undefined
      ) {
        break;
      }
    }
  }
  return joins;
}

/**
 * How the snapshot reads each configuration a test file joins: the program `programs`
 * describes with the files added to its root files, or a configuration only the snapshot
 * holds that extends the one `programs` writes, or the configuration itself, and lists
 * every file the configuration lists and the joined ones.
 */
export function withJoinedTests(
  engine: Engine,
  host: Host,
  programs: ReadonlyMap<string, WorkspaceProgram>,
  joins: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, WorkspaceProgram> {
  const found = new Map(programs);
  for (const [configFile, files] of joins) {
    const program = programs.get(configFile);
    if (program?.kind === "program") {
      found.set(configFile, {
        kind: "program",
        params: {
          ...program.params,
          rootFiles: [...(program.params.rootFiles ?? []), ...files],
        },
      });
      continue;
    }
    let listed: readonly string[];
    try {
      listed =
        program?.kind === "configuration"
          ? engine.parseConfigJson(JSON.parse(program.text), program.file).fileNames
          : engine.parseConfigFile(configFile).fileNames;
    } catch {
      continue;
    }
    const value =
      program?.kind === "configuration"
        ? { ...(JSON.parse(program.text) as Record<string, unknown>), files: [...listed, ...files] }
        : { extends: configFile, files: [...listed, ...files] };
    found.set(configFile, {
      kind: "configuration",
      file: program?.kind === "configuration" ? program.file : writtenPath(host, configFile),
      text: `${JSON.stringify({ ...value, include: [] }, null, 2)}\n`,
    });
  }
  return found;
}
