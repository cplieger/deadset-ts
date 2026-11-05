import type { ParseFile } from "./configuration-files.ts";
import { membersNamed, staticModule, textsOf } from "./static-module.ts";
import { holdsManifest } from "../fs/manifest.ts";
import type { Host } from "../host.ts";
import { ancestors, dirnamePath, joinPath, resolvePath } from "../paths.ts";

/** The directories a tool run over one file starts from, read before any of its loads is resolved. */
export interface RunDirectories {
  /**
   * The directory a package manager runs the scripts of the file's package in, the package's
   * root (https://docs.npmjs.com/cli/v11/using-npm/scripts#best-practices): the nearest
   * directory at or above the file, up to the run's top, holding a manifest, else the top.
   */
  workingDirectoryOf(fileName: string): string;
  /**
   * The bundler's project root a `/` glob is read against
   * (https://vite.dev/guide/features.html#glob-import): the directory of the nearest bundler
   * configuration at or above the file, moved by a literal `root` it writes, else the
   * working directory. Undefined where a configuration there may move it to a place its
   * text does not state.
   */
  bundlerRootOf(fileName: string): string | undefined;
}

/** The configuration file names the bundler and its test runner read their root from. */
const BUNDLER_CONFIGS = ["vite.config", "vitest.config"].flatMap((stem) =>
  ["js", "mjs", "cjs", "ts", "mts", "cts"].map((extension) => `${stem}.${extension}`),
);

/**
 * The root the configurations of one directory state: the directory where none writes a
 * `root`, the one literal they all write, or undefined where one cannot be read, writes a
 * value that is not a literal, or two disagree.
 */
function statedRoot(
  host: Host,
  parse: ParseFile,
  dir: string,
  configs: readonly string[],
): string | undefined {
  const roots = new Set<string>();
  for (const name of configs) {
    const path = joinPath(dir, name);
    let text: string;
    try {
      text = host.readFile(path);
    } catch {
      return undefined;
    }
    const objects = staticModule(parse(path, text)).defaultExport;
    if (objects.length === 0) {
      return undefined;
    }
    for (const object of objects) {
      const values = object.kind === "object" ? membersNamed(object, "root") : undefined;
      if (values === undefined) {
        return undefined;
      }
      for (const value of values) {
        const [root] = textsOf(value, false) ?? [];
        if (root === undefined) {
          return undefined;
        }
        roots.add(resolvePath(dir, root));
      }
    }
  }
  if (roots.size > 1) {
    return undefined;
  }
  return [...roots][0] ?? dir;
}

/** The directories of one run below `top`, each read once per directory. */
export function runDirectories(host: Host, top: string, parse: ParseFile): RunDirectories {
  const working = new Map<string, string>();
  const bundler = new Map<string, string | undefined>();
  const workingDirectoryOf = (fileName: string): string => {
    const dir = dirnamePath(fileName);
    let found = working.get(dir);
    if (found === undefined) {
      found = ancestors(dir, top).find((at) => holdsManifest(host, at)) ?? top;
      working.set(dir, found);
    }
    return found;
  };
  return {
    workingDirectoryOf,
    bundlerRootOf: (fileName) => {
      const dir = dirnamePath(fileName);
      if (bundler.has(dir)) {
        return bundler.get(dir);
      }
      let found: string | undefined = workingDirectoryOf(fileName);
      for (const at of ancestors(dir, top)) {
        const configs = BUNDLER_CONFIGS.filter(
          (name) => host.kindOf(joinPath(at, name)) === "file",
        );
        if (configs.length > 0) {
          found = statedRoot(host, parse, at, configs);
          break;
        }
      }
      bundler.set(dir, found);
      return found;
    },
  };
}
