/**
 * The dependencies the target's manifest and its workspace members' manifests declare, and what the
 * projects' own files need from outside the target. A file needs a package it imports, re-exports
 * from, augments, references the types of or asks the runtime to resolve, by name or through the
 * file the specifier resolves to; a compiler configuration needs one it names, and a configuration
 * file a tool loads needs each dependency its strings spell. A package one dependency pulls in for
 * itself is that dependency's need, not the target's.
 */

import {
  isArrayLiteralExpression,
  isCallExpression,
  isExportDeclaration,
  isExpressionStatement,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isMetaProperty,
  isNamespaceExport,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isNoSubstitutionTemplateLiteral,
  SyntaxKind,
  type Identifier,
  type Node,
  type SourceFile,
} from "@typescript/native/ast";
import { automaticTypes, type AutomaticTypes } from "./automatic-types.ts";
import {
  configurationFiles,
  declaredIn as declaredBeside,
  dependenciesNamed,
  moduleStrings,
  outsideChain,
  type OutsideModule,
  type ParseFile,
} from "./configuration-files.ts";
import type { FindingPosition } from "./finding.ts";
import type { Host } from "./host.ts";
import { nodeKey, packageScope, type Inventory } from "./inventory.ts";
import {
  ancestors,
  dirnamePath,
  isAbsolutePath,
  joinPath,
  relativePath,
  resolvePath,
} from "./paths.ts";
import type { DependencySection, Module } from "./ref.ts";
import { UNANSWERED } from "./query.ts";
import type { Handle, ProjectView } from "./session.ts";
import { sourceFilesOf, type SourceFiles } from "./source-files.ts";
import { workflowCommands, workflowTokens } from "./workflow-steps.ts";
import { bytewise } from "./text/compare.ts";
import { isRecord } from "./json-document.ts";
import { inInstalledPackages, INSTALLED_PACKAGES, MANIFEST, readDocument } from "./fs/manifest.ts";
import { commandsOf, scriptTokens } from "./text/shell.ts";

const MODULES_SEGMENT = `/${INSTALLED_PACKAGES}/`;
const TYPES_SCOPE = "@types/";

/** A script token naming a JavaScript file by a path no expansion changes. */
const SCRIPT_FILE = /^[^$`{*?[~]+\.(?:js|mjs|cjs)$/u;

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
    uses: new Map([[PROJECT_OWNER, new Set(packages)]]),
    at: new Map([[ANYWHERE, new Map(packages.map((one) => [one, new Set([PROJECT_OWNER])]))]]),
    unanswered: [],
  };
}

/** The key of {@link ProjectNeeds.at} for a use no file of the target governs. */
const ANYWHERE = "";

/** What the installed copy of one declared dependency states about itself. */
interface InstalledDependency {
  /** The commands its manifest's `bin` declares, by name. */
  readonly commands: readonly string[];
  /** The packages its manifest's `peerDependencies` names, optional ones included. */
  readonly peers: readonly string[];
}

/** What one project's own files and configuration need from outside the target. */
export interface ProjectNeeds {
  /**
   * Per declaration of the inventory, the packages the uses written inside it name; a
   * use is held by the innermost declaration around it. The empty key holds what the
   * compiler configuration names, which no deletion removes.
   */
  readonly uses: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Per absolute path of the file a use is written in, the packages it names, which a
   * dependency of the nearest manifest at or above that file declaring the name serves,
   * each with the owners {@link uses} holds it by; an import whose bindings nothing in the
   * file uses holds its package by none. The empty key holds the uses no one file holds,
   * which every manifest's dependency of that name serves.
   */
  readonly at: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
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
  /**
   * The declared dependencies, by {@link declarationKey}, a use written at or below their
   * manifest's directory needs, and each declared peer of a needed one.
   */
  readonly needed: ReadonlySet<string>;
  /**
   * The declared dependencies whose command a script entry of the manifest declaring them,
   * or a workflow step of the target, runs, each by {@link declarationKey}.
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
  /**
   * Per file, by its path below the target root, the declared dependencies whose every use
   * in the target is written in it, sorted bytewise, which deleting the file removes.
   */
  readonly fileLastUses: ReadonlyMap<string, readonly string[]>;
  /**
   * The needed declared dependencies, by {@link declarationKey}, each with the owners
   * {@link ProjectNeeds.uses} holds its uses by, sorted bytewise: none that a command runs,
   * that an unanswered specifier may need, that an import none of whose bindings is used
   * names, or that a dependency so needed names as a peer.
   */
  readonly heldBy: ReadonlyMap<string, readonly string[]>;
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
 * The strings the `extends` member of one compiler configuration file holds, read as the
 * compiler reads the file, comments and trailing commas allowed; none where it cannot be read.
 */
function extendsOf(host: Host, path: string, parse: ParseFile): readonly string[] {
  let text: string;
  try {
    text = host.readFile(path);
  } catch {
    return [];
  }
  const [statement] = parse(path, text).statements;
  const document =
    statement !== undefined && isExpressionStatement(statement) ? statement.expression : undefined;
  if (document === undefined || !isObjectLiteralExpression(document)) {
    return [];
  }
  const value = document.properties
    .filter(isPropertyAssignment)
    .findLast(
      (property) => isLiteralText(property.name) && property.name.text === "extends",
    )?.initializer;
  const entries = value !== undefined && isArrayLiteralExpression(value) ? value.elements : [value];
  return entries.flatMap((entry) =>
    entry !== undefined && isLiteralText(entry) ? [entry.text] : [],
  );
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
  parse: ParseFile,
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
    for (const entry of extendsOf(host, file, parse)) {
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
  parse: ParseFile,
): ProjectNeeds {
  const programPackages = new Set<string>();
  for (const name of project.program.getSourceFileNames()) {
    const named = packageOfPath(name);
    if (named !== undefined) {
      programPackages.add(named);
    }
  }
  const options = project.program.getCompilerOptions() as Readonly<Record<string, unknown>>;
  const packages = configurationPackages(host, project.configFile, options, programPackages, parse);
  const automatic = automaticTypes(host, project.configFile, options, parse);
  const uses = new Map<string, Set<string>>();
  const at = new Map<string, Map<string, Set<string>>>();
  const use = (owners: readonly string[], named: Iterable<string>, path: string): void => {
    for (const one of named) {
      const inFile = at.get(path) ?? new Map<string, Set<string>>();
      at.set(path, inFile);
      const holders = inFile.get(one) ?? new Set<string>();
      inFile.set(one, holders);
      for (const owner of owners) {
        holders.add(owner);
        let set = uses.get(owner);
        if (set === undefined) {
          set = new Set();
          uses.set(owner, set);
        }
        set.add(one);
      }
    }
  };
  use([PROJECT_OWNER], packages, project.configFile);

  const unanswered: string[] = [];
  for (const file of project.ownSourceFiles()) {
    const inFile = (owners: readonly string[], named: Iterable<string>): void => {
      use(owners, named, file.fileName);
    };
    if (fileNeeds(project, held, file, { programPackages, automatic }, inFile)) {
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
  const files = sourceFilesOf(project, targetRoot);
  const configuration = configurationFiles(host, targetRoot, files, parse);
  for (const { file, manifestDir } of configuration.modules) {
    const names = declaredAt(joinPath(manifestDir, MANIFEST));
    for (const { node, text } of moduleStrings(file)) {
      use(ownersOf(file, held, node), dependenciesNamed(text, names), file.fileName);
    }
  }
  for (const { strings, manifestDirs } of configuration.documents) {
    for (const manifestDir of manifestDirs) {
      const names = declaredAt(joinPath(manifestDir, MANIFEST));
      for (const text of strings) {
        use([PROJECT_OWNER], dependenciesNamed(text, names), joinPath(manifestDir, MANIFEST));
      }
    }
  }
  const ranFiles: readonly OutsideModule[] = outsideChain(
    host,
    targetRoot,
    files,
    parse,
    scriptRunFiles(host, targetRoot, files),
  );
  for (const { file, manifestDirs } of [...configuration.outside, ...ranFiles]) {
    for (const manifestDir of manifestDirs) {
      const names = declaredAt(joinPath(manifestDir, MANIFEST));
      for (const { text } of moduleStrings(file)) {
        use([PROJECT_OWNER], dependenciesNamed(text, names), joinPath(manifestDir, MANIFEST));
      }
    }
  }
  return { uses, at, unanswered };
}

/**
 * The JavaScript files no program holds that a script of a manifest at or above one of the
 * project's files runs, each with the directory of that manifest, and those a workflow
 * step or git hook runs, with the target root's: a token naming such a file below the
 * target root and in no `node_modules`, read against the manifest's directory.
 */
function scriptRunFiles(
  host: Host,
  targetRoot: string,
  files: SourceFiles,
): readonly { readonly path: string; readonly manifestDir: string }[] {
  const root = resolvePath(host.workingDirectory(), targetRoot);
  const dirs = new Set<string>([root]);
  for (const name of files.byName.keys()) {
    for (const dir of ancestors(dirnamePath(name), root)) {
      if (dirs.has(dir)) {
        break;
      }
      dirs.add(dir);
    }
  }
  const tokens = new Map<string, ReadonlySet<string>>([
    [root, new Set(workflowTokens(host, root))],
  ]);
  for (const dir of dirs) {
    const read = readDocument(host, joinPath(dir, MANIFEST));
    if (read !== undefined && isRecord(read.value)) {
      const own = scriptTokensOf(read.value);
      tokens.set(dir, dir === root ? new Set([...own, ...(tokens.get(root) ?? [])]) : own);
    }
  }
  const found: { path: string; manifestDir: string }[] = [];
  for (const [manifestDir, held] of tokens) {
    for (const token of held) {
      const path = SCRIPT_FILE.test(token) ? resolvePath(manifestDir, token) : undefined;
      const below = path === undefined ? undefined : relativePath(root, path);
      if (
        path !== undefined &&
        below !== undefined &&
        !inInstalledPackages(below) &&
        !files.byName.has(path) &&
        host.kindOf(path) === "file"
      ) {
        found.push({ path, manifestDir });
      }
    }
  }
  return found;
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

/**
 * Whether one identifier stands for a value or type of the scope it is written in, rather
 * than naming a member, a property or a label.
 */
function isScopeName(node: Identifier): boolean {
  const parent = node.parent as Node | undefined;
  if (parent === undefined || isShorthandPropertyAssignment(parent)) {
    return true;
  }
  const named = parent as {
    readonly name?: Node;
    readonly right?: Node;
    readonly propertyName?: Node;
    readonly label?: Node;
  };
  return (
    named.name !== node &&
    (parent.kind !== SyntaxKind.QualifiedName || named.right !== node) &&
    named.propertyName !== node &&
    named.label !== node
  );
}

/** What the packages a project's configuration brings in hold, which a file's needs are read against. */
interface ProgramTypes {
  /** The packages the program holds a file of. */
  readonly programPackages: ReadonlySet<string>;
  /** What the type packages a compiler would include automatically declare. */
  readonly automatic: AutomaticTypes;
}

/**
 * Records the needs of one file, and answers whether a specifier of it went unanswered. A
 * module specifier or a name of the file's scope that resolves to nothing, and that an
 * automatically included type package declares, uses that package.
 */
function fileNeeds<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  file: SourceFile,
  { programPackages, automatic }: ProgramTypes,
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
  const globals: Identifier[] = [];
  const visit = (node: Node): void => {
    if (isIdentifier(node) && !bound.has(node)) {
      if (names.has(node.text)) {
        candidates.push(node);
      } else if (automatic.globals.has(node.text) && isScopeName(node)) {
        globals.push(node);
      }
    }
    node.forEachChild(visit);
  };
  if (names.size > 0 || automatic.globals.size > 0) {
    visit(file);
  }

  const asked = [...specifiers, ...bindings.map(({ node }) => node), ...candidates, ...globals];
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
    if (symbol === undefined) {
      automatic.modules.get(specifier.text)?.forEach((one) => named.add(one));
    }
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
      symbol = project.shorthandValueAt(project.handle(parent));
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
  const unresolvedAt = offset + candidates.length;
  globals.forEach((node, index) => {
    const symbol = resolved[unresolvedAt + index];
    if (symbol === undefined || symbol === UNANSWERED) {
      use(ownersOf(file, held, node), automatic.globals.get(node.text) ?? []);
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
  let cursor = skipWhitespace(text, at + 1);
  while (text.charAt(cursor) === '"') {
    const keyEnd = valueEnd(text, cursor);
    const key = JSON.parse(text.slice(cursor, keyEnd)) as string;
    const value = skipWhitespace(text, skipWhitespace(text, keyEnd) + 1);
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
  for (const dir of ancestors(root)) {
    const read = readDocument(host, joinPath(dir, INSTALLED_PACKAGES, name, MANIFEST));
    if (read !== undefined && isRecord(read.value)) {
      const bin = read.value["bin"];
      const peers = read.value["peerDependencies"];
      // A string `bin` names one command, the package's name without its scope.
      return {
        peers: isRecord(peers) ? Object.keys(peers) : [],
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
  }
  return undefined;
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

/**
 * The runtime flags whose value is a module loaded before the entry, as `--flag value` or
 * `--flag=value`: https://nodejs.org/api/cli.html#--importmodule,
 * https://nodejs.org/api/cli.html#--experimental-loadermodule,
 * https://nodejs.org/api/cli.html#-r---require-module
 */
const PRELOAD_FLAGS: ReadonlySet<string> = new Set([
  "--experimental-loader",
  "--import",
  "--loader",
  "--require",
  "-r",
]);

/**
 * The programs that pass a preload flag to the runtime they start: Node itself, and the
 * runners that forward Node's flags or read the same `--require`:
 * https://mochajs.org/#-require-module-r-module, https://tsx.is/node-enhancement,
 * https://typestrong.org/ts-node/docs/options#require,
 * https://github.com/remy/nodemon#running-non-node-scripts
 */
const PRELOADING_PROGRAMS: ReadonlySet<string> = new Set([
  "mocha",
  "node",
  "nodemon",
  "ts-node",
  "tsx",
]);

/** The programs that run the command after them, and an environment assignment before it. */
const LAUNCHERS: ReadonlySet<string> = new Set(["cross-env", "env", "npx"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/**
 * The command strings one manifest runs: each of its `scripts`, and the `exec` command of
 * nodemon's configuration, in the manifest's `nodemonConfig` or the `nodemon.json` beside
 * it, which nodemon runs the watched script with:
 * https://github.com/remy/nodemon#config-files
 */
function manifestCommands(
  host: Host,
  dir: string,
  manifest: Record<string, unknown>,
): readonly string[] {
  const scripts = manifest["scripts"];
  const nodemon = [
    manifest["nodemonConfig"],
    readDocument(host, joinPath(dir, "nodemon.json"))?.value,
  ];
  return [
    ...(isRecord(scripts) ? Object.values(scripts) : []),
    ...nodemon.map((config) => (isRecord(config) ? config["exec"] : undefined)),
  ].filter((command): command is string => typeof command === "string");
}

/**
 * The packages `scripts` preload by a runtime flag's bare module specifier, a flag
 * counting only in a command whose program passes it to the runtime, and for Node only
 * before the script it runs, whose own arguments come after it.
 */
function preloadsOf(scripts: readonly string[]): ReadonlySet<string> {
  const found = new Set<string>();
  for (const script of scripts) {
    for (const command of commandsOf(script)) {
      const tokens = scriptTokens(command);
      let at = 0;
      while (
        at < tokens.length &&
        (ASSIGNMENT.test(tokens[at] ?? "") || LAUNCHERS.has(tokens[at] ?? ""))
      ) {
        at += 1;
      }
      const path = tokens[at] ?? "";
      const program = path.slice(path.lastIndexOf("/") + 1);
      if (!PRELOADING_PROGRAMS.has(program)) {
        continue;
      }
      for (at += 1; at < tokens.length; at += 1) {
        const token = tokens[at] ?? "";
        if (!token.startsWith("-")) {
          if (program === "node") {
            break;
          }
          continue;
        }
        const equals = token.indexOf("=");
        const flag = equals < 0 ? token : token.slice(0, equals);
        if (!PRELOAD_FLAGS.has(flag)) {
          continue;
        }
        if (equals < 0) {
          at += 1;
        }
        const value = equals < 0 ? tokens[at] : token.slice(equals + 1);
        const name = value === undefined ? undefined : packageOfSpecifier(value);
        if (name !== undefined) {
          found.add(name);
        }
      }
    }
  }
  return found;
}

/** Whether a path below the target root lies in the directory `dir` below it, `""` being the root. */
function isInside(path: string, dir: string): boolean {
  return dir === "" || path.startsWith(`${dir}/`);
}

/** The directory below the target root a declared dependency's manifest is in, `""` being the root. */
function manifestDir(dependency: DeclaredDependency): string {
  const dir = dirnamePath(dependency.position.path);
  return dir === "." ? "" : dir;
}

/**
 * The declarations of one name a use written at `below` needs: those of the nearest
 * manifest at or above it that declares the name, or every one for a use no file holds.
 */
function nearestDeclaring(
  declarations: readonly DeclaredDependency[],
  below: string | undefined,
): readonly DeclaredDependency[] {
  if (below === undefined) {
    return declarations;
  }
  const enclosing = declarations.filter((dependency) => isInside(below, manifestDir(dependency)));
  const nearest = Math.max(-1, ...enclosing.map((dependency) => manifestDir(dependency).length));
  return enclosing.filter((dependency) => manifestDir(dependency).length === nearest);
}

/**
 * Adds to `needed` each declared dependency that the installed manifest of a needed or
 * run declared dependency names as a peer, until no further one joins: the declaration of
 * that name in the needing dependency's manifest or in a manifest above it, where the
 * installed peer is resolved from. `peers` holds each declaration's installed peers by
 * {@link declarationKey}.
 */
function addNeededPeers(
  declared: readonly DeclaredDependency[],
  peers: ReadonlyMap<string, readonly string[]>,
  needed: Set<string>,
  ran: ReadonlySet<string>,
): void {
  const pending = declared.filter(
    (dependency) => needed.has(declarationKey(dependency)) || ran.has(declarationKey(dependency)),
  );
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const below = manifestDir(next);
    for (const peer of peers.get(declarationKey(next)) ?? []) {
      for (const dependency of declared) {
        const key = declarationKey(dependency);
        if (
          dependency.name === peer &&
          !needed.has(key) &&
          (below === manifestDir(dependency) || isInside(below, manifestDir(dependency)))
        ) {
          needed.add(key);
          pending.push(dependency);
        }
      }
    }
  }
}

/**
 * The run's dependency evidence over the target's manifest and those of `members` and
 * `nested` packages below the root: each declared dependency's position, what the projects,
 * scripts and workflow steps need, and each deletion candidate's last uses. A member in
 * `unbuilt` holds source only in configurations the run could not build. An unreadable
 * manifest declares nothing, nor does a nested package's uninstalled dependency, because
 * no run requires a nested package to be installed.
 */
export function dependenciesOf(
  host: Host,
  targetRoot: string,
  perProject: readonly ProjectNeeds[],
  candidates: readonly string[],
  members: readonly string[] = [],
  unbuiltMembers: readonly string[] = [],
  nested: readonly string[] = [],
): Dependencies {
  const root = resolvePath(host.workingDirectory(), targetRoot);
  const scopeOf = packageScope(host, targetRoot);
  const manifests = new Map<string, string>([[root, MANIFEST]]);
  const unbuilt = new Set<string>();
  for (const dir of [...members, ...unbuiltMembers, ...nested]) {
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
  const workflowPreloads = preloadsOf(workflowCommands(host, targetRoot));
  const declared: DeclaredDependency[] = [];
  const ran = new Set<string>();
  const peers = new Map<string, readonly string[]>();
  const uninstalledHere = new Set(nested);
  for (const [dir, path] of manifests) {
    const read = readDocument(host, joinPath(dir, MANIFEST));
    if (read === undefined || !isRecord(read.value)) {
      continue;
    }
    const tokens = scriptTokensOf(read.value);
    const preloads = preloadsOf(manifestCommands(host, dir, read.value));
    for (const dependency of declaredIn(read.text, read.value, path, scopeOf(path))) {
      const found = installedOf(host, dir, dependency.name);
      if (found === undefined && uninstalledHere.has(dir)) {
        continue;
      }
      declared.push(dependency);
      if (preloads.has(dependency.name) || workflowPreloads.has(dependency.name)) {
        ran.add(declarationKey(dependency));
      }
      if (found === undefined) {
        continue;
      }
      peers.set(declarationKey(dependency), found.peers);
      const runs = (command: string): boolean => tokens.has(command) || workflow.has(command);
      if (found.commands.some(runs)) {
        ran.add(declarationKey(dependency));
      }
    }
  }

  // A declaration several projects compile is one user, and a use any project makes is
  // a use, so the uses are merged by declaration before anything is counted.
  const needed = new Set<string>();
  const live = new Set<string>();
  const holders = new Map<string, Set<string>>();
  const byName = new Map<string, DeclaredDependency[]>();
  for (const dependency of declared) {
    byName.set(dependency.name, [...(byName.get(dependency.name) ?? []), dependency]);
  }
  const uses = new Map<string, Set<string>>();
  for (const project of perProject) {
    // A specifier the checker left unanswered may resolve to any dependency a manifest at
    // or above its file declares, and what the configuration needs is never deleted.
    const unanswered = project.unanswered.flatMap((file) => relativePath(root, file) ?? []);
    const unknownDeclared = declared.filter((dependency) =>
      unanswered.some((file) => isInside(file, manifestDir(dependency))),
    );
    for (const dependency of unknownDeclared) {
      needed.add(declarationKey(dependency));
      live.add(declarationKey(dependency));
    }
    const unknown = unknownDeclared.map((dependency) => dependency.name);
    const held = unknown.length === 0 ? [] : [[PROJECT_OWNER, new Set(unknown)] as const];
    for (const [id, used] of [...project.uses, ...held]) {
      const merged = uses.get(id) ?? new Set<string>();
      used.forEach((one) => merged.add(one));
      uses.set(id, merged);
    }
    for (const [path, named] of project.at) {
      const below = path === ANYWHERE ? undefined : relativePath(root, path);
      for (const [one, owners] of named) {
        // An import none of whose bindings is used is no evidence about the code using it.
        const unheld = owners.size === 0;
        for (const dependency of nearestDeclaring(byName.get(one) ?? [], below)) {
          const key = declarationKey(dependency);
          needed.add(key);
          if (unheld) {
            live.add(key);
          } else {
            const held = holders.get(key) ?? new Set<string>();
            owners.forEach((owner) => held.add(owner));
            holders.set(key, held);
          }
        }
      }
    }
  }
  addNeededPeers(declared, peers, needed, ran);
  addNeededPeers(declared, peers, live, ran);
  const heldBy = new Map<string, readonly string[]>();
  for (const [key, held] of holders) {
    if (!live.has(key) && !ran.has(key)) {
      heldBy.set(key, [...held].sort(bytewise));
    }
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
      lastUses.set(id, sole.sort(bytewise));
    }
  }
  const owners = new Map<string, Set<string>>();
  for (const [owner, used] of uses) {
    for (const one of used) {
      if (names.has(one)) {
        owners.set(one, (owners.get(one) ?? new Set<string>()).add(owner));
      }
    }
  }
  const fileLastUses = new Map<string, string[]>();
  for (const [one, held] of [...owners].sort(([a], [b]) => bytewise(a, b))) {
    const paths = new Set([...held].map((owner) => owner.replace(/:\d+:\d+$/u, "")));
    const [path] = paths;
    if (paths.size === 1 && path !== undefined && path !== PROJECT_OWNER) {
      fileLastUses.set(path, [...(fileLastUses.get(path) ?? []), one]);
    }
  }
  return { declared, needed, ran, unbuilt, lastUses, fileLastUses, heldBy };
}
