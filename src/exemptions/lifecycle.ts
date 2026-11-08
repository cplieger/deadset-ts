/**
 * The exemption lifecycle: the classes of reason for which a declaration the reference
 * graph alone would report is live all the same. A class is policy over what one
 * project's checker answers, and its detector names the declarations it holds back. This
 * module runs the detectors over one project, then settles every project's records
 * against the run: the writes they wait for, the interface methods they wait to be
 * called, and the mode and test files that decide which of them hold. It names no class:
 * the composition hands it the table of the classes it has.
 */

import { EXEMPTION_CLASSES } from "../contract/contract.generated.ts";
import type { ResolvedConfig } from "../config.ts";
import type { Inventory, Visibility } from "../inventory.ts";
import { byPosition, type Position } from "../position.ts";
import { Unanswerable } from "../query.ts";
import type { Reference } from "../references.ts";
import type { ProjectView } from "../session.ts";
import type { Mode } from "../tests/file-class.ts";
import { bytewise } from "../text/compare.ts";
import {
  TS_EXEMPTION_CLASSES,
  typescriptVisibilityOf,
  type ExemptionClass,
  type TSExemptionClass,
  type TypeScriptVisibility,
} from "./classes.ts";
import type { GeneratedFact } from "./generated-file.ts";
import { projectSites, type ProjectSites } from "./sites.ts";
import type { Templates } from "./template-field.ts";

/** One declaration an exemption class holds back, and the evidence it was found by. */
export interface Exemption extends Evidence {
  readonly class: TSExemptionClass;
}

/** The interface methods one retained class member implements, and whether its body is empty. */
interface Implementing {
  /** The declarations of the interface's methods the member answers, by identifier. */
  readonly methods: readonly string[];
  readonly empty: boolean;
}

/** One declaration a detector holds back, and where and why. */
export interface Evidence {
  /** The identifier of the declaration held back. */
  readonly id: string;
  /** One clause naming the relation, then the thing it relates to: `passed to JSON.stringify`. */
  readonly detail: string;
  /** Where the evidence is written. */
  readonly site: Position;
  /**
   * The component file, below the target root, whose markup holds the evidence. The
   * record holds only while that file is live.
   */
  readonly whileLive?: string;
  /**
   * The interface methods the retained member implements, and whether its body is empty.
   * The record holds only while one of them is called through its interface.
   */
  readonly implementing?: Implementing;
  /** Whether the record holds only where a write the mode counts stores into the declaration. */
  readonly whileWritten?: true;
  /** Whether a detector the checker left without an answer holds it, rather than evidence. */
  readonly unanswered?: true;
}

/** What a detector reads of one project, while the project's view is open. */
export interface DetectorInput<Brand> {
  readonly project: ProjectView<Brand>;
  readonly held: Inventory;
  /** The project's own calls, classes and parameters, walked once for every detector. */
  readonly sites: ProjectSites;
  readonly targetRoot: string;
  /** The configured templates, read once for the run. */
  readonly templates: Templates;
  /** The `ts` section, whose declarations the configured classes read. */
  readonly ts: ResolvedConfig["ts"];
  /** The absolute path of each declared consumer, whose modules are part of the analysis. */
  readonly consumers: readonly string[];
  /** The project's generated files, by path below the target root, each with what decided it. */
  readonly generated?: ReadonlyMap<string, GeneratedFact>;
}

/**
 * One class's detection over one project. The framework records each piece of evidence
 * under the class the table names the detector by, so a detector names no class.
 */
export type Detector = <Brand>(input: DetectorInput<Brand>) => readonly Evidence[];

/** The detector of each class one composition implements. */
export type Detectors = ReadonlyMap<TSExemptionClass, Detector>;

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

/** The kinds of declaration each class can hold back, which a detector that stops holds back whole. */
const RETAINABLE: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  EXEMPTION_CLASSES.flatMap((row) =>
    "ts" in row.retainsKinds ? [[row.class, new Set<string>(row.retainsKinds.ts)] as const] : [],
  ),
);

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
      .filter((symbol) => kinds?.has(symbol.kind) === true)
      .map((symbol) => ({
        id: symbol.id,
        detail: "kept live by a question the checker did not answer",
        site: symbol.position,
        unanswered: true,
      }));
  }
}

/**
 * Every record one project's detectors found, one per piece of evidence, before the run
 * settles which of them hold. Classes run in the vocabulary's order and a switched-off
 * class runs not at all; evidence on a private member the class's row says it cannot
 * retain is dropped, whatever the detector found.
 */
export function detect<Brand>(
  input: Omit<DetectorInput<Brand>, "sites">,
  detectors: Detectors,
  disabled: ReadonlySet<ExemptionClass>,
): readonly Exemption[] {
  const visibility = new Map(input.held.symbols.map((symbol) => [symbol.id, symbol.visibility]));
  const sited = { ...input, sites: projectSites(input.project, input.held) };
  return TS_EXEMPTION_CLASSES.flatMap((exemptionClass) => {
    const run = detectors.get(exemptionClass);
    if (run === undefined || disabled.has(exemptionClass)) {
      return [];
    }
    const allowed = typescriptVisibilityOf(exemptionClass);
    return detected(exemptionClass, run, sited).flatMap((evidence) =>
      retainable(allowed, visibility.get(evidence.id))
        ? [{ ...evidence, class: exemptionClass }]
        : [],
    );
  });
}

/** One project's records, and what decides which of them hold. */
interface ProjectRecords {
  readonly records: readonly Exemption[];
  readonly held: Inventory;
  /** The paths of the project's test files and of the run's test-support files. */
  readonly testFiles: ReadonlySet<string>;
}

/** What the run settles every project's records against. */
interface Settling {
  /** Every reference of the run, a loaded consumer's included. */
  readonly references: readonly Reference[];
  /** The declarations a write the mode counts stores into. */
  readonly written: ReadonlySet<string>;
  readonly mode: Mode;
}

/** One project's records as the run holds them, and the references settling made. */
interface Settled {
  readonly records: readonly Exemption[];
  /**
   * A reference from each uncalled interface method to each implementation it alone
   * keeps, which then falls with the method, and, under a production mode, a test
   * reference to each declaration whose evidence a test file writes.
   */
  readonly references: readonly Reference[];
}

/**
 * Every project's records settled against the run, in three steps. A record that holds
 * only while written holds where a write the mode counts stores into its declaration.
 * A record whose member implements only interface methods nothing calls is dropped,
 * unless every implementation of such a method is empty. Under a production mode a
 * record whose evidence a test file writes holds nothing, and is a test reference to its
 * declaration, as a reference the test file wrote would be.
 */
export function settle(projects: readonly ProjectRecords[], run: Settling): readonly Settled[] {
  const written = projects.map((one) =>
    one.records.flatMap(({ whileWritten, ...record }) =>
      whileWritten === undefined || run.written.has(record.id) ? [record] : [],
    ),
  );
  const methods = new Set(
    projects.flatMap((one) =>
      one.held.symbols.filter((symbol) => symbol.kind === "interface-method").map((one) => one.id),
    ),
  );
  const called = new Set(run.references.map((reference) => reference.to));
  const bodies = new Map<string, boolean>();
  for (const record of written.flat()) {
    for (const method of record.implementing?.methods ?? []) {
      bodies.set(method, (bodies.get(method) ?? true) && record.implementing?.empty === true);
    }
  }
  const uncalled = (method: string): boolean =>
    methods.has(method) && !called.has(method) && bodies.get(method) !== true;
  return projects.map((project, index) => {
    const files = new Map(
      project.held.symbols
        .filter((symbol) => symbol.kind === "file")
        .map((symbol) => [symbol.position.path, symbol.id]),
    );
    const kept: Exemption[] = [];
    const references: Reference[] = [];
    const tested: Reference[] = [];
    for (const record of written[index] ?? []) {
      const implemented = record.implementing?.methods ?? [];
      if (implemented.length > 0 && implemented.every(uncalled)) {
        references.push(
          ...implemented.map((method): Reference => ({
            from: method,
            to: record.id,
            position: record.site,
            use: "read",
            resolution: "override",
            test: false,
          })),
        );
      } else if (run.mode.production && project.testFiles.has(record.site.path)) {
        const from = files.get(record.site.path);
        if (from !== undefined) {
          tested.push({
            from,
            to: record.id,
            position: record.site,
            use: "read",
            resolution: "syntax",
            test: true,
          });
        }
      } else {
        kept.push(record);
      }
    }
    return { records: exemptionsOf(kept), references: [...references, ...tested] };
  });
}

/**
 * Records as a run holds them: ordered by site, then class, then declaration, and one
 * per declaration, class, detail and file it holds while live, the one at the first
 * site. A fact found at many sites, or by several projects, is one record.
 */
export function exemptionsOf(found: readonly Exemption[]): readonly Exemption[] {
  const ordered = [...found].sort(
    (a, b) => byPosition(a.site, b.site) || bytewise(a.class, b.class) || bytewise(a.id, b.id),
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
