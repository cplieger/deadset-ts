/**
 * The configuration files a tool loads by name, and the strings they hold. A file in a
 * directory that holds a `package.json` is a configuration module when its name is
 * `<stem>.config.<ext>`, `<stem>.<qualifier>.config.<ext>` or `.<stem>rc.<ext>`, and a
 * JSON configuration file when its name is the JSON form of one of them. A tool reads
 * every string either holds as it likes, so each one that spells a declared dependency
 * uses it and each relative one that names a source file of the program roots the file.
 */

import {
  isCallExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
  SyntaxKind,
  type Node,
  type SourceFile,
} from "@typescript/native/ast";
import type { Host } from "./host.ts";
import { ancestors, dirnamePath, joinPath, relativePath, resolvePath } from "./paths.ts";
import type { SourceFiles } from "./source-files.ts";
import { bytewise } from "./text/compare.ts";
import { isRecord } from "./json-document.ts";
import { filesIn } from "./fs/tree.ts";
import {
  DEPENDENCY_SECTIONS,
  holdsManifest,
  inInstalledPackages,
  manifestAt,
  readJSON,
} from "./fs/manifest.ts";
import { readCommands } from "./commands/read.ts";
import { manifestCommands } from "./manifest.ts";

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

/** The file's name, the last segment of its path. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Whether one path is the project's own: below the target root and in no `node_modules`. */
function isProjectPath(root: string, path: string): boolean {
  const below = relativePath(root, path);
  return below !== undefined && !inInstalledPackages(below);
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
export interface OutsideModule {
  /** The file, parsed alone. */
  readonly file: SourceFile;
  /** The directories of the manifests of the configuration files the file was reached from. */
  readonly manifestDirs: readonly string[];
}

/** The extensions of a module a configuration flag may name. */
const MODULE_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"] as const;

/**
 * The files the command strings of the manifest in one directory name after a configuration
 * flag, as `commands/read.ts` reads them against the directory each command runs in, each a
 * JSON file or a module below the target root and in no `node_modules`.
 */
function scriptConfigurations(host: Host, root: string, dir: string): readonly string[] {
  const manifest = manifestAt(host, dir);
  const found: string[] = [];
  for (const { command } of manifest === undefined ? [] : manifestCommands(host, dir, manifest)) {
    for (const { dir: runs, written } of readCommands(command, dir).configurations) {
      const path = resolvePath(runs, written);
      if (
        [".json", ...MODULE_EXTENSIONS].some((extension) => path.endsWith(extension)) &&
        isProjectPath(root, path) &&
        host.kindOf(path) === "file"
      ) {
        found.push(path);
      }
    }
  }
  return found;
}

/** The configuration files one project holds and sits beside. */
interface ConfigurationFiles {
  /**
   * Every own file that is a configuration module, with the form its name has and the
   * directory of the manifest whose dependencies its strings are read against.
   */
  readonly modules: readonly {
    readonly file: SourceFile;
    readonly form: string;
    readonly manifestDir: string;
  }[];
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
  const manifestHeld = (dir: string): boolean => {
    let held = manifests.get(dir);
    if (held === undefined) {
      held = holdsManifest(host, dir);
      manifests.set(dir, held);
    }
    return held;
  };

  const modules: { file: SourceFile; form: string; manifestDir: string }[] = [];
  const dirs = new Set<string>([root]);
  for (const file of files.byPath.values()) {
    const form = configurationModuleForm(basename(file.fileName));
    const fileDir = dirnamePath(file.fileName);
    if (form !== undefined && manifestHeld(fileDir)) {
      modules.push({ file, form, manifestDir: fileDir });
    }
    for (const dir of ancestors(dirnamePath(file.fileName), root)) {
      if (dirs.has(dir)) {
        break;
      }
      dirs.add(dir);
    }
  }

  const pending: { path: string; manifestDir: string }[] = [];
  const named: { path: string; manifestDir: string }[] = [];
  for (const dir of [...dirs].sort(bytewise)) {
    if (!manifestHeld(dir)) {
      continue;
    }
    const names = filesIn(host, dir, isConfigurationDocumentName);
    pending.push(...names.map((name) => ({ path: joinPath(dir, name), manifestDir: dir })));
    for (const path of scriptConfigurations(host, root, dir)) {
      const held = files.byName.get(path);
      if (path.endsWith(".json")) {
        pending.push({ path, manifestDir: dir });
      } else if (held !== undefined) {
        modules.push({ file: held, form: "a script's configuration flag", manifestDir: dir });
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
      const value = readJSON(host, next.path);
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
        : outsideModules(host, root, [...dirs], files, manifestHeld, parse, named),
  };
}

/** The literal module specifier one `require(...)` or `import(...)` call names, if any. */
function calledSpecifier(node: Node): Node | undefined {
  if (!isCallExpression(node) || node.arguments.length !== 1) {
    return undefined;
  }
  const callee = node.expression;
  const loads =
    callee.kind === SyntaxKind.ImportKeyword || (isIdentifier(callee) && callee.text === "require");
  return loads ? node.arguments[0] : undefined;
}

/**
 * The relative specifiers one file's imports and re-exports name, and those its
 * `require(...)` and `import(...)` calls name by a literal.
 */
export function relativeSpecifiers(file: SourceFile): readonly string[] {
  const known = specifiersOf.get(file);
  if (known !== undefined) {
    return known;
  }
  const found: string[] = [];
  const named = (specifier: Node | undefined): void => {
    if (
      specifier !== undefined &&
      (isStringLiteral(specifier) || isNoSubstitutionTemplateLiteral(specifier)) &&
      RELATIVE_PREFIXES.some((prefix) => specifier.text.startsWith(prefix))
    ) {
      found.push(specifier.text);
    }
  };
  const visit = (node: Node): void => {
    named(calledSpecifier(node));
    node.forEachChild(visit);
  };
  for (const statement of file.statements) {
    named(
      isImportDeclaration(statement) || isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined,
    );
    visit(statement);
  }
  specifiersOf.set(file, found);
  return found;
}

/** What {@link relativeSpecifiers} found in each file, which every project of a run reads alike. */
const specifiersOf = new WeakMap<SourceFile, readonly string[]>();

/**
 * The files no program holds that a chain from `seeds` reads: each seed, and each file
 * below the target root one imports, re-exports or loads by a relative specifier that no
 * program holds either, until no further file joins, each read against the manifest
 * directory its seed names. A file that cannot be read is skipped.
 */
export function outsideChain(
  host: Host,
  targetRoot: string,
  files: SourceFiles,
  parse: ParseFile,
  seeds: readonly { readonly path: string; readonly manifestDir: string }[],
): readonly OutsideModule[] {
  const root = resolvePath(host.workingDirectory(), targetRoot);
  return outsideModules(host, root, [], files, () => false, parse, seeds);
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
 * does not hold, and the project files below `root` they import by a relative specifier,
 * until no further file joins. A file that cannot be read is skipped.
 */
function outsideModules(
  host: Host,
  root: string,
  dirs: readonly string[],
  files: SourceFiles,
  manifestHeld: (dir: string) => boolean,
  parse: ParseFile,
  named: readonly { readonly path: string; readonly manifestDir: string }[],
): readonly OutsideModule[] {
  const pending: { path: string; manifestDir: string }[] = [...named];
  for (const dir of [...dirs].sort(bytewise)) {
    if (!manifestHeld(dir)) {
      continue;
    }
    const names = filesIn(host, dir, (name) => configurationModuleForm(name) !== undefined);
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
      if (reached !== undefined && isProjectPath(root, reached)) {
        pending.push({ path: reached, manifestDir: next.manifestDir });
      }
    }
  }
  return [...found.values()];
}

/** Every dependency the manifest in one directory declares, or none where it holds none to read. */
export function declaredIn(host: Host, dir: string): readonly string[] {
  const value = manifestAt(host, dir);
  if (value === undefined) {
    return [];
  }
  const names = new Set<string>();
  for (const member of DEPENDENCY_SECTIONS) {
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
