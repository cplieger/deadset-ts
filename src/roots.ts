/**
 * The root set of one project: every declaration the analysis keeps live without a
 * reference, and why.
 *
 * Every root seeds REACHABILITY, and no root counts as a reference. A root of a kind
 * that names a caller is live under reference counting as well, which the sweep
 * decides; the published API only supposes a consumer, so a published export is live
 * under reachability and still a candidate under reference counting.
 */

import {
  isArrowFunction,
  isAssertionExpression,
  isExpressionWithTypeArguments,
  isFunctionLikeDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAssignment,
  isReturnStatement,
  isSatisfiesExpression,
  isPropertyAccessExpression,
  isQualifiedName,
  isTypeQueryNode,
  isTypeReferenceNode,
  isPropertyDeclaration,
  isVariableDeclaration,
  isVariableStatement,
  SyntaxKind,
  type Expression,
  type Node,
  type ObjectLiteralExpression,
  type SourceFile,
} from "@typescript/native/ast";
import { aliasChains } from "./alias-chain.ts";
import {
  filesNamedBy,
  outsideChain,
  relativeSpecifiers,
  type ParseFile,
} from "./configuration-files.ts";
import { conventionEntries, type Conventions } from "./conventions.ts";
import { entryPoints, type EntryRule } from "./entry-points.ts";
import { globExpression } from "./glob.ts";
import type { Host } from "./host.ts";
import { nodeKey, type Inventory, type InventorySymbol } from "./inventory.ts";
import type { Manifest, ManifestEntry } from "./manifest.ts";
import { dirnamePath, joinPath, relativePath, resolvePath } from "./paths.ts";
import { byPosition } from "./position.ts";
import { UNANSWERED } from "./query.ts";
import type { ProjectView } from "./session.ts";
import type { Symbol as TSSymbol, Type } from "@typescript/native/sync";
import { sourceFilesOf, type SourceFiles } from "./source-files.ts";
import { typeQueryAliases } from "./type-query-alias.ts";

/** Why one declaration is a root. */
export type RootKind =
  /** A file `ts.entry_files` names, and what it exports. */
  | "entry-file"
  /** A file an applied convention row's globs match, and what it exports. */
  | "convention"
  /** A file the manifest names as an importable entry point, and what it exports outside the published API. */
  | "manifest-entry"
  /** A file the manifest names as a command, and what it exports outside the published API. */
  | "manifest-binary"
  /** A file a token of a manifest's script names, and what it exports. */
  | "script"
  /**
   * A global a declaration file declares as an alias of a module's export, and the
   * module declarations around it: a use of the global is a use of the export.
   */
  | "type-query-alias"
  /** A declaration a consumer of a library target can name. */
  | "published-api"
  /** A declaration an exact reference from the configuration names. */
  | "configured"
  /** A declaration a pattern from the configuration names. */
  | "pattern"
  /** A declaration of a function or statement a type error skipped, and what it may have selected. */
  | "type-error"
  /** An ambient global interface merging into one declared outside the target, and its holders. */
  | "global-augmentation"
  /** A file a tool or the platform enters by its own convention, and what it exports where the tool reads it. */
  | EntryRule;

/** One declaration the analysis keeps live under reachability, and why. */
export interface Root {
  /** The identifier of the declaration, as the inventory spells it. */
  readonly id: string;
  readonly kind: RootKind;
  /**
   * The string from a document that named this root: the configured root or pattern,
   * the entry-file or test-file pattern that matched, the manifest member that named
   * the file, the file-name convention a tool looks for, or the literal a
   * configuration or a call writes. It is empty where a rule alone decided the root.
   */
  readonly source: string;
}

/** One project's roots, and every configured string that named nothing in it. */
export interface Roots {
  /**
   * Every root of this project, ordered by the site of the declaration it names,
   * then by kind, then by the string that named it. A declaration that is a root for
   * more than one reason appears once per reason, so an explanation can name every
   * reason it is live.
   *
   * The member says which relation the set feeds: every declaration here is live
   * under reachability. A root of a kind that names a caller is also live under
   * reference counting, which the sweep decides.
   */
  readonly liveUnderReachability: readonly Root[];
  /**
   * Every configured root and pattern that named no declaration of this project, in
   * configuration order and each once. It is per project, and a finding is per run:
   * {@link unmatchedEverywhere} is what turns one into the other.
   */
  readonly unmatched: readonly string[];
  /**
   * Every declaration of the project, where the checker left the module or export table
   * of an entry or a published file unanswered, since which of them that file exports is
   * unknown; otherwise each one an unanswered published type name may name.
   */
  readonly unanswered: readonly string[];
  /** Every manifest entry naming a file to import or run that reads back to no file of this project. */
  readonly unmappedEntries: readonly ManifestEntry[];
}

/** What decides the roots beside the declarations themselves. */
export interface RootOptions {
  /** The platform the configuration files beside the program are read from. */
  readonly host: Host;
  /** The target's own manifest. */
  readonly manifest: Manifest;
  /**
   * The entry points the target's other packages name, its workspace's members and the
   * packages below it, each already marked published or not by its own manifest's rule.
   */
  readonly otherPackages?: readonly ManifestEntry[] | undefined;
  /** `roots.patterns` from the resolved configuration. */
  readonly patterns: readonly string[];
  /** `ts.entry_files` from the resolved configuration. */
  readonly entryFiles: readonly string[];
  /** The convention rows the run applied. */
  readonly conventions?: Conventions | undefined;
  /** `ts.test_files` from the resolved configuration. */
  readonly testFiles: readonly string[];
  /** The parser the configuration files no program holds are read with, where they are read. */
  readonly parse?: ParseFile | undefined;
  /** Whether the target is a library, so a consumer outside it reaches its published API. */
  readonly publishedAPI: boolean;
  /**
   * The directories of the workspace members whose manifest is not private, each a library
   * inside the target whose entries are published API whatever the target's kind.
   */
  readonly publishedMembers?: ReadonlySet<string> | undefined;
  /** Every file a program of the run holds, so a file another configuration compiles is no outside file. */
  readonly runFiles?: ReadonlySet<string> | undefined;
}

/** Whether one declaration is written below the directory of a published workspace member. */
function inPublishedMember(
  held: Inventory,
  id: string,
  root: string,
  members: ReadonlySet<string> | undefined,
): boolean {
  const path = held.symbols.find((symbol) => symbol.id === id)?.position.path;
  if (path === undefined || members === undefined) {
    return false;
  }
  const file = resolvePath(root, path);
  return [...members].some((dir) => file.startsWith(`${dir}/`));
}

/** The kind of root each role of a manifest entry makes. */
const ENTRY_KINDS = {
  import: "manifest-entry",
  run: "manifest-binary",
  script: "script",
} as const satisfies Record<ManifestEntry["role"], RootKind>;

/** The rules whose rooted files a manifest target is read back to by name. */
const READ_BACK_RULES: ReadonlySet<EntryRule> = new Set([
  "configuration-file",
  "configuration-string",
  "html-entry",
]);

/** The extensions a manifest target's name drops: the ones a build writes. */
const OUTPUT_EXTENSION = /\.(?:d\.ts|d\.mts|d\.cts|js|mjs|cjs|jsx)$/u;

/** The extension a source file's name drops. */
const SOURCE_EXTENSION = /\.(?:d\.)?[cm]?[jt]sx?$/u;

/** Whether no `package.json` sits between one file and the manifest's directory, which holds it. */
function ofPackage(host: Host, dir: string, file: string): boolean {
  for (let at = dirnamePath(file); at !== dir; at = dirnamePath(at)) {
    if (
      relativePath(dir, at) === undefined ||
      host.kindOf(joinPath(at, "package.json")) === "file"
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The rooted files one manifest target reads back to by name: its path below the
 * manifest's directory, past its first directory where it names one, without its output
 * extension, is the name, and a rooted file of the manifest's own package is one whose
 * path below the same directory, without its source extension, ends with that name at a
 * directory boundary.
 */
function readBackByName(
  host: Host,
  entry: ManifestEntry,
  rooted: readonly SourceFile[],
): readonly SourceFile[] {
  const dir = resolvePath(host.workingDirectory(), entry.dir);
  const below = relativePath(dir, resolvePath(host.workingDirectory(), entry.path));
  if (below === undefined || below === "") {
    return [];
  }
  const cut = below.indexOf("/");
  const name = (cut === -1 ? below : below.slice(cut + 1)).replace(OUTPUT_EXTENSION, "");
  if (name === "") {
    return [];
  }
  const found = new Map<string, SourceFile>();
  for (const file of rooted) {
    const path = relativePath(dir, file.fileName)?.replace(SOURCE_EXTENSION, "");
    if (
      path !== undefined &&
      (path === name || path.endsWith(`/${name}`)) &&
      ofPackage(host, dir, file.fileName)
    ) {
      found.set(file.fileName, file);
    }
  }
  return [...found.values()];
}

/**
 * The program files a manifest target no program holds reaches: the target is a file
 * read as a configuration file outside the program is, and each file of the chain it
 * starts loads the program files its relative specifiers name, read through the emit
 * mapping, as a command's shim loads the compiled entry it runs.
 */
function throughOutside(
  options: RootOptions,
  targetRoot: string,
  files: SourceFiles,
  entry: ManifestEntry,
): readonly SourceFile[] {
  const cwd = options.host.workingDirectory();
  const path = resolvePath(cwd, entry.path);
  if (
    options.parse === undefined ||
    options.runFiles?.has(path) === true ||
    options.host.kindOf(path) !== "file"
  ) {
    return [];
  }
  const chain = outsideChain(options.host, targetRoot, files, options.parse, [
    { path, manifestDir: resolvePath(cwd, entry.dir) },
  ]);
  const found = new Map<string, SourceFile>();
  for (const { file } of chain) {
    for (const specifier of relativeSpecifiers(file)) {
      for (const named of filesNamedBy(files, dirnamePath(file.fileName), specifier)) {
        found.set(named.fileName, named);
      }
    }
  }
  return [...found.values()];
}

/** Whether a configured string carries either special character. */
function isPattern(text: string): boolean {
  return text.includes("*") || text.includes("?");
}

/**
 * Whether ref matches a pattern whose only special characters are `*`, which stands
 * for any run of characters including the solidus, and `?`, which stands for exactly
 * one character counted as a code point. A star keeps the position it last stood at,
 * so the shortest run it can stand for is tried first.
 */
function matchGlob(pattern: readonly string[], ref: readonly string[]): boolean {
  let next = 0;
  let star = -1;
  let resume = 0;
  let at = 0;
  while (at < ref.length) {
    if (next < pattern.length && (pattern[next] === "?" || pattern[next] === ref[at])) {
      next += 1;
      at += 1;
    } else if (next < pattern.length && pattern[next] === "*") {
      star = next;
      resume = at;
      next += 1;
    } else if (star >= 0) {
      resume += 1;
      next = star + 1;
      at = resume;
    } else {
      return false;
    }
  }
  while (next < pattern.length && pattern[next] === "*") {
    next += 1;
  }
  return next === pattern.length;
}

/**
 * Whether one configured string names the symbol reference ref. A string carrying
 * neither special character names only the reference it spells.
 *
 * Both sides are read as code points: a character outside the basic plane is two
 * string units, and `?` stands for one character.
 */
export function matchRef(pattern: string, ref: string): boolean {
  if (!isPattern(pattern)) {
    return pattern === ref;
  }
  return matchGlob(Array.from(pattern), Array.from(ref));
}

/** Two strings ordered bytewise, which is the order every set of a run is read in. */
function compare(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** The members of one declaration, indexed by the container that holds them. */
function childrenOf(held: Inventory): ReadonlyMap<string, readonly InventorySymbol[]> {
  const byParent = new Map<string, InventorySymbol[]>();
  for (const symbol of held.symbols) {
    const siblings = byParent.get(symbol.parent);
    if (siblings === undefined) {
      byParent.set(symbol.parent, [symbol]);
    } else {
      siblings.push(symbol);
    }
  }
  return byParent;
}

/**
 * The roots one project holds, and every configured string that named nothing in it.
 *
 * A file a manifest member, an entry-file pattern or a tool's configuration names
 * is a root with everything its module exports: each name of the module's export
 * table, and where a name is a re-export, every link of the chain to the declaration
 * it carries, so a re-exported declaration is a root of the file that publishes it.
 * In a library, what a published file exports is rooted by the published API alone.
 * A file a runtime executes without reading its exports, a test file or a worker, is
 * a root by itself.
 */
export function roots<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  targetRoot: string,
  options: RootOptions,
): Roots {
  const files = sourceFilesOf(project, targetRoot);
  const declared = held.declarations;
  const fileIds = new Map<string, string>();
  for (const file of files.byName.values()) {
    const id = declared.get(nodeKey(file, file));
    if (id !== undefined) {
      fileIds.set(file.fileName, id);
    }
  }
  const found = new Map<string, Root>();
  const add = (id: string, kind: RootKind, source: string): void => {
    found.set([id, kind, source].join("\u0000"), { id, kind, source });
  };

  const entered: {
    file: SourceFile;
    kind: RootKind;
    source: string;
    exports: boolean;
    names?: readonly string[];
  }[] = [];
  const enter = (
    file: SourceFile,
    kind: RootKind,
    source: string,
    exports: boolean,
    names?: readonly string[],
  ): void => {
    entered.push({ file, kind, source, exports, ...(names === undefined ? {} : { names }) });
  };

  const points = entryPoints(
    project,
    files,
    options.testFiles,
    options.host,
    targetRoot,
    options.parse,
    options.conventions?.selected,
  );
  const published: SourceFile[] = [];
  const entries = [
    ...options.manifest.entries.map((entry) => ({
      entry,
      publishes:
        options.publishedAPI &&
        entry.published &&
        (options.manifest.declaresExports ? entry.member.startsWith("exports") : true),
    })),
    ...(options.otherPackages ?? []).map((entry) => ({
      entry,
      publishes:
        entry.published &&
        (options.publishedAPI || options.publishedMembers?.has(entry.dir) === true),
    })),
  ];
  const scripted = entries.flatMap(({ entry }) =>
    entry.role === "script" ? files.named(entry.path) : [],
  );
  const readBackTo = [
    ...scripted,
    ...points.filter((point) => READ_BACK_RULES.has(point.rule)).map((point) => point.file),
  ];
  const entryFilesOf = new Map<ManifestEntry, readonly SourceFile[]>();
  const entryFiles = (entry: ManifestEntry): readonly SourceFile[] => {
    const known = entryFilesOf.get(entry);
    if (known !== undefined) {
      return known;
    }
    const found = readEntryFiles(entry);
    entryFilesOf.set(entry, found);
    return found;
  };
  const readEntryFiles = (entry: ManifestEntry): readonly SourceFile[] => {
    const named = files.named(entry.path);
    if (named.length > 0 || entry.role === "script") {
      return named;
    }
    const cwd = options.host.workingDirectory();
    const shipped = files.namedAsOutput(resolvePath(cwd, entry.dir), resolvePath(cwd, entry.path));
    if (shipped.length > 0) {
      return shipped;
    }
    const byName = readBackByName(options.host, entry, readBackTo);
    return byName.length > 0 ? byName : throughOutside(options, targetRoot, files, entry);
  };
  for (const { entry, publishes } of entries) {
    if (publishes) {
      published.push(...entryFiles(entry));
    }
  }
  if (options.publishedAPI) {
    // A library's bundle hands what its entry exports to every program that loads it.
    published.push(
      ...points.filter((point) => point.rule === "bundler-entry").map((point) => point.file),
    );
  }
  const publishedNames = new Set(published.map((file) => file.fileName));
  const patterned: { file: SourceFile; pattern: string }[] = [];
  for (const pattern of options.entryFiles) {
    const expression = globExpression(pattern);
    for (const [path, file] of files.byPath) {
      if (expression.test(path)) {
        patterned.push({ file, pattern });
      }
    }
  }
  const unmapped: ManifestEntry[] = [];
  const mapped = patterned.map(({ file }) => file);
  for (const { entry } of entries) {
    const named = entryFiles(entry);
    if (named.length === 0 && entry.role !== "script") {
      unmapped.push(entry);
    }
    mapped.push(...named);
    for (const file of named) {
      const kind = ENTRY_KINDS[entry.role];
      enter(file, kind, entry.member, !publishedNames.has(file.fileName));
    }
  }
  const unmappedEntries = unmapped.filter(
    (entry) => readBackByName(options.host, entry, mapped).length === 0,
  );
  for (const { file, pattern } of patterned) {
    enter(file, "entry-file", pattern, true);
  }
  for (const { file, row } of options.conventions === undefined
    ? []
    : conventionEntries(options.conventions, files)) {
    enter(file, "convention", row, true);
  }
  for (const point of points) {
    enter(point.file, point.rule, point.source, point.exports, point.names);
  }
  for (const file of files.byPath.values()) {
    for (const alias of typeQueryAliases(file)) {
      const source = alias.type.getText().replace(/\s+/gu, " ");
      for (const node of [alias.declaration, ...alias.containers]) {
        const id = declared.get(nodeKey(file, node));
        if (id !== undefined) {
          add(id, "type-query-alias", source);
        }
      }
    }
  }

  const {
    tables: exportsOf,
    named,
    answered,
  } = exportTables(project, held, [
    ...entered.filter((entry) => entry.exports).map((entry) => entry.file),
    ...published,
  ]);
  for (const entry of entered) {
    const id = fileIds.get(entry.file.fileName);
    if (id === undefined) {
      continue;
    }
    add(id, entry.kind, entry.source);
    if (entry.exports) {
      const byName = named.get(entry.file.fileName);
      const exported =
        entry.names === undefined || byName === undefined
          ? (exportsOf.get(entry.file.fileName) ?? [])
          : entry.names.flatMap((name) => byName.get(name) ?? []);
      for (const one of exported) {
        add(one, entry.kind, entry.source);
      }
    }
  }

  const tagged = releaseTagged(held, files).filter(
    (id) =>
      options.publishedAPI || inPublishedMember(held, id, targetRoot, options.publishedMembers),
  );
  const api =
    published.length > 0 || tagged.length > 0
      ? publishedAPI(project, published, exportsOf, held, files.byPath, tagged)
      : { ids: [], guessed: [] };
  for (const id of api.ids) {
    add(id, "published-api", "");
  }

  const unmatched = configured(held, options.patterns, add);

  const sites = new Map(held.symbols.map((symbol) => [symbol.id, symbol.position]));
  const ordered = [...found.values()].sort((a, b) => {
    const left = sites.get(a.id);
    const right = sites.get(b.id);
    const site = left === undefined || right === undefined ? 0 : byPosition(left, right);
    return site || compare(a.kind, b.kind) || compare(a.source, b.source);
  });

  return {
    liveUnderReachability: ordered,
    unmatched,
    unanswered: answered ? api.guessed : held.symbols.map((symbol) => symbol.id),
    unmappedEntries,
  };
}

/**
 * Every declaration each file's module exports, by the file's name: the declaration
 * each name of the export table is, and every link of a re-export's chain. A name
 * whose declaration is outside the project's own files names nothing here. One batch
 * resolves every file to its module and one request per module reads its export
 * table, star re-exports resolved into it. A file that is no module exports nothing.
 * `answered` is false where the checker left a table or a link of a chain unanswered.
 */
function exportTables<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  wanted: readonly SourceFile[],
): {
  readonly tables: ReadonlyMap<string, readonly string[]>;
  /** Per file whose table the checker answered, the declarations each export name reaches. */
  readonly named: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  readonly answered: boolean;
} {
  const unique = [...new Map(wanted.map((file) => [file.fileName, file])).values()];
  const tables = new Map<string, readonly string[]>();
  const named = new Map<string, Map<string, string[]>>();
  let answered = true;
  if (unique.length === 0) {
    return { tables, named, answered };
  }
  const modules = project.symbolsAt(unique.map((file) => project.handle(file)));
  const chains = aliasChains(project, held);

  const topLevel = (file: SourceFile): readonly string[] => {
    const fileId = held.declarations.get(nodeKey(file, file));
    return held.symbols.filter((symbol) => symbol.parent === fileId).map((symbol) => symbol.id);
  };
  unique.forEach((file, index) => {
    const module = modules[index];
    if (module === undefined) {
      tables.set(file.fileName, []);
      return;
    }
    const table = module === UNANSWERED ? UNANSWERED : project.queries.exportsOfModule(module);
    if (table === UNANSWERED) {
      answered = false;
      tables.set(file.fileName, topLevel(file));
      return;
    }
    const ids = new Set<string>();
    const byName = new Map<string, string[]>();
    for (const exported of table) {
      for (const target of chains.chainOf(exported)) {
        answered &&= !target.guessed;
        ids.add(target.id);
        byName.set(exported.name, [...(byName.get(exported.name) ?? []), target.id]);
      }
    }
    tables.set(file.fileName, [...ids]);
    named.set(file.fileName, byName);
  });
  return { tables, named, answered };
}

/** A release tag of a documentation comment: `@` and its name, between white space or the ends. */
const RELEASE_TAG = /(?:^|\s)@(?:public|beta|alpha)(?=\s|$)/u;

/**
 * Whether the documentation comment of the statement that starts at `start`, the last
 * `/** *\/` comment before it with only white space between the two, holds a release tag.
 */
function releaseTagIn(text: string, from: number, start: number): boolean {
  const leading = text.slice(from, start);
  const open = leading.lastIndexOf("/**");
  const close = open < 0 ? -1 : leading.indexOf("*/", open + 3);
  if (close < 0 || leading.slice(close + 2).trim() !== "") {
    return false;
  }
  return RELEASE_TAG.test(leading.slice(open + 3, close));
}

/** The exported top-level declarations of the program's files a release tag marks. */
function releaseTagged(
  held: Inventory,
  files: { readonly byPath: ReadonlyMap<string, SourceFile> },
): readonly string[] {
  const exported = new Set(held.symbols.filter((symbol) => symbol.exported).map((one) => one.id));
  const found: string[] = [];
  for (const file of files.byPath.values()) {
    for (const statement of file.statements) {
      if (!releaseTagIn(file.text, statement.pos, statement.getStart())) {
        continue;
      }
      const nodes: readonly Node[] = isVariableStatement(statement)
        ? statement.declarationList.declarations
        : [statement];
      for (const node of nodes) {
        const id = held.declarations.get(nodeKey(file, node));
        if (id !== undefined && exported.has(id)) {
          found.push(id);
        }
      }
    }
  }
  return found;
}

/** The kinds of container whose export table, not its members' visibility, says what it publishes. */
const EXPORTING_CONTAINERS: ReadonlySet<string> = new Set(["file", "namespace"]);

/**
 * Every declaration a consumer of the library can name: what the published files export,
 * and below each the members a consumer writes, a namespace's exported ones and any other
 * declaration's public and protected ones. A declaration a published one's type names is
 * published too, and so is an exported declaration a release tag marks. A type name the
 * checker leaves unanswered publishes every declaration spelled as it is, as `guessed`. A
 * published file is not itself published.
 */
function publishedAPI<Brand>(
  project: ProjectView<Brand>,
  published: readonly SourceFile[],
  exportsOf: ReadonlyMap<string, readonly string[]>,
  held: Inventory,
  byPath: ReadonlyMap<string, SourceFile>,
  tagged: readonly string[],
): { readonly ids: readonly string[]; readonly guessed: readonly string[] } {
  const byId = new Map(held.symbols.map((symbol) => [symbol.id, symbol]));
  const children = childrenOf(held);
  const nodes = declarationNodes(held, byPath);
  const chains = aliasChains(project, held);
  const reached = new Set<string>();
  const entered = new Set<string>();
  const guessed = new Set<string>();
  const pending: string[] = [];
  const reach = (id: string): void => {
    const file = byId.get(id)?.kind === "file";
    if (!(file ? entered : reached).has(id)) {
      (file ? entered : reached).add(id);
      pending.push(id);
    }
  };
  for (const id of tagged) {
    reach(id);
  }
  for (const file of published) {
    for (const id of exportsOf.get(file.fileName) ?? []) {
      reach(id);
    }
  }
  while (pending.length > 0) {
    const round: string[] = [];
    for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
      round.push(next);
      const exporting = EXPORTING_CONTAINERS.has(byId.get(next)?.kind ?? "");
      for (const member of children.get(next) ?? []) {
        const reachable = exporting
          ? member.exported
          : member.visibility !== "private" && member.visibility !== "private-name";
        if (member.kind !== "type-parameter" && reachable) {
          reach(member.id);
        }
      }
    }
    const named = round.flatMap((id) => {
      const symbol = byId.get(id);
      return symbol === undefined || symbol.kind === "file" ? [] : nodes.typeNamesOf(symbol);
    });
    const inferred = inferredTypeSymbols(
      project,
      round.flatMap((id) => {
        const symbol = byId.get(id);
        return symbol === undefined ? [] : nodes.nodesOf(symbol);
      }),
    );
    for (const symbol of inferred.types) {
      for (const target of chains.chainOf(symbol)) {
        reach(target.id);
      }
    }
    for (const symbol of inferred.members) {
      for (const target of chains.chainOf(symbol)) {
        const member = byId.get(target.id);
        if (member?.visibility === "public" || member?.visibility === "protected") {
          reach(target.id);
        }
      }
    }
    project.symbolsAt(named.map((node) => project.handle(node))).forEach((symbol, index) => {
      if (symbol === UNANSWERED) {
        for (const id of held.byName.get(named[index]?.getText() ?? "") ?? []) {
          guessed.add(id);
          reach(id);
        }
      } else if (symbol !== undefined) {
        for (const target of chains.chainOf(symbol)) {
          reach(target.id);
        }
      }
    });
  }
  return { ids: [...reached], guessed: [...guessed] };
}

/** The type names declarations of the inventory write, each file walked once, when first asked. */
function declarationNodes(
  held: Inventory,
  byPath: ReadonlyMap<string, SourceFile>,
): {
  typeNamesOf(symbol: InventorySymbol): readonly Node[];
  nodesOf(symbol: InventorySymbol): readonly Node[];
} {
  const walked = new Map<string, { byId: Map<string, Node[]>; nodes: Set<Node> }>();
  const nodesIn = (path: string): { byId: Map<string, Node[]>; nodes: Set<Node> } => {
    const known = walked.get(path);
    if (known !== undefined) {
      return known;
    }
    const found = { byId: new Map<string, Node[]>(), nodes: new Set<Node>() };
    const file = byPath.get(path);
    if (file !== undefined) {
      const visit = (node: Node): void => {
        const id = held.declarations.get(nodeKey(file, node));
        if (id !== undefined) {
          found.nodes.add(node);
          found.byId.set(id, [...(found.byId.get(id) ?? []), node]);
        }
        node.forEachChild(visit);
      };
      visit(file);
    }
    walked.set(path, found);
    return found;
  };
  return {
    typeNamesOf: (symbol) => {
      const { byId, nodes } = nodesIn(symbol.position.path);
      return (byId.get(symbol.id) ?? []).flatMap((declaration) => typeNamesOf(declaration, nodes));
    },
    nodesOf: (symbol) => nodesIn(symbol.position.path).byId.get(symbol.id) ?? [],
  };
}

/** How deep the type arguments and constituents of an inferred type are followed. */
const INFERRED_DEPTH = 4;

/**
 * The values one function body returns, each through the type assertions around it: the
 * value a caller receives carries the operand's type whatever type the assertion or the
 * signature names. A nested function's returns are its own.
 */
function returnedValues(body: Node): readonly Expression[] {
  const found: Expression[] = [];
  const add = (value: Expression): void => {
    for (let at: Expression | undefined = value; at !== undefined;) {
      found.push(at);
      at =
        isAssertionExpression(at) || isSatisfiesExpression(at) || isParenthesizedExpression(at)
          ? at.expression
          : undefined;
    }
  };
  if (!isFunctionLikeDeclaration(body.parent) || body.parent.body !== body) {
    return found;
  }
  if (isArrowFunction(body.parent) && body.kind !== SyntaxKind.Block) {
    add(body as Expression);
    return found;
  }
  const visit = (node: Node): void => {
    if (isFunctionLikeDeclaration(node)) {
      return;
    }
    if (isReturnStatement(node) && node.expression !== undefined) {
      add(node.expression);
    }
    node.forEachChild(visit);
  };
  body.forEachChild(visit);
  return found;
}

/** The object literal one returned value is, written there or as the initializer of a variable `body` declares. */
function returnedLiteral(value: Expression, body: Node): ObjectLiteralExpression | undefined {
  if (isObjectLiteralExpression(value)) {
    return value;
  }
  if (!isIdentifier(value)) {
    return undefined;
  }
  let found: ObjectLiteralExpression | undefined;
  const visit = (node: Node): void => {
    if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.name.text === value.text &&
      node.initializer !== undefined
    ) {
      let at: Expression = node.initializer;
      while (
        isAssertionExpression(at) ||
        isSatisfiesExpression(at) ||
        isParenthesizedExpression(at)
      ) {
        at = at.expression;
      }
      found = isObjectLiteralExpression(at) ? at : found;
    }
    if (!isFunctionLikeDeclaration(node)) {
      node.forEachChild(visit);
    }
  };
  body.forEachChild(visit);
  return found;
}

/**
 * The values one function body returns, and those each method of an object literal it
 * returns returns, to a fixed depth: a caller holding the literal calls its methods, and
 * receives what they return.
 */
function returnedThroughLiterals(body: Node, depth = 0): readonly Expression[] {
  const values = returnedValues(body);
  if (depth >= INFERRED_DEPTH) {
    return values;
  }
  const found = [...values];
  for (const value of values) {
    for (const property of returnedLiteral(value, body)?.properties ?? []) {
      const fn = isMethodDeclaration(property)
        ? property
        : isPropertyAssignment(property) && isFunctionLikeDeclaration(property.initializer)
          ? property.initializer
          : undefined;
      if (fn?.body !== undefined) {
        found.push(...returnedThroughLiterals(fn.body, depth + 1));
      }
    }
  }
  return found;
}

/**
 * The declarations of the types the compiler infers where a declaration writes none, and
 * of the values a function returns: the type of a variable or a property with no
 * annotation, the result of a function or a method with no result annotation, and the type
 * of each value its body returns, each with the types its type arguments and its union or
 * intersection constituents name, to a fixed depth; and as `members` the properties of each
 * returned value's type. A question the checker leaves unanswered names nothing.
 */
function inferredTypeSymbols<Brand>(
  project: ProjectView<Brand>,
  declarations: readonly Node[],
): { readonly types: readonly TSSymbol[]; readonly members: readonly TSSymbol[] } {
  const { queries } = project;
  const valued: Node[] = declarations.flatMap((node) =>
    (isVariableDeclaration(node) || isPropertyDeclaration(node)) &&
    node.type === undefined &&
    !isFunctionLikeDeclaration(node.initializer ?? node)
      ? [node.name]
      : [],
  );
  const returned = declarations.flatMap((node) => {
    const signature = isFunctionLikeDeclaration(node)
      ? node
      : isVariableDeclaration(node) &&
          node.initializer !== undefined &&
          isFunctionLikeDeclaration(node.initializer)
        ? node.initializer
        : undefined;
    return signature?.body === undefined ? [] : returnedThroughLiterals(signature.body);
  });
  const types: Type[] = [];
  const returnedTypes: Type[] = [];
  queries.typesAt([...valued, ...returned]).forEach((type, at) => {
    if (type !== UNANSWERED && type !== undefined) {
      (at < valued.length ? types : returnedTypes).push(type);
    }
  });
  types.push(...returnedTypes);
  for (const node of declarations) {
    const signature = isFunctionLikeDeclaration(node)
      ? node
      : isVariableDeclaration(node) &&
          node.type === undefined &&
          node.initializer !== undefined &&
          isFunctionLikeDeclaration(node.initializer)
        ? node.initializer
        : undefined;
    if (signature === undefined || signature.type !== undefined || signature.body === undefined) {
      continue;
    }
    const typed = queries.signatureOf(signature);
    const result =
      typed === UNANSWERED || typed === undefined ? undefined : queries.returnTypeOf(typed);
    if (result !== UNANSWERED && result !== undefined) {
      types.push(result);
    }
  }
  const found = new Map<number, TSSymbol>();
  const seen = new Set<Type>();
  const visit = (type: Type, depth: number): void => {
    if (depth > INFERRED_DEPTH || seen.has(type)) {
      return;
    }
    seen.add(type);
    const symbol = queries.symbolOfType(type);
    if (symbol !== UNANSWERED && symbol !== undefined) {
      found.set(symbol.id, symbol);
    }
    const parts = queries.constituents(type);
    const args = queries.typeArguments(type);
    for (const next of [
      ...(parts === UNANSWERED || (parts.length === 1 && parts[0] === type) ? [] : parts),
      ...(args === UNANSWERED ? [] : args),
    ]) {
      visit(next, depth + 1);
    }
  };
  types.forEach((type) => {
    visit(type, 0);
  });
  // A returned value carries each property of its type, one an anonymous type declares or
  // an intersection merges included, which no type name reaches.
  const members = new Map<number, TSSymbol>();
  for (const type of returnedTypes) {
    const parts = queries.constituents(type);
    for (const one of [type, ...(parts === UNANSWERED ? [] : parts)]) {
      const properties = queries.propertiesOf(one);
      for (const property of properties === UNANSWERED ? [] : properties) {
        members.set(property.id, property);
      }
    }
  }
  return { types: [...found.values()], members: [...members.values()] };
}

/**
 * The names of types one declaration's own syntax writes: in a type reference, a
 * heritage clause or a type query. A function body is not read, and neither is a
 * declaration nested in this one, which `nested` holds and which is read on its own.
 */
function typeNamesOf(declaration: Node, nested: ReadonlySet<Node>): readonly Node[] {
  const found: Node[] = [];
  const visit = (node: Node): void => {
    if (node !== declaration && nested.has(node)) {
      return;
    }
    if (isTypeReferenceNode(node)) {
      found.push(isQualifiedName(node.typeName) ? node.typeName.right : node.typeName);
    } else if (isExpressionWithTypeArguments(node)) {
      found.push(
        isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression,
      );
    } else if (isTypeQueryNode(node)) {
      found.push(isQualifiedName(node.exprName) ? node.exprName.right : node.exprName);
    }
    const body = isFunctionLikeDeclaration(node) ? node.body : undefined;
    node.forEachChild((child) => {
      if (child !== body) {
        visit(child);
      }
    });
  };
  visit(declaration);
  return found;
}

/**
 * Keeps every declaration the configuration names and returns every string that
 * named none, in configuration order. A string the configuration lists twice is one
 * configured root.
 */
function configured(
  held: Inventory,
  patterns: readonly string[],
  add: (id: string, kind: RootKind, source: string) => void,
): readonly string[] {
  const unmatched: string[] = [];
  for (const pattern of new Set(patterns)) {
    const kind: RootKind = isPattern(pattern) ? "pattern" : "configured";
    let matched = false;
    for (const symbol of held.symbols) {
      if (matchRef(pattern, symbol.ref)) {
        add(symbol.id, kind, pattern);
        matched = true;
      }
    }
    if (!matched) {
      unmatched.push(pattern);
    }
  }
  return unmatched;
}

/**
 * Every configured string that named no declaration in ANY project of the run, in
 * configuration order and each once.
 *
 * A finding about a configured root is about the configuration and not about a
 * declaration, so there is one per run: a string that names a declaration of one
 * project has named something, and the projects it named nothing in are not a
 * finding. A run with no project names nothing with any of them.
 */
export function unmatchedEverywhere(
  patterns: readonly string[],
  perProject: readonly Roots[],
): readonly string[] {
  return [...new Set(patterns)].filter((pattern) =>
    perProject.every((project) => project.unmatched.includes(pattern)),
  );
}
