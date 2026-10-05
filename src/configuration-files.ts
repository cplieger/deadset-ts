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
const RESOLVED_EXTENSIONS = [
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
  /** Every string value at any depth, in document order; a member's name is no value. */
  readonly strings: readonly string[];
}

/** Parses one file the program does not hold, with no type information. */
export type ParseFile = (fileName: string, text: string) => SourceFile;

/** One file no program holds that a configuration module outside the program leads to. */
export interface OutsideModule {
  /** The file, parsed alone. */
  readonly file: SourceFile;
  /** The directory of the configuration module the file was reached from, which holds its manifest. */
  readonly manifestDir: string;
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
  /** Every JSON configuration file in a directory of the project's files or above one. */
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

  const documents: ConfigurationDocument[] = [];
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
      continue;
    }
    for (const name of names) {
      const path = joinPath(dir, name);
      let value: unknown;
      try {
        value = JSON.parse(host.readFile(path));
      } catch {
        continue;
      }
      documents.push({ path, strings: documentStrings(value) });
    }
  }
  return {
    modules,
    documents,
    outside:
      parse === undefined ? [] : outsideModules(host, [...dirs], files, holdsManifest, parse),
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
 * The module one relative specifier from a configuration file reaches: the path it names,
 * that path with its JavaScript extension replaced by the TypeScript counterparts, that
 * path with an extension appended, and a directory's `index` with one appended.
 */
function reachedBy(host: Host, dir: string, specifier: string): string | undefined {
  const path = resolvePath(dir, specifier);
  const isFile = (candidate: string): boolean => host.kindOf(candidate) === "file";
  // A data file such as `./package.json` is no module, so its strings use no dependency.
  if (isFile(path) && APPENDED.some((extension) => path.endsWith(extension))) {
    return path;
  }
  for (const [extension, counterparts] of COUNTERPARTS) {
    if (path.endsWith(extension)) {
      const stem = path.slice(0, -extension.length);
      const found = counterparts.map((one) => stem + one).find(isFile);
      if (found !== undefined) {
        return found;
      }
    }
  }
  const appended = APPENDED.map((extension) => path + extension).find(isFile);
  if (appended !== undefined) {
    return appended;
  }
  return host.kindOf(path) === "directory"
    ? APPENDED.map((extension) => joinPath(path, `index${extension}`)).find(isFile)
    : undefined;
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
): readonly OutsideModule[] {
  const pending: { path: string; manifestDir: string }[] = [];
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
  const found: OutsideModule[] = [];
  const seen = new Set<string>();
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    if (seen.has(next.path) || files.byName.has(next.path)) {
      continue;
    }
    seen.add(next.path);
    let text: string;
    try {
      text = host.readFile(next.path);
    } catch {
      continue;
    }
    const file = parse(next.path, text);
    found.push({ file, manifestDir: next.manifestDir });
    for (const specifier of relativeSpecifiers(file)) {
      const reached = reachedBy(host, dirnamePath(next.path), specifier);
      if (reached !== undefined) {
        pending.push({ path: reached, manifestDir: next.manifestDir });
      }
    }
  }
  return found;
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
 * The own files one string names read against a directory: none unless it starts with
 * `./` or `../`, else the file it names directly or through the emit mapping, or the
 * file it names with an extension the module resolution appends.
 */
export function filesNamedBy(files: SourceFiles, dir: string, text: string): readonly SourceFile[] {
  if (!RELATIVE_PREFIXES.some((prefix) => text.startsWith(prefix)) || text.includes("*")) {
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
