/**
 * The configuration files a tool loads by name, and the strings they hold. A file in a
 * directory that holds a `package.json` is a configuration module when its name is
 * `<stem>.config.<ext>`, `<stem>.<qualifier>.config.<ext>` or `.<stem>rc.<ext>`, and a
 * JSON configuration file when its name is the JSON form of one of them. A tool reads
 * every string either holds as it likes, so each one that spells a declared dependency
 * uses it and each relative one that names a source file of the program roots the file.
 */

import {
  isExportDeclaration,
  isImportDeclaration,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
  type Node,
  type SourceFile,
} from "@typescript/native/unstable/ast";
import type { Host } from "./host.ts";
import { dirnamePath, joinPath, relativePath, resolvePath } from "./paths.ts";
import type { SourceFiles } from "./source-files.ts";

const MANIFEST = "package.json";

/** A configuration module's name, each form with the spelling a root reports it by. */
const MODULE_FORMS: readonly { readonly name: RegExp; readonly form: string }[] = [
  { name: /^[\w-]+\.config\.(?:js|mjs|cjs|ts|mts|cts)$/u, form: "<stem>.config.<ext>" },
  {
    name: /^[\w-]+\.[\w-]+\.config\.(?:js|mjs|cjs|ts|mts|cts)$/u,
    form: "<stem>.<qualifier>.config.<ext>",
  },
  { name: /^\.[\w-]+rc\.(?:js|mjs|cjs)$/u, form: ".<stem>rc.<ext>" },
];

/** A JSON configuration file's name. */
const DOCUMENT_NAME = /^(?:[\w-]+(?:\.[\w-]+)?\.config\.json|\.[\w-]+rc(?:\.json)?)$/u;

/** The manifest members a dependency is declared in. */
const DEPENDENCY_MEMBERS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/** The prefixes a string names a file with, relative to the file that writes it. */
const RELATIVE_PREFIXES = ["./", "../"] as const;

/** The JavaScript extensions a relative specifier from a configuration file stands for TypeScript under. */
const COUNTERPARTS: readonly (readonly [string, readonly string[]])[] = [
  [".js", [".ts", ".tsx"]],
  [".jsx", [".tsx", ".ts"]],
  [".mjs", [".mts"]],
  [".cjs", [".cts"]],
];

/** The extensions appended to a relative specifier from a configuration file, in order. */
const APPENDED = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

/** The extensions the program's module resolution appends to a specifier written without one. */
export const RESOLVED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".d.ts",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

/** The directory a package manager installs packages into, whose files are no project's own. */
const MODULES_DIR = "node_modules";

/** The file's name, the last segment of its path. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Whether one path is the project's own: below the target root and in no `node_modules`. */
function isProjectPath(root: string, path: string): boolean {
  return relativePath(root, path)?.split("/").includes(MODULES_DIR) === false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The form one file name is as a configuration module, or undefined where it is none. */
export function configurationModuleForm(name: string): string | undefined {
  return MODULE_FORMS.find((one) => one.name.test(name))?.form;
}

/** Whether one file name is a JSON configuration file's. */
export function isConfigurationDocumentName(name: string): boolean {
  return DOCUMENT_NAME.test(name);
}

/** One JSON configuration file, with every string value it holds. */
interface ConfigurationDocument {
  /** The file, absolute. */
  readonly path: string;
  /** The directories of the manifests whose dependencies the strings are read against. */
  readonly manifestDirs: readonly string[];
  /** Every string value at any depth, in document order; a member's name is no value. */
  readonly strings: readonly string[];
}

/** Parses one file the program does not hold, with no type information. */
export type ParseFile = (fileName: string, text: string) => SourceFile;

/** One file no program holds that a configuration module outside the program leads to. */
interface OutsideModule {
  /** The file, parsed alone. */
  readonly file: SourceFile;
  /** The directories of the manifests of the configuration files the file was reached from. */
  readonly manifestDirs: readonly string[];
}

/** The flags a tool's command line names its configuration file with. */
const CONFIG_FLAGS: ReadonlySet<string> = new Set(["--config", "-c"]);

/** The extensions of a module a configuration flag may name. */
const MODULE_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"] as const;

/** The characters that end a word outside quotes and separate nothing: blanks. */
const BLANK = /[ \t\r\f\v]/u;

/** The characters that end a word outside quotes and begin an operator: newline included. */
const OPERATOR = /[\n;&|()<>]/u;

/** The characters a backslash escapes inside double quotes; before any other it stands for itself. */
const DOUBLE_QUOTE_ESCAPES = new Set(["$", "`", '"', "\\"]);

/**
 * The words of one command line, as POSIX token recognition reads quotes, backslashes,
 * line continuations, comments and operators. A word an expansion may change (an unquoted
 * `$`, backquote, glob character or leading `~`, or a `$` or backquote in double quotes)
 * is computed, and so is the rest of a line whose quote is never closed. A computed word
 * and each operator are undefined, so a flag's file is never read across them.
 */
function shellWords(command: string): readonly (string | undefined)[] {
  const words: (string | undefined)[] = [];
  let word: string | undefined;
  let computed = false;
  const end = (): void => {
    if (word !== undefined) {
      words.push(computed ? undefined : word);
    }
    word = undefined;
    computed = false;
  };
  for (let at = 0; at < command.length; at += 1) {
    const char = command.charAt(at);
    if (char === "\\" && command.charAt(at + 1) === "\n") {
      at += 1;
    } else if (BLANK.test(char)) {
      end();
    } else if (OPERATOR.test(char)) {
      end();
      words.push(undefined);
    } else if (char === "#" && word === undefined) {
      const newline = command.indexOf("\n", at);
      at = newline < 0 ? command.length : newline - 1;
    } else if (char === "\\") {
      at += 1;
      word = (word ?? "") + command.charAt(at);
    } else if (char === "'" || char === '"') {
      const close = closingQuote(command, at);
      if (close < 0) {
        word ??= "";
        computed = true;
        break;
      }
      const quoted =
        char === "'"
          ? { text: command.slice(at + 1, close), computed: false }
          : doubleQuoted(command.slice(at + 1, close));
      word = (word ?? "") + quoted.text;
      computed ||= quoted.computed;
      at = close;
    } else {
      computed ||= /[$`*?[]/u.test(char) || (char === "~" && word === undefined);
      word = (word ?? "") + char;
    }
  }
  end();
  return words;
}

/** The text between one pair of double quotes, unescaped, and whether an expansion may change it. */
function doubleQuoted(inner: string): { readonly text: string; readonly computed: boolean } {
  let text = "";
  let computed = false;
  for (let at = 0; at < inner.length; at += 1) {
    const char = inner.charAt(at);
    const next = inner.charAt(at + 1);
    if (char === "\\" && next === "\n") {
      at += 1;
    } else if (char === "\\" && DOUBLE_QUOTE_ESCAPES.has(next)) {
      text += next;
      at += 1;
    } else {
      computed ||= char === "$" || char === "`";
      text += char;
    }
  }
  return { text, computed };
}

/** The index of the quote that closes the one at `open`, or -1 where none does. */
function closingQuote(command: string, open: number): number {
  const quote = command.charAt(open);
  for (let at = open + 1; at < command.length; at += 1) {
    const char = command.charAt(at);
    if (char === quote) {
      return at;
    }
    if (quote === '"' && char === "\\") {
      at += 1;
    }
  }
  return -1;
}

/**
 * The files the scripts of the manifest in one directory name after a configuration flag,
 * `--config <file>`, `-c <file>` or `--config=<file>`, each a JSON file or a module below
 * the target root and in no `node_modules`.
 */
function scriptConfigurations(host: Host, root: string, dir: string): readonly string[] {
  let scripts: unknown;
  try {
    const manifest: unknown = JSON.parse(host.readFile(joinPath(dir, MANIFEST)));
    scripts = isRecord(manifest) ? manifest["scripts"] : undefined;
  } catch {
    return [];
  }
  if (!isRecord(scripts)) {
    return [];
  }
  const found: string[] = [];
  for (const command of Object.values(scripts)) {
    if (typeof command !== "string") {
      continue;
    }
    const words = shellWords(command);
    words.forEach((word, at) => {
      const named =
        word !== undefined && CONFIG_FLAGS.has(word)
          ? words[at + 1]
          : word === undefined
            ? undefined
            : /^--config=(.+)$/su.exec(word)?.[1];
      const path = named === undefined ? undefined : resolvePath(dir, named);
      if (
        path !== undefined &&
        [".json", ...MODULE_EXTENSIONS].some((extension) => path.endsWith(extension)) &&
        isProjectPath(root, path) &&
        host.kindOf(path) === "file"
      ) {
        found.push(path);
      }
    });
  }
  return found;
}

/** The decoded value of one JSON file, or undefined where it cannot be read or parsed. */
function readDocument(host: Host, path: string): unknown {
  try {
    return JSON.parse(host.readFile(path)) as unknown;
  } catch {
    return undefined;
  }
}

/** The configuration files one project holds and sits beside. */
interface ConfigurationFiles {
  /** Every own file that is a configuration module, with the form its name has. */
  readonly modules: readonly { readonly file: SourceFile; readonly form: string }[];
  /**
   * Every configuration module in a directory of the project that the program does not
   * hold, and every file such a file imports or re-exports by a relative specifier that
   * the program does not hold either, read where a parser is given.
   */
  readonly outside: readonly OutsideModule[];
  /**
   * Every JSON configuration file in a directory of the project's files or above one, every
   * JSON file a script's configuration flag names, and every JSON file below the target
   * root and in no `node_modules` a relative string of either names, read against each
   * manifest whose chain reaches it.
   */
  readonly documents: readonly ConfigurationDocument[];
}

/** Every string value one decoded JSON value holds at any depth. */
export function documentStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(documentStrings);
  }
  return isRecord(value) ? Object.values(value).flatMap(documentStrings) : [];
}

/** Every string literal and every template literal with no substitution one file writes. */
export function moduleStrings(
  file: SourceFile,
): readonly { readonly node: Node; readonly text: string }[] {
  const found: { node: Node; text: string }[] = [];
  const visit = (node: Node): void => {
    if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
      found.push({ node, text: node.text });
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return found;
}

/**
 * The configuration files of one project's own files below the target root. A module
 * is an own file; a JSON configuration file is read from each directory below the
 * target root, the root included, that holds an own file or is above one. Either sits
 * in a directory that holds a manifest. A document that cannot be read or parsed as
 * JSON holds no string.
 */
export function configurationFiles(
  host: Host,
  targetRoot: string,
  files: SourceFiles,
  parse?: ParseFile,
): ConfigurationFiles {
  const root = resolvePath(host.workingDirectory(), targetRoot);
  const manifests = new Map<string, boolean>();
  const holdsManifest = (dir: string): boolean => {
    let held = manifests.get(dir);
    if (held === undefined) {
      held = host.kindOf(joinPath(dir, MANIFEST)) === "file";
      manifests.set(dir, held);
    }
    return held;
  };

  const modules: { file: SourceFile; form: string }[] = [];
  const dirs = new Set<string>([root]);
  for (const file of files.byPath.values()) {
    const form = configurationModuleForm(basename(file.fileName));
    if (form !== undefined && holdsManifest(dirnamePath(file.fileName))) {
      modules.push({ file, form });
    }
    for (
      let dir = dirnamePath(file.fileName);
      relativePath(root, dir) !== undefined && !dirs.has(dir);
      dir = dirnamePath(dir)
    ) {
      dirs.add(dir);
    }
  }

  const pending: { path: string; manifestDir: string }[] = [];
  const named: { path: string; manifestDir: string }[] = [];
  for (const dir of [...dirs].sort()) {
    if (!holdsManifest(dir)) {
      continue;
    }
    let names: readonly string[];
    try {
      names = host
        .readDirectory(dir)
        .filter((entry) => !entry.directory && isConfigurationDocumentName(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch {
      names = [];
    }
    pending.push(...names.map((name) => ({ path: joinPath(dir, name), manifestDir: dir })));
    for (const path of scriptConfigurations(host, root, dir)) {
      const held = files.byName.get(path);
      if (path.endsWith(".json")) {
        pending.push({ path, manifestDir: dir });
      } else if (held !== undefined) {
        modules.push({ file: held, form: "a script's configuration flag" });
      } else {
        named.push({ path, manifestDir: dir });
      }
    }
  }

  // A document reached from two manifests is read against each, so a chain is keyed by both.
  const documents = new Map<string, { path: string; manifestDirs: string[]; strings: string[] }>();
  const unreadable = new Set<string>();
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    let document = documents.get(next.path);
    if (unreadable.has(next.path) || document?.manifestDirs.includes(next.manifestDir) === true) {
      continue;
    }
    if (document === undefined) {
      const value = readDocument(host, next.path);
      if (value === undefined) {
        unreadable.add(next.path);
        continue;
      }
      document = { path: next.path, manifestDirs: [], strings: documentStrings(value) };
      documents.set(next.path, document);
    }
    document.manifestDirs.push(next.manifestDir);
    for (const text of document.strings) {
      const path = RELATIVE_PREFIXES.some((prefix) => text.startsWith(prefix))
        ? resolvePath(dirnamePath(next.path), text)
        : undefined;
      if (
        path?.endsWith(".json") === true &&
        isProjectPath(root, path) &&
        host.kindOf(path) === "file"
      ) {
        pending.push({ path, manifestDir: next.manifestDir });
      }
    }
  }
  return {
    modules,
    documents: [...documents.values()],
    outside:
      parse === undefined
        ? []
        : outsideModules(host, [...dirs], files, holdsManifest, parse, named),
  };
}

/** The relative specifiers one file's imports and re-exports name. */
function relativeSpecifiers(file: SourceFile): readonly string[] {
  return file.statements.flatMap((statement) => {
    const specifier =
      isImportDeclaration(statement) || isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined;
    return specifier !== undefined &&
      isStringLiteral(specifier) &&
      RELATIVE_PREFIXES.some((prefix) => specifier.text.startsWith(prefix))
      ? [specifier.text]
      : [];
  });
}

/**
 * The paths one relative specifier from a configuration file may reach, in the order they
 * are tried: the path it names where that ends with a module extension, that path with its
 * JavaScript extension replaced by the TypeScript counterparts, that path with an
 * extension appended, and a directory's `index` with one appended. A data file such as
 * `./package.json` is no module, so it is no candidate.
 */
export function specifierCandidates(dir: string, specifier: string): readonly string[] {
  const path = resolvePath(dir, specifier);
  const candidates: string[] = [];
  if (APPENDED.some((extension) => path.endsWith(extension))) {
    candidates.push(path);
  }
  for (const [extension, counterparts] of COUNTERPARTS) {
    if (path.endsWith(extension)) {
      const stem = path.slice(0, -extension.length);
      candidates.push(...counterparts.map((one) => stem + one));
    }
  }
  candidates.push(...APPENDED.map((extension) => path + extension));
  candidates.push(...APPENDED.map((extension) => joinPath(path, `index${extension}`)));
  return candidates;
}

/** The file on disk one relative specifier from a configuration file reaches, or undefined. */
export function resolveRelativeSpecifier(
  host: Host,
  dir: string,
  specifier: string,
): string | undefined {
  return specifierCandidates(dir, specifier).find((path) => host.kindOf(path) === "file");
}

/**
 * The configuration modules of the directories that hold a manifest which the program
 * does not hold, and the files they import by a relative specifier, until no further
 * file joins. A file that cannot be read is skipped.
 */
function outsideModules(
  host: Host,
  dirs: readonly string[],
  files: SourceFiles,
  holdsManifest: (dir: string) => boolean,
  parse: ParseFile,
  named: readonly { readonly path: string; readonly manifestDir: string }[],
): readonly OutsideModule[] {
  const pending: { path: string; manifestDir: string }[] = [...named];
  for (const dir of [...dirs].sort()) {
    if (!holdsManifest(dir)) {
      continue;
    }
    let names: readonly string[];
    try {
      names = host
        .readDirectory(dir)
        .filter((entry) => !entry.directory && configurationModuleForm(entry.name) !== undefined)
        .map((entry) => entry.name)
        .sort();
    } catch {
      continue;
    }
    pending.push(...names.map((name) => ({ path: joinPath(dir, name), manifestDir: dir })));
  }
  const found = new Map<string, { file: SourceFile; manifestDirs: string[] }>();
  const unreadable = new Set<string>();
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    let outside = found.get(next.path);
    if (
      unreadable.has(next.path) ||
      files.byName.has(next.path) ||
      outside?.manifestDirs.includes(next.manifestDir) === true
    ) {
      continue;
    }
    if (outside === undefined) {
      let text: string;
      try {
        text = host.readFile(next.path);
      } catch {
        unreadable.add(next.path);
        continue;
      }
      outside = { file: parse(next.path, text), manifestDirs: [] };
      found.set(next.path, outside);
    }
    outside.manifestDirs.push(next.manifestDir);
    for (const specifier of relativeSpecifiers(outside.file)) {
      const reached = resolveRelativeSpecifier(host, dirnamePath(next.path), specifier);
      if (reached !== undefined) {
        pending.push({ path: reached, manifestDir: next.manifestDir });
      }
    }
  }
  return [...found.values()];
}

/** Every dependency the manifest in one directory declares, or none where it holds none to read. */
export function declaredIn(host: Host, dir: string): readonly string[] {
  let value: unknown;
  try {
    value = JSON.parse(host.readFile(joinPath(dir, MANIFEST)));
  } catch {
    return [];
  }
  if (!isRecord(value)) {
    return [];
  }
  const names = new Set<string>();
  for (const member of DEPENDENCY_MEMBERS) {
    const section = value[member];
    if (isRecord(section)) {
      Object.keys(section).forEach((name) => names.add(name));
    }
  }
  return [...names];
}

/** The dependencies one string uses: each it equals, or is followed by `/` and a subpath in. */
export function dependenciesNamed(text: string, declared: readonly string[]): readonly string[] {
  return declared.filter((name) => text === name || text.startsWith(`${name}/`));
}

/**
 * The own files one string names read against a directory: the file it names directly or
 * through the emit mapping, or the file it names with an extension the module resolution
 * appends. An empty string, one starting with `/` and one holding a glob character names
 * none.
 */
export function filesNamedBy(files: SourceFiles, dir: string, text: string): readonly SourceFile[] {
  if (text === "" || text.startsWith("/") || /[*?[{]/u.test(text)) {
    return [];
  }
  const path = resolvePath(dir, text);
  const direct = files.named(path);
  if (direct.length > 0) {
    return direct;
  }
  for (const extension of RESOLVED_EXTENSIONS) {
    const held = files.byName.get(path + extension);
    if (held !== undefined) {
      return [held];
    }
  }
  return [];
}
