/**
 * The exemption framework: the classes of reason for which a declaration the reference
 * graph alone would report is live all the same. A class is policy over what one
 * project's checker answers, and its detector names the declarations it holds back;
 * this module runs the detectors, decides which of their records stand, and answers
 * which records held something back. It names no class's detector: the composition
 * hands it the table of the classes it has.
 */

import type { Config, TSSection } from "./config.ts";
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
import type { Inventory, InventorySymbol, SymbolKind, Visibility } from "./inventory.ts";
import type { Matrix } from "./matrix.ts";
import { byPosition, positionKey, type Position } from "./position.ts";
import { Unanswerable } from "./query.ts";
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
  /** The component file, below the target root, whose markup holds the evidence. */
  readonly whileLive?: string;
}

/** What a detector reads of one project, while the project's view is open. */
export interface DetectorInput<Brand> {
  readonly project: ProjectView<Brand>;
  readonly held: Inventory;
  readonly targetRoot: string;
  /** The configured templates, read once for the run. */
  readonly templates: Templates;
  /** The `ts` section, whose declarations the configured classes read. */
  readonly ts: TSSection;
  /** The absolute path of each declared consumer, whose modules are part of the analysis. */
  readonly consumers: readonly string[];
  /**
   * The project's generated files, by path below the target root, each with the
   * convention row that names its directory as generated.
   */
  readonly generated?: ReadonlyMap<string, string>;
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
 * The kinds of declaration each class can hold back, which a detector that stops holds
 * back whole. A class with no row here holds back every declaration but a file.
 */
const RETAINABLE: ReadonlyMap<TSExemptionClass, ReadonlySet<SymbolKind>> = new Map([
  ["interface-satisfaction", new Set<SymbolKind>(["method", "class-member"])],
  ["enum-group", new Set<SymbolKind>(["enum-member"])],
  ["injection-container", new Set<SymbolKind>(["method", "class-member"])],
  ["framework-lifecycle", new Set<SymbolKind>(["method", "class-member"])],
  [
    "serialization-contract",
    new Set<SymbolKind>(["method", "class-member", "interface-method", "type-member"]),
  ],
]);

/** The detail of a record a detector that could not finish holds. */
const UNANSWERED_DETAIL = "kept live by a question the checker did not answer";

/** Whether one record is held by a detector that could not finish. */
export function isUnansweredRecord(record: Exemption): boolean {
  return record.detail === UNANSWERED_DETAIL;
}

/**
 * What one detector holds back over one project. A detector that stops because the
 * checker left a question it needs unanswered holds back every declaration of the
 * project its class could hold back, each recorded at its own position, so the gap
 * never yields a finding.
 */
function detected<Brand>(
  exemptionClass: TSExemptionClass,
  detect: Detector,
  input: DetectorInput<Brand>,
): readonly Evidence[] {
  try {
    return detect(input);
  } catch (error: unknown) {
    if (!(error instanceof Unanswerable)) {
      throw error;
    }
    const kinds = RETAINABLE.get(exemptionClass);
    return input.held.symbols
      .filter((symbol) => (kinds === undefined ? symbol.kind !== "file" : kinds.has(symbol.kind)))
      .map((symbol) => ({ id: symbol.id, detail: UNANSWERED_DETAIL, site: symbol.position }));
  }
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
  return detectExemptions(input, detectors, holding).records;
}

/** One project's records, and the evidence a production mode found in a test file. */
export interface Detected {
  readonly records: readonly Exemption[];
  /**
   * Under a production mode, each record whose evidence is written in a test file. It
   * holds nothing, and it is a test reference to its declaration, as a reference the
   * test file wrote would be.
   */
  readonly inTestFiles: readonly Exemption[];
}

/** The records of {@link computeExemptions}, beside the test-file evidence it set aside. */
export function detectExemptions<Brand>(
  input: DetectorInput<Brand>,
  detectors: Detectors,
  holding: Holding,
): Detected {
  return heldRecords(evidenceRecords(input, detectors, holding.disabled), holding);
}

/**
 * Every record one project's detectors found, one per piece of evidence, before the
 * mode decides which of them hold: what {@link heldRecords} reads.
 */
export function evidenceRecords<Brand>(
  input: DetectorInput<Brand>,
  detectors: Detectors,
  disabled: ReadonlySet<ExemptionClass>,
): readonly Exemption[] {
  const visibility = new Map(input.held.symbols.map((symbol) => [symbol.id, symbol.visibility]));
  const found: Exemption[] = [];
  for (const exemptionClass of TS_EXEMPTION_CLASSES) {
    const detect = detectors.get(exemptionClass);
    if (detect === undefined || disabled.has(exemptionClass)) {
      continue;
    }
    const allowed = typescriptVisibilityOf(exemptionClass);
    for (const evidence of detected(exemptionClass, detect, input)) {
      if (!retainable(allowed, visibility.get(evidence.id))) {
        continue;
      }
      found.push({
        id: evidence.id,
        class: exemptionClass,
        detail: evidence.detail,
        site: evidence.site,
        ...(evidence.whileLive === undefined ? {} : { whileLive: evidence.whileLive }),
      });
    }
  }
  return found;
}

/** The records that hold under one mode, beside the evidence a production mode found in a test file. */
export function heldRecords(records: readonly Exemption[], holding: Holding): Detected {
  const found: Exemption[] = [];
  const inTestFiles: Exemption[] = [];
  for (const record of records) {
    if (holding.mode.production && holding.testFiles.has(record.site.path)) {
      inTestFiles.push(record);
    } else {
      found.push(record);
    }
  }
  return { records: exemptionsOf(found), inTestFiles };
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
 * per declaration, class, detail and file it holds while live, the one at the first
 * site. A fact found at many sites, or by several projects, is one record.
 */
export function exemptionsOf(found: readonly Exemption[]): readonly Exemption[] {
  const ordered = [...found].sort(
    (a, b) => byPosition(a.site, b.site) || compare(a.class, b.class) || compare(a.id, b.id),
  );
  const seen = new Set<string>();
  return ordered.filter((record) => {
    const fact = [record.id, record.class, record.detail, record.whileLive ?? ""].join("\u0000");
    if (seen.has(fact)) {
      return false;
    }
    seen.add(fact);
    return true;
  });
}

/**
 * The records that hold while the component files at `live` are live: every record that
 * holds whatever is live, and each one a live file's markup holds, as a record of the run.
 */
export function holdingWhile(
  records: readonly Exemption[],
  live: ReadonlySet<string>,
): readonly Exemption[] {
  return exemptionsOf(
    records.flatMap(({ whileLive, ...record }) =>
      whileLive === undefined || live.has(whileLive) ? [record] : [],
    ),
  );
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
 * The records that held back a declaration: one some configuration's graph, swept
 * again with no exemption and its marks, judges a candidate, whatever another
 * configuration answers, or one in `writeOnly`, which the run would report as written
 * and never read without the record's read. A declaration a relation or a mark holds
 * live in every configuration is held back by no record. The order is the
 * declarations' site order, and for one declaration the input's.
 */
export function retainedIn(
  matrix: Matrix,
  input: SweepInput,
  writeOnly: ReadonlySet<string> = new Set(),
): readonly Exemption[] {
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
  const held = byDeclaration(
    exempt.filter((record) => dead.has(record.id) || writeOnly.has(record.id)),
  );
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
