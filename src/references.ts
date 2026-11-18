/**
 * Every use one side's files make of the target's declarations: one walk and one batched
 * resolution per file, never a reference query per symbol, whose answers would depend on the
 * order the symbols are asked in. A reference carries its use, its position, the declaration
 * enclosing it and whether a test file made it; it carries no mode: which references a run
 * counts is the sweep's reading of this set.
 */

import { SyntaxKind, type Node, type SourceFile } from "@typescript/native/ast";
import type { Symbol as TSSymbol } from "@typescript/native/sync";
import { aliasChains, type ChainTarget } from "./alias-chain.ts";
import { augmentationReferences, mergedGlobalInterfaces } from "./augmentations.ts";
import { contextualUses } from "./contextual-uses.ts";
import { destructuring } from "./destructuring.ts";
import type { RunDirectories } from "./entries/run-directories.ts";
import { bindingsOf } from "./import-bindings.ts";
import { sitesOf } from "./index/sites.ts";
import { nameNodeOf, nodeKey, type Inventory, type InventorySymbol } from "./inventory.ts";
import { OUTSIDE, wholeReads } from "./liveness/graph.ts";
import { relativePath } from "./paths.ts";
import type { Position } from "./position.ts";
import { DEFAULT_BATCH_CAP, propertyTables, UNANSWERED, type Answer } from "./query.ts";
import { heldBy, READ_RULES } from "./references/read-rules.ts";
import { Sink } from "./references/sink.ts";
import { emitFile, prepared, type Pass } from "./references/sources.ts";
import type { ProjectView } from "./session.ts";
import { boundValue } from "./namespace-objects.ts";
import { sourceFilesOf, type SourceFiles } from "./source-files.ts";
import { bytewise } from "./text/compare.ts";
import type { TestFile } from "./tests/file-class.ts";
import { typeQueryAliases } from "./type-query-alias.ts";
import { canonicalDeclarations } from "./canonical-order.ts";

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
   * Present on each read a use of a namespace value makes, the checker resolving the use to a
   * module or a `namespace` declaration, where the pass judges every use where it is read and
   * records the members each reads, and on a re-export's read of one: the read names no member
   * (references-ts.3 to .5).
   */
  readonly namespace?: true;
  /**
   * Present on a re-export's read of what it carries, and on an alias declaration's: it is no
   * use by itself, its uses being judged where it is read (references-ts.4), unless a root
   * names it, whose callers the analysis does not see.
   */
  readonly reexport?: true;
  /**
   * The identifier of the consumer whose file made the reference, absent for one the
   * target made. A consumer's declarations are no declarations of the run, so such a
   * reference comes from outside the inventory, and its position is rendered against
   * the consumer's root.
   */
  readonly consumer?: string;
  /** Made by a target file no project of the run holds, so it enters as a consumer's reference does. */
  readonly unheld?: true;
  /** Made by the exemption evidence a test file carries rather than by a name it writes. */
  readonly evidence?: true;
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
  const positions = new Map(held.symbols.map((symbol, place) => [symbol.id, place]));
  let inventoryReads: readonly (readonly number[])[] | undefined;
  /**
   * Every declaration a whole read of each of `ids` references by the inventory alone
   * (`wholeReads`), each member read whole in turn: the read where the checker leaves a table
   * unanswered, so each target is guessed.
   */
  const inventoryRead = (ids: Iterable<string>): readonly ChainTarget[] => {
    inventoryReads ??= wholeReads(
      held.symbols,
      held.symbols.map((symbol) => positions.get(symbol.parent) ?? OUTSIDE),
    );
    const reads = inventoryReads;
    const queue = [...ids].flatMap((id) => positions.get(id) ?? []);
    const seen = new Set(queue);
    const found: ChainTarget[] = [];
    // An array's iterator reads its length at each step, so the members queued here are read too.
    for (const at of queue) {
      for (const member of reads[at] ?? []) {
        const symbol = held.symbols[member];
        if (!seen.has(member) && symbol !== undefined) {
          seen.add(member);
          queue.push(member);
          found.push({ id: symbol.id, stepped: false, guessed: true });
        }
      }
    }
    return found;
  };

  let sourceById: ReadonlyMap<string, SourceFile> | undefined;
  const declarationNodes = new Map<string, ReadonlyMap<string, Node>>();
  const declarationSymbols = new Map<string, Answer<TSSymbol | undefined>>();
  /** The symbol the checker gives one declaration of the inventory at its own name. */
  const declarationSymbol = (id: string): Answer<TSSymbol | undefined> => {
    if (!declarationSymbols.has(id)) {
      sourceById ??= new Map(
        project.ownSourceFiles().flatMap((file) => {
          const fileId = declaredAt(file);
          return fileId === undefined ? [] : [[fileId, file] as const];
        }),
      );
      let fileId = id;
      while (!fileIds.has(fileId) && positions.has(fileId)) {
        fileId = held.symbols[positions.get(fileId) ?? OUTSIDE]?.parent ?? "";
      }
      const file = sourceById.get(fileId);
      if (file !== undefined && !declarationNodes.has(fileId)) {
        const nodes = new Map<string, Node>();
        const visit = (node: Node): void => {
          const declared = declaredAt(node);
          if (declared !== undefined && !nodes.has(declared)) {
            nodes.set(declared, node);
          }
          node.forEachChild(visit);
        };
        file.forEachChild(visit);
        declarationNodes.set(fileId, nodes);
      }
      const node = declarationNodes.get(fileId)?.get(id);
      const name = node === undefined ? undefined : nameNodeOf(node);
      declarationSymbols.set(
        id,
        name === undefined ? UNANSWERED : project.symbolsAt([project.handle(name)])[0],
      );
    }
    return declarationSymbols.get(id);
  };

  /** One namespace value's read set before an entry the checker left unanswered adds any module's. */
  interface Closure {
    readonly read: readonly ChainTarget[];
    /** Whether an entry's chain went unanswered, so the read also takes in any module's. */
    readonly anyModule: boolean;
  }
  const closures = new Map<number, Closure>();
  /**
   * The read set of one namespace value the checker answers (references-ts.3, .5): every entry
   * of its export table along its alias chain, and the read set of each entry that is a namespace
   * value the inventory declares, through every level, each value once.
   */
  const closureOf = (module: TSSymbol): Closure => {
    const known = closures.get(module.id);
    if (known !== undefined) {
      return known;
    }
    const found = new Map<string, ChainTarget>();
    const add = (targets: readonly ChainTarget[]): void => {
      for (const target of targets) {
        if (!found.has(target.id)) {
          found.set(target.id, target);
        }
      }
    };
    const seen = new Set([module.id]);
    const queue = [module];
    let anyModule = false;
    for (const namespace of queue) {
      const table = project.queries.exportsOfModule(namespace);
      if (table === UNANSWERED) {
        add(inventoryRead(chains.declarationsOf(namespace)));
        continue;
      }
      for (const exported of table) {
        add(chains.chainOf(exported));
        const inner = chains.namespaceOf(exported);
        if (inner === UNANSWERED) {
          anyModule = true;
        } else if (
          inner !== undefined &&
          !seen.has(inner.id) &&
          chains.declarationsOf(inner).length > 0
        ) {
          seen.add(inner.id);
          queue.push(inner);
        }
      }
    }
    const closure = { read: [...found.values()], anyModule };
    closures.set(module.id, closure);
    return closure;
  };

  /** Whether one declaration of the inventory is a value `namespace`. */
  const valueNamespace = (id: string): boolean => {
    const symbol = held.symbols[positions.get(id) ?? OUTSIDE];
    return symbol?.kind === "namespace" && symbol.block === undefined;
  };
  /** Whether one declaration of the inventory is an alias, which records no target it stands for. */
  const alias = (id: string): boolean =>
    held.symbols[positions.get(id) ?? OUTSIDE]?.kind === "export-alias";
  /** The read set of one value `namespace` of the inventory. */
  const namespaceSet = (id: string): readonly ChainTarget[] => {
    const symbol = declarationSymbol(id);
    return typeof symbol === "object" ? closureOf(symbol).read : inventoryRead([id]);
  };

  let everyFile: readonly ChainTarget[] | undefined;
  /** The read set of every module of the target, each file by its module symbol. */
  const everyFileRead = (): readonly ChainTarget[] => {
    if (everyFile === undefined) {
      const owned = project.ownSourceFiles().flatMap((file) => {
        const fileId = declaredAt(file);
        return fileId !== undefined && fileIds.has(fileId) ? [{ file, fileId }] : [];
      });
      const modules = project.symbolsAt(
        owned.map(({ file }) => project.handle(file)),
        cap,
      );
      everyFile = owned.flatMap(({ fileId }, index) => {
        const module = modules[index];
        return typeof module === "object" ? closureOf(module).read : inventoryRead([fileId]);
      });
    }
    return everyFile;
  };
  /**
   * What a whole use whose name the checker left unanswered reads: whatever the name may stand
   * for (references-ts.5, program.33). A candidate that is a file or an alias, whose target the
   * inventory does not record, or no candidate list, may be any module or any value `namespace`;
   * a value `namespace` among `candidates`, through which a merged class, function or enum is
   * named too, reads its own set. Every target is guessed.
   */
  const unansweredRead = (candidates?: readonly string[]): readonly ChainTarget[] => {
    const found = new Map<string, ChainTarget>();
    const add = (targets: readonly ChainTarget[]): void => {
      for (const target of targets) {
        if (!found.has(target.id)) {
          found.set(target.id, { ...target, guessed: true });
        }
      }
    };
    const any = candidates === undefined || candidates.some((id) => fileIds.has(id) || alias(id));
    if (any) {
      add(everyFileRead());
    }
    const namespaces = any
      ? held.symbols.flatMap((symbol) => (valueNamespace(symbol.id) ? [symbol.id] : []))
      : candidates.filter(valueNamespace);
    for (const id of namespaces) {
      add(namespaceSet(id));
    }
    return [...found.values()];
  };
  /** The member one namespace value's export table holds under `name` (`Pass.memberOf`). */
  const memberOf = (
    namespace: TSSymbol,
    name: string,
  ): { readonly targets: readonly ChainTarget[]; readonly inner: Answer<TSSymbol | undefined> } => {
    const table = project.queries.exportsOfModule(namespace);
    if (table === UNANSWERED) {
      return { targets: inventoryRead(chains.declarationsOf(namespace)), inner: undefined };
    }
    const exported = table.find((one) => one.name === name);
    return exported === undefined
      ? { targets: [], inner: undefined }
      : { targets: chains.chainOf(exported), inner: chains.namespaceOf(exported) };
  };
  /**
   * The read set of one whole use of a namespace value (references-ts.5), the one the reference
   * pass gives every such use under both relations; `candidates` are the declarations an
   * unanswered name may stand for.
   */
  const exportsRead = (
    module: Answer<TSSymbol>,
    candidates?: readonly string[],
  ): readonly ChainTarget[] => {
    if (module === UNANSWERED) {
      return unansweredRead(candidates);
    }
    const { read, anyModule } = closureOf(module);
    if (!anyModule) {
      return read;
    }
    const ids = new Set(read.map((target) => target.id));
    return [...read, ...unansweredRead().filter((target) => !ids.has(target.id))];
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
  const destructured = destructuring(project, cap, tables);
  const loadable = sites
    .filter((one) => fileIds.has(one.fileId))
    .map(({ file, fileId }) => ({ file, fileId }));
  const directories = options.directories;
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
    for (const handle of writtenBy.size === 0 ? [] : canonicalDeclarations(symbol)) {
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

  const bindings = new Map<Node, boolean>();
  /** Whether one declaration's name binds a namespace value, asked once per name. */
  const binding = (name: Node): boolean => {
    let known = bindings.get(name);
    if (known === undefined) {
      const symbol = project.symbolsAt([project.handle(name)])[0];
      known = typeof symbol === "object" && typeof chains.namespaceOf(symbol) === "object";
      bindings.set(name, known);
    }
    return known;
  };
  const namesBound = new Map<SourceFile, ReadonlySet<string>>();
  /** The names one file's declarations that may bind a namespace value bind (`boundValue`). */
  const bindingNames = (file: SourceFile): ReadonlySet<string> => {
    let names = namesBound.get(file);
    if (names === undefined) {
      const found = new Set<string>();
      const visit = (node: Node): void => {
        const name = (node as { readonly name?: Node }).name;
        if (name !== undefined && boundValue(node) !== undefined) {
          found.add(name.getText());
        }
        node.forEachChild(visit);
      };
      file.forEachChild(visit);
      names = found;
      namesBound.set(file, names);
    }
    return names;
  };

  let ownFiles: SourceFiles | undefined;
  const shorthands = new Map<Node, Answer<TSSymbol | undefined>>();
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
    memberOf,
    named,
    targetsOf: (symbol) => {
      const through = forwarded(symbol);
      return through.length === 0
        ? chains.chainOf(symbol)
        : [...chains.chainOf(symbol), ...through];
    },
    throughAliases,
    ownFiles: () => (ownFiles ??= sourceFilesOf(project, targetRoot)),
    candidates: (node) => {
      const ids = named(node).map(({ id }) => id);
      if (ids.some((id) => fileIds.has(id) || valueNamespace(id) || alias(id))) {
        return ids;
      }
      const file = node.getSourceFile();
      // A namespace binding may be any module or namespace, which a file candidate stands for.
      return bindingNames(file).has(node.getText()) ? [...ids, declaredAt(file) ?? ""] : undefined;
    },
    binding,
    shorthandValue: (assignment) => {
      if (!shorthands.has(assignment)) {
        shorthands.set(assignment, project.shorthandValueAt(project.handle(assignment)));
      }
      return shorthands.get(assignment);
    },
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
          [read.namespace === true ? { id: read.to, namespace: true } : read.to],
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
