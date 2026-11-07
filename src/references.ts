/**
 * Every use one side's files make of the target's declarations: one walk and one batched
 * resolution per file, never a reference query per symbol, whose answers would depend on the
 * order the symbols are asked in. A reference carries its use, its position, the declaration
 * enclosing it and whether a test file made it; it carries no mode: which references a run
 * counts is the sweep's reading of this set.
 */

import { SyntaxKind, type Node } from "@typescript/native/ast";
import type { Symbol as TSSymbol } from "@typescript/native/sync";
import { aliasChains, type ChainTarget } from "./alias-chain.ts";
import { augmentationReferences, mergedGlobalInterfaces } from "./augmentations.ts";
import { contextualUses } from "./contextual-uses.ts";
import { destructuring } from "./destructuring.ts";
import type { RunDirectories } from "./entries/run-directories.ts";
import { bindingsOf } from "./import-bindings.ts";
import { sitesOf } from "./index/sites.ts";
import { nodeKey, type Inventory, type InventorySymbol } from "./inventory.ts";
import { relativePath } from "./paths.ts";
import type { Position } from "./position.ts";
import { DEFAULT_BATCH_CAP, propertyTables, UNANSWERED, type Answer } from "./query.ts";
import { heldBy, READ_RULES } from "./references/read-rules.ts";
import { Sink } from "./references/sink.ts";
import { emitFile, prepared, type Pass } from "./references/sources.ts";
import type { ProjectView } from "./session.ts";
import { sourceFilesOf, type SourceFiles } from "./source-files.ts";
import { bytewise } from "./text/compare.ts";
import type { TestFile } from "./tests/file-class.ts";
import { typeQueryAliases } from "./type-query-alias.ts";

/**
 * How one reference uses the declaration it names. An `evaluation` names a file: the
 * place it is written imports the module, which runs the module's top level and reads
 * none of what it exports. A `read` of a file reads the module's namespace. A
 * `decorator` names the declaration a decorator expression is attached to, which the
 * decorator receives when the class is defined.
 */
export type Use = "read" | "write" | "evaluation" | "decorator";

/**
 * Which path answered for one reference, provenance only: `batch`, a file's batched lookup;
 * `resolved-symbol`, the per-node lookup for its residue; `shorthand`, the value `{ a }` reads;
 * `alias`, a step along an import or export chain; `syntax`, the tree alone; `destructured`,
 * the property a pattern names; `contextual`, the member a literal property writes or a
 * value's position reads; `override`, the override a base call dispatches to; `keyed`, the
 * member a key selects; `by-name`, each declaration so spelled, where the checker failed.
 */
export type Resolution =
  | "batch"
  | "resolved-symbol"
  | "shorthand"
  | "alias"
  | "syntax"
  | "destructured"
  | "contextual"
  | "override"
  | "keyed"
  | "by-name";

/** One use of one declaration by one declaration. */
export interface Reference {
  /**
   * The identifier of the declaration the referencing name is written inside. A
   * reference written outside every declaration of a file belongs to the file and
   * carries the file's own identifier, the way an import belongs to the file that
   * writes it rather than to the first declaration below it.
   */
  readonly from: string;
  /** The identifier of the declaration the reference names. */
  readonly to: string;
  /** Where the referencing name is written. */
  readonly position: Position;
  readonly use: Use;
  readonly resolution: Resolution;
  /** Whether a test file made the reference (`tests/file-class.ts`). */
  readonly test: boolean;
  /**
   * Present where only the name answered, the checker having failed (program.33): the
   * reference may be a use of any declaration so spelled, so the run holds what it names.
   */
  readonly guessed?: true;
  /**
   * The identifier of the consumer whose file made the reference, absent for one the
   * target made. A consumer's declarations are no declarations of the run, so such a
   * reference comes from outside the inventory, and its position is rendered against
   * the consumer's root.
   */
  readonly consumer?: string;
  /** Made by a target file no project of the run holds, so it enters as a consumer's reference does. */
  readonly unheld?: true;
  /**
   * On a write, the local names of the writing file's import bindings that only the
   * values its file writes into the same declaration use, which deleting the
   * declaration with its writes deletes too.
   */
  readonly alone?: readonly string[];
  /**
   * The declarations whose deletion with their writes deletes the referencing name,
   * innermost first: `from` where the name is in its own annotation, then each declaration
   * a write of the same file stores into whose stored value holds the name. Absent where
   * there is none, and on a consumer's reference.
   */
  readonly carriers?: readonly string[];
}

/** The consumer one reference pass reads the files of, beside the target it names. */
export interface ConsumerSide {
  /** The name the consumer publishes itself under. */
  readonly id: string;
  /** The consumer's directory, absolute: the files below it are its own. */
  readonly root: string;
}

/** One side's references, in position order. */
export interface References {
  readonly references: readonly Reference[];
  /**
   * The declarations a read rule's unanswered question could have made live, and those
   * making such a read, each once, ascending: the run holds them (program.33).
   */
  readonly held: readonly string[];
  /**
   * Each load by a computed path a production file of the target writes whose files the
   * analysis cannot name (confidence.26), in file then source order; none for a consumer.
   */
  readonly unseenLoads: readonly Position[];
  /**
   * The files, and the declarations an import binds there, that only a bundler's retry of a
   * specifier Node leaves unresolved names (program.38), each once, ascending.
   */
  readonly possiblyLoaded: readonly string[];
}

/** How one run resolves references. */
export interface ReferenceOptions {
  /**
   * The greatest number of name nodes one batched lookup asks about. A batch is
   * answered by an array of its own length, so an uncapped batch over a large file
   * makes one answer proportional to that file. Absent takes {@link DEFAULT_BATCH_CAP}.
   */
  readonly batchCap?: number;
  /** Which of the side's files are test files. */
  readonly testFile: TestFile;
  /**
   * The consumer whose files the pass walks instead of the target's. Its files are the
   * program's own files below its root and not below the target root, each position is
   * rendered against its root, and only a reference to a declaration of `held`, the
   * target's, is recorded.
   */
  readonly consumer?: ConsumerSide;
  /** The directories a thread's path and a glob's root are read against. */
  readonly directories: RunDirectories;
  /** Whether the program is one the run formed to resolve as Node does (program.36). */
  readonly formedForNode?: boolean;
}

/** The declaration kinds of a property an object literal declares. */
const LITERAL_PROPERTY_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.PropertyAssignment,
  SyntaxKind.ShorthandPropertyAssignment,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);

/**
 * Every reference one side's files make to the target's declarations. `held` is the
 * target's inventory over the files the project holds, where a resolved symbol is looked up;
 * positions render against `targetRoot`, or a consumer's root as
 * {@link ReferenceOptions.consumer} states. The order is by position, then the declaration
 * named, the referencing declaration and the use: an alias chain or a bare star re-export
 * names several at one position, and one name references one declaration once.
 */
export function references<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
  targetRoot: string,
  options: ReferenceOptions,
): References {
  const cap = options.batchCap ?? DEFAULT_BATCH_CAP;
  const declarations = held.declarations;
  const chains = aliasChains(project, held);
  const tables = propertyTables(project.queries);
  const consumer = options.consumer;
  const files =
    consumer === undefined
      ? project.ownSourceFiles()
      : project
          .ownSourceFiles()
          .filter(
            (file) =>
              relativePath(consumer.root, file.fileName) !== undefined &&
              relativePath(targetRoot, file.fileName) === undefined,
          );
  const ownPaths = project.ownPaths();
  const fileIds = new Set(
    held.symbols.filter((symbol) => symbol.kind === "file").map((symbol) => symbol.id),
  );
  const declaredAt = (node: Node): string | undefined =>
    declarations.get(nodeKey(node.getSourceFile(), node));
  const sink = new Sink(consumer?.root ?? targetRoot, options.testFile, consumer, declaredAt);

  let moduleBodies: ReadonlyMap<string, readonly InventorySymbol[]> | undefined;
  /**
   * The declarations one module holds directly: a file's top level, or the body of a
   * `declare module` whose name is a string. Any other declaration holds none here.
   */
  const declaredIn = (moduleId: string): readonly InventorySymbol[] => {
    if (moduleBodies === undefined) {
      const byModule = new Map<string, InventorySymbol[]>();
      for (const symbol of held.symbols) {
        if (fileIds.has(symbol.parent) || held.modules.has(symbol.parent)) {
          byModule.set(symbol.parent, [...(byModule.get(symbol.parent) ?? []), symbol]);
        }
      }
      moduleBodies = byModule;
    }
    return moduleBodies.get(moduleId) ?? [];
  };
  const exportedBy = (ids: Iterable<string>): readonly ChainTarget[] =>
    [...ids].flatMap((id) =>
      declaredIn(id)
        .filter((symbol) => symbol.exported)
        .map((symbol) => ({ id: symbol.id, stepped: false, guessed: true })),
    );
  const exportsCache = new Map<number, readonly ChainTarget[]>();
  /**
   * Every declaration one module exports, each re-export walked along its chain. A module
   * the checker left unanswered may be any file, so it reads every file's exports.
   */
  const exportsRead = (module: Answer<TSSymbol>): readonly ChainTarget[] => {
    if (module === UNANSWERED) {
      return exportedBy(fileIds);
    }
    const known = exportsCache.get(module.id);
    if (known !== undefined) {
      return known;
    }
    const table = project.queries.exportsOfModule(module);
    const read =
      table === UNANSWERED
        ? exportedBy(chains.declarationsOf(module))
        : table.flatMap((exported) => chains.chainOf(exported));
    exportsCache.set(module.id, read);
    return read;
  };

  /**
   * Every declaration bearing the name one node spells, or the name an import of its file
   * binds that name to, which is what a reference the checker could not resolve is counted
   * as (program.33): it may be a use of any of them. A name a namespace import binds may be
   * a use of any file.
   */
  const named = (node: Node): readonly ChainTarget[] => {
    const text = node.getText();
    const imported = bindingsOf(node.getSourceFile()).filter(
      (binding) => binding.name.text === text,
    );
    return [
      ...new Set([
        ...(held.byName.get(text) ?? []),
        ...imported.flatMap((binding) =>
          binding.imported === undefined ? [...fileIds] : (held.byName.get(binding.imported) ?? []),
        ),
      ]),
    ].map((id) => ({ id, stepped: false, guessed: true }));
  };

  // A type-query alias's own type names its export without using it; a use of the
  // global is the use, so it names every link of the export's chain as well.
  const aliases = project.ownSourceFiles().flatMap(typeQueryAliases);
  const unread = new Set<Node>(aliases.map((alias) => alias.type));
  const aliased = new Map<string, readonly ChainTarget[]>();
  if (aliases.length > 0) {
    const exported = project.symbolsAt(aliases.map((alias) => project.handle(alias.exported)));
    aliases.forEach((alias, index) => {
      const id = declaredAt(alias.declaration);
      const symbol = exported[index];
      if (id === undefined || symbol === undefined) {
        return;
      }
      aliased.set(
        id,
        symbol === UNANSWERED
          ? (held.byName.get(alias.name) ?? []).map((one) => ({
              id: one,
              stepped: true,
              guessed: true,
            }))
          : chains.chainOf(symbol).map((target) => ({ ...target, stepped: true })),
      );
    });
  }
  /** One use's targets, then every link an alias global among them stands for, each once. */
  const throughAliases = (targets: readonly ChainTarget[]): readonly ChainTarget[] => {
    if (aliased.size === 0) {
      return targets;
    }
    const all = [...targets];
    const seen = new Set(targets.map((target) => target.id));
    for (const target of targets) {
      for (const forwarded of aliased.get(target.id) ?? []) {
        if (!seen.has(forwarded.id)) {
          seen.add(forwarded.id);
          all.push(forwarded);
        }
      }
    }
    return all;
  };

  const rules = READ_RULES.map((rule) => rule.start());
  const sites = files.map((file) => {
    const fileId = declaredAt(file) ?? "";
    return {
      file,
      fileId,
      ...sitesOf(file, declarations, fileId, unread, (node, from) => {
        for (const rule of rules) {
          rule.visit(node, { file, from });
        }
      }),
    };
  });
  const loadable = sites
    .filter((one) => fileIds.has(one.fileId))
    .map(({ file, fileId }) => ({ file, fileId }));
  const directories = options.directories;
  const destructured = destructuring(project, cap, tables);
  const contextual = contextualUses(
    project,
    held,
    chains,
    sites.flatMap((one) => one.literals),
    sites.flatMap((one) => one.flows),
    cap,
    tables,
  );

  const writtenBy = new Map<string, readonly string[]>();
  for (const write of contextual.writes) {
    const property = write.at.parent;
    writtenBy.set(nodeKey(property.getSourceFile(), property), write.ids);
  }
  const forwardedCache = new Map<number, readonly ChainTarget[]>();
  /**
   * The members a literal property one symbol declares writes: a use of the property
   * reaches them, because the literal's type carries the data the member describes.
   */
  const forwarded = (symbol: TSSymbol): readonly ChainTarget[] => {
    const known = forwardedCache.get(symbol.id);
    if (known !== undefined) {
      return known;
    }
    const found: ChainTarget[] = [];
    for (const handle of writtenBy.size === 0 ? [] : symbol.declarations) {
      if (!LITERAL_PROPERTY_KINDS.has(handle.kind) || !ownPaths.has(handle.path)) {
        continue;
      }
      const node = project.declarationAt(handle)?.node;
      const ids =
        node === undefined ? undefined : writtenBy.get(nodeKey(node.getSourceFile(), node));
      for (const id of ids ?? []) {
        if (!found.some((target) => target.id === id)) {
          found.push({ id, stepped: true, guessed: false });
        }
      }
    }
    forwardedCache.set(symbol.id, found);
    return found;
  };

  let ownFiles: SourceFiles | undefined;
  const pass: Pass<Brand> = {
    project,
    held,
    chains,
    tables,
    cap,
    sink,
    consumer: consumer !== undefined,
    directories,
    fileIds,
    fileIdByName: new Map(loadable.map((one) => [one.file.fileName, one.fileId])),
    loadableById: new Map(loadable.map((one) => [one.fileId, one.file])),
    destructured,
    unseenLoads: [],
    formedForNode: options.formedForNode === true,
    possiblyLoaded: new Set(),
    declaredIn,
    exportsRead,
    named,
    targetsOf: (symbol) => {
      const through = forwarded(symbol);
      return through.length === 0
        ? chains.chainOf(symbol)
        : [...chains.chainOf(symbol), ...through];
    },
    throughAliases,
    ownFiles: () => (ownFiles ??= sourceFilesOf(project, targetRoot)),
  };

  for (const site of contextual.writes) {
    const file = site.at.getSourceFile();
    sink.add(file, site.at, site.from, site.ids, "write", "contextual", site.at.parent);
  }
  for (const site of contextual.reads) {
    sink.add(site.at.getSourceFile(), site.at, site.from, site.ids, "read", "contextual");
  }
  for (const one of sites) {
    emitFile(prepared(one, pass, loadable), pass);
  }
  const context = { project, held, chains };
  for (const rule of rules) {
    for (const read of rule.reads(context)) {
      if (read.kind === "named") {
        sink.add(
          read.file,
          read.at,
          read.from,
          [read.to],
          read.use,
          read.via,
          undefined,
          read.production,
        );
      } else {
        sink.hold(heldBy(read, context));
      }
    }
  }

  const merges = mergedGlobalInterfaces(project, held, pass.ownFiles());
  sink.extend(augmentationReferences(held, sink.made, merges.scripts, merges.interfaces));
  const finished = sink.finish(new Map(sites.map((one) => [one.file, one.uses])));
  return {
    ...finished,
    unseenLoads: pass.unseenLoads,
    possiblyLoaded: [...pass.possiblyLoaded].sort(bytewise),
  };
}
