/**
 * The target's own source files of one project, looked up the ways a path written
 * in a document or a string names one: as the file itself, or as a file the
 * compiler emits from it.
 */

import type { SourceFile } from "@typescript/native/unstable/ast";
import { dirnamePath, joinPath, relativePath, resolvePath } from "./paths.ts";
import type { ProjectView } from "./session.ts";

/** The source extensions the compiler emits each output extension from. */
const EMITTED: readonly { readonly emitted: string; readonly sources: readonly string[] }[] = [
  { emitted: ".d.ts", sources: [".ts", ".tsx"] },
  { emitted: ".d.mts", sources: [".mts"] },
  { emitted: ".d.cts", sources: [".cts"] },
  { emitted: ".js", sources: [".ts", ".tsx"] },
  { emitted: ".jsx", sources: [".tsx"] },
  { emitted: ".mjs", sources: [".mts"] },
  { emitted: ".cjs", sources: [".cts"] },
];

/** The one character a subpath pattern of a manifest's `exports` holds. */
const SUBPATH_WILDCARD = "*";

/** One path with its extension replaced, where it carries the one named. */
function reExtended(path: string, emitted: string, source: string): string | undefined {
  return path.endsWith(emitted) ? path.slice(0, path.length - emitted.length) + source : undefined;
}

/**
 * The longest directory every path shares, which is the directory the compiler
 * emits from where the configuration declares no root directory.
 */
function commonDirectory(paths: readonly string[]): string {
  const first = paths[0];
  if (first === undefined) {
    return "";
  }
  let common = dirnamePath(first).split("/");
  for (const path of paths.slice(1)) {
    const segments = dirnamePath(path).split("/");
    let shared = 0;
    while (
      shared < common.length &&
      shared < segments.length &&
      common[shared] === segments[shared]
    ) {
      shared += 1;
    }
    common = common.slice(0, shared);
  }
  return common.join("/");
}

/**
 * Whether one path is what a subpath pattern stands for: the text before the
 * wildcard, any run of characters including the solidus, then the text after it.
 */
function matchesSubpath(pattern: string, path: string): boolean {
  const at = pattern.indexOf(SUBPATH_WILDCARD);
  const before = pattern.slice(0, at);
  const after = pattern.slice(at + SUBPATH_WILDCARD.length);
  return (
    path.length >= before.length + after.length && path.startsWith(before) && path.endsWith(after)
  );
}

/** One project's own source files, and the lookups a written path is resolved through. */
export interface SourceFiles {
  /** Every own file, by its path below the target root, in the order the program holds them. */
  readonly byPath: ReadonlyMap<string, SourceFile>;
  /** Every own file, by the absolute path the program names it by. */
  readonly byName: ReadonlyMap<string, SourceFile>;
  /**
   * The own files one absolute path names: the file at that path, or the source the
   * project would emit a file at that path from. A path holding the wildcard of a
   * subpath pattern names every file it stands for. A path no rule reaches names
   * nothing.
   */
  named(path: string): readonly SourceFile[];
}

/**
 * The lookups over one project's own files.
 *
 * A path that names an emitted file is read back to the source the project would
 * emit it from through the project's own emit mapping and nothing else: the
 * extension is one the compiler emits from a source extension, and a path below the
 * output directory is read below the directory the compiler emits from, which the
 * configuration declares or which is the directory every input file shares.
 */
export function sourceFilesOf<Brand>(project: ProjectView<Brand>, targetRoot: string): SourceFiles {
  const byName = new Map<string, SourceFile>();
  const byPath = new Map<string, SourceFile>();
  for (const file of project.ownSourceFiles()) {
    byName.set(file.fileName, file);
    const path = relativePath(targetRoot, file.fileName);
    if (path !== undefined) {
      byPath.set(path, file);
    }
  }

  const options = project.program.getCompilerOptions();
  const configDir = dirnamePath(project.configFile);
  const at = (option: string | undefined): string | undefined =>
    option === undefined ? undefined : resolvePath(configDir, option);
  const outDir = at(options.outDir);
  const declarationDir = at(options.declarationDir);
  const sourceDir = at(options.rootDir) ?? commonDirectory([...byName.keys()]);

  /** One path read below the directory the compiler emits from, where it is below the one it emits to. */
  const fromEmit = (path: string, emitted: string): string | undefined => {
    const emitDir = emitted.startsWith(".d.") ? (declarationDir ?? outDir) : outDir;
    if (emitDir === undefined) {
      return undefined;
    }
    const below = relativePath(emitDir, path);
    return below === undefined ? undefined : joinPath(sourceDir, below);
  };

  /** The source paths one written path may stand for, the path itself first. */
  const candidates = (path: string): readonly string[] => {
    const found = [path];
    for (const { emitted, sources } of EMITTED) {
      const mapped = fromEmit(path, emitted);
      for (const source of sources) {
        for (const from of [path, mapped]) {
          const candidate = from === undefined ? undefined : reExtended(from, emitted, source);
          if (candidate !== undefined) {
            found.push(candidate);
          }
        }
      }
    }
    return found;
  };

  return {
    byPath,
    byName,
    named: (path) => {
      if (!path.includes(SUBPATH_WILDCARD)) {
        for (const candidate of candidates(path)) {
          const held = byName.get(candidate);
          if (held !== undefined) {
            return [held];
          }
        }
        return [];
      }
      const patterns = candidates(path).filter((candidate) => candidate.includes(SUBPATH_WILDCARD));
      return [...byName.values()].filter((file) =>
        patterns.some((pattern) => matchesSubpath(pattern, file.fileName)),
      );
    },
  };
}
