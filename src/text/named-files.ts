/**
 * Layer 3 of the command reader: the files and the package names a command's text names, read
 * as plain text. The text is searched for each name, which every spelling of what it names
 * contains, so no part of it is split, unquoted or skipped first.
 */

import { dirnamePath, normalizePath, relativePath } from "../paths.ts";

/** The extension a source or an emitted file carries: a JavaScript or TypeScript one, or a declaration's. */
const SOURCE_EXTENSION = /\.(?:d\.[cm]?ts|[cm]?[jt]s|[jt]sx)$/u;

/** One file, and every path it is spelled by: its own and each one the project writes it to. */
interface Spelled<File> {
  readonly file: File;
  readonly paths: readonly string[];
}

/**
 * The names whose presence in a text holds one path below `dir`: its last name without the
 * extension, or with it where nothing else is left, and for an `index` file its directory's
 * last name, and `.` too where that is `dir`. Every spelling of the path relative to `dir`,
 * with or without `./`, `/` or `\`, its extension or its `/index` part, and every longer path
 * ending in one, holds one of them. None is empty, because an empty name is in every text.
 */
function stemsOf(path: string, dir: string): readonly string[] {
  const last = path.slice(path.lastIndexOf("/") + 1);
  const bare = last.replace(SOURCE_EXTENSION, "");
  const name = bare === "" ? last : bare;
  if (name !== "index") {
    return [name];
  }
  const parent = dirnamePath(path);
  return [
    name,
    parent.slice(parent.lastIndexOf("/") + 1),
    ...(parent === normalizePath(dir) ? ["."] : []),
  ].filter((stem) => stem !== "");
}

/**
 * Every file of `files` below `dir` that `text` names: one whose {@link stemsOf} a path of it
 * spells appears anywhere in the text. A file the text does not name may be held too, and no
 * file it names is missed.
 */
export function spelledFiles<File>(
  text: string,
  dir: string,
  files: readonly Spelled<File>[],
): readonly File[] {
  const byStem = new Map<string, File[]>();
  for (const { file, paths } of files) {
    const [own] = paths;
    if (own === undefined || relativePath(dir, own) === undefined) {
      continue;
    }
    for (const stem of new Set(paths.flatMap((path) => stemsOf(path, dir)))) {
      byStem.set(stem, [...(byStem.get(stem) ?? []), file]);
    }
  }
  const found = new Set<File>();
  // One pass per stem length: each place of the text is looked up once for every length.
  for (const length of new Set([...byStem.keys()].map((stem) => stem.length))) {
    for (let at = 0; at + length <= text.length; at += 1) {
      byStem.get(text.slice(at, at + length))?.forEach((file) => found.add(file));
    }
  }
  return [...found];
}

/** A character a package's or a command's name may hold, so one beside a name makes it part of a longer one. */
const NAME_CHARACTER = /[\w.@-]/u;

/**
 * Each of `names`, a package's or a command's name, that `text` holds with no name character
 * before it and no character after it but one a path or a version may go on with, `/`, `.` or
 * `@` among them: `module-alias/register` holds `module-alias`, and `tsxx` holds no `tsx`.
 */
export function heldNames(text: string, names: readonly string[]): ReadonlySet<string> {
  const found = new Set<string>();
  for (const name of names) {
    for (let at = text.indexOf(name); at >= 0 && name !== ""; at = text.indexOf(name, at + 1)) {
      const before = text.charAt(at - 1);
      const after = text.charAt(at + name.length);
      if (!NAME_CHARACTER.test(before) && !/[\w-]/u.test(after)) {
        found.add(name);
        break;
      }
    }
  }
  return found;
}
