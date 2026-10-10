/**
 * What a run knows about the stores into its declarations and the reads of them, which
 * a sweep does not keep: a sweep asks whether anything names a declaration, and a store
 * names it as surely as a read does.
 */

import {
  isGetAccessorDeclaration,
  isSetAccessorDeclaration,
  type Node,
} from "@typescript/native/unstable/ast";
import { nodeKey, type Inventory } from "./inventory.ts";
import type { Reference } from "./references.ts";
import type { ProjectView } from "./session.ts";
import type { Exemption, Mode } from "./sweep.ts";

/** One run's stores and reads, over every configuration. */
export interface Stores {
  /**
   * Every reference the run's mode counts, each configuration's in the run's order, so
   * one written at a position several configurations compile appears once per
   * configuration. A production mode counts none a test file made.
   */
  readonly references: readonly Reference[];
  /** The declarations a test file reads, which a production mode counts no read of. */
  readonly readInTests: ReadonlySet<string>;
  /**
   * The class members declared by a getter or a setter. A store into one runs the
   * setter, which is code rather than state.
   */
  readonly accessors: ReadonlySet<string>;
  /**
   * The declarations an exemption record names, whether or not the record held back
   * anything dead: a mechanism the analysis cannot see uses each of them.
   */
  readonly exempt: ReadonlySet<string>;
}

/** What one configuration contributes to the run's stores. */
interface ConfigurationStores {
  readonly references: readonly Reference[];
  readonly accessors: readonly string[];
}

/** The class members one project's own files declare by a getter or a setter. */
export function accessorsOf<Brand>(
  project: ProjectView<Brand>,
  held: Inventory,
): readonly string[] {
  const found: string[] = [];
  for (const file of project.ownSourceFiles()) {
    const visit = (node: Node): void => {
      if (isGetAccessorDeclaration(node) || isSetAccessorDeclaration(node)) {
        const id = held.declarations.get(nodeKey(file, node));
        if (id !== undefined) {
          found.push(id);
        }
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
  }
  return found;
}

/** The run's stores, from what each configuration contributed, the records and the mode. */
export function storesOf(
  per: readonly ConfigurationStores[],
  exempt: readonly Exemption[],
  mode: Mode,
): Stores {
  return {
    references: per.flatMap((one) =>
      one.references.filter((reference) => !mode.production || !reference.test),
    ),
    readInTests: new Set(
      per.flatMap((one) =>
        one.references
          .filter((reference) => reference.test && reference.use !== "write")
          .map((reference) => reference.to),
      ),
    ),
    accessors: new Set(per.flatMap((one) => one.accessors)),
    exempt: new Set(exempt.map((record) => record.id)),
  };
}
