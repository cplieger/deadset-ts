/**
 * One project's declarations, the references between them and the roots that seed
 * reachability, indexed for the sweep. The graph reads no file and asks the compiler
 * nothing, so a sweep over it is a function of the values it was built from, and the
 * inventory's order is the order every set a sweep answers reads in.
 */

import type { InventorySymbol, SymbolKind } from "./inventory.ts";
import type { Reference } from "./references.ts";
import type { Root, RootKind } from "./roots.ts";

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
 * tool reads the configuration it loads and the files its strings name, a runtime runs a
 * test file, a setup file, a worker, a page's module script, a command and a script, the
 * manifest names what enters the package, an alias global stands for the export it names,
 * and an entry file, a configured root and a pattern assert a caller. A library's
 * published API only supposes an unseen consumer, so it is live under reachability alone.
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
  "configuration-file": true,
  "configuration-string": true,
  "test-runner": true,
  "mutation-testing": true,
  "browser-tests": true,
  worker: true,
  "html-entry": true,
};

/** Whether the sweep judges a declaration of one kind. */
export function swept(kind: SymbolKind): boolean {
  return SWEPT[kind];
}

/** Whether a root of one kind names a caller rather than supposing one. */
export function namesACaller(kind: RootKind): boolean {
  return NAMES_A_CALLER[kind];
}

/** One reference as the sweep reads it: the declaration named, and whether a test file made it. */
export interface Edge {
  readonly to: number;
  readonly test: boolean;
  /**
   * Whether the reference evaluates the module whose file it names, which reaches the
   * module's top level and none of what it exports.
   */
  readonly evaluation: boolean;
}

/** How many references one declaration carries, split by the classification of the file that made each. */
export interface Counts {
  readonly production: number;
  readonly test: number;
}

/** One root the inventory holds, at the position of the declaration it names. */
export interface Rooted {
  readonly at: number;
  readonly kind: RootKind;
}

/** The index the sweep and the component pass read. */
export interface Graph {
  /** The declarations, in the order the inventory returns them. */
  readonly symbols: readonly InventorySymbol[];
  /** Per declaration, the references it makes to declarations the inventory holds. */
  readonly out: readonly (readonly Edge[])[];
  /** Per declaration, the references made to it, whoever made them. */
  readonly made: readonly Counts[];
  /** Per declaration, the position of its container, or {@link OUTSIDE} for a file. */
  readonly parent: readonly number[];
  /** Per declaration, whether a test file holds it. */
  readonly test: readonly boolean[];
  /** Per declaration, whether a test-support file holds it. */
  readonly support: readonly boolean[];
  /** Per declaration, whether the sweep judges its liveness. */
  readonly subject: readonly boolean[];
  /**
   * Per declaration, the declarations its export table names where it is a file, and
   * nothing for any other declaration. A reference that reads a file reads the module's
   * namespace, which reaches everything the module exports.
   */
  readonly exportsOf: readonly (readonly number[])[];
  /** Every root naming a declaration the inventory holds, in the order the root set gives them. */
  readonly rooted: readonly Rooted[];
  /**
   * Every reference a loaded consumer or an unheld file makes to a declaration the
   * inventory holds, in the order given. Such a file is a caller the analysis read, so the
   * sweep holds what it names live under both relations and reaches on from there.
   */
  readonly consumed: readonly Edge[];
  /** The position of the declaration one identifier names, or {@link OUTSIDE}. */
  at(id: string): number;
}

/**
 * Indexes one project's inventory, references and roots. `testFiles` are the paths the
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
): Graph {
  const supports = new Set(supportFiles);
  const index = new Map(symbols.map((symbol, at) => [symbol.id, at]));
  const at = (id: string): number => index.get(id) ?? OUTSIDE;
  const tests = new Set(testFiles);

  const out: Edge[][] = symbols.map(() => []);
  const made = symbols.map(() => ({ production: 0, test: 0 }));
  const consumed: Edge[] = [];
  for (const reference of references) {
    const to = at(reference.to);
    if (to === OUTSIDE) {
      continue;
    }
    const counts = made[to];
    if (counts !== undefined) {
      if (reference.test) {
        counts.test += 1;
      } else {
        counts.production += 1;
      }
    }
    const edge = { to, test: reference.test, evaluation: reference.use === "evaluation" };
    if (reference.consumer !== undefined || reference.unheld === true) {
      consumed.push(edge);
      continue;
    }
    out[at(reference.from)]?.push(edge);
  }

  const parent = symbols.map((symbol) => at(symbol.parent));
  const exportsOf: number[][] = symbols.map(() => []);
  symbols.forEach((symbol, position) => {
    const container = parent[position] ?? OUTSIDE;
    if (symbol.exported && symbols[container]?.kind === "file") {
      exportsOf[container]?.push(position);
    }
  });

  const rooted: Rooted[] = [];
  for (const root of roots) {
    const position = at(root.id);
    if (position !== OUTSIDE) {
      rooted.push({ at: position, kind: root.kind });
    }
  }

  return {
    symbols,
    out,
    made,
    parent,
    test: symbols.map((symbol) => tests.has(symbol.position.path)),
    support: symbols.map((symbol) => supports.has(symbol.position.path)),
    subject: symbols.map((symbol) => swept(symbol.kind)),
    exportsOf,
    rooted,
    consumed,
    at,
  };
}
