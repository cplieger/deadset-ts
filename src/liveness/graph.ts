/**
 * The run's declarations, the references every configuration makes between them and the
 * roots that seed reachability, indexed for the sweep. The graph reads no file and asks the
 * compiler nothing, so a sweep over it is a function of the values it was built from, and
 * the inventory's order is the order every set a sweep answers reads in.
 */

import type { InventorySymbol, SymbolKind } from "../inventory.ts";
import type { Reference } from "../references.ts";
import { madeByTestCode } from "../tests/file-class.ts";
import type { Root, RootKind } from "../roots/root-set.ts";

/** The position of a declaration the inventory does not hold. */
export const OUTSIDE = -1;

/**
 * Whether the sweep judges a declaration of each kind. A file is not judged by either
 * relation: whether a file is built and whether anything imports it are the subjects of
 * the file kinds, which read the program rather than ask whether anything references the
 * file. The Contract's finding schema names the kinds that carry no liveness relation,
 * and a test holds this table to that list.
 */
const SWEPT: Readonly<Record<SymbolKind, boolean>> = {
  file: false,
  function: true,
  class: true,
  interface: true,
  type: true,
  enum: true,
  namespace: true,
  variable: true,
  "export-alias": true,
  method: true,
  "class-member": true,
  "interface-method": true,
  "type-member": true,
  "enum-member": true,
  "type-parameter": true,
};

/**
 * Whether a root of each kind names a caller, which holds it live under both relations: a
 * tool reads what it loads and what its strings name, a runtime runs a test or setup
 * file, a page's module script, a command, a script or a workflow step, the manifest
 * names what enters the package, an alias global stands for its export, an outside
 * declaration names a global interface merging into it, and an entry file, a configured root
 * and a pattern assert a caller. A published API supposes a consumer: reachability alone.
 */
const NAMES_A_CALLER: Readonly<Record<RootKind, boolean>> = {
  "entry-file": true,
  convention: true,
  "manifest-entry": true,
  "manifest-binary": true,
  script: true,
  "published-api": false,
  configured: true,
  pattern: true,
  "type-error": true,
  "type-query-alias": true,
  "global-augmentation": true,
  "configuration-file": true,
  "configuration-string": true,
  "bundler-entry": true,
  "test-runner": true,
  "html-entry": true,
  "workflow-step": true,
  "document-import": true,
};

/** Whether the sweep judges a declaration of one kind. */
export function swept(kind: SymbolKind): boolean {
  return SWEPT[kind];
}

/** Whether a root of one kind names a caller rather than supposing one. */
export function namesACaller(kind: RootKind): boolean {
  return NAMES_A_CALLER[kind];
}

/**
 * What one reference reads beyond the declaration it names (references-ts.3 to .5): `whole`
 * where no rule judged the read, so it may read everything the declaration exports; `passes`
 * where a re-export passes a namespace object on, read whole only where code the
 * analysis does not see uses its source; `none` for a judged read of a namespace object, a
 * write, and an evaluation, which reaches the module's top level alone.
 */
export type Reads = "whole" | "passes" | "none";

/** {@link Reads} of one reference, from the marks the reference pass gives it. */
function readsOf(reference: Reference): Reads {
  if (reference.use === "evaluation" || reference.use === "write") {
    return "none";
  }
  if (reference.namespace !== true) {
    return "whole";
  }
  return reference.reexport === true ? "passes" : "none";
}

/** One reference as the sweep reads it: the declaration named, and whether a test file made it. */
export interface Edge {
  readonly to: number;
  /** The reference's place in {@link Graph.references}. */
  readonly reference: number;
  readonly test: boolean;
  /** Whether only the name answered, which counts at the sweep's guessed tier alone. */
  readonly guessed: boolean;
  readonly reads: Reads;
  /**
   * Whether a loaded consumer made it, whose test references a mode may class as
   * production. Only a consumed edge can be one.
   */
  readonly consumer: boolean;
}

/**
 * How many references one declaration carries, split by the classification of the file that
 * made each; `consumerTest` counts the test references a loaded consumer's test files made,
 * which a mode may class as production (`sweep.ts` `countedRefs`).
 */
export interface Counts {
  readonly production: number;
  readonly test: number;
  readonly consumerTest: number;
}

/** One root the inventory holds, at the position of the declaration it names. */
export interface Rooted {
  readonly at: number;
  readonly kind: RootKind;
  /** What names the root, as the root set spells it. */
  readonly source: string;
}

/** The index the sweep and the component pass read. */
export interface Graph {
  /** The declarations, in the order the inventory returns them. */
  readonly symbols: readonly InventorySymbol[];
  /** Per declaration, the references it makes to declarations the inventory holds. */
  readonly out: readonly (readonly Edge[])[];
  /** Per declaration, the references made to it, whoever made them. */
  readonly made: readonly Counts[];
  /** Per declaration, those of {@link Graph.made} only a name answered. */
  readonly guessedMade: readonly Counts[];
  /** Per declaration, how many of the test references {@link Graph.made} counts are test-file exemption evidence. */
  readonly testEvidence: readonly number[];
  /** The references the graph was built from, in the order given. */
  readonly references: readonly Reference[];
  /** Per reference, the configurations that make it, in the run's order. */
  readonly configurations: readonly (readonly string[])[];
  /** Per declaration, the position of its container, or {@link OUTSIDE} for a file. */
  readonly parent: readonly number[];
  /** Per declaration, whether a test file holds it. */
  readonly test: readonly boolean[];
  /** Per declaration, whether a test-support file holds it. */
  readonly support: readonly boolean[];
  /** Per declaration, whether it is ambient, describing code the target does not implement. */
  readonly ambient: readonly boolean[];
  /** Per declaration, whether the sweep judges its liveness. */
  readonly subject: readonly boolean[];
  /** Per declaration, what a whole read of it references directly ({@link wholeReads}). */
  readonly exportsOf: readonly (readonly number[])[];
  /** Every root naming a declaration the inventory holds, in the order the root set gives them. */
  readonly rooted: readonly Rooted[];
  /**
   * Every reference a loaded consumer, an unheld file or a declaration no configuration
   * judges makes to a declaration the inventory holds, in the order given. Such code is a
   * caller the analysis read, so the sweep holds what it names live under both relations
   * and reaches on from there.
   */
  readonly consumed: readonly Edge[];
  /** The position of the declaration one identifier names, or {@link OUTSIDE}. */
  at(id: string): number;
}

/** What the run says of a graph's references beyond the references themselves. */
interface Sources {
  /**
   * The declarations a configuration holds only for their references, judged by none: each
   * reference one makes enters as a consumer's does, since deleting what it names breaks
   * that configuration's compile (matrix.5).
   */
  readonly unjudged?: ReadonlySet<string>;
  /** Per reference, in the order given, the configurations that make it. */
  readonly configurations?: readonly (readonly string[])[];
}

/** Whether one declaration is a value `namespace`, rather than a module block or a global augmentation. */
function valueNamespace(symbol: InventorySymbol): boolean {
  return symbol.kind === "namespace" && symbol.block === undefined;
}

/**
 * Per declaration, by position, what a whole read of it references directly (references-ts.3,
 * .5): a file's, a `declare module` block's or a value `namespace`'s exported declarations. The
 * declarations of one symbol share one container and one ref; where they merge a `namespace`
 * with a class, a function or an enum, each of them reads every merged body's exports, the
 * class's static members and the enum's members. Nothing else is read here: a nested namespace value is read
 * whole in turn by whoever expands it. `parent` gives each declaration's container's position.
 */
export function wholeReads(
  symbols: readonly InventorySymbol[],
  parent: readonly number[],
): readonly (readonly number[])[] {
  const reads: number[][] = symbols.map(() => []);
  const keyOf = (place: number, symbol: InventorySymbol): string =>
    `${String(parent[place] ?? OUTSIDE)} ${symbol.ref}`;
  const groups = new Map<string, number[]>();
  const namespaced = new Set<string>();
  symbols.forEach((symbol, place) => {
    if (
      symbol.kind === "class" ||
      symbol.kind === "enum" ||
      symbol.kind === "function" ||
      valueNamespace(symbol)
    ) {
      const key = keyOf(place, symbol);
      groups.set(key, [...(groups.get(key) ?? []), place]);
      if (valueNamespace(symbol)) {
        namespaced.add(key);
      }
    }
  });
  symbols.forEach((symbol, place) => {
    const container = parent[place] ?? OUTSIDE;
    const holding = symbols[container];
    if (holding === undefined) {
      return;
    }
    if (holding.kind === "file" || holding.block === "module") {
      if (symbol.exported) {
        reads[container]?.push(place);
      }
      return;
    }
    const key = keyOf(container, holding);
    const member =
      (valueNamespace(holding) && symbol.exported) ||
      (holding.kind === "class" && symbol.static) ||
      (holding.kind === "enum" && symbol.kind === "enum-member");
    if (member && namespaced.has(key)) {
      for (const one of groups.get(key) ?? []) {
        reads[one]?.push(place);
      }
    }
  });
  return reads;
}

/** Adds one reference's count to the counts of the declaration it names. */
function count(
  counts: { production: number; test: number; consumerTest: number },
  test: boolean,
  consumer: boolean,
): void {
  if (test) {
    counts.test += 1;
    counts.consumerTest += consumer ? 1 : 0;
  } else {
    counts.production += 1;
  }
}

/**
 * Indexes the run's inventory, references and roots. `testFiles` are the paths the
 * reference pass classified as test files, so a declaration one holds is a test
 * declaration. A reference to a declaration the inventory does not hold is dropped; one
 * from such a declaration still counts toward its target, because reference counting
 * asks whether any declaration names the target. A root naming nothing is dropped.
 */
export function graphOf(
  symbols: readonly InventorySymbol[],
  references: readonly Reference[],
  roots: readonly Root[],
  testFiles: readonly string[],
  supportFiles: readonly string[] = [],
  ambient: ReadonlySet<string> = new Set(),
  sources: Sources = {},
): Graph {
  const supports = new Set(supportFiles);
  const index = new Map(symbols.map((symbol, at) => [symbol.id, at]));
  const at = (id: string): number => index.get(id) ?? OUTSIDE;
  const tests = new Set(testFiles);
  const unjudged = sources.unjudged ?? new Set<string>();

  const out: Edge[][] = symbols.map(() => []);
  const made = symbols.map(() => ({ production: 0, test: 0, consumerTest: 0 }));
  const guessedMade = symbols.map(() => ({ production: 0, test: 0, consumerTest: 0 }));
  const testEvidence = symbols.map(() => 0);
  const consumed: Edge[] = [];
  references.forEach((reference, place) => {
    const to = at(reference.to);
    if (to === OUTSIDE) {
      return;
    }
    const test = madeByTestCode(reference, supports);
    const consumer = reference.consumer !== undefined;
    const guessed = reference.guessed === true;
    const counts = made[to];
    if (counts !== undefined) {
      count(counts, test, consumer);
    }
    const guesses = guessedMade[to];
    if (guessed && guesses !== undefined) {
      count(guesses, test, consumer);
    }
    if (test && reference.evidence === true) {
      testEvidence[to] = (testEvidence[to] ?? 0) + 1;
    }
    const edge = {
      to,
      reference: place,
      test,
      guessed,
      reads: readsOf(reference),
      consumer,
    };
    if (consumer || reference.unheld === true || unjudged.has(reference.from)) {
      consumed.push(edge);
      return;
    }
    out[at(reference.from)]?.push(edge);
  });

  const parent = symbols.map((symbol) => at(symbol.parent));
  const exportsOf = wholeReads(symbols, parent);

  const rooted: Rooted[] = [];
  for (const root of roots) {
    const position = at(root.id);
    if (position !== OUTSIDE) {
      rooted.push({ at: position, kind: root.kind, source: root.source });
    }
  }

  return {
    symbols,
    out,
    made,
    guessedMade,
    testEvidence,
    references,
    configurations: sources.configurations ?? references.map(() => []),
    parent,
    test: symbols.map((symbol) => tests.has(symbol.position.path)),
    support: symbols.map((symbol) => supports.has(symbol.position.path)),
    ambient: symbols.map((symbol) => ambient.has(symbol.id)),
    subject: symbols.map((symbol) => swept(symbol.kind)),
    exportsOf,
    rooted,
    consumed,
    at,
  };
}
