/** Layer 3 of the command reader: the files its words name, and the package names a command's text names. */

import type { HeldWord } from "../commands/held.ts";
import { PART } from "../commands/shell.ts";
import { APPENDED_EXTENSIONS, extensionOf } from "../extensions.ts";
import { dirnamePath, normalizePath, relativePath } from "../paths.ts";

/** The extensions a name of a file drops: a source's, an emitted file's, and a declaration's (roots.13). */
const NAMED_EXTENSIONS = [...APPENDED_EXTENSIONS, ".d.ts", ".d.mts", ".d.cts"];

/** A character a package's or a command's name may hold, so one beside a name makes it part of a longer one. */
const NAME_CHARACTER = /[\w.@-]/u;

const SEPARATOR = /[/\\]/u;

/**
 * What makes one name of a file a path where it appears: a `stem`, a last segment without its
 * extension, may have the extension after it; a `segment`, a whole last segment, is one where
 * it holds an extension of its own; a `directory`, an `index` file's, may have a separator
 * after it; and `root` is `.`, the package's own directory.
 */
type NameKind = "stem" | "segment" | "directory" | "root";

interface FileName {
  readonly text: string;
  readonly kind: NameKind;
}

/** One file, and every path it is spelled by: its own and each one the project writes it to. */
interface Spelled<File> {
  readonly file: File;
  readonly paths: readonly string[];
}

/**
 * The names whose appearance as a path in a text holds one path below `dir`: its last segment
 * without the extension, or whole where nothing else is left or it has none, and for an
 * `index` file its directory's last segment, and `.` too where that is `dir`. Every spelling
 * of the path that writes it as a path holds one of them (roots.13). None is empty, because
 * an empty name is in every text.
 */
function namesOf(path: string, dir: string): readonly FileName[] {
  const last = path.slice(path.lastIndexOf("/") + 1);
  const bare = last.slice(0, last.length - (extensionOf(last, NAMED_EXTENSIONS)?.length ?? 0));
  const own: FileName =
    bare === "" || bare === last ? { text: last, kind: "segment" } : { text: bare, kind: "stem" };
  if (own.text !== "index") {
    return [own];
  }
  const parent = dirnamePath(path);
  const directory = parent.slice(parent.lastIndexOf("/") + 1);
  return [
    own,
    ...(directory === "" ? [] : [{ text: directory, kind: "directory" as const }]),
    ...(parent === normalizePath(dir) ? [{ text: ".", kind: "root" as const }] : []),
  ];
}

/**
 * Whether a name that ends at `end` ends there as a path: no name character follows, nor a
 * separator, which goes on to a path below it, nor a part, whose text goes on with the name,
 * nor a `.` that a word character or a part follows, which goes on to another extension.
 */
function endsAt(text: string, end: number): boolean {
  const next = text.charAt(end);
  const after = text.charAt(end + 1);
  return (
    !/[\w@/\\-]/u.test(next) &&
    next !== PART &&
    !(next === "." && (/\w/u.test(after) || after === PART))
  );
}

/** A character a word that writes a path may hold, a part only its run knows among them. */
const PATH_CHARACTER = new RegExp(`[\\w.@+/\\\\${PART}-]`, "u");

/** A run of {@link PATH_CHARACTER}s: a word as {@link noFileEnd} reads one. */
const PATH_WORD = new RegExp(`${PATH_CHARACTER.source}+`, "gu");

const SCOPED_PACKAGE = /^@[\w-][\w.-]*\/[\w-][\w.-]*(?:@[\w.-]*)?$/u;

/**
 * The end of what `text` writes from `start`, where `word` starts, that names an image or a
 * package and never a file, or `start` where it names none (roots.13): a value of a `docker:`
 * that starts no longer name, and a scoped package's name, which no part goes on with, since
 * a part beside it may make it a path.
 */
function noFileEnd(text: string, start: number, word: string): number {
  const end = start + word.length;
  const image =
    word.startsWith("//") &&
    start >= 7 &&
    text.startsWith("docker:", start - 7) &&
    !NAME_CHARACTER.test(text.charAt(start - 8));
  return image || (SCOPED_PACKAGE.test(word) && !holdsExtension(word)) ? end : start;
}

/** Each place of `text` that {@link noFileEnd} rules out, as a 1. */
function placesNamingNoFile(text: string): Uint8Array {
  const ruledOut = new Uint8Array(text.length);
  for (const { 0: word, index: start } of text.matchAll(PATH_WORD)) {
    ruledOut.fill(1, start, noFileEnd(text, start, word));
  }
  return ruledOut;
}

/** The place after the separators `text` holds from `at`. */
function pastSeparators(text: string, at: number): number {
  let after = at;
  while (SEPARATOR.test(text.charAt(after))) {
    after += 1;
  }
  return after;
}

/** Whether `name`, found in `text` at `at`, appears there as a path (roots.13). */
function appearsAsPath(text: string, at: number, name: FileName): boolean {
  const before = text.charAt(at - 1);
  const end = at + name.text.length;
  if (before === PART) {
    return false;
  }
  if (name.kind === "root") {
    const after = pastSeparators(text, end);
    return (
      [before, text.charAt(after)].every(
        (one) => !NAME_CHARACTER.test(one) && !SEPARATOR.test(one),
      ) && text.charAt(after) !== PART
    );
  }
  if (NAME_CHARACTER.test(before)) {
    return false;
  }
  const after = pastSeparators(text, end);
  if (name.kind === "directory" && after > end && endsAt(text, after)) {
    return true;
  }
  if (
    (SEPARATOR.test(before) || (name.kind === "segment" && name.text.indexOf(".", 1) > 0)) &&
    endsAt(text, end)
  ) {
    return true;
  }
  return (
    name.kind === "stem" &&
    NAMED_EXTENSIONS.some(
      (extension) => text.startsWith(extension, end) && endsAt(text, end + extension.length),
    )
  );
}

/** Whether some text holds one of the extensions as a whole. */
function holdsExtension(written: string): boolean {
  return NAMED_EXTENSIONS.some((extension) =>
    new RegExp(`${extension.replaceAll(".", "\\.")}(?!\\w)`, "u").test(written),
  );
}

/**
 * A word with a part only its run knows: the text a path it names ends in after a `/`, split
 * at each part, and whether it names a directory.
 */
interface DynamicWord {
  readonly glob: readonly string[];
  readonly directory: boolean;
}

/** Whether a word's segment writes path text: text beside its parts other than `.` and `..`. */
function writesPath(segment: string): boolean {
  return segment.split(PART).some((piece) => piece !== "" && piece !== "." && piece !== "..");
}

/**
 * Each run of path characters of `word`, at `start`, whose last segment holds a part, read as
 * roots.13 reads one from past its last segment before the last that writes no path: one that
 * writes none names nothing and is `unwritten` where the word may write the file a command runs,
 * where a bare one names a file too. The word stands `depth` segments below the target root,
 * whose own directories no checkout names alike: a leading `..` past it writes none, and an
 * absolute run reads from its last segment that writes a path, `unwritten` where more is left.
 */
function dynamicWords(
  word: HeldWord,
  start: number,
  ruledOut: Uint8Array,
  depth: number,
): { readonly found: readonly DynamicWord[]; readonly unwritten: boolean } {
  const { text, runs } = word;
  const found: DynamicWord[] = [];
  let unwritten = false;
  const read = (from: number, next: number): void => {
    const entry = next < 0;
    // A `.` the word ends with ends a sentence, as endsAt reads one after a name.
    const run = entry ? text : text.slice(from, next).replace(/\.+$/u, "");
    const all = run.replaceAll("\\", "/").split("/");
    const directory = all.length > 1 && all.at(-1) === "";
    const written = all.filter((segment) => segment !== "" && segment !== ".");
    const last = (written.at(-1) ?? "").split(PART);
    // A runtime's entry is a path whatever it looks like, a scoped package's name among them.
    if (!entry && (last.length < 2 || ruledOut[start + from] === 1)) {
      return;
    }
    const climbs = written.findIndex((segment) => segment !== "..");
    const above = Math.max(0, (climbs < 0 ? written.length : climbs) - depth);
    const segments = written.filter((_, at) => at < climbs || at >= climbs + above);
    if (!segments.some(writesPath)) {
      unwritten ||= runs && (!entry || above > 0);
    } else if (all.length > 1 || holdsExtension(last.join("")) || runs) {
      const kept = directory ? segments.length : segments.length - 1;
      const anyDirectory = segments.slice(0, kept).findLastIndex((one) => !writesPath(one));
      const absolute = all[0] === "" && all.length > 1 && anyDirectory < 0;
      const from = absolute ? segments.findLastIndex(writesPath) : anyDirectory + 1;
      unwritten ||= runs && absolute && from < segments.length - 1;
      const glob = segments.slice(from).join("/");
      found.push({ glob: glob === "" ? ["", ""] : glob.split(PART), directory });
    }
  };
  if (runs && !text.includes(PART)) {
    read(0, -1);
  }
  let at = text.indexOf(PART);
  while (at >= 0) {
    let from = at;
    while (from > 0 && PATH_CHARACTER.test(text.charAt(from - 1))) {
      from -= 1;
    }
    let next = at;
    while (next < text.length && PATH_CHARACTER.test(text.charAt(next))) {
      next += 1;
    }
    read(from, next);
    at = text.indexOf(PART, Math.max(next, at + 1));
  }
  return { found, unwritten };
}

/** Whether `segment` is the text `glob` writes, any text standing between two of its parts. */
function standsFor(glob: readonly string[], segment: string): boolean {
  const first = glob[0] ?? "";
  const last = glob.at(-1) ?? "";
  if (glob.length === 1) {
    return segment === first;
  }
  if (
    !segment.startsWith(first) ||
    !segment.endsWith(last) ||
    first.length + last.length > segment.length
  ) {
    return false;
  }
  let at = first.length;
  const end = segment.length - last.length;
  for (const middle of glob.slice(1, -1)) {
    const found = segment.indexOf(middle, at);
    if (found < 0 || found + middle.length > end) {
      return false;
    }
    at = found + middle.length;
  }
  return true;
}

/** Whether a word's glob may write `path` or the end of it after a `/`. */
function mayStandFor(glob: readonly string[], path: string): boolean {
  let at = 0;
  while (!standsFor(glob, path.slice(at))) {
    const slash = path.indexOf("/", at);
    if (slash < 0) {
      return false;
    }
    at = slash + 1;
  }
  return true;
}

/**
 * Each spelling of one path below `dir` a word may write the end of: the whole path from `root`,
 * so a word may write the directories between them too, but no checkout's own, without its
 * extension, and without its `/index` part, which alone is a directory's spelling.
 */
function spellingsBelow(
  path: string,
  dir: string,
  root: string,
): { readonly file: readonly string[]; readonly directory: readonly string[] } {
  const fromRoot = relativePath(root, path);
  if (relativePath(dir, path) === undefined || fromRoot === undefined) {
    return { file: [], directory: [] };
  }
  const whole = `/${fromRoot}`;
  const extension = extensionOf(whole, NAMED_EXTENSIONS);
  const bare = extension === undefined ? whole : whole.slice(0, -extension.length);
  const directory = bare.endsWith("/index") ? [bare.slice(0, -"/index".length)] : [];
  return { file: [whole, bare, ...directory], directory };
}

/**
 * Every file of `files` below `dir` that `words` name: one of whose {@link namesOf} a path of it
 * has appears in a word as a path, or a spelling of one of whose paths a word that writes a
 * path with a part only its run knows may stand for, and whether a word that may write the
 * file a command runs writes no path text. A file the words do not name may be named too, and
 * no file a word writes as a path outside an image's or a package's name is missed.
 */
export function spelledFiles<File>(
  words: readonly HeldWord[],
  dir: string,
  root: string,
  files: readonly Spelled<File>[],
): { readonly files: readonly File[]; readonly unwritten: boolean } {
  const byName = new Map<string, { readonly file: File; readonly name: FileName }[]>();
  for (const { file, paths } of files) {
    const [own] = paths;
    if (own === undefined || relativePath(dir, own) === undefined) {
      continue;
    }
    const seen = new Set<string>();
    for (const name of paths.flatMap((path) => namesOf(path, dir))) {
      const key = `${name.kind}\u0000${name.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        byName.set(name.text, [...(byName.get(name.text) ?? []), { file, name }]);
      }
    }
  }
  const found = new Set<File>();
  const text = words.map((word) => word.text).join("\n");
  const ruledOut = placesNamingNoFile(text);
  // One pass per name length: each place of the text is looked up once for every length.
  for (const length of new Set([...byName.keys()].map((name) => name.length))) {
    for (let at = 0; at + length <= text.length; at += 1) {
      for (const { file, name } of byName.get(text.slice(at, at + length)) ?? []) {
        if (!found.has(file) && ruledOut[at] !== 1 && appearsAsPath(text, at, name)) {
          found.add(file);
        }
      }
    }
  }
  const dynamic: DynamicWord[] = [];
  let unwritten = false;
  let start = 0;
  const depth =
    normalizePath(dir) === normalizePath(root)
      ? 0
      : (relativePath(root, dir)?.split("/").length ?? 0);
  for (const word of words) {
    const read = dynamicWords(word, start, ruledOut, depth);
    dynamic.push(...read.found);
    unwritten ||= read.unwritten;
    start += word.text.length + 1;
  }
  if (dynamic.length > 0) {
    for (const { file, paths } of files) {
      const spellings = paths.map((path) => spellingsBelow(path, dir, root));
      if (
        !found.has(file) &&
        dynamic.some((word) =>
          spellings.some((spelled) =>
            (word.directory ? spelled.directory : spelled.file).some((one) =>
              mayStandFor(word.glob, one),
            ),
          ),
        )
      ) {
        found.add(file);
      }
    }
  }
  return { files: [...found], unwritten };
}

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
