/**
 * The root set of one project: every declaration the analysis keeps live without a
 * reference, and why.
 *
 * Every root seeds REACHABILITY, and no root counts as a reference. A root of a kind
 * that names a caller is live under reference counting as well, which the sweep
 * decides; the published API only supposes a consumer, so a published export is live
 * under reachability and still a candidate under reference counting.
 */

import type { SourceFile } from "@typescript/native/unstable/ast";
import { aliasChains } from "./alias-chain.ts";
import { entryPoints, type EntryRule } from "./entry-points.ts";
import { globExpression } from "./glob.ts";
import { nodeKey, type Inventory, type InventorySymbol } from "./inventory.ts";
import type { Manifest, ManifestEntry } from "./manifest.ts";
import { byPosition } from "./position.ts";
import { UNANSWERED } from "./query.ts";
import type { ProjectView } from "./session.ts";
import { sourceFilesOf } from "./source-files.ts";

/** Why one declaration is a root. */
export type RootKind =
  /** A file `ts.entry_files` names, and what it exports. */
  | "entry-file"
  /** A file the manifest names as an importable entry point, and what it exports outside the published API. */
  | "manifest-entry"
  /** A file the manifest names as a command, and what it exports outside the published API. */
  | "manifest-binary"
  /** A declaration a consumer of a library target can name. */
  | "published-api"
  /** A declaration an exact reference from the configuration names. */
  | "configured"
  /** A declaration a pattern from the configuration names. */
  | "pattern"
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
   * of an entry or a published file unanswered, and none otherwise: which of them that
   * file exports is unknown.
   */
  readonly unanswered: readonly string[];
}

/** What decides the roots beside the declarations themselves. */
export interface RootOptions {
  /** The target's own manifest. */
  readonly manifest: Manifest;
  /** `roots.patterns` from the resolved configuration. */
  readonly patterns: readonly string[];
  /** `ts.entry_files` from the resolved configuration. */
  readonly entryFiles: readonly string[];
  /** `ts.test_files` from the resolved configuration. */
  readonly testFiles: readonly string[];
  /** Whether the target is a library, so a consumer outside it reaches its published API. */
  readonly publishedAPI: boolean;
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

  const published: SourceFile[] = [];
  const publishes = (entry: ManifestEntry): boolean =>
    options.publishedAPI &&
    entry.published &&
    (options.manifest.declaresExports ? entry.member.startsWith("exports") : true);
  for (const entry of options.manifest.entries) {
    if (publishes(entry)) {
      published.push(...files.named(entry.path));
    }
  }
  const publishedNames = new Set(published.map((file) => file.fileName));
  for (const entry of options.manifest.entries) {
    for (const file of files.named(entry.path)) {
      const kind = entry.role === "run" ? "manifest-binary" : "manifest-entry";
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
  for (const point of entryPoints(project, files, options.testFiles)) {
    enter(point.file, point.rule, point.source, point.exports);
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

  if (options.publishedAPI) {
    for (const id of publishedAPI(published, exportsOf, held)) {
      add(id, "published-api", "");
    }
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
    unanswered: answered ? [] : held.symbols.map((symbol) => symbol.id),
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

/** The kinds of container whose export table, not its members' visibility, says what it publishes. */
const EXPORTING_CONTAINERS: ReadonlySet<string> = new Set(["file", "namespace"]);

/**
 * Every declaration a consumer of the library can name: what the published files
 * export, and below each, the members a consumer reaches through it.
 *
 * The published files are the ones `exports` reaches where the manifest declares
 * one, because a package that declares `exports` has said exactly what a consumer may
 * import; where it declares none, they are the ones the members that preceded it
 * name. Below a published module or namespace the walk follows what its export table
 * names; below any other published declaration it follows every member a consumer
 * can write: a public one, and a protected one, which a consumer's subclass names. A
 * private member is not published, nor is anything below one, and a type parameter
 * is not published either, because a consumer supplies a type argument by position.
 *
 * A published file is not itself published. A consumer imports a module and names
 * what it exports; the file is a root because the manifest names it, which is a
 * different reason.
 */
function publishedAPI(
  published: readonly SourceFile[],
  exportsOf: ReadonlyMap<string, readonly string[]>,
  held: Inventory,
): readonly string[] {
  const byId = new Map(held.symbols.map((symbol) => [symbol.id, symbol]));
  const children = childrenOf(held);
  const reached = new Set<string>();
  const pending: string[] = [];
  for (const file of published) {
    for (const id of exportsOf.get(file.fileName) ?? []) {
      if (byId.get(id)?.kind === "file") {
        pending.push(id);
      } else if (!reached.has(id)) {
        reached.add(id);
        pending.push(id);
      }
    }
  }
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    const exporting = EXPORTING_CONTAINERS.has(byId.get(next)?.kind ?? "");
    for (const member of children.get(next) ?? []) {
      const reachable = exporting
        ? member.exported
        : member.visibility !== "private" && member.visibility !== "private-name";
      if (member.kind === "type-parameter" || reached.has(member.id) || !reachable) {
        continue;
      }
      reached.add(member.id);
      pending.push(member.id);
    }
  }
  return [...reached];
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
