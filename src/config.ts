import type { ResolvedConfig } from "./contract/config.generated.ts";
import { SEVERITIES, type Severity } from "./contract/contract.generated.ts";
import { LANGUAGE } from "./product.ts";

/**
 * The name of the repository configuration at the target root, which is also the
 * document a finding about the configuration names where no document of the
 * target supplied the setting it is about.
 */
export const REPOSITORY_DOCUMENT = "deadset.json";

export type { PartialConfig, ResolvedConfig } from "./contract/config.generated.ts";

/** Whether the target is an application or a library. */
export type TargetKind = Extract<ResolvedConfig["target"]["kind"], string>;
export type DeclarationEntry = ResolvedConfig["ts"]["serializers"][number];
export type LifecycleContract = ResolvedConfig["ts"]["lifecycle_contracts"][number];
export type BuildConfiguration = ResolvedConfig["analysis"]["configurations"][number];
export type ProjectConfiguration = Extract<BuildConfiguration, { readonly project: string }>;
export type TemplateDelimiters = ResolvedConfig["analysis"]["template_delimiters"];
export type Sort = ResolvedConfig["reporters"]["sort"];
export type Cascade = ResolvedConfig["reporters"]["cascade"];

/** The kind a target kind setting gives this analyzer's declarations. */
export function kindOf(kind: ResolvedConfig["target"]["kind"]): TargetKind {
  return typeof kind === "string" ? kind : kind[LANGUAGE];
}

/** Whether a finding at one severity fails a run under the failing severity. */
export function fails(severity: Severity, failOn: Severity): boolean {
  return SEVERITIES.indexOf(severity) >= SEVERITIES.indexOf(failOn);
}

/** Where a resolved setting came from, in the order the sources outrank each other. */
export type Source = "flag" | "repository" | "central" | "default";

/** One setting's source with the file or flag that supplied it, empty for a default. */
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
 * The origin of each resolved setting, keyed by the setting's dotted path. A section
 * has no entry; a keyed section carries one entry per member it names, or one for
 * itself when it is empty.
 */
export type Provenance = ReadonlyMap<string, Origin>;

/** One configuration document: its text and the path it was read from. */
export interface Document {
  readonly text: string;
  readonly label: string;
}

/**
 * The configuration sources one invocation carries. `flags` holds the text each
 * setting option was given, by the setting's dotted path.
 */
export interface Inputs {
  readonly flags?: ReadonlyMap<string, string>;
  readonly repository?: Document;
  readonly central?: Document;
}
