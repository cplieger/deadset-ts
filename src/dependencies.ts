/**
 * The dependencies the target's manifest declares, and what the projects' own files
 * need from outside the target. A file needs a package it imports, re-exports from,
 * augments or references the types of, by name or through the file the specifier
 * resolves to; a compiler configuration needs one it names, and a configuration file a
 * tool loads needs each dependency its strings spell. A package one dependency pulls in
 * for itself is that dependency's need, not the target's.
 */

import {
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isNamespaceExport,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isNoSubstitutionTemplateLiteral,
  SyntaxKind,
  type Identifier,
  type Node,
  type SourceFile,
} from "@typescript/native/unstable/ast";
import {
  configurationFiles,
  declaredIn as declaredBeside,
  dependenciesNamed,
  moduleStrings,
  type ParseFile,
} from "./configuration-files.ts";
import type { FindingPosition } from "./finding.ts";
import type { Host } from "./host.ts";
import { nodeKey, packageScope, type Inventory } from "./inventory.ts";
import { dirnamePath, isAbsolutePath, joinPath, resolvePath } from "./paths.ts";
import type { DependencySection, Module } from "./ref.ts";
import { UNANSWERED } from "./query.ts";
import type { Handle, ProjectView } from "./session.ts";
import { sourceFilesOf } from "./source-files.ts";

const MANIFEST = "package.json";
const MODULES_DIR = "node_modules";
const MODULES_SEGMENT = `/${MODULES_DIR}/`;
const TYPES_SCOPE = "@types/";

/** The manifest sections a dependency is declared in, each by the selector its reference spells. */
const SECTIONS: readonly (readonly [string, DependencySection])[] = [
  ["dependencies", "dependency"],
  ["devDependencies", "dev-dependency"],
  ["peerDependencies", "peer-dependency"],
];

/** The owner of a use no declaration of the inventory holds: a configuration's. */
const PROJECT_OWNER = "";

/** One dependency the target's manifest declares. */
export interface DeclaredDependency {
  readonly name: string;
  readonly section: DependencySection;
  /** Where the manifest writes the dependency's key, below the target root. */
  readonly position: FindingPosition;
}

/** What the installed copy of one declared dependency states about itself. */
export interface InstalledDependency {
  /** Whether its manifest declares a command. */
  readonly command: boolean;
  /** The peer dependencies its manifest requires: every peer not marked optional. */
  readonly peers: readonly string[];
}

/** What one project's own files and configuration need from outside the target. */
export interface ProjectNeeds {
  /** Every package a use names or resolves to. */
  readonly packages: ReadonlySet<string>;
  /**
   * Per declaration of the inventory, the packages the uses written inside it name; a
   * use is held by the innermost declaration around it. The empty key holds what the
   * compiler configuration names, which no deletion removes.
   */
  readonly uses: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Whether the checker left a module specifier unanswered, so the project may use any
   * dependency the manifest declares.
   */
  readonly unanswered: boolean;
}

/** The run's dependency evidence. */
export interface Dependencies {
  /** The scope every dependency's reference is written in: the target's manifest. */
  readonly manifest: Module;
  /** Every declared dependency, in the order the manifest writes them. */
  readonly declared: readonly DeclaredDependency[];
  /** The installed copy of each declared dependency the run found, by name. */
  readonly installed: ReadonlyMap<string, InstalledDependency>;
  /** Every package some project needs. */
  readonly needed: ReadonlySet<string>;
  /**
   * Per deletion candidate, the declared dependencies whose last use in the target is
   * written inside it, sorted bytewise; a candidate holding no last use has no entry.
   */
  readonly lastUses: ReadonlyMap<string, readonly string[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One JSON document's decoded value, or undefined where it cannot be read or parsed. */
function readJSON(host: Host, path: string): { text: string; value: unknown } | undefined {
  let text: string;
  try {
    text = host.readFile(path);
  } catch {
    return undefined;
  }
  try {
    return { text, value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

/**
 * The package a bare module specifier names: its first segment, or its first two
 * where it starts with a scope. A relative, absolute or scheme-prefixed specifier and
 * a subpath import name no package.
 */
export function packageOfSpecifier(specifier: string): string | undefined {
  if (/^[./#]/u.test(specifier) || /^[^/]*:/u.test(specifier)) {
    return undefined;
  }
  const segments = specifier.split("/");
  const [first, second] = segments;
  if (first === undefined || first === "") {
    return undefined;
  }
  if (!first.startsWith("@")) {
    return first;
  }
  return second === undefined || second === "" || first === "@" ? undefined : `${first}/${second}`;
}

/** The package an installed file belongs to, read below the last dependency directory of its path. */
function packageOfPath(path: string): string | undefined {
  const at = path.lastIndexOf(MODULES_SEGMENT);
  return at < 0 ? undefined : packageOfSpecifier(path.slice(at + MODULES_SEGMENT.length));
}

/**
 * The packages a type reference names: the type package the compiler reads for it
 * where the program holds a file of one, else the package of that name, else both.
 */
function typePackages(name: string, programPackages: ReadonlySet<string>): readonly string[] {
  const named = packageOfSpecifier(name);
  if (named === undefined) {
    return [];
  }
  if (named.startsWith(TYPES_SCOPE)) {
    return [named];
  }
  const typed = TYPES_SCOPE + (named.startsWith("@") ? named.slice(1).replace("/", "__") : named);
  for (const candidate of [typed, named]) {
    if (programPackages.has(candidate)) {
      return [candidate];
    }
  }
  return [typed, named];
}

/**
 * The packages the compiler configuration of one project names: its type packages,
 * its JSX import source, the helper library it imports, its plugins, and every
 * package a configuration file it extends through is read from.
 */
function configurationPackages(
  host: Host,
  configFile: string,
  options: Readonly<Record<string, unknown>>,
  programPackages: ReadonlySet<string>,
): Set<string> {
  const found = new Set<string>();
  const add = (name: unknown): void => {
    const named = typeof name === "string" ? packageOfSpecifier(name) : undefined;
    if (named !== undefined) {
      found.add(named);
    }
  };
  const types = options["types"];
  if (Array.isArray(types)) {
    for (const name of types) {
      if (typeof name === "string") {
        typePackages(name, programPackages).forEach((one) => found.add(one));
      }
    }
  }
  add(options["jsxImportSource"]);
  if (options["importHelpers"] === true) {
    found.add("tslib");
  }
  const plugins = options["plugins"];
  if (Array.isArray(plugins)) {
    for (const plugin of plugins) {
      add(isRecord(plugin) ? plugin["name"] : undefined);
    }
  }

  // A local `extends` is followed, because that file is the project's configuration
  // too; a package's configuration is that package's.
  const seen = new Set<string>();
  const pending = [configFile];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const read = readJSON(host, file);
    const extended = isRecord(read?.value) ? read.value["extends"] : undefined;
    for (const entry of Array.isArray(extended) ? extended : [extended]) {
      if (typeof entry !== "string") {
        continue;
      }
      if (entry.startsWith(".") || isAbsolutePath(entry)) {
        const local = resolvePath(dirnamePath(file), entry);
        pending.push(local.endsWith(".json") ? local : `${local}.json`);
      } else {
        add(entry);
      }
    }
  }
  return found;
}

/** A node that carries its own text: a name, or a literal module specifier. */
type Texted = Node & { readonly text: string };

/** Whether one node is a string the source writes literally, which a module specifier is. */
function isLiteralText(node: Node): node is Texted {
  return isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node);
}

/** The import declaration one module specifier is written in, if it is an import's. */
function importOf(specifier: Node): Node | undefined {
  const parent = specifier.parent as Node | undefined;
  if (parent !== undefined && isExternalModuleReference(parent)) {
    return parent.parent;
  }
  return parent;
}

/** The local names one import declaration binds. */
function bindingsOf(node: Node | undefined): readonly Texted[] {
  if (node === undefined) {
    return [];
  }
  if (isImportEqualsDeclaration(node)) {
    return [node.name];
  }
  if (!isImportDeclaration(node) || node.importClause === undefined) {
    return [];
  }
  const clause = node.importClause;
  const names: Texted[] = clause.name === undefined ? [] : [clause.name];
  const bindings = clause.namedBindings;
  if (bindings !== undefined) {
    if (bindings.kind === SyntaxKind.NamespaceImport) {
      names.push(bindings.name);
    } else {
      names.push(...bindings.elements.map((element) => element.name));
    }
  }
  return names;
}

/**
 * Every package one project needs, and which declaration each use is written in.
 * One local walk and one batched resolution per file: a use of an import binding is
 * an identifier resolving to the binding's own symbol, so a local declaration that
 * shadows the name is not one. A string of a configuration file uses each dependency
 * the manifest beside the file declares that it spells.
 */
export function projectNeeds<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  host: Host,
  targetRoot: string,
  parse?: ParseFile,
): ProjectNeeds {
  const programPackages = new Set<string>();
  for (const name of project.program.getSourceFileNames()) {
    const named = packageOfPath(name);
    if (named !== undefined) {
      programPackages.add(named);
    }
  }
  const packages = configurationPackages(
    host,
    project.configFile,
    project.program.getCompilerOptions() as Readonly<Record<string, unknown>>,
    programPackages,
  );
  const uses = new Map<string, Set<string>>();
  const use = (owners: readonly string[], named: Iterable<string>): void => {
    for (const one of named) {
      packages.add(one);
      for (const owner of owners) {
        let set = uses.get(owner);
        if (set === undefined) {
          set = new Set();
          uses.set(owner, set);
        }
        set.add(one);
      }
    }
  };
  use([PROJECT_OWNER], packages);

  let unanswered = false;
  for (const file of project.ownSourceFiles()) {
    unanswered = fileNeeds(project, held, file, programPackages, use) || unanswered;
  }

  const beside = new Map<string, readonly string[]>();
  const declaredAt = (path: string): readonly string[] => {
    const dir = dirnamePath(path);
    let names = beside.get(dir);
    if (names === undefined) {
      names = declaredBeside(host, dir);
      beside.set(dir, names);
    }
    return names;
  };
  const configuration = configurationFiles(
    host,
    targetRoot,
    sourceFilesOf(project, targetRoot),
    parse,
  );
  for (const { file } of configuration.modules) {
    const names = declaredAt(file.fileName);
    for (const { node, text } of moduleStrings(file)) {
      use(ownersOf(file, held, node), dependenciesNamed(text, names));
    }
  }
  for (const document of configuration.documents) {
    const names = declaredAt(document.path);
    for (const text of document.strings) {
      use([PROJECT_OWNER], dependenciesNamed(text, names));
    }
  }
  for (const { file, manifestDir } of configuration.outside) {
    const names = declaredAt(joinPath(manifestDir, "package.json"));
    for (const { text } of moduleStrings(file)) {
      use([PROJECT_OWNER], dependenciesNamed(text, names));
    }
  }
  return { packages, uses, unanswered };
}

/** The declarations of the inventory a use written at one node belongs to. */
function ownersOf(file: SourceFile, held: Inventory, node: Node): readonly string[] {
  const parent = node.parent as Node | undefined;
  // A re-export names its module once for every specifier it declares, so the use is
  // each specifier's: deleting one of two leaves the module used.
  if (parent !== undefined && isExportDeclaration(parent) && parent.exportClause !== undefined) {
    const clause = parent.exportClause;
    const declared = isNamespaceExport(clause) ? [clause] : clause.elements;
    const owners = declared
      .map((one) => held.declarations.get(nodeKey(file, one)))
      .filter((id): id is string => id !== undefined);
    if (owners.length > 0) {
      return owners;
    }
  }
  for (let at: Node | undefined = node; at !== undefined; at = at.parent as Node | undefined) {
    const id = held.declarations.get(nodeKey(file, at));
    if (id !== undefined) {
      return [id];
    }
  }
  return [PROJECT_OWNER];
}

/** Records the needs of one file, and answers whether a specifier of it went unanswered. */
function fileNeeds<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  file: SourceFile,
  programPackages: ReadonlySet<string>,
  use: (owners: readonly string[], named: Iterable<string>) => void,
): boolean {
  const specifiers = [...file.imports, ...file.moduleAugmentations].filter(isLiteralText);
  const bindings: { readonly node: Texted; readonly specifier: Texted }[] = [];
  const bound = new Set<Node>();
  const binding = new Set<Node>();
  for (const specifier of specifiers) {
    const names = bindingsOf(importOf(specifier));
    if (names.length > 0) {
      binding.add(specifier);
    }
    for (const name of names) {
      bindings.push({ node: name, specifier });
      bound.add(name);
    }
  }
  const names = new Set(bindings.map(({ node }) => node.text));
  const candidates: Identifier[] = [];
  const visit = (node: Node): void => {
    if (isIdentifier(node) && names.has(node.text) && !bound.has(node)) {
      candidates.push(node);
    }
    node.forEachChild(visit);
  };
  if (names.size > 0) {
    visit(file);
  }

  const asked = [...specifiers, ...bindings.map(({ node }) => node), ...candidates];
  const handles: Handle<Brand>[] = asked.map((node) => project.handle(node));
  const resolved = project.symbolsAt(handles);

  const packagesOf = new Map<Node, readonly string[]>();
  specifiers.forEach((specifier, index) => {
    const named = new Set<string>();
    const byName = packageOfSpecifier(specifier.text);
    if (byName !== undefined) {
      named.add(byName);
    }
    const symbol = resolved[index];
    for (const declaration of typeof symbol === "object" ? symbol.declarations : []) {
      const byPath = packageOfPath(declaration.path);
      if (byPath !== undefined) {
        named.add(byPath);
      }
    }
    packagesOf.set(specifier, [...named]);
  });

  // A name the checker could not resolve counts as a use of every package a binding of
  // that name brings in, so a gap never makes a dependency read as unused.
  const bySymbol = new Map<number, readonly string[]>();
  const byName = new Map<string, string[]>();
  const unresolvedNames = new Set<string>();
  bindings.forEach(({ node, specifier }, index) => {
    const packages = packagesOf.get(specifier) ?? [];
    byName.set(node.text, [...(byName.get(node.text) ?? []), ...packages]);
    const symbol = resolved[specifiers.length + index];
    if (symbol === UNANSWERED) {
      unresolvedNames.add(node.text);
    } else if (symbol !== undefined) {
      bySymbol.set(symbol.id, packages);
    }
  });

  for (const specifier of specifiers) {
    // An import that binds names is used where a binding is; any other form, a bare
    // import, a re-export, an `import()` or an augmentation, is a use where it stands.
    const owners = binding.has(specifier) ? [] : ownersOf(file, held, specifier);
    use(owners, packagesOf.get(specifier) ?? []);
  }

  const offset = specifiers.length + bindings.length;
  candidates.forEach((node, index) => {
    let symbol = resolved[offset + index];
    const parent = node.parent as Node | undefined;
    if (parent !== undefined && isShorthandPropertyAssignment(parent) && parent.name === node) {
      symbol = project.shorthandValueAt(project.handle(node));
    }
    const named =
      symbol === UNANSWERED || (unresolvedNames.has(node.text) && symbol === undefined)
        ? byName.get(node.text)
        : symbol === undefined
          ? undefined
          : (bySymbol.get(symbol.id) ??
            (unresolvedNames.has(node.text) ? byName.get(node.text) : undefined));
    if (named !== undefined) {
      use(ownersOf(file, held, node), named);
    }
  });

  for (const reference of file.typeReferenceDirectives) {
    use(ownersOf(file, held, file), typePackages(reference.fileName, programPackages));
  }
  return resolved.slice(0, specifiers.length).includes(UNANSWERED);
}

/** The offset just past the JSON value that starts at `at` in text the parser has accepted. */
function valueEnd(text: string, at: number): number {
  const first = text.charAt(at);
  if (first === '"') {
    let end = at + 1;
    while (end < text.length && text.charAt(end) !== '"') {
      end += text.charAt(end) === "\\" ? 2 : 1;
    }
    return end + 1;
  }
  if (first === "{" || first === "[") {
    let depth = 0;
    let end = at;
    while (end < text.length) {
      const one = text.charAt(end);
      if (one === '"') {
        end = valueEnd(text, end);
        continue;
      }
      if (one === "{" || one === "[") {
        depth += 1;
      } else if (one === "}" || one === "]") {
        depth -= 1;
        if (depth === 0) {
          return end + 1;
        }
      }
      end += 1;
    }
    return end;
  }
  let end = at;
  while (end < text.length && !",}] \t\n\r".includes(text.charAt(end))) {
    end += 1;
  }
  return end;
}

/** The offset of the first character at or after `at` that is not JSON whitespace. */
function skipWhitespace(text: string, at: number): number {
  let end = at;
  while (end < text.length && " \t\n\r".includes(text.charAt(end))) {
    end += 1;
  }
  return end;
}

/**
 * Each member of the object starting at `at`, by its decoded key, at the offset of the
 * key's opening quote and of its value. A key written twice is its last occurrence,
 * which is the one the parser kept.
 */
function membersAt(text: string, at: number): Map<string, { key: number; value: number }> {
  const found = new Map<string, { key: number; value: number }>();
  if (text.charAt(at) !== "{") {
    return found;
  }
  let cursor = skipWhitespace(text, at + 1);
  while (text.charAt(cursor) === '"') {
    const keyEnd = valueEnd(text, cursor);
    const key = JSON.parse(text.slice(cursor, keyEnd)) as string;
    const value = skipWhitespace(text, skipWhitespace(text, keyEnd) + 1);
    found.delete(key);
    found.set(key, { key: cursor, value });
    cursor = skipWhitespace(text, valueEnd(text, value));
    if (text.charAt(cursor) === ",") {
      cursor = skipWhitespace(text, cursor + 1);
    }
  }
  return found;
}

/** The line and column of one offset, a CR, an LF and a CRLF each ending a line. */
function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let start = 0;
  for (let at = 0; at < offset; at += 1) {
    const one = text.charAt(at);
    if (one === "\n" || (one === "\r" && text.charAt(at + 1) !== "\n")) {
      line += 1;
      start = at + 1;
    }
  }
  return { line, column: offset - start + 1 };
}

/** The installed copy of one dependency, read where the package manager puts it for the target. */
function installedOf(host: Host, root: string, name: string): InstalledDependency | undefined {
  for (let dir = root; ; dir = dirnamePath(dir)) {
    const read = readJSON(host, joinPath(dir, MODULES_DIR, name, MANIFEST));
    if (read !== undefined && isRecord(read.value)) {
      const manifest = read.value;
      const bin = manifest["bin"];
      const peers = manifest["peerDependencies"];
      const meta = isRecord(manifest["peerDependenciesMeta"])
        ? manifest["peerDependenciesMeta"]
        : {};
      return {
        command:
          (typeof bin === "string" && bin !== "") || (isRecord(bin) && Object.keys(bin).length > 0),
        peers: isRecord(peers)
          ? Object.keys(peers).filter((peer) => {
              const about = meta[peer];
              return !(isRecord(about) && about["optional"] === true);
            })
          : [],
      };
    }
    if (dirnamePath(dir) === dir) {
      return undefined;
    }
  }
}

/** Every dependency the manifest text declares, in the order the text writes them. */
function declaredIn(text: string, manifest: Record<string, unknown>): DeclaredDependency[] {
  const sections = membersAt(text, skipWhitespace(text, 0));
  const declared: { readonly dependency: DeclaredDependency; readonly at: number }[] = [];
  for (const [member, section] of SECTIONS) {
    const value = manifest[member];
    const held = sections.get(member);
    if (!isRecord(value) || held === undefined) {
      continue;
    }
    for (const [name, { key }] of membersAt(text, held.value)) {
      const { line, column } = lineAndColumn(text, key);
      declared.push({
        dependency: { name, section, position: { path: MANIFEST, line, column, endLine: line } },
        at: key,
      });
    }
  }
  return declared.sort((a, b) => a.at - b.at).map(({ dependency }) => dependency);
}

/**
 * The run's dependency evidence: the target's manifest read with the position of every
 * dependency it declares, the installed copy of each, what the projects need, and the
 * last uses each deletion candidate holds.
 *
 * Only the manifest at the target root is read, as for entry points. A manifest the
 * program cannot read declares nothing.
 */
export function dependenciesOf(
  host: Host,
  targetRoot: string,
  perProject: readonly ProjectNeeds[],
  candidates: readonly string[],
): Dependencies {
  const read = readJSON(host, joinPath(targetRoot, MANIFEST));
  const manifest = isRecord(read?.value) ? read.value : undefined;
  const scope = packageScope(host, targetRoot)(MANIFEST);
  const declared =
    read !== undefined && manifest !== undefined ? declaredIn(read.text, manifest) : [];

  const root = resolvePath(host.workingDirectory(), targetRoot);
  const installed = new Map<string, InstalledDependency>();
  for (const dependency of declared) {
    if (!installed.has(dependency.name)) {
      const found = installedOf(host, root, dependency.name);
      if (found !== undefined) {
        installed.set(dependency.name, found);
      }
    }
  }

  // A declaration several projects compile is one user, and a use any project makes is
  // a use, so the uses are merged by declaration before anything is counted.
  const needed = new Set<string>();
  const uses = new Map<string, Set<string>>();
  for (const project of perProject) {
    // A specifier the checker left unanswered may resolve to any declared dependency,
    // and what the configuration needs is never deleted, so it is needed there.
    const unknown = project.unanswered ? declared.map((dependency) => dependency.name) : [];
    const held = unknown.length === 0 ? [] : [[PROJECT_OWNER, new Set(unknown)] as const];
    for (const [id, used] of [...project.uses, ...held]) {
      const merged = uses.get(id) ?? new Set<string>();
      used.forEach((one) => merged.add(one));
      uses.set(id, merged);
    }
    [...project.packages, ...unknown].forEach((one) => needed.add(one));
  }
  const users = new Map<string, number>();
  for (const used of uses.values()) {
    used.forEach((one) => users.set(one, (users.get(one) ?? 0) + 1));
  }
  const names = new Set(declared.map((dependency) => dependency.name));
  const lastUses = new Map<string, readonly string[]>();
  for (const id of candidates) {
    const sole = [...(uses.get(id) ?? [])].filter((one) => users.get(one) === 1 && names.has(one));
    if (sole.length > 0) {
      lastUses.set(
        id,
        sole.sort((a, b) => (a < b ? -1 : 1)),
      );
    }
  }
  return { manifest: scope, declared, installed, needed, lastUses };
}
