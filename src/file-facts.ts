/**
 * What the file kinds read about the target's files beside the sweep: every source
 * file below the target root, whether or not a project includes it, and the files a
 * program holds by inclusion rather than by an import.
 */

import type { SourceFile } from "@typescript/native/unstable/ast";
import { IGNORED_DIRECTORIES } from "./discover.ts";
import type { Host } from "./host.ts";
import { packageScope } from "./inventory.ts";
import { dirnamePath, joinPath, relativePath, resolvePath } from "./paths.ts";
import { renderRef } from "./ref.ts";
import type { ProjectView } from "./session.ts";

/** A file name the compiler reads as a source file. */
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/u;

/** A file name the compiler reads as a declaration file, which no build emits code from. */
const DECLARATION_FILE = /\.d\.(?:[^./]+\.)?[mc]?ts$/u;

/** A line break as the compiler counts lines. */
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/gu;

/** One source file below the target root. */
export interface TreeFile {
  /** The path below the target root, with the solidus as separator. */
  readonly path: string;
  /** The stable reference of the file's module. */
  readonly ref: string;
  /** The line of the file's last character, counted from one. */
  readonly endLine: number;
}

/** The target's files, as the file kinds read them. */
export interface FileFacts {
  /**
   * Every source file below the target root a compiler configuration can include, in
   * path order: a source extension, not a declaration file, and not below a directory
   * discovery skips.
   */
  readonly tree: readonly TreeFile[];
  /**
   * The paths below the target root of the files a program holds by inclusion rather
   * than by an import. A file that carries a triple-slash directive, augments a module
   * or the global scope, or declares an ambient module changes what every file of the
   * program sees for as long as the program includes it, and a file a triple-slash path
   * reference names is included by the file that names it.
   */
  readonly heldByInclusion: ReadonlySet<string>;
  /** The paths below the target root of the generated files. */
  readonly generated?: ReadonlySet<string>;
}

/** The line of the last character of one text, counted from one; an empty text is one line. */
function lastLine(text: string): number {
  const last = Math.max(text.length - 1, 0);
  let line = 1;
  for (const found of text.matchAll(LINE_BREAK)) {
    if (found.index + found[0].length > last) {
      break;
    }
    line += 1;
  }
  return line;
}

/**
 * The path below the target root of every source file there, in path order. A directory
 * that cannot be read is skipped, as discovery skips it.
 */
export function sourcePaths(host: Host, targetRoot: string): readonly string[] {
  const found: string[] = [];
  const pending = [""];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    let entries: readonly { readonly name: string; readonly directory: boolean }[];
    try {
      entries = host.readDirectory(joinPath(targetRoot, dir));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.directory) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          pending.push(path);
        }
        continue;
      }
      if (SOURCE_FILE.test(entry.name) && !DECLARATION_FILE.test(entry.name)) {
        found.push(path);
      }
    }
  }
  return found.sort((a, b) => (a < b ? -1 : 1));
}

/**
 * Every source file below the target root, in path order. A file that cannot be read is
 * skipped: a tree the analysis may not enter holds no file it can report.
 */
export function sourceTree(host: Host, targetRoot: string): readonly TreeFile[] {
  const scopeOf = packageScope(host, targetRoot);
  return sourcePaths(host, targetRoot).flatMap((path) => {
    let text: string;
    try {
      text = host.readFile(joinPath(targetRoot, path));
    } catch {
      return [];
    }
    return [{ path, ref: renderRef(scopeOf(path), { of: "module" }), endLine: lastLine(text) }];
  });
}

/** Whether one file changes what the program sees by being included in it. */
function actsByInclusion(file: SourceFile): boolean {
  return (
    file.referencedFiles.length > 0 ||
    file.typeReferenceDirectives.length > 0 ||
    file.libReferenceDirectives.length > 0 ||
    file.moduleAugmentations.length > 0 ||
    file.ambientModuleNames.length > 0
  );
}

/**
 * The paths below the target root of one project's own files the program holds by
 * inclusion, in the order the program holds them, each once.
 */
export function heldByInclusion<Brand>(
  project: ProjectView<Brand>,
  targetRoot: string,
): readonly string[] {
  const held = new Set<string>();
  const add = (fileName: string): void => {
    const path = relativePath(targetRoot, fileName);
    if (path !== undefined) {
      held.add(path);
    }
  };
  for (const file of project.ownSourceFiles()) {
    if (actsByInclusion(file)) {
      add(file.fileName);
    }
    for (const reference of file.referencedFiles) {
      add(resolvePath(dirnamePath(file.fileName), reference.fileName));
    }
  }
  return [...held];
}
