import { CONTRACT_VERSION } from "./version.ts";

/**
 * Whether the target is an application, whose every caller is in the analyzed
 * graph, or a library, whose published API has callers outside it.
 */
export type TargetKind = "application" | "library";

/** The lowest reachability class a finding must reach to be reported. */
export type Confidence = "certain" | "probable" | "possible";

/** Whether declarations in generated files are analyzed. */
export type GeneratedFiles = "exclude" | "include";

/** How a reference from a consumer's test file counts. */
export type ConsumerTests = "test" | "production";

/** One language an analysis covers. */
export type Language = "go" | "ts";

/** What a finding of one issue kind does to a run. */
export type Severity = "allow" | "warn" | "deny";

/** One rendering of the finding list. */
export type Format = "text" | "json" | "github" | "sarif" | "template";

/** The order findings are rendered in. */
export type Sort = "position" | "size";

/** How much of a dead component a rendering names. */
export type Cascade = "roots" | "full";

/** One entry of the build matrix: a configuration the target builds under. */
export interface BuildConfiguration {
  readonly id: string;
  readonly os: string;
  readonly arch: string;
  readonly tags: readonly string[];
}

/**
 * The pair of action delimiters a template is parsed with. Both members are
 * required once a document names the object, so the pair is one setting rather
 * than two.
 */
export interface TemplateDelimiters {
  readonly left: string;
  readonly right: string;
}

/** How the analysis is scoped and filtered. */
export interface Analysis {
  readonly languages: readonly Language[];
  readonly minConfidence: Confidence;
  readonly generatedFiles: GeneratedFiles;
  readonly consumerTests: ConsumerTests;
  readonly configurations: readonly BuildConfiguration[];
  readonly matrixComplete: boolean;
  readonly templateDirs: readonly string[];
  readonly templateDelimiters: TemplateDelimiters;
}

/** How findings are rendered. */
export interface Reporters {
  readonly formats: readonly Format[];
  readonly sort: Sort;
  readonly cascade: Cascade;
  readonly maxFindings: number;
  readonly failOn: Severity;
}

/** The section the TypeScript analyzer owns. */
export interface TSSection {
  readonly testFiles: readonly string[];
  readonly entryFiles: readonly string[];
}

/**
 * The resolved configuration: the closed key list of the Contract's
 * configuration schema, decoded, with every default applied.
 *
 * `targetKind` is empty exactly in the configuration every default states, which
 * is not a configuration a run may use: the field has no default and resolution
 * refuses a result that carries none.
 *
 * `severity` is a map rather than an object because its keys come from a
 * document, and an object keyed by document text answers for names it never
 * held. The order it is written in is the emitter's, not the map's.
 */
export interface Config {
  readonly contractVersion: string;
  readonly targetKind: TargetKind | "";
  readonly analysis: Analysis;
  readonly consumersComplete: boolean;
  readonly rootPatterns: readonly string[];
  readonly severity: ReadonlyMap<string, Severity>;
  readonly exemptionsDisabled: readonly string[];
  readonly reporters: Reporters;
  readonly ts: TSSection;
}

/**
 * The configuration every documented default states. `targetKind` is empty: the
 * field has no default and is never inferred.
 */
export function defaultConfig(): Config {
  return {
    contractVersion: CONTRACT_VERSION,
    targetKind: "",
    analysis: {
      languages: [],
      minConfidence: "possible",
      generatedFiles: "exclude",
      consumerTests: "test",
      configurations: [],
      matrixComplete: false,
      templateDirs: [],
      templateDelimiters: { left: "{{", right: "}}" },
    },
    consumersComplete: false,
    rootPatterns: [],
    severity: new Map(),
    exemptionsDisabled: [],
    reporters: {
      formats: ["text"],
      sort: "position",
      cascade: "roots",
      maxFindings: 0,
      failOn: "deny",
    },
    ts: {
      testFiles: ["**/*.test.{ts,tsx,mts,cts}"],
      entryFiles: [],
    },
  };
}

/** Where a resolved setting came from, in the order the sources outrank each other. */
export type Source = "flag" | "repository" | "central" | "default";

/**
 * One setting's source together with the file or flag that supplied it. `label`
 * is empty exactly when `source` is `"default"`.
 */
export interface Origin {
  readonly source: Source;
  readonly label: string;
}

/**
 * Renders the origin as the provenance value the Contract declares: `default`,
 * or the source, a colon, a space and the file or flag.
 */
export function renderOrigin(origin: Origin): string {
  return origin.source === "default" ? "default" : `${origin.source}: ${origin.label}`;
}

/**
 * The origin of each resolved setting, keyed by the setting's dotted path. A
 * section holds no value of its own and has no entry; the severity object
 * carries one entry per code it names, or the entry `severity` alone when it is
 * empty.
 */
export type Provenance = ReadonlyMap<string, Origin>;

/**
 * The configuration documents one invocation reads, each the document's text or
 * absent. `repositoryLabel` names the document `repository` holds and
 * `centralLabel` the one `central` holds; `flagLabels` names the flag that
 * supplied each setting `flags` names, keyed by dotted setting path.
 */
export interface Inputs {
  readonly flags?: string;
  readonly repository?: string;
  readonly central?: string;
  readonly repositoryLabel?: string;
  readonly centralLabel?: string;
  readonly flagLabels?: ReadonlyMap<string, string>;
}

/** Which refusal a {@link ConfigError} carries. */
export type ErrorKind =
  /**
   * A document that is not one JSON instance of the closed key list: a syntax
   * error, a value of the wrong type, a value outside the closed set a key
   * declares, or a member written twice at one level.
   */
  | "malformed"
  /**
   * A key the closed key list does not declare, or a severity key naming a kind
   * whose severity the Contract fixes.
   */
  | "unimplemented-key"
  /** A resolved configuration no source supplied a target kind for. */
  | "missing-target-kind";

/**
 * Every refusal configuration resolution makes. Each maps to the usage exit
 * code, and each is thrown rather than returned: a refusal ends the run, and the
 * one caller that turns it into an exit code is the command line.
 */
export class ConfigError extends Error {
  /** Which refusal this is. */
  readonly kind: ErrorKind;

  /**
   * The key or field the message names, spelled as the document spells it. It is
   * empty when the refusal names none.
   */
  readonly key: string;

  constructor(kind: ErrorKind, key: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.kind = kind;
    this.key = key;
  }
}
