/**
 * The files the import declarations of the target's Markdown and MDX documents load. A
 * document is read as text: a line outside a fenced code block that starts with `import`
 * is an import declaration, which an MDX compiler hoists into the module it builds.
 */

import type { SourceFile } from "@typescript/native/ast";
import { resolveRelativeSpecifier } from "./configuration-files.ts";
import type { Host } from "./host.ts";
import { dirnamePath, joinPath, resolvePath } from "./paths.ts";
import type { SourceFiles } from "./source-files.ts";
import { filesBelow } from "./fs/tree.ts";

/** One file a document imports, the specifier that named it, and the export names it reads. */
interface DocumentEntry {
  readonly file: SourceFile;
  readonly source: string;
  /** The export names the import reads, or undefined for a namespace import, which reads them all. */
  readonly names: readonly string[] | undefined;
}

/** The extensions of a document whose imports an MDX compiler reads. */
const DOCUMENT = /\.mdx?$/u;

/** A fence line, its marker run and what follows it captured. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;

/** A string literal in either quote, its escapes included. */
const STRING = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'`;

/** An import declaration at the start of a line, its clause and its specifier captured. */
const IMPORT_LINE = new RegExp(
  String.raw`^import\s+(?:((?:[^"'\n]|${STRING})*?)\s+from\s*)?["']([^"'\n]+)["']`,
  "u",
);

/** The braces of an import clause, what they hold captured. */
const BRACES = new RegExp(String.raw`\{((?:[^}"']|${STRING})*)\}`, "u");

/** One comma-separated part of a clause's braces. */
const PART = new RegExp(String.raw`(?:[^,"']|${STRING})+`, "gu");

/** A named import of a clause's braces: the exported name and an optional local alias. */
const NAMED_IMPORT = new RegExp(String.raw`^([\w$]+|${STRING})(?:\s+as\s+[\w$]+)?$`, "u");

/** The single-character escapes of a string literal and the character each stands for. */
const SINGLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
  ["0", "\0"],
  ["'", "'"],
  ['"', '"'],
  ["\\", "\\"],
]);

/**
 * One escape of a string literal: two hexadecimal digits, a code unit, a code point, or one
 * character and the digit after it.
 */
const ESCAPE = /\\(?:x([\da-fA-F]{2})|u([\da-fA-F]{4})|u\{([\da-fA-F]+)\}|(.)(\d?))/gu;

/** What one escape stands for, or undefined for one a module cannot hold. */
function unescaped([, hex, unit, point, single, digit]: RegExpExecArray): string | undefined {
  if (single === undefined) {
    const code = Number.parseInt(hex ?? unit ?? point ?? "", 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : undefined;
  }
  return /[1-9xu]/u.test(single) || (single === "0" && digit !== "")
    ? undefined
    : `${SINGLE_ESCAPES.get(single) ?? single}${digit ?? ""}`;
}

/**
 * The value of a quoted export name, its escapes decoded, or undefined for an escape this
 * reading does not decode. A module is strict code, so no legacy octal escape is valid.
 */
function quotedName(literal: string): string | undefined {
  const body = literal.slice(1, -1);
  let value = "";
  let from = 0;
  for (const escape of body.matchAll(ESCAPE)) {
    const decoded = unescaped(escape);
    if (decoded === undefined) {
      return undefined;
    }
    value += body.slice(from, escape.index) + decoded;
    from = escape.index + escape[0].length;
  }
  return value + body.slice(from);
}

/**
 * The export names one import clause reads: `default` for a default binding and each name
 * its braces list, or undefined for a namespace import, which reads every export, and for
 * a clause this reading does not parse, which may read any.
 */
function clauseNames(clause: string): readonly string[] | undefined {
  const braces = BRACES.exec(clause);
  const head = (braces === null ? clause : clause.slice(0, braces.index))
    .replace(/,\s*$/u, "")
    .trim();
  if (head.includes("*")) {
    return undefined;
  }
  const names = head === "" ? [] : ["default"];
  if (head !== "" && !/^[\w$]+$/u.test(head)) {
    return undefined;
  }
  for (const part of (braces?.[1]?.match(PART) ?? []).map((one) => one.trim())) {
    const named = NAMED_IMPORT.exec(part);
    if (part === "") {
      continue;
    }
    if (named?.[1] === undefined) {
      return undefined;
    }
    const name = /^["']/u.test(named[1]) ? quotedName(named[1]) : named[1];
    if (name === undefined) {
      return undefined;
    }
    names.push(name);
  }
  return names;
}

/** The relative specifiers one document's import lines name, its fenced code blocks skipped. */
function importedBy(
  text: string,
): readonly { readonly specifier: string; readonly names: readonly string[] | undefined }[] {
  const found: { specifier: string; names: readonly string[] | undefined }[] = [];
  let open: string | undefined;
  for (const line of text.split(/\r?\n/u)) {
    const fence = FENCE.exec(line);
    const marker = fence?.[1];
    if (marker !== undefined && open === undefined) {
      open = marker;
      continue;
    }
    // https://spec.commonmark.org/0.31.2/#fenced-code-blocks: only a run of the opening
    // character, at least as long and followed by nothing, closes a fence.
    if (
      marker !== undefined &&
      open !== undefined &&
      marker.startsWith(open.slice(0, 1)) &&
      marker.length >= open.length &&
      fence?.[2]?.trim() === ""
    ) {
      open = undefined;
      continue;
    }
    const matched = open === undefined ? IMPORT_LINE.exec(line) : null;
    const specifier = matched?.[2];
    if (specifier?.startsWith("./") === true || specifier?.startsWith("../") === true) {
      found.push({ specifier, names: clauseNames(matched?.[1] ?? "") });
    }
  }
  return found;
}

/** One document below a target root, by absolute path, and what its import lines name. */
interface DocumentImports {
  readonly path: string;
  readonly imports: ReturnType<typeof importedBy>;
}

/**
 * The documents each host's target roots hold, which every project of a run reads alike,
 * kept for the host's life as {@link Host} allows.
 */
const documentsOf = new WeakMap<Host, Map<string, readonly DocumentImports[]>>();

/** Every readable document below `root` and the import lines it writes, read once per host. */
function documentImports(host: Host, root: string): readonly DocumentImports[] {
  const byRoot = documentsOf.get(host) ?? new Map<string, readonly DocumentImports[]>();
  documentsOf.set(host, byRoot);
  const known = byRoot.get(root);
  if (known !== undefined) {
    return known;
  }
  const found = filesBelow(host, root, (name) => DOCUMENT.test(name)).flatMap((below) => {
    const path = joinPath(root, below);
    try {
      return [{ path, imports: importedBy(host.readFile(path)) }];
    } catch {
      return [];
    }
  });
  byRoot.set(root, found);
  return found;
}

/**
 * Every own file one document below the target root imports by a relative specifier,
 * read against the document's directory, on disk or through the emit mapping.
 */
export function documentEntries(
  host: Host,
  targetRoot: string,
  files: SourceFiles,
): readonly DocumentEntry[] {
  const root = resolvePath(host.workingDirectory(), targetRoot);
  const found: DocumentEntry[] = [];
  for (const { path, imports } of documentImports(host, root)) {
    const dir = dirnamePath(path);
    for (const { specifier, names } of imports) {
      const reached = resolveRelativeSpecifier(host, dir, specifier);
      const held = reached === undefined ? undefined : files.byName.get(reached);
      for (const file of held === undefined ? files.named(resolvePath(dir, specifier)) : [held]) {
        found.push({ file, source: specifier, names });
      }
    }
  }
  return found;
}
