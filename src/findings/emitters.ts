import { dependenciesAndModuleMachinery } from "./dependencies-and-module-machinery.ts";
import type { CompletedFinding } from "../finding.ts";
import { completed, reportable } from "./completion.ts";
import type { Emitter, EmitterInput, Emitters } from "./emitter.ts";
import { interfaces } from "./interfaces.ts";
import { intraFunction } from "./intra-function.ts";
import { nonCodeArtifacts } from "./non-code-artifacts.ts";
import { readsAndWrites } from "./reads-and-writes.ts";
import { selfCheck } from "./self-check.ts";
import { unusedDeclarations } from "./unused-declarations.ts";
import { visibilityNarrowing } from "./visibility-narrowing.ts";

/** Every kind family this analyzer reports, each by its emitter, in code order. */
export const EMITTERS: Emitters = new Map<string, Emitter>([
  ["unused-declarations", unusedDeclarations],
  ["visibility-narrowing", visibilityNarrowing],
  ["interfaces", interfaces],
  ["reads-and-writes", readsAndWrites],
  ["non-code-artifacts", nonCodeArtifacts],
  ["dependencies-and-module-machinery", dependenciesAndModuleMachinery],
  ["self-check", selfCheck],
  ["intra-function", intraFunction],
]);

/**
 * Every finding of the run the dials do not withhold, each family's in table order: every
 * family's findings completed by one step, then withheld by one step, so a root one
 * family reports withholds what another family reports in its component.
 */
export function findingsOf(input: EmitterInput): readonly CompletedFinding[] {
  const found = [...EMITTERS.values()].flatMap((emit) => emit(input));
  return reportable(completed(input, found), input.config.analysis.minConfidence);
}
