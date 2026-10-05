/**
 * The files the module scripts of the target's HTML files load. An HTML file is read as
 * text and no markup is parsed, so a `<script>` inside a comment is read as well.
 */

import {
  isExportDeclaration,
  isImportDeclaration,
  isStringLiteral,
  type SourceFile,
} from "@typescript/native/unstable/ast";
import { resolveRelativeSpecifier, type ParseFile } from "./configuration-files.ts";
import type { Host } from "./host.ts";
import { dirnamePath, joinPath, relativePath, resolvePath } from "./paths.ts";
import type { SourceFiles } from "./source-files.ts";

/** One file a module script loads, and the value or specifier that named it. */
export interface HTMLEntry {
  readonly file: SourceFile;
  readonly source: string;
}

/** The directory no HTML file is read below. */
const SKIPPED = "node_modules";

/** A `<script` start tag, its attribute text captured. */
const SCRIPT_TAG = /<script(?=[\s>/])([^>]*)>/giu;

/** The end tag an inline module script's content runs to. */
const SCRIPT_END = /<\/script\s*>/iu;

/** One attribute: a name, then a double-quoted, single-quoted or unquoted value. */
const ATTRIBUTE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;

/** A value that names a resource on another origin, or by another scheme. */
const ELSEWHERE = /^(?:\/\/|[A-Za-z][A-Za-z\d+.-]*:)/u;

/** The prefixes an inline script's specifier names a file of the target with. */
const FILE_PREFIXES = ["/", "./", "../"] as const;

/** Every HTML file below `dir`, outside every `node_modules` directory, by absolute path. */
function htmlFiles(host: Host, dir: string): readonly string[] {
  let entries;
  try {
    entries = host.readDirectory(dir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const path = joinPath(dir, entry.name);
    if (entry.directory) {
      if (entry.name !== SKIPPED) {
        found.push(...htmlFiles(host, path));
      }
    } else if (entry.name.endsWith(".html")) {
      found.push(path);
    }
  }
  return found.sort();
}

/** Each attribute of one start tag's attribute text, by its lowercase name. */
function attributes(text: string): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  for (const match of text.matchAll(ATTRIBUTE)) {
    const [, name = "", double, single, bare] = match;
    const key = name.toLowerCase();
    if (!found.has(key)) {
      found.set(key, double ?? single ?? bare ?? "");
    }
  }
  return found;
}

/** The specifiers of the import and re-export declarations one inline script holds. */
function specifiersOf(parse: ParseFile, fileName: string, content: string): readonly string[] {
  return parse(fileName, content).statements.flatMap((statement) => {
    const specifier =
      isImportDeclaration(statement) || isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined;
    return specifier !== undefined && isStringLiteral(specifier) ? [specifier.text] : [];
  });
}

/**
 * Every value a module script of one HTML file names a file by: a `src` attribute's
 * value, or each specifier an inline script imports or re-exports that starts with `/`,
 * `./` or `../`.
 */
function scriptValues(parse: ParseFile | undefined, path: string, text: string): readonly string[] {
  const values: string[] = [];
  for (const match of text.matchAll(SCRIPT_TAG)) {
    const held = attributes(match[1] ?? "");
    if (held.get("type") !== "module") {
      continue;
    }
    const src = held.get("src");
    if (src !== undefined) {
      values.push(src);
      continue;
    }
    if (parse === undefined) {
      continue;
    }
    const start = match.index + match[0].length;
    const rest = text.slice(start);
    const end = rest.search(SCRIPT_END);
    const content = end === -1 ? rest : rest.slice(0, end);
    values.push(
      ...specifiersOf(parse, `${path}.${String(start)}.ts`, content).filter((specifier) =>
        FILE_PREFIXES.some((prefix) => specifier.startsWith(prefix)),
      ),
    );
  }
  return values;
}

/** The directory of the nearest `package.json` at or above `dir`, inside `root`, else `root`. */
function manifestDirectory(host: Host, root: string, dir: string): string {
  for (let at = dir; relativePath(root, at) !== undefined; at = dirnamePath(at)) {
    if (host.kindOf(joinPath(at, "package.json")) === "file") {
      return at;
    }
    if (at === root) {
      break;
    }
  }
  return root;
}

/**
 * The own files the module scripts of every HTML file below the target root load. A value
 * starting with a single `/` is read against the nearest manifest's directory, any other
 * against the HTML file's own, and either resolves as a configuration file's relative
 * specifier does. A value naming another origin or scheme, or no source file of the
 * program, loads nothing here.
 */
export function htmlEntries(
  host: Host,
  targetRoot: string,
  files: SourceFiles,
  parse: ParseFile | undefined,
): readonly HTMLEntry[] {
  const root = resolvePath(host.workingDirectory(), targetRoot);
  const found: HTMLEntry[] = [];
  for (const path of htmlFiles(host, root)) {
    let text: string;
    try {
      text = host.readFile(path);
    } catch {
      continue;
    }
    const dir = dirnamePath(path);
    for (const value of scriptValues(parse, path, text)) {
      if (ELSEWHERE.test(value)) {
        continue;
      }
      const reached = value.startsWith("/")
        ? resolveRelativeSpecifier(host, manifestDirectory(host, root, dir), `.${value}`)
        : resolveRelativeSpecifier(host, dir, value);
      const file = reached === undefined ? undefined : files.byName.get(reached);
      if (file !== undefined) {
        found.push({ file, source: value });
      }
    }
  }
  return found;
}
