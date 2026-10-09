/**
 * The files the scripts of the target's HTML files load: a module script's, and a
 * classic script's that names its file by `src`. An HTML file is read as text and no
 * markup is parsed, so a `<script>` inside a comment is read as well.
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

/** One file a script loads, and the value or specifier that named it. */
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

/** The `type` values a classic script carries, compared in lowercase. */
const CLASSIC_TYPES: ReadonlySet<string> = new Set(["text/javascript", "application/javascript"]);

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
 * Every value a script of one HTML file names a file by: the `src` attribute's value of a
 * module script or of a classic one, or each specifier an inline module script imports or
 * re-exports that starts with `/`, `./` or `../`.
 */
function scriptValues(parse: ParseFile | undefined, path: string, text: string): readonly string[] {
  const values: string[] = [];
  for (const match of text.matchAll(SCRIPT_TAG)) {
    const held = attributes(match[1] ?? "");
    const type = held.get("type");
    const src = held.get("src");
    if (type !== "module") {
      if (src !== undefined && (type === undefined || CLASSIC_TYPES.has(type.toLowerCase()))) {
        values.push(src);
      }
      continue;
    }
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
 * The own files the scripts of every HTML file below the target root load. A value
 * starting with a single `/` is read against the nearest manifest's directory, any other
 * against the HTML file's own, as a configuration file's relative specifier. One naming no
 * source file is read back through the project's emit mapping, and a `/` one also against
 * an output directory that is the HTML file's own. Another origin or scheme loads nothing.
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
      const base = value.startsWith("/") ? manifestDirectory(host, root, dir) : dir;
      const relative = value.startsWith("/") ? `.${value}` : value;
      const reached = resolveRelativeSpecifier(host, base, relative);
      const file = reached === undefined ? undefined : files.byName.get(reached);
      if (file !== undefined) {
        found.push({ file, source: value });
        continue;
      }
      const served = value.startsWith("/")
        ? files.outputDirs.filter((outDir) => outDir === dir)
        : [];
      const emitting = [base, ...served].flatMap((against) =>
        files.named(resolvePath(against, relative)),
      );
      for (const one of new Set(emitting)) {
        found.push({ file: one, source: value });
      }
    }
  }
  return found;
}
