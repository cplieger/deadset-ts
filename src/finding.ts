import type { Confidence, Severity } from "./config.ts";
import type { Fixability } from "./kinds.ts";
import type { DependencySection } from "./ref.ts";
import type { Mechanism } from "./suppress.ts";
import type { Relation } from "./sweep.ts";

/**
 * The finding: what an emitter decides about one subject, and every member the
 * Contract's finding schema requires, spelled in this language's case. An emitter states
 * the code, where the subject is, what it is, the sentence, and the details its code
 * carries; the completion step reads every other member from the run and from the code's
 * row of the issue-kind vocabulary, so no emitter states one that disagrees with either.
 */

/** Where the subject of a finding is. */
export interface FindingPosition {
  /** The file below the target root, with the solidus as separator. */
  readonly path: string;
  /** The line of the subject's first character, counted from one. */
  readonly line: number;
  /** The column of the subject's first character, counted from one in UTF-16 code units. */
  readonly column: number;
  /** The line of the subject's last character. */
  readonly endLine: number;
}

/** What a finding is about. */
export interface FindingSubject {
  /** The stable symbol reference, or for a configured root the root as written. */
  readonly ref: string;
  /** The subject kind, from the closed vocabulary of the finding schema. */
  readonly kind: string;
  /** The display name a text line renders. */
  readonly name: string;
  /** The number of source lines the subject spans. */
  readonly sizeLines: number;
}

/** A declaration a finding names beside the subject, with where it is written. */
export interface PositionedSymbol {
  readonly ref: string;
  readonly name: string;
  readonly position: FindingPosition;
}

/**
 * What only some codes carry. The finding schema's branches decide which code carries
 * which member, and every member is absent under every other code.
 */
export interface FindingDetails {
  /**
   * On `DS1101` and `DS1104`: the widest scope that holds every reference to the
   * subject, which is the visibility its references support.
   */
  readonly narrowerVisibility?: "file" | "package";
  /** On `DS1201` and `DS1203`: the classes implementing the interface, in site order. */
  readonly implementations?: readonly PositionedSymbol[];
  /** On `DS1301` and `DS1807`: every position the subject is written at, in site order. */
  readonly writePositions?: readonly FindingPosition[];
  /** On `DS1601`: the manifest section that declares the dependency. */
  readonly dependencyClass?: DependencySection;
  /** On `DS1701` and `DS1702`: the document that holds the refused suppression. */
  readonly mechanism?: Mechanism;
  /** On `DS1701` and `DS1702`: the refused suppression as written, a member absent where it lacks one. */
  readonly entry?: SuppressionEntry;
  /** On the intra-function kinds: the external rules that report the same kind, as the vocabulary lists them. */
  readonly overlap?: readonly string[];
}

/** One suppression in the four-member form the ignore file and the baseline share. */
export interface SuppressionEntry {
  readonly code: string;
  readonly symbol?: string;
  readonly path?: string;
  readonly reason?: string;
}

/** One finding as its emitter states it. */
export interface Finding {
  readonly code: string;
  readonly position: FindingPosition;
  readonly symbol: FindingSubject;
  readonly message: string;
  /** Absent where the code carries nothing. */
  readonly details?: FindingDetails;
  /** The reachability class of a subject that is no declaration, where it is not `certain`. */
  readonly reachabilityClass?: Confidence;
}

/** The dead component a finding names, as the finding schema spells its members. */
export interface FindingComponent {
  readonly id: string;
  /** Whether the subject is a root member of the component. */
  readonly root: boolean;
  /** The number of the component's members. */
  readonly symbolCount: number;
  readonly deletableLines: number;
  /** Every member, the subject included, where the run lists a component in full. */
  readonly members?: readonly PositionedSymbol[];
}

/** One finding with every member the finding schema requires. */
export interface CompletedFinding extends Finding {
  /** The name of the code's row of the issue-kind vocabulary. */
  readonly kind: string;
  readonly language: "ts";
  readonly reachabilityClass: Confidence;
  /** The reachability class capped by the code's ceiling. */
  readonly confidence: Confidence;
  /**
   * The relation that decided the subject: present on a declaration the sweep judged
   * dead, absent on a live one and on a subject that is no declaration.
   */
  readonly livenessRelation?: Relation;
  /** Whether every reference to the subject comes from a test file. */
  readonly testOnly: boolean;
  readonly generated: boolean;
  readonly component: FindingComponent;
  /** Empty on every finding: a declaration an exemption holds back is not reported. */
  readonly retainedBy: readonly string[];
  /** The configurations the finding holds in, in the run's order. */
  readonly configurations: readonly string[];
  /** The consumers the run loaded beside the target. */
  readonly consumersLoaded: readonly string[];
  readonly fixability: Fixability;
  readonly severity: Severity;
  readonly details: FindingDetails;
}
