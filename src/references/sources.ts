/**
 * The reference sources of the reference pass: each turns one form of site the walk found in a
 * file into uses, through the file's one batch, into the pass's one sink. A source names the
 * nodes it needs the batch to answer, and the pass asks them all in capped runs.
 */

import {
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isStringLiteralLikeNode,
  type Node,
  type SourceFile,
} from "@typescript/native/ast";
import type { Symbol as TSSymbol } from "@typescript/native/sync";
import type { AliasChains, ChainTarget } from "../alias-chain.ts";
import { amdPath, amdPlatform } from "../amd.ts";
import type { destructuring } from "../destructuring.ts";
import { specifierCandidates } from "../entries/configuration-files.ts";
import type { RunDirectories } from "../entries/run-directories.ts";
import { bindingsOf, importedNames } from "../import-bindings.ts";
import {
  isLiteralText,
  WORKER_CONSTRUCTORS,
  type Evaluation,
  type FileSites,
  type Link,
  type Site,
} from "../index/sites.ts";
import { nodeKey, type Inventory, type InventorySymbol } from "../inventory.ts";
import { JAVASCRIPT_FILE } from "../javascript-file.ts";
import {
  dirnamePath,
  isRelativeSpecifier,
  queriedModulePath,
  relativeURLPath,
  resolvePath,
  startsRelativePath,
} from "../paths.ts";
import { callsPlatform, isPlatformGlobal, startsThread } from "../platform-symbols.ts";
import { isComponentFile, type Position } from "../position.ts";
import { UNANSWERED, type Answer } from "../query.ts";
import type { Resolution } from "../references.ts";
import { computedLoadsOf, type ComputedLoad } from "../roots/unseen-loads.ts";
import type { ProjectView } from "../session.ts";
import type { SourceFiles } from "../source-files.ts";
import { computedKeyNames, keyedUses } from "../symbol-keys.ts";
import type { PropertyTables } from "../query.ts";
import { storedValue, type Sink, type Target } from "./sink.ts";

/** One walked file of the side, its sites, and what the pass read of it before the batch. */
interface WalkedFile extends FileSites {
  readonly file: SourceFile;
  readonly fileId: string;
  /** The loads by a computed path the file makes. */
  readonly loads: readonly ComputedLoad[];
  /** Whether the file is a component file, whose markup may use any binding it declares. */
  readonly markup: boolean;
  /** The name nodes of the file's import bindings its markup may use. */
  readonly bindings: readonly Node[];
}

/** What every source reads across the files of one pass. */
export interface Pass<Brand> {
  readonly project: ProjectView<Brand>;
  readonly held: Inventory;
  readonly chains: AliasChains;
  readonly tables: PropertyTables;
  readonly cap: number;
  readonly sink: Sink;
  readonly consumer: boolean;
  readonly directories: RunDirectories;
  readonly fileIds: ReadonlySet<string>;
  /** The target's walked files by file name, each with its identifier. */
  readonly fileIdByName: ReadonlyMap<string, string>;
  readonly loadableById: ReadonlyMap<string, SourceFile>;
  readonly destructured: ReturnType<typeof destructuring>;
  /** Each load by a computed path a production file of the target makes whose files the analysis cannot name. */
  readonly unseenLoads: Position[];
  /** Whether the program is one the run formed to resolve as Node does (program.36). */
  readonly formedForNode: boolean;
  /** What an import {@link possibleLoad} retries names: its file and what it binds there. */
  readonly possiblyLoaded: Set<string>;
  readonly declaredIn: (moduleId: string) => readonly InventorySymbol[];
  readonly exportsRead: (module: Answer<TSSymbol>) => readonly ChainTarget[];
  readonly named: (node: Node) => readonly ChainTarget[];
  readonly targetsOf: (symbol: TSSymbol) => readonly ChainTarget[];
  readonly throughAliases: (targets: readonly ChainTarget[]) => readonly ChainTarget[];
  readonly ownFiles: () => SourceFiles;
}

/** One form of site, and the uses it makes once the file's batch has answered. */
interface ReferenceSource {
  batched?<Brand>(walked: WalkedFile, pass: Pass<Brand>): Iterable<Node>;
  emit<Brand>(
    walked: WalkedFile,
    answered: ReadonlyMap<Node, Answer<TSSymbol>>,
    pass: Pass<Brand>,
  ): void;
}

/** The file of the target a relative specifier written in `file` names, by its source or output name. */
function fileNamed(
  file: SourceFile,
  specifier: string,
  fileIdByName: ReadonlyMap<string, string>,
): string | undefined {
  return specifierCandidates(dirnamePath(file.fileName), specifier)
    .map((path) => fileIdByName.get(path))
    .find((id) => id !== undefined);
}

/**
 * The own file a module specifier with a query evaluates ({@link queriedModulePath}): the
 * checker resolves the whole specifier to whatever module declaration matches it.
 */
function queriedFile(
  file: SourceFile,
  specifier: Node,
  fileIdByName: ReadonlyMap<string, string>,
): string | undefined {
  if (!isLiteralText(specifier)) {
    return undefined;
  }
  const path = queriedModulePath(specifier.text);
  return path === undefined
    ? undefined
    : fileIdByName.get(resolvePath(dirnamePath(file.fileName), path));
}

/**
 * A decorator is written inside the declaration it is attached to and receives it, so the
 * declaration is used where the decorator is written, whatever the decorator does with it.
 */
const decorators: ReferenceSource = {
  emit({ file, decorated }, _answered, { sink }) {
    for (const { decorator, declaration } of decorated) {
      sink.add(file, decorator, declaration, [declaration], "decorator", "syntax");
    }
  },
};

/** The constructor stores its argument in the member a parameter property declares. */
const parameterWrites: ReferenceSource = {
  emit({ file, parameterWrites: writes }, _answered, { sink }) {
    for (const { name, from, member } of writes) {
      sink.add(file, name, from, [member], "write", "syntax");
    }
  },
};

/**
 * A re-export references the first declaration its alias chain carries forward that the
 * inventory declares, one link per re-export, or for a bare star the module it names.
 */
const links: ReferenceSource = {
  batched: ({ links: found }) => found.map((link) => link.node),
  emit({ file, links: found }, answered, { sink, chains, named }) {
    for (const link of found) {
      const symbol = answered.get(link.node);
      if (symbol === undefined) {
        continue;
      }
      const carried: readonly Target[] =
        symbol === UNANSWERED ? named(link.at) : carriedBy(chains, link, symbol);
      sink.add(file, link.at, link.from, carried, "read", link.alias ? "alias" : "batch");
    }
  },
};

/**
 * The declarations one re-export carries forward: for an alias, the first link along its chain
 * that the inventory declares, stepping over the links it does not, such as an import the
 * re-export is written against; for a bare star, the module it names.
 */
function carriedBy(chains: AliasChains, link: Link, symbol: TSSymbol): readonly ChainTarget[] {
  return link.alias
    ? chains.nextDeclared(symbol).map((target) => ({ ...target, stepped: false }))
    : chains.declarationsOf(symbol).map((id) => ({ id, stepped: false, guessed: false }));
}

/**
 * Whether one evaluation loads its module: an import form, or a `require`, or an AMD `define`
 * or `require`, that {@link callsPlatform} names.
 */
function loading<Brand>(
  evaluation: Evaluation,
  answered: ReadonlyMap<Node, Answer<TSSymbol>>,
  project: ProjectView<Brand>,
): boolean {
  const { require } = evaluation;
  return (
    require === undefined ||
    callsPlatform(
      project,
      evaluation.amd === true ? amdPlatform(require) : "require",
      require,
      answered.get(require),
    )
  );
}

/**
 * Every import of one of the target's modules evaluates that module's file. A required
 * file the checker names no module for is read whole where the call's value is used: the
 * value is the file's exports object, which this pass does not follow.
 */
const evaluations: ReferenceSource = {
  batched: ({ evaluations: found }) =>
    found.flatMap((evaluation) =>
      evaluation.require === undefined
        ? [evaluation.node]
        : [
            evaluation.require,
            ...(evaluation.require.text === "require" && evaluation.amd !== true
              ? [evaluation.node]
              : []),
          ],
    ),
  emit({ file, evaluations: found }, answered, pass) {
    const { project, sink, fileIds, fileIdByName, chains, loadableById, cap, exportsRead } = pass;
    const loaded = found.filter((one) => loading(one, answered, project));
    // A script declares no module, so the checker names nothing for a specifier of one;
    // the compiler's module resolution still names its file.
    const unnamed = loaded.flatMap(({ node, amd }) =>
      amd !== true &&
      answered.get(node) === undefined &&
      isStringLiteralLikeNode(node) &&
      queriedFile(file, node, fileIdByName) === undefined
        ? [node]
        : [],
    );
    const resolved = project.resolvedFileNames(unnamed);
    const scripts = new Map<Node, string | undefined>(
      unnamed.map((node, at) => {
        const name = resolved[at];
        return [node, name === undefined ? undefined : fileIdByName.get(name)];
      }),
    );
    const wholeReads: { readonly evaluation: Evaluation; readonly loaded: SourceFile }[] = [];
    for (const evaluation of loaded) {
      const queried = queriedFile(file, evaluation.node, fileIdByName);
      if (queried !== undefined) {
        sink.add(file, evaluation.node, evaluation.from, [queried], "evaluation", "syntax");
      }
      const module = answered.get(evaluation.node);
      const amd = evaluation.amd === true && isLiteralText(evaluation.node);
      const amdFile = amd
        ? fileIdByName.get(amdPath(dirnamePath(file.fileName), evaluation.node.text) ?? "")
        : undefined;
      // Node's require resolves a relative specifier the program records no resolution for,
      // as in a TypeScript file, by its own extension search.
      const script =
        amdFile ??
        scripts.get(evaluation.node) ??
        (!amd &&
        evaluation.require !== undefined &&
        module === undefined &&
        isLiteralText(evaluation.node) &&
        startsRelativePath(evaluation.node.text)
          ? fileNamed(file, evaluation.node.text, fileIdByName)
          : undefined);
      if (script === undefined && module === undefined) {
        possibleLoad(file, evaluation, pass);
      }
      if (script !== undefined) {
        const whole = loadableById.get(script);
        if (evaluation.whole === true && module === undefined && whole !== undefined) {
          wholeReads.push({ evaluation, loaded: whole });
        }
        sink.add(file, evaluation.node, evaluation.from, [script], "evaluation", "syntax");
      }
      if (module === undefined) {
        continue;
      }
      // A module the checker could not resolve may be any file of the target.
      const evaluated: readonly Target[] =
        module === UNANSWERED
          ? [...fileIds].map((id) => ({ id, guessed: true }))
          : chains
              .declarationsOf(module)
              .flatMap((id) => (fileIds.has(id) ? [id] : []))
              .map((id) => ({ id }));
      sink.add(file, evaluation.node, evaluation.from, evaluated, "evaluation", "batch");
    }
    const modules = project.symbolsAt(
      wholeReads.map((one) => project.handle(one.loaded)),
      cap,
    );
    wholeReads.forEach(({ evaluation }, at) => {
      const module = modules[at];
      const targets = module === undefined ? [] : exportsRead(module);
      sink.add(file, evaluation.node, evaluation.from, targets, "read", "batch");
    });
  },
};

/**
 * An import of a JavaScript file that a program formed for Node leaves unresolved, asked again
 * as a bundler resolves it (program.38): the file it names, and each export there the import
 * binds, a namespace import binding every one, are only possibly loaded.
 */
function possibleLoad<Brand>(file: SourceFile, evaluation: Evaluation, pass: Pass<Brand>): void {
  const { node } = evaluation;
  const declaration = node.parent;
  if (
    !pass.formedForNode ||
    evaluation.require !== undefined ||
    !JAVASCRIPT_FILE.test(file.fileName) ||
    !isLiteralText(node) ||
    !isRelativeSpecifier(node.text) ||
    !(isImportDeclaration(declaration) || isExportDeclaration(declaration))
  ) {
    return;
  }
  const loaded = fileNamed(file, node.text, pass.fileIdByName);
  if (loaded === undefined) {
    return;
  }
  pass.possiblyLoaded.add(loaded);
  const exported = pass.declaredIn(loaded).filter((one) => one.exported);
  for (const name of importedNames(declaration)) {
    for (const one of exported) {
      if (name === undefined || one.name === name) {
        pass.possiblyLoaded.add(one.id);
      }
    }
  }
}

/** A module URL the platform's `URL` builds names the file a runtime starts as a module. */
const urls: ReferenceSource = {
  batched: ({ urls: found }) => found.flatMap((url) => url.constructor ?? []),
  emit({ file, urls: found }, answered, { project, sink, fileIdByName }) {
    for (const url of found) {
      if (
        url.constructor !== undefined &&
        !callsPlatform(project, "URL", url.constructor, answered.get(url.constructor))
      ) {
        continue;
      }
      const path = relativeURLPath(dirnamePath(file.fileName), url.specifier);
      const loaded = path === undefined ? undefined : fileNamed(file, path, fileIdByName);
      if (loaded !== undefined) {
        sink.add(file, url.at, url.from, [loaded], "evaluation", "syntax");
      }
    }
  },
};

/**
 * A worker address names the file a runtime starts (references-ts.2): Node's `Worker` reads
 * a relative path against the working directory and a path of the module's own directory
 * against that directory, a browser's an address against the module's URL.
 */
const workers: ReferenceSource = {
  batched: ({ workers: found }) =>
    found.flatMap((worker) =>
      worker.holder === undefined ? [worker.constructor] : [worker.constructor, worker.holder],
    ),
  emit({ file, workers: found }, answered, pass) {
    const { project, sink, fileIds, directories, held } = pass;
    for (const worker of found) {
      const symbol = answered.get(worker.constructor);
      const text = worker.address;
      let path: string | undefined;
      if (startsThread(project, symbol, worker.holder && answered.get(worker.holder))) {
        path = worker.evaluated
          ? undefined
          : worker.ownDirectory
            ? resolvePath(dirnamePath(file.fileName), text)
            : startsRelativePath(text)
              ? resolvePath(directories.workingDirectoryOf(file.fileName), text)
              : undefined;
      } else if (
        !worker.ownDirectory &&
        (WORKER_CONSTRUCTORS.has(worker.constructor.text) ||
          worker.constructor.text === "navigator") &&
        isPlatformGlobal(project, symbol)
      ) {
        path = relativeURLPath(dirnamePath(file.fileName), text);
      }
      const started = (path === undefined ? [] : pass.ownFiles().named(path)).flatMap((one) => {
        const id = held.declarations.get(nodeKey(one, one));
        return id !== undefined && fileIds.has(id) ? [id] : [];
      });
      sink.add(file, worker.at, worker.from, started, "evaluation", "syntax");
    }
  },
};

/**
 * A computed load imports each file it loads where the call is written, reading what the file
 * exports unless it reads the file as text or a URL; callsPlatform owns which call is a `require`.
 */
const loads: ReferenceSource = {
  batched: ({ loads: found }) =>
    found.flatMap((load) => [
      ...(load.require === undefined ? [] : [load.require]),
      ...(load.asset ? [] : load.files.map((loaded) => loaded.file)),
    ]),
  emit({ file, fileId, loads: found }, answered, pass) {
    const { project, sink, consumer, exportsRead, unseenLoads } = pass;
    for (const load of found) {
      if (
        load.require !== undefined &&
        !callsPlatform(
          project,
          load.amd ? amdPlatform(load.require) : "require",
          load.require,
          answered.get(load.require),
        )
      ) {
        continue;
      }
      const position = sink.position(file, load.call);
      if (!load.resolved && !consumer && !file.isDeclarationFile && !sink.isTest(file)) {
        unseenLoads.push(position);
      }
      for (const loaded of load.files) {
        sink.add(
          file,
          position,
          load.eager ? fileId : load.from,
          [loaded.fileId],
          "evaluation",
          "syntax",
        );
        const module = load.asset ? undefined : answered.get(loaded.file);
        sink.add(
          file,
          position,
          load.from,
          module === undefined ? [] : exportsRead(module),
          "read",
          "batch",
        );
      }
    }
  },
};

/** A use of a module namespace object that may read every export of the module reads them all. */
const wholes: ReferenceSource = {
  batched: ({ wholes: found }) => found.map((whole) => whole.specifier),
  emit({ file, wholes: found }, answered, { sink, exportsRead }) {
    for (const whole of found) {
      const module = answered.get(whole.specifier);
      if (module !== undefined) {
        sink.add(file, whole.at, whole.from, exportsRead(module), "read", "batch");
      }
    }
  },
};

/**
 * A component file's markup may use any binding its blocks declare at the top level, and any
 * export of a module a binding's chain reaches, whether a namespace import binds it or a named
 * or default import of a namespace re-export.
 */
const markup: ReferenceSource = {
  batched: ({ bindings }) => bindings,
  emit({ file, fileId, markup: written, bindings }, answered, pass) {
    if (!written) {
      return;
    }
    const { sink, chains, named, declaredIn } = pass;
    for (const symbol of declaredIn(fileId)) {
      sink.add(file, symbol.position, fileId, [symbol.id], "read", "syntax");
    }
    for (const binding of bindings) {
      const symbol = answered.get(binding);
      if (symbol === undefined) {
        continue;
      }
      const chained: readonly Target[] =
        symbol === UNANSWERED ? named(binding) : chains.chainOf(symbol);
      const targets = chained.flatMap((target) => [
        target,
        ...declaredIn(target.id)
          .filter((one) => one.exported)
          .map((one) => ({ ...target, id: one.id })),
      ]);
      sink.add(file, binding, fileId, targets, "read", "batch");
    }
  },
};

/**
 * A pattern names a property of the value it destructures, which no name node of the pattern
 * resolves to: a shorthand's name is the local it binds.
 */
const patterns: ReferenceSource = {
  emit({ file, reads }, _answered, { sink, held, destructured, targetsOf }) {
    destructured.resolve(reads).forEach((symbol, index) => {
      const read = reads[index];
      if (symbol === undefined || read === undefined) {
        return;
      }
      const targets: readonly Target[] =
        symbol === UNANSWERED
          ? (held.byName.get(read.name) ?? []).map((id) => ({ id, guessed: true }))
          : targetsOf(symbol).map((target) => ({ ...target, stepped: false }));
      sink.add(file, read.key, read.from, targets, "read", "destructured");
    });
  },
};

/** A key a unique symbol types selects the member declared under that symbol. */
const keyed: ReferenceSource = {
  emit({ file, keyed: found }, answered, { project, sink, chains, tables, cap, held }) {
    const keyNames = computedKeyNames(held.symbols);
    const resolvedKeys = found.flatMap((access) => {
      const symbol =
        isIdentifier(access.key) && keyNames.has(access.key.text)
          ? answered.get(access.key)
          : undefined;
      return typeof symbol === "object" ? [{ access, symbol }] : [];
    });
    for (const { access, ids } of keyedUses(project, chains, resolvedKeys, tables, cap)) {
      for (const use of access.use === "both" ? (["read", "write"] as const) : [access.use]) {
        sink.add(file, access.access.argumentExpression, access.from, ids, use, "keyed");
      }
    }
  },
};

/**
 * A name a use writes resolves to what it names; a re-export something imports is used and so
 * is the declaration behind it, so the use names every link of the chain its name stands at the
 * head of. A shorthand is left out of the batch: its name resolves to the property the literal
 * declares, which this project's inventory never holds, so its value is asked on its own.
 */
const names: ReferenceSource = {
  batched: ({ uses }) =>
    uses.filter((site) => site.shorthand === undefined).map((site) => site.node),
  emit({ file, uses }, answered, pass) {
    const { project, sink, named, targetsOf, throughAliases } = pass;
    for (const site of uses) {
      const symbol = symbolFor(project, site, answered);
      if (symbol === undefined) {
        continue;
      }
      const direct: Resolution =
        site.shorthand !== undefined
          ? "shorthand"
          : typeof answered.get(site.node) === "object"
            ? "batch"
            : "resolved-symbol";
      const targets = throughAliases(symbol === UNANSWERED ? named(site.node) : targetsOf(symbol));
      const value = site.use === "write" ? storedValue(site.node) : undefined;
      sink.add(file, site.node, site.from, targets, site.use, direct, value);
    }
  },
};

/** The symbol one site resolves to, asking only the accessor the site's form names. */
function symbolFor<Brand>(
  project: ProjectView<Brand>,
  site: Site,
  answered: ReadonlyMap<Node, Answer<TSSymbol>>,
): Answer<TSSymbol | undefined> {
  if (site.shorthand !== undefined) {
    return project.shorthandValueAt(project.handle(site.shorthand));
  }
  const batched = answered.get(site.node);
  if (batched === UNANSWERED || typeof batched === "object") {
    return batched;
  }
  return project.resolvedSymbolAt(project.handle(site.node));
}

/** Every per-file source, in the order the pass asks their nodes. */
const REFERENCE_SOURCES: readonly ReferenceSource[] = [
  names,
  links,
  evaluations,
  wholes,
  urls,
  workers,
  markup,
  loads,
  decorators,
  parameterWrites,
  patterns,
  keyed,
];

/** What the pass reads of one walked file before its batch: its computed loads and its markup bindings. */
export function prepared<Brand>(
  sites: FileSites & { readonly file: SourceFile; readonly fileId: string },
  pass: Pick<Pass<Brand>, "directories">,
  loadable: readonly { readonly file: SourceFile; readonly fileId: string }[],
): WalkedFile {
  const markupFile = isComponentFile(sites.file);
  return {
    ...sites,
    loads: computedLoadsOf(sites.file, sites.loadCalls, loadable, (fileName) =>
      pass.directories.bundlerRootOf(fileName),
    ),
    markup: markupFile,
    bindings: markupFile ? bindingsOf(sites.file).map((binding) => binding.name) : [],
  };
}

/**
 * Runs every source over one walked file: one batch per capped run of the nodes the sources
 * name, each node once, then each source's uses.
 */
export function emitFile<Brand>(walked: WalkedFile, pass: Pass<Brand>): void {
  const { project, cap } = pass;
  const batching = [
    ...new Set(REFERENCE_SOURCES.flatMap((source) => [...(source.batched?.(walked, pass) ?? [])])),
  ];
  const answered = new Map<Node, Answer<TSSymbol>>();
  for (let from = 0; from < batching.length; from += cap) {
    const run = batching.slice(from, from + cap);
    const answers = project.symbolsAt(
      run.map((node) => project.handle(node)),
      cap,
    );
    run.forEach((node, index) => {
      const symbol = answers[index];
      if (symbol !== undefined) {
        answered.set(node, symbol);
      }
    });
  }
  for (const source of REFERENCE_SOURCES) {
    source.emit(walked, answered, pass);
  }
}
