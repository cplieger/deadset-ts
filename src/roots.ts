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
  isExpressionWithTypeArguments,
  isFunctionLikeDeclaration,
  isPropertyAccessExpression,
  isQualifiedName,
  isTypeQueryNode,
  isTypeReferenceNode,
  isVariableStatement,
  type Node,
  type SourceFile,
} from "@typescript/native/unstable/ast";
import { aliasChains } from "./alias-chain.ts";
import type { ParseFile } from "./configuration-files.ts";
import { conventionEntries, type Conventions } from "./conventions.ts";
import { entryPoints, type EntryRule } from "./entry-points.ts";
import { globExpression } from "./glob.ts";
import type { Host } from "./host.ts";
import { nodeKey, type Inventory, type InventorySymbol } from "./inventory.ts";
import type { Manifest, ManifestEntry } from "./manifest.ts";
import { relativePath, resolvePath } from "./paths.ts";
import { byPosition } from "./position.ts";
import { UNANSWERED } from "./query.ts";
import type { ProjectView } from "./session.ts";
import { sourceFilesOf } from "./source-files.ts";
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
  /** The compiler configuration the project was opened from. */
  readonly configFile: string;
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

/**
 * The rooted files one manifest target reads back to by name: its path below the
 * manifest's directory, past its first directory where it names one, without its output
 * extension, is the name, and a rooted file is one whose path below the same directory,
 * without its source extension, ends with that name at a directory boundary.
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
    if (path !== undefined && (path === name || path.endsWith(`/${name}`))) {
      found.set(file.fileName, file);
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

  const entered: { file: SourceFile; kind: RootKind; source: string; exports: boolean }[] = [];
  const enter = (file: SourceFile, kind: RootKind, source: string, exports: boolean): void => {
    entered.push({ file, kind, source, exports });
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
        entry.published &&
        (options.manifest.declaresExports ? entry.member.startsWith("exports") : true),
    })),
    ...(options.otherPackages ?? []).map((entry) => ({ entry, publishes: entry.published })),
  ];
  const scripted = entries.flatMap(({ entry }) =>
    entry.role === "script" ? files.named(entry.path) : [],
  );
  const readBackTo = [
    ...scripted,
    ...points.filter((point) => READ_BACK_RULES.has(point.rule)).map((point) => point.file),
  ];
  const entryFiles = (entry: ManifestEntry): readonly SourceFile[] => {
    const named = files.named(entry.path);
    return named.length > 0 || entry.role === "script"
      ? named
      : readBackByName(options.host, entry, readBackTo);
  };
  for (const { entry, publishes } of entries) {
    if (options.publishedAPI && publishes) {
      published.push(...entryFiles(entry));
    }
  }
  const publishedNames = new Set(published.map((file) => file.fileName));
  for (const { entry } of entries) {
    for (const file of entryFiles(entry)) {
      const kind = ENTRY_KINDS[entry.role];
      enter(file, kind, entry.member, !publishedNames.has(file.fileName));
    }
  }
  for (const pattern of options.entryFiles) {
    const expression = globExpression(pattern);
    for (const [path, file] of files.byPath) {
      if (expression.test(path)) {
        enter(file, "entry-file", pattern, true);
      }
    }
  }
  for (const { file, row } of options.conventions === undefined
    ? []
    : conventionEntries(options.conventions, files)) {
    enter(file, "convention", row, true);
  }
  for (const point of points) {
    enter(point.file, point.rule, point.source, point.exports);
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

  const { tables: exportsOf, answered } = exportTables(project, held, [
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
      for (const exported of exportsOf.get(entry.file.fileName) ?? []) {
        add(exported, entry.kind, entry.source);
      }
    }
  }

  const api = options.publishedAPI
    ? publishedAPI(project, published, exportsOf, held, files.byPath, releaseTagged(held, files))
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
    configFile: project.configFile,
    liveUnderReachability: ordered,
    unmatched,
    unanswered: answered ? api.guessed : held.symbols.map((symbol) => symbol.id),
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
): { readonly tables: ReadonlyMap<string, readonly string[]>; readonly answered: boolean } {
  const unique = [...new Map(wanted.map((file) => [file.fileName, file])).values()];
  const tables = new Map<string, readonly string[]>();
  let answered = true;
  if (unique.length === 0) {
    return { tables, answered };
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
    for (const exported of table) {
      for (const target of chains.chainOf(exported)) {
        answered &&= !target.guessed;
        ids.add(target.id);
      }
    }
    tables.set(file.fileName, [...ids]);
  });
  return { tables, answered };
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
  const guessed = new Set<string>();
  const pending: string[] = [];
  const reach = (id: string): void => {
    if (!reached.has(id) && byId.get(id)?.kind !== "file") {
      reached.add(id);
      pending.push(id);
    }
  };
  for (const id of tagged) {
    reach(id);
  }
  for (const file of published) {
    for (const id of exportsOf.get(file.fileName) ?? []) {
      if (byId.get(id)?.kind === "file") {
        pending.push(id);
      } else {
        reach(id);
      }
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
): { typeNamesOf(symbol: InventorySymbol): readonly Node[] } {
  const walked = new Map<string, { byId: Map<string, Node>; nodes: Set<Node> }>();
  const nodesIn = (path: string): { byId: Map<string, Node>; nodes: Set<Node> } => {
    const known = walked.get(path);
    if (known !== undefined) {
      return known;
    }
    const found = { byId: new Map<string, Node>(), nodes: new Set<Node>() };
    const file = byPath.get(path);
    if (file !== undefined) {
      const visit = (node: Node): void => {
        const id = held.declarations.get(nodeKey(file, node));
        if (id !== undefined) {
          found.nodes.add(node);
          if (!found.byId.has(id)) {
            found.byId.set(id, node);
          }
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
      const declaration = byId.get(symbol.id);
      return declaration === undefined ? [] : typeNamesOf(declaration, nodes);
    },
  };
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
