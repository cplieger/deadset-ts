/**
 * The exemption framework: the classes of reason for which a declaration the reference
 * graph alone would report is live all the same. A class is policy over what one
 * project's checker answers, and its detector names the declarations it holds back;
 * this module runs the detectors, decides which of their records stand, and answers
 * which records held something back. It names no class's detector: the composition
 * hands it the table of the classes it has.
 */

import type { Config } from "./config.ts";
import { ConfigError } from "./config.ts";
import {
  EXEMPTION_CLASSES,
  isExemptionClass,
  TS_EXEMPTION_CLASSES,
  typescriptVisibilityOf,
  type ExemptionClass,
  type TSExemptionClass,
  type TypeScriptVisibility,
} from "./exempt-classes.ts";
import type { Inventory, InventorySymbol, Visibility } from "./inventory.ts";
import type { Matrix } from "./matrix.ts";
import { byPosition, positionKey, type Position } from "./position.ts";
import type { ProjectView } from "./session.ts";
import type { Templates } from "./template-field.ts";
import { sweep, type Exemption, type Mode, type SweepInput } from "./sweep.ts";

/** One declaration a detector holds back, and where and why. */
export interface Evidence {
  /** The identifier of the declaration held back. */
  readonly id: string;
  /** One clause naming the relation, then the thing it relates to. */
  readonly detail: string;
  readonly site: Position;
}

/** What a detector reads of one project, while the project's view is open. */
export interface DetectorInput<Brand> {
  readonly project: ProjectView<Brand>;
  readonly held: Inventory;
  readonly targetRoot: string;
  /** The configured templates, read once for the run. */
  readonly templates: Templates;
}

/**
 * One class's detection over one project. The framework records each piece of evidence
 * under the class the table names the detector by, so a detector names no class.
 */
export type Detector = <Brand>(input: DetectorInput<Brand>) => readonly Evidence[];

/** The detector of each class one composition implements. */
export type Detectors = ReadonlyMap<TSExemptionClass, Detector>;

/** What decides which records of one project stand. */
export interface Holding {
  /** The classes the configuration switches off, whose detectors do not run. */
  readonly disabled: ReadonlySet<ExemptionClass>;
  readonly mode: Mode;
  /** The paths the reference pass classified as test files. */
  readonly testFiles: ReadonlySet<string>;
}

/**
 * The classes `exemptions.disabled` switches off. A name is refused unless the
 * vocabulary holds it; a class that runs on another language only is admitted and
 * switches nothing off here, so one configuration serves every analyzer.
 */
export function disabledClasses(config: Config): ReadonlySet<ExemptionClass> {
  const disabled = new Set<ExemptionClass>();
  for (const name of config.exemptionsDisabled) {
    if (!isExemptionClass(name)) {
      const known = EXEMPTION_CLASSES.map((row) => row.class).join(", ");
      throw new ConfigError(
        "malformed",
        "exemptions.disabled",
        `exemptions.disabled: ${JSON.stringify(name)} is not an exemption class: the classes are ${known}`,
      );
    }
    disabled.add(name);
  }
  return disabled;
}

/**
 * Whether a class whose row states `allowed` may retain a member of one visibility. A
 * declaration the inventory does not hold has no visibility to refuse it by.
 */
function retainable(allowed: TypeScriptVisibility, visibility: Visibility | undefined): boolean {
  if (visibility === "private") {
    return allowed.private;
  }
  if (visibility === "private-name") {
    return allowed.privateName;
  }
  return true;
}

/**
 * The records one project's detectors found, each class in the vocabulary's order and
 * none of a switched-off class. Evidence on a private member the class's row says it
 * cannot retain is dropped first, whatever the detector found. Under a production mode
 * a record whose evidence is written in a test file holds nothing, as a reference a
 * test file makes is none there.
 */
export function computeExemptions<Brand>(
  input: DetectorInput<Brand>,
  detectors: Detectors,
  holding: Holding,
): readonly Exemption[] {
  const visibility = new Map(input.held.symbols.map((symbol) => [symbol.id, symbol.visibility]));
  const found: Exemption[] = [];
  for (const exemptionClass of TS_EXEMPTION_CLASSES) {
    const detect = detectors.get(exemptionClass);
    if (detect === undefined || holding.disabled.has(exemptionClass)) {
      continue;
    }
    const allowed = typescriptVisibilityOf(exemptionClass);
    for (const evidence of detect(input)) {
      if (!retainable(allowed, visibility.get(evidence.id))) {
        continue;
      }
      if (holding.mode.production && holding.testFiles.has(evidence.site.path)) {
        continue;
      }
      found.push({
        id: evidence.id,
        class: exemptionClass,
        detail: evidence.detail,
        site: evidence.site,
      });
    }
  }
  return exemptionsOf(found);
}

/** Two strings ordered bytewise. */
function compare(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Records as a run holds them: ordered by site, then class, then declaration, and one
 * per declaration, class and detail, the one at the first site. A fact found at many
 * sites, or by several projects, is one record.
 */
export function exemptionsOf(found: readonly Exemption[]): readonly Exemption[] {
  const ordered = [...found].sort(
    (a, b) => byPosition(a.site, b.site) || compare(a.class, b.class) || compare(a.id, b.id),
  );
  const seen = new Set<string>();
  return ordered.filter((record) => {
    const fact = [record.id, record.class, record.detail].join("\u0000");
    if (seen.has(fact)) {
      return false;
    }
    seen.add(fact);
    return true;
  });
}

/** The records per declaration, each declaration's in the order given. */
function byDeclaration(records: readonly Exemption[]): ReadonlyMap<string, readonly Exemption[]> {
  const grouped = new Map<string, Exemption[]>();
  for (const record of records) {
    const held = grouped.get(record.id);
    if (held === undefined) {
      grouped.set(record.id, [record]);
    } else {
      held.push(record);
    }
  }
  return grouped;
}

/**
 * The records that held back a declaration some configuration of the run would
 * otherwise judge dead: each configuration's graph is swept once more with no
 * exemption and the marks it was given, and a record is retained when one of those
 * sweeps judged its declaration a candidate. A record that holds a declaration back in
 * one configuration is retained whatever another configuration answers about it, as a
 * run of that configuration alone would report the declaration without it. A record
 * on a declaration that a relation or a mark holds live in every configuration held
 * nothing back. The order is the declarations' site order, and for one declaration
 * the input's.
 */
export function retainedIn(matrix: Matrix, input: SweepInput): readonly Exemption[] {
  const exempt = input.exempt ?? [];
  if (exempt.length === 0) {
    return [];
  }
  const bare: SweepInput = { marked: input.marked, mode: input.mode };
  const dead = new Set(
    matrix.graphs.flatMap((graph) =>
      sweep(graph, bare).candidates.map((candidate) => candidate.id),
    ),
  );
  const held = byDeclaration(exempt.filter((record) => dead.has(record.id)));
  return matrix.union.symbols.flatMap((symbol) => held.get(symbol.id) ?? []);
}

/**
 * One line per held-back declaration, in site order: its reference, then each record's
 * class, site and detail, all separated by tabs.
 */
export function retainedLines(
  symbols: readonly InventorySymbol[],
  retained: readonly Exemption[],
): readonly string[] {
  const held = byDeclaration(retained);
  return symbols.flatMap((symbol) => {
    const records = held.get(symbol.id);
    if (records === undefined) {
      return [];
    }
    const fields = records.flatMap((record) => [
      record.class,
      positionKey(record.site),
      record.detail,
    ]);
    return [[symbol.ref, ...fields].join("\t")];
  });
}
