/**
 * The root set of one project: every declaration kept live without a reference, and why.
 * Every root seeds reachability and none counts as a reference; a root of a kind that
 * names a caller is live under reference counting too, which the sweep decides, so a
 * published export, which only supposes a consumer, stays a reference-counting candidate.
 */

import type { SourceFile } from "@typescript/native/ast";
import { aliasChains } from "../alias-chain.ts";
import { filesNamedBy, outsideChain, type ParseFile } from "../entries/configuration-files.ts";
import type { EntryRule, SourceFacts } from "../entries/sources.ts";
import { relativeSpecifiers } from "../entries/static-module.ts";
import type { Host } from "../host.ts";
import { nodeKey, type Inventory } from "../inventory.ts";
import type { Manifest, ManifestEntry } from "./manifest.ts";
import { ancestors, dirnamePath, relativePath, resolvePath } from "../paths.ts";
import { byPosition } from "../position.ts";
import { UNANSWERED } from "../query.ts";
import type { ProjectView } from "../session.ts";
import { sourceFilesOf, type SourceFiles } from "../source-files.ts";
import { typeQueryAliases } from "../type-query-alias.ts";
import { bytewise } from "../text/compare.ts";
import { holdsManifest } from "../fs/manifest.ts";
import { globExpression } from "../text/glob.ts";
import { heldWords, type HeldText } from "../commands/held.ts";
import { spelledFiles } from "../text/named-files.ts";
import type { Workflows } from "../entries/workflow-steps.ts";
import { extensionOf, OUTPUT_EXTENSIONS } from "../extensions.ts";
import { publishedAPI, releaseTagged } from "./published-reach.ts";
import { skippedRoots, type Skip } from "../type-errors.ts";
import { mergedGlobalInterfaces } from "../augmentations.ts";

/** Why one declaration is a root. */
export type RootKind =
  /** A file `ts.entry_files` names, and what it exports. */
  | "entry-file"
  /** A file the manifest names as an importable entry point, and what it exports outside the published API. */
  | "manifest-entry"
  /** A file the manifest names as a command, and what it exports outside the published API. */
  | "manifest-binary"
  /** A file a manifest's script names or runs, as `commands/read.ts` reads it, and what it exports. */
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
   * Every root of this project, live under reachability, ordered by the site of the
   * declaration it names, then by kind, then by the string that named it. A declaration
   * rooted for several reasons appears once per reason, so an explanation names each.
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
   * unknown; otherwise each one an unanswered published type name may name. Beside them, each
   * file of {@link heldScripts} and every declaration its export table names.
   */
  readonly unanswered: readonly string[];
  /** Every manifest entry naming a file to import or run that reads back to no file of this project. */
  readonly unmappedEntries: readonly ManifestEntry[];
  /** Every package whose command strings, in what no command reader understands, name an own file no root enters with all it exports. */
  readonly heldScripts: readonly HeldScripts[];
}

/** One package's command strings, and the own files they name that no root enters with all they export. */
export interface HeldScripts {
  /** The package's directory, absolute. */
  readonly dir: string;
  /** Each file, by its path below the target root. */
  readonly files: readonly string[];
  /** Whether a word that may write the file a command runs writes no path text (`roots.13`). */
  readonly unwritten: boolean;
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
  /** What the project's entry sources enter, read once. */
  readonly sources: SourceFacts;
  /** The type errors that skipped a unit of the project's own files. */
  readonly skips: readonly Skip[];
  /** The parser the configuration files no program holds are read with, where they are read. */
  readonly parse?: ParseFile | undefined;
  /** Whether the target is a library, so a consumer outside it reaches its published API. */
  readonly publishedAPI: boolean;
  /**
   * The directories of the workspace members whose manifest is not private, each a library
   * inside the target whose entries are published API whatever the target's kind.
   */
  readonly publishedMembers?: ReadonlySet<string> | undefined;
  /** The files the configurations read from a file hold, so a file another configuration compiles is no outside file. */
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

/** The extension a source file's name drops. */
const SOURCE_EXTENSION = /\.(?:d\.)?[cm]?[jt]sx?$/u;

/** Whether no `package.json` sits between one file and the manifest's directory, which holds it. */
function ofPackage(host: Host, dir: string, file: string): boolean {
  const between = ancestors(dirnamePath(file), dir);
  return between.length > 0 && !between.slice(0, -1).some((at) => holdsManifest(host, at));
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
  const written = cut === -1 ? below : below.slice(cut + 1);
  const name = written.slice(
    0,
    written.length - (extensionOf(written, OUTPUT_EXTENSIONS)?.length ?? 0),
  );
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

/**
 * Per package, the own files the words of its held texts name, as `spelledFiles` reads them,
 * but those a root enters with all they export: a command can use no more of such a file than
 * the root keeps live. A manifest's are its entries' held texts, and the target root's package
 * has the workflow steps, git hooks and makefile recipes beside its own, with the values of
 * each file they are read from. A package is listed too where a word that may write the file
 * a command runs writes no path text.
 */
function scriptHolds(
  entries: readonly ManifestEntry[],
  files: SourceFiles,
  entered: readonly Entered[],
  host: Host,
  targetRoot: string,
  workflows: Workflows,
): readonly HeldScripts[] {
  const rooted = new Set(
    entered.filter((one) => one.exports && one.names === undefined).map((one) => one.file.fileName),
  );
  const spelled = [...files.byName.values()]
    .filter((file) => !rooted.has(file.fileName))
    .map((file) => ({ file, paths: [file.fileName, ...files.writtenAs(file)] }));
  const cwd = host.workingDirectory();
  const root = resolvePath(cwd, targetRoot);
  const commands = new Map<string, HeldText[]>([[root, [...workflows.held]]]);
  for (const entry of entries) {
    if (entry.held !== undefined) {
      const dir = resolvePath(cwd, entry.dir);
      commands.set(dir, [...(commands.get(dir) ?? []), ...entry.held]);
    }
  }
  const held: HeldScripts[] = [];
  for (const [dir, texts] of commands) {
    const named = spelledFiles(heldWords(texts), dir, root, spelled);
    if (named.files.length > 0 || named.unwritten) {
      const paths = named.files.map(
        (file) => relativePath(targetRoot, file.fileName) ?? file.fileName,
      );
      held.push({ dir, files: paths, unwritten: named.unwritten });
    }
  }
  return held;
}

/** One file a source enters, with the export names it roots where it roots only some. */
interface Entered {
  readonly file: SourceFile;
  readonly kind: RootKind;
  readonly source: string;
  readonly exports: boolean;
  readonly names?: readonly string[];
}

/** One manifest entry, and whether a consumer outside the target reaches what it names. */
interface PackageEntry {
  readonly entry: ManifestEntry;
  readonly publishes: boolean;
}

/** The target's manifest entries, then those of its other packages. */
function packageEntries(options: RootOptions): readonly PackageEntry[] {
  return [
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
}

/**
 * The program files one manifest entry names, read once per entry: its path, else its
 * output's source, else a rooted file of `readBackTo` by name, else the chain it starts
 * outside every program.
 */
function entryFileReader(
  options: RootOptions,
  targetRoot: string,
  files: SourceFiles,
  readBackTo: readonly SourceFile[],
): (entry: ManifestEntry) => readonly SourceFile[] {
  const read = new Map<ManifestEntry, readonly SourceFile[]>();
  const readEntry = (entry: ManifestEntry): readonly SourceFile[] => {
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
  return (entry) => {
    const known = read.get(entry) ?? readEntry(entry);
    read.set(entry, known);
    return known;
  };
}

/** The files `ts.entry_files` names, each with the pattern that names it. */
function patternedFiles(
  files: SourceFiles,
  patterns: readonly string[],
): readonly { file: SourceFile; pattern: string }[] {
  const patterned: { file: SourceFile; pattern: string }[] = [];
  for (const pattern of patterns) {
    const expression = globExpression(pattern);
    for (const [path, file] of files.byPath) {
      if (expression.test(path)) {
        patterned.push({ file, pattern });
      }
    }
  }
  return patterned;
}

/**
 * The files every root source enters, in the order manifest entries, entry-file patterns,
 * entry sources; the files whose exports a consumer outside the target reaches; and the
 * entries that name no file even read back by name to another entered file.
 */
function enteredFiles(
  options: RootOptions,
  targetRoot: string,
  files: SourceFiles,
  entries: readonly PackageEntry[],
): {
  entered: readonly Entered[];
  published: readonly SourceFile[];
  unmappedEntries: readonly ManifestEntry[];
} {
  const points = options.sources.entered;
  const scripted = entries.flatMap(({ entry }) =>
    entry.role === "script" && entry.held === undefined ? files.named(entry.path) : [],
  );
  const entryFiles = entryFileReader(options, targetRoot, files, [
    ...scripted,
    ...points.filter((point) => READ_BACK_RULES.has(point.rule)).map((point) => point.file),
  ]);
  const published = entries.flatMap(({ entry, publishes }) => (publishes ? entryFiles(entry) : []));
  if (options.publishedAPI) {
    // A library's bundle hands what its entry exports to every program that loads it.
    published.push(
      ...points.filter((point) => point.rule === "bundler-entry").map((point) => point.file),
    );
  }
  const publishedNames = new Set(published.map((file) => file.fileName));
  const patterned = patternedFiles(files, options.entryFiles);
  const entered: Entered[] = [];
  const unmapped: ManifestEntry[] = [];
  const mapped = patterned.map(({ file }) => file);
  for (const { entry } of entries) {
    if (entry.held !== undefined) {
      continue;
    }
    const named = entryFiles(entry);
    if (named.length === 0 && entry.role !== "script") {
      unmapped.push(entry);
    }
    mapped.push(...named);
    for (const file of named) {
      const kind = ENTRY_KINDS[entry.role];
      entered.push({
        file,
        kind,
        source: entry.member,
        exports: !publishedNames.has(file.fileName),
      });
    }
  }
  for (const { file, pattern } of patterned) {
    entered.push({ file, kind: "entry-file", source: pattern, exports: true });
  }
  for (const point of points) {
    entered.push({
      file: point.file,
      kind: point.rule,
      source: point.source,
      exports: point.exports,
      ...(point.names === undefined ? {} : { names: point.names }),
    });
  }
  return {
    entered,
    published,
    unmappedEntries: unmapped.filter(
      (entry) => readBackByName(options.host, entry, mapped).length === 0,
    ),
  };
}

/** Every declaration and container of a `typeof import(...)` global, with the type's text. */
function typeQueryRoots(
  files: SourceFiles,
  declared: Inventory["declarations"],
  add: (id: string, kind: RootKind, source: string) => void,
): void {
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
}

/** The roots in the order {@link Roots.liveUnderReachability} states. */
function orderedRoots(found: Iterable<Root>, held: Inventory): readonly Root[] {
  const sites = new Map(held.symbols.map((symbol) => [symbol.id, symbol.position]));
  return [...found].sort((a, b) => {
    const left = sites.get(a.id);
    const right = sites.get(b.id);
    const site = left === undefined || right === undefined ? 0 : byPosition(left, right);
    return site || bytewise(a.kind, b.kind) || bytewise(a.source, b.source);
  });
}

/**
 * The roots one project holds, and every configured string that named nothing in it. A
 * file a manifest member, an entry-file pattern or a tool's configuration names is a root
 * with each name of its export table and every re-export link to what it carries; in a
 * library, the published API alone roots what a published file exports. A test file is a
 * root by itself, and so is each declaration a type error's skip keeps and each global
 * interface merging into one declared outside the project.
 */
export function rootSet<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  targetRoot: string,
  options: RootOptions,
): Roots {
  const files = sourceFilesOf(project, targetRoot);
  const fileIds = new Map<string, string>();
  for (const file of files.byName.values()) {
    const id = held.declarations.get(nodeKey(file, file));
    if (id !== undefined) {
      fileIds.set(file.fileName, id);
    }
  }
  const found = new Map<string, Root>();
  const add = (id: string, kind: RootKind, source: string): void => {
    found.set([id, kind, source].join("\u0000"), { id, kind, source });
  };

  const entries = packageEntries(options);
  const { entered, published, unmappedEntries } = enteredFiles(options, targetRoot, files, entries);
  const heldScripts = scriptHolds(
    entries.map(({ entry }) => entry),
    files,
    entered,
    options.host,
    targetRoot,
    options.sources.workflows,
  );
  const heldFiles = [...new Set(heldScripts.flatMap((one) => one.files))].flatMap(
    (path) => files.byPath.get(path) ?? [],
  );
  typeQueryRoots(files, held.declarations, add);

  const {
    tables: exportsOf,
    named,
    answered,
  } = exportTables(project, held, [
    ...entered.filter((entry) => entry.exports).map((entry) => entry.file),
    ...published,
    ...heldFiles,
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
  for (const id of skippedRoots(project, held, options.skips)) {
    add(id, "type-error", "");
  }
  for (const id of mergedGlobalInterfaces(project, held, files).kept) {
    add(id, "global-augmentation", "");
  }

  return {
    liveUnderReachability: orderedRoots(found.values(), held),
    unmatched,
    unanswered: [
      ...(answered ? api.guessed : held.symbols.map((symbol) => symbol.id)),
      // A command runs a held file and may read any export of it, so the file, which reaches its
      // top level, and its exports are held; a declaration neither reaches is still dead.
      ...heldFiles.flatMap((file) => {
        const id = fileIds.get(file.fileName);
        return [...(id === undefined ? [] : [id]), ...(exportsOf.get(file.fileName) ?? [])];
      }),
    ],
    unmappedEntries,
    heldScripts,
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
 * Every configured string that named no declaration in any project of the run, in
 * configuration order and each once. The finding is about the configuration, so a string
 * naming a declaration of one project has named something, and a run with no project
 * names nothing with any of them.
 */
export function unmatchedEverywhere(
  patterns: readonly string[],
  perProject: readonly Roots[],
): readonly string[] {
  return [...new Set(patterns)].filter((pattern) =>
    perProject.every((project) => project.unmatched.includes(pattern)),
  );
}
