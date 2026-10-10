/**
 * The dependencies the target's manifest and its workspace members' manifests declare, and what the
 * projects' own files need from outside the target. A file needs a package it imports, re-exports
 * from, augments, references the types of or asks the runtime to resolve, by name or through the
 * file the specifier resolves to; a compiler configuration needs one it names, and a configuration
 * file a tool loads needs each dependency its strings spell. A package one dependency pulls in for
 * itself is that dependency's need, not the target's.
 */

import {
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isMetaProperty,
  isNamespaceExport,
  isPropertyAccessExpression,
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
import { scriptTokens } from "./manifest.ts";
import { dirnamePath, isAbsolutePath, joinPath, relativePath, resolvePath } from "./paths.ts";
import type { DependencySection, Module } from "./ref.ts";
import { UNANSWERED } from "./query.ts";
import type { Handle, ProjectView } from "./session.ts";
import { sourceFilesOf } from "./source-files.ts";
import { workflowTokens } from "./workflow-steps.ts";

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

/** One dependency a manifest the run reads declares. */
interface DeclaredDependency {
  readonly name: string;
  readonly section: DependencySection;
  /** Where the manifest writes the dependency's key, below the target root. */
  readonly position: FindingPosition;
  /** The scope the dependency's reference is written in: its manifest's. */
  readonly manifest: Module;
}

/** What a configuration's own reading needs: packages no deletion of a declaration removes. */
export function configurationNeeds(packages: readonly string[]): ProjectNeeds {
  return {
    packages: new Set(packages),
    uses: new Map([[PROJECT_OWNER, new Set(packages)]]),
    unanswered: [],
  };
}

/** What the installed copy of one declared dependency states about itself. */
interface InstalledDependency {
  /** The commands its manifest's `bin` declares, by name. */
  readonly commands: readonly string[];
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
   * The files writing a module specifier the checker left unanswered, each of which may
   * use any dependency a manifest at or above it declares.
   */
  readonly unanswered: readonly string[];
}

/** The run's dependency evidence. */
export interface Dependencies {
  /** Every declared dependency, manifest by manifest, in the order each writes them. */
  readonly declared: readonly DeclaredDependency[];
  /** Every package some project needs. */
  readonly needed: ReadonlySet<string>;
  /**
   * The declared dependencies whose command a script entry of the manifest declaring them,
   * or a workflow step for the target's manifest, runs, each by {@link declarationKey}.
   */
  readonly ran: ReadonlySet<string>;
  /**
   * The manifests, by their path below the target root, whose directory holds source only
   * in configurations the run could not build, so a dependency they declare that nothing
   * needs is reported at `possible`.
   */
  readonly unbuilt: ReadonlySet<string>;
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

  const unanswered: string[] = [];
  for (const file of project.ownSourceFiles()) {
    if (fileNeeds(project, held, file, programPackages, use)) {
      unanswered.push(file.fileName);
    }
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
  for (const { strings, manifestDirs } of configuration.documents) {
    for (const manifestDir of manifestDirs) {
      const names = declaredAt(joinPath(manifestDir, "package.json"));
      for (const text of strings) {
        use([PROJECT_OWNER], dependenciesNamed(text, names));
      }
    }
  }
  for (const { file, manifestDirs } of configuration.outside) {
    for (const manifestDir of manifestDirs) {
      const names = declaredAt(joinPath(manifestDir, "package.json"));
      for (const { text } of moduleStrings(file)) {
        use([PROJECT_OWNER], dependenciesNamed(text, names));
      }
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
  for (const specifier of resolvedSpecifiers(file)) {
    const named = packageOfSpecifier(specifier.text);
    if (named !== undefined) {
      use(ownersOf(file, held, specifier), [named]);
    }
  }
  return resolved.slice(0, specifiers.length).includes(UNANSWERED);
}

/**
 * The literal specifiers one file asks the runtime to resolve, through `import.meta.resolve`
 * or `require.resolve`, each of which needs the package it names installed.
 */
function resolvedSpecifiers(file: SourceFile): readonly Texted[] {
  const found: Texted[] = [];
  if (!file.text.includes(".resolve(")) {
    return found;
  }
  const visit = (node: Node): void => {
    if (isCallExpression(node) && isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      const [argument] = node.arguments;
      const receiver = callee.expression;
      const resolving =
        callee.name.text === "resolve" &&
        ((isMetaProperty(receiver) && receiver.name.text === "meta") ||
          (isIdentifier(receiver) && receiver.text === "require"));
      if (resolving && argument !== undefined && isLiteralText(argument)) {
        found.push(argument);
      }
    }
    node.forEachChild(visit);
  };
  visit(file);
  return found;
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
      const bin = read.value["bin"];
      // A string `bin` names one command, the package's name without its scope.
      return {
        commands:
          typeof bin === "string"
            ? bin === ""
              ? []
              : [name.slice(name.indexOf("/") + 1)]
            : isRecord(bin)
              ? Object.keys(bin)
              : [],
      };
    }
    if (dirnamePath(dir) === dir) {
      return undefined;
    }
  }
}

/** Every dependency the manifest text at `path` declares, in the order the text writes them. */
function declaredIn(
  text: string,
  manifest: Record<string, unknown>,
  path: string,
  scope: Module,
): DeclaredDependency[] {
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
        dependency: {
          name,
          section,
          position: { path, line, column, endLine: line },
          manifest: scope,
        },
        at: key,
      });
    }
  }
  return declared.sort((a, b) => a.at - b.at).map(({ dependency }) => dependency);
}

/** The key one declared dependency is known by: its manifest's path and its name. */
export function declarationKey(dependency: DeclaredDependency): string {
  return `${dependency.position.path}\u0000${dependency.name}`;
}

/** Every token of every value of one manifest's `scripts` member. */
function scriptTokensOf(manifest: Record<string, unknown>): ReadonlySet<string> {
  const scripts = manifest["scripts"];
  const found = new Set<string>();
  if (isRecord(scripts)) {
    for (const command of Object.values(scripts)) {
      if (typeof command === "string") {
        scriptTokens(command).forEach((token) => found.add(token));
      }
    }
  }
  return found;
}

/** Whether a path below the target root lies in the directory `dir` below it, `""` being the root. */
function isInside(path: string, dir: string): boolean {
  return dir === "" || path.startsWith(`${dir}/`);
}

/**
 * The run's dependency evidence: the target's manifest and each workspace member's in
 * `members` below the target root, read with the position of every dependency each
 * declares, what the projects and the commands its scripts and workflow steps run need,
 * and the last uses each deletion candidate holds. A member in `unbuilt` holds source only
 * in configurations the run could not build. A manifest the program cannot read declares
 * nothing.
 */
export function dependenciesOf(
  host: Host,
  targetRoot: string,
  perProject: readonly ProjectNeeds[],
  candidates: readonly string[],
  members: readonly string[] = [],
  unbuiltMembers: readonly string[] = [],
): Dependencies {
  const root = resolvePath(host.workingDirectory(), targetRoot);
  const scopeOf = packageScope(host, targetRoot);
  const manifests = new Map<string, string>([[root, MANIFEST]]);
  const unbuilt = new Set<string>();
  for (const dir of [...members, ...unbuiltMembers]) {
    const below = relativePath(root, dir);
    if (below !== undefined && !manifests.has(dir)) {
      manifests.set(dir, `${below}/${MANIFEST}`);
    }
  }
  for (const dir of unbuiltMembers) {
    const path = manifests.get(dir);
    if (path !== undefined && dir !== root) {
      unbuilt.add(path);
    }
  }
  const workflow = new Set(workflowTokens(host, targetRoot));
  const declared: DeclaredDependency[] = [];
  const ran = new Set<string>();
  for (const [dir, path] of manifests) {
    const read = readJSON(host, joinPath(dir, MANIFEST));
    if (read === undefined || !isRecord(read.value)) {
      continue;
    }
    const tokens = scriptTokensOf(read.value);
    for (const dependency of declaredIn(read.text, read.value, path, scopeOf(path))) {
      declared.push(dependency);
      const found = installedOf(host, dir, dependency.name);
      if (found === undefined) {
        continue;
      }
      const runs = (command: string): boolean =>
        tokens.has(command) || (dir === root && workflow.has(command));
      if (found.commands.some(runs)) {
        ran.add(declarationKey(dependency));
      }
    }
  }

  // A declaration several projects compile is one user, and a use any project makes is
  // a use, so the uses are merged by declaration before anything is counted.
  const needed = new Set<string>();
  const uses = new Map<string, Set<string>>();
  for (const project of perProject) {
    // A specifier the checker left unanswered may resolve to any dependency a manifest at
    // or above its file declares, and what the configuration needs is never deleted.
    const unanswered = project.unanswered.flatMap((file) => relativePath(root, file) ?? []);
    const unknown = declared
      .filter((dependency) => {
        const dir = dirnamePath(dependency.position.path);
        return unanswered.some((file) => isInside(file, dir === "." ? "" : dir));
      })
      .map((dependency) => dependency.name);
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
  return { declared, needed, ran, unbuilt, lastUses };
}
