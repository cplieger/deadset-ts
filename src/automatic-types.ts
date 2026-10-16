/**
 * The global names and ambient modules of the `@types` packages a compiler before version 6
 * includes automatically: every package of each type root when the configuration lists no
 * `types`. Version 6 and later include none, so the analysis program holds none of their
 * declarations, and a use of one resolves to nothing; each such use is a use of the package.
 */

import {
  isClassDeclaration,
  isEnumDeclaration,
  isExportAssignment,
  isExportDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isInterfaceDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableStatement,
  SyntaxKind,
  type Node,
  type SourceFile,
  type Statement,
} from "@typescript/native/ast";
import type { ParseFile } from "./configuration-files.ts";
import type { Host } from "./host.ts";
import { ancestors, dirnamePath, joinPath, resolvePath } from "./paths.ts";
import { entriesOf } from "./fs/tree.ts";
import { manifestAt } from "./fs/manifest.ts";

const TYPE_ROOT = "node_modules/@types";

/** What the automatically included `@types` packages of one configuration declare. */
export interface AutomaticTypes {
  /** Per global name, the packages that declare it. */
  readonly globals: ReadonlyMap<string, readonly string[]>;
  /** Per ambient module name, the packages that declare it. */
  readonly modules: ReadonlyMap<string, readonly string[]>;
}

const NONE: AutomaticTypes = { globals: new Map(), modules: new Map() };

/** What one installed type package declares, by its directory. */
interface PackageDeclarations {
  readonly globals: readonly string[];
  readonly modules: readonly string[];
}

/**
 * The packages each host has read, so a run's configurations share one reading of a type
 * root; a host reads one unchanging tree for its whole life.
 */
const READ = new WeakMap<Host, Map<string, PackageDeclarations>>();

/** Whether one file is a module: it imports, exports or assigns an export at its top level. */
function isModuleFile(file: SourceFile): boolean {
  return file.statements.some(
    (statement) =>
      isImportDeclaration(statement) ||
      isImportEqualsDeclaration(statement) ||
      isExportDeclaration(statement) ||
      isExportAssignment(statement) ||
      ((statement as { readonly modifiers?: readonly Node[] }).modifiers ?? []).some(
        (modifier) => modifier.kind === SyntaxKind.ExportKeyword,
      ),
  );
}

/** The names one statement of a global scope declares, and the ambient modules it declares. */
function declared(statement: Statement, globals: string[], modules: string[]): void {
  if (isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (isIdentifier(declaration.name)) {
        globals.push(declaration.name.text);
      }
    }
  } else if (
    isFunctionDeclaration(statement) ||
    isClassDeclaration(statement) ||
    isInterfaceDeclaration(statement) ||
    isTypeAliasDeclaration(statement) ||
    isEnumDeclaration(statement)
  ) {
    if (statement.name !== undefined) {
      globals.push(statement.name.text);
    }
  } else if (isModuleDeclaration(statement)) {
    if (isStringLiteral(statement.name)) {
      modules.push(statement.name.text);
    } else {
      globals.push(statement.name.text);
    }
  }
}

/**
 * What one declaration file declares in the global scope: its top level where it is no
 * module, and the body of each `declare global` block where it is one.
 */
function fileDeclarations(file: SourceFile, globals: string[], modules: string[]): void {
  if (!isModuleFile(file)) {
    file.statements.forEach((statement) => {
      declared(statement, globals, modules);
    });
    return;
  }
  for (const statement of file.statements) {
    if (
      isModuleDeclaration(statement) &&
      isIdentifier(statement.name) &&
      statement.name.text === "global" &&
      statement.body !== undefined &&
      isModuleBlock(statement.body)
    ) {
      statement.body.statements.forEach((inner) => {
        declared(inner, globals, modules);
      });
    }
  }
}

/** The entry declaration file of one installed type package's directory. */
function entryOf(host: Host, dir: string): string {
  const manifest = manifestAt(host, dir);
  const named = manifest?.["types"] ?? manifest?.["typings"];
  if (typeof named === "string" && named !== "") {
    const path = resolvePath(dir, named);
    return path.endsWith(".ts") ? path : `${path}.d.ts`;
  }
  return joinPath(dir, "index.d.ts");
}

/**
 * Every global name and ambient module one installed type package declares: in its entry
 * file and each file a `/// <reference path>` of a file read reaches, inside the package.
 */
function packageDeclarations(host: Host, dir: string, parse: ParseFile): PackageDeclarations {
  const known = READ.get(host) ?? new Map<string, PackageDeclarations>();
  READ.set(host, known);
  const held = known.get(dir);
  if (held !== undefined) {
    return held;
  }
  const globals: string[] = [];
  const modules: string[] = [];
  const seen = new Set<string>();
  const pending = [entryOf(host, dir)];
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    if (seen.has(path) || !path.startsWith(`${dir}/`)) {
      continue;
    }
    seen.add(path);
    let text: string;
    try {
      text = host.readFile(path);
    } catch {
      continue;
    }
    const file = parse(path, text);
    fileDeclarations(file, globals, modules);
    for (const reference of file.referencedFiles) {
      pending.push(resolvePath(dirnamePath(path), reference.fileName));
    }
  }
  const found = { globals, modules };
  known.set(dir, found);
  return found;
}

/**
 * What the `@types` packages a compiler before version 6 would include for one
 * configuration declare: none where its options list `types`, else every package of each
 * `node_modules/@types` directory at or above the configuration's directory, the nearest
 * holding a name winning.
 */
export function automaticTypes(
  host: Host,
  configFile: string,
  options: Readonly<Record<string, unknown>>,
  parse: ParseFile,
): AutomaticTypes {
  if (options["types"] !== undefined) {
    return NONE;
  }
  const globals = new Map<string, string[]>();
  const modules = new Map<string, string[]>();
  const add = (into: Map<string, string[]>, name: string, named: string): void => {
    const held = into.get(name) ?? [];
    if (!held.includes(named)) {
      into.set(name, [...held, named]);
    }
  };
  const read = new Set<string>();
  for (const root of typeRoots(configFile, options)) {
    for (const entry of entriesOf(host, root)) {
      if (read.has(entry.name) || host.kindOf(joinPath(root, entry.name)) !== "directory") {
        continue;
      }
      read.add(entry.name);
      const named = `@types/${entry.name}`;
      const found = packageDeclarations(host, joinPath(root, entry.name), parse);
      found.globals.forEach((name) => {
        add(globals, name, named);
      });
      found.modules.forEach((name) => {
        add(modules, name, named);
      });
    }
  }
  return { globals, modules };
}

/**
 * The type roots of one configuration that a package manager installs into: those its
 * `typeRoots` lists, else each `node_modules/@types` directory at or above its directory.
 */
function typeRoots(configFile: string, options: Readonly<Record<string, unknown>>): string[] {
  const listed = options["typeRoots"];
  if (Array.isArray(listed)) {
    return listed.filter(
      (root): root is string => typeof root === "string" && root.endsWith(`/${TYPE_ROOT}`),
    );
  }
  return ancestors(dirnamePath(configFile)).map((dir) => joinPath(dir, TYPE_ROOT));
}
