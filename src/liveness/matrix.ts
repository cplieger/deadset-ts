/**
 * One run's projects as one matrix: every declaration any project judges, keyed by its
 * position and carrying the configurations that hold it, and one graph over every
 * configuration's references and roots, which the sweep judges once (matrix.4, matrix.5).
 */

import { graphOf, swept, type Graph } from "./graph.ts";
import type { InventorySymbol } from "../inventory.ts";
import { byPosition } from "../position.ts";
import type { Reference } from "../references.ts";
import type { Root } from "../roots/root-set.ts";

/** What the passes answered for one configuration of the run. */
export interface Configured {
  /** The name discovery gives the configuration's project. */
  readonly configuration: string;
  readonly symbols: readonly InventorySymbol[];
  readonly references: readonly Reference[];
  readonly roots: readonly Root[];
  /** The paths the reference pass classified as test files. */
  readonly testFiles: readonly string[];
  /** The paths of the test-support files, which only test code imports. */
  readonly supportFiles?: readonly string[] | undefined;
  /** The paths of the files only tests reach that are no test-support file. */
  readonly testUsedFiles?: readonly string[] | undefined;
  /** The ids of the ambient declarations, which describe code the target does not implement. */
  readonly ambient?: ReadonlySet<string> | undefined;
  /**
   * The paths of the workspace-package files the configuration holds but does not
   * compile itself. Their declarations count in its graph and its verdict on them is no
   * finding.
   */
  readonly referenceOnly?: readonly string[] | undefined;
  /** Each declaration's dependents, by id, as the configuration's inventory states them. */
  readonly dependents?: ReadonlyMap<string, readonly string[]> | undefined;
}

/** The run's configurations, indexed for the sweep. */
export interface Matrix {
  /** The configurations, in the run's order. */
  readonly configurations: readonly string[];
  /**
   * The graph over every configuration at once: every declaration a configuration
   * holds in a file it does not hold only for its references, once per position and in
   * site order, and every reference any configuration makes, a reference several
   * configurations make at one position counted once and tagged with each of them.
   */
  readonly union: Graph;
  /**
   * Per declaration of {@link Matrix.union}, at its position there, the configurations
   * whose project holds it, in the run's order.
   */
  readonly heldIn: readonly (readonly string[])[];
  /**
   * Per declaration of {@link Matrix.union}, whether a file only tests reach that is no
   * test-support file holds it in some configuration: production code only tests use.
   */
  readonly testUsed: readonly boolean[];
  /** Each declaration's dependents, by id, as the first configuration holding it states them. */
  readonly dependents: ReadonlyMap<string, readonly string[]>;
}

/**
 * What makes one reference one reference, whichever configuration made it. A consumer's
 * position is rendered against its own root, so the consumer is part of what it names.
 */
export function referenceKey(reference: Reference): string {
  const { path, line, column } = reference.position;
  return [
    reference.consumer ?? "",
    reference.from,
    reference.to,
    path,
    String(line),
    String(column),
    reference.use,
  ].join("\u0000");
}

/**
 * Indexes what the passes answered for each configuration of one run, in the run's order.
 * A declaration is keyed by its rendered position, with the fields of the first
 * configuration that judges it; one in a file every holder holds only for its references
 * is judged by none and is not in the union, and a reference it makes enters the union as a
 * consumer's does. One reference at one position of a file several configurations compile
 * is one reference; two one configuration makes are two.
 */
export function matrixOf(per: readonly Configured[]): Matrix {
  const symbols: InventorySymbol[] = [];
  const holders = new Map<string, string[]>();
  const references: Reference[] = [];
  const makers: string[][] = [];
  const firstSeen = new Map<string, { readonly index: number; readonly places: number[] }>();
  const judged = new Set<string>();
  const unjudged = new Set<string>();
  const dependents = new Map<string, readonly string[]>();
  per.forEach((one, index) => {
    for (const [id, after] of one.dependents ?? []) {
      if (!dependents.has(id)) {
        dependents.set(id, after);
      }
    }
    const referenceOnly = new Set(one.referenceOnly);
    for (const symbol of one.symbols) {
      const held = holders.get(symbol.id);
      if (held === undefined) {
        holders.set(symbol.id, [one.configuration]);
      } else if (!held.includes(one.configuration)) {
        held.push(one.configuration);
      }
      if (referenceOnly.has(symbol.position.path)) {
        if (swept(symbol.kind)) {
          unjudged.add(symbol.id);
        }
      } else if (!judged.has(symbol.id)) {
        judged.add(symbol.id);
        symbols.push(symbol);
      }
    }
    for (const reference of one.references) {
      const key = referenceKey(reference);
      const seen = firstSeen.get(key);
      if (seen !== undefined && seen.index !== index) {
        for (const place of seen.places) {
          const making = makers[place];
          if (making !== undefined && !making.includes(one.configuration)) {
            making.push(one.configuration);
          }
        }
        continue;
      }
      const places = seen?.places ?? [];
      if (seen === undefined) {
        firstSeen.set(key, { index, places });
      }
      places.push(references.length);
      references.push(reference);
      makers.push([one.configuration]);
    }
  });
  for (const id of judged) {
    unjudged.delete(id);
  }
  symbols.sort((a, b) => byPosition(a.position, b.position));
  const testUsed = new Set(per.flatMap((one) => one.testUsedFiles ?? []));

  return {
    configurations: per.map((one) => one.configuration),
    union: graphOf(
      symbols,
      references,
      per.flatMap((one) => one.roots),
      [...new Set(per.flatMap((one) => one.testFiles))],
      [...new Set(per.flatMap((one) => one.supportFiles ?? []))],
      new Set(per.flatMap((one) => [...(one.ambient ?? [])])),
      { unjudged, configurations: makers },
    ),
    heldIn: symbols.map((symbol) => holders.get(symbol.id) ?? []),
    testUsed: symbols.map((symbol) => testUsed.has(symbol.position.path)),
    dependents,
  };
}
