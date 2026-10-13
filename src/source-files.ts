/**
 * The target's own source files of one project, looked up the ways a path written
 * in a document or a string names one: as the file itself, or as a file the
 * compiler emits from it.
 */

import type { SourceFile } from "@typescript/native/ast";
import { commonDirectory, emittedFrom } from "./emit-map.ts";
import { dirnamePath, joinPath, relativePath, resolvePath } from "./paths.ts";
import type { ProjectView } from "./session.ts";

/** The one character a subpath pattern of a manifest's `exports` holds. */
const SUBPATH_WILDCARD = "*";

/** The extension a source file's name drops when the project writes it out. */
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/u;

/** The extensions the project may write a source file's output under. */
const OUTPUT_EXTENSIONS = [".js", ".mjs", ".cjs", ".jsx", ".d.ts", ".d.mts", ".d.cts"] as const;

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
  /** The directories the project writes its output below, absolute: its output and declaration directories. */
  readonly outputDirs: readonly string[];
  /** The output paths, absolute, the project writes one own file to, each of which {@link named} reads back to it. */
  writtenAs(file: SourceFile): readonly string[];
  /**
   * The own files one absolute path names read as an output of the project written below
   * `outputDir`: a manifest that ships from its build directory names its entries there.
   */
  namedAsOutput(outputDir: string, path: string): readonly SourceFile[];
}

/** The first own file of the paths given that the project holds, or none. */
function heldAt(
  byName: ReadonlyMap<string, SourceFile>,
  paths: readonly string[],
): readonly SourceFile[] {
  for (const candidate of paths) {
    const file = byName.get(candidate);
    if (file !== undefined) {
      return [file];
    }
  }
  return [];
}

/** Where one project writes its output, and the directory it writes it from, absolute. */
function layoutOf<Brand>(
  project: ProjectView<Brand>,
  fileNames: readonly string[],
): {
  readonly outDir: string | undefined;
  readonly declarationDir: string | undefined;
  readonly sourceDir: string;
} {
  const options = project.program.getCompilerOptions();
  const configDir = dirnamePath(project.configFile);
  const at = (option: string | undefined): string | undefined =>
    option === undefined ? undefined : resolvePath(configDir, option);
  return {
    outDir: at(options.outDir),
    declarationDir: at(options.declarationDir),
    sourceDir: at(options.rootDir) ?? commonDirectory(fileNames),
  };
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

  const { outDir, declarationDir, sourceDir } = layoutOf(project, [...byName.keys()]);
  const layout = { outDir, declarationDir, sourceDirs: [sourceDir] };

  /** The source paths one written path may stand for, the path itself first. */
  const candidates = (path: string): readonly string[] => [path, ...emittedFrom(path, layout)];

  return {
    byPath,
    byName,
    outputDirs: [...new Set([outDir, declarationDir])].filter((dir) => dir !== undefined),
    writtenAs: (file) => {
      const below = relativePath(sourceDir, file.fileName);
      if (below === undefined) {
        return [];
      }
      const written = [outDir, declarationDir].flatMap((dir) =>
        dir === undefined
          ? []
          : OUTPUT_EXTENSIONS.map((extension) =>
              joinPath(dir, below.replace(SOURCE_EXTENSION, extension)),
            ),
      );
      return [...new Set(written)].filter((path) => heldAt(byName, candidates(path))[0] === file);
    },
    namedAsOutput: (outputDir, path) =>
      heldAt(byName, emittedFrom(path, { outDir: outputDir, sourceDirs: [sourceDir] })),
    named: (path) => {
      if (!path.includes(SUBPATH_WILDCARD)) {
        return heldAt(byName, candidates(path));
      }
      const patterns = candidates(path).filter((candidate) => candidate.includes(SUBPATH_WILDCARD));
      return [...byName.values()].filter((file) =>
        patterns.some((pattern) => matchesSubpath(pattern, file.fileName)),
      );
    },
  };
}
