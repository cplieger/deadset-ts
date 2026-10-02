import { dependenciesAndModuleMachinery } from "./dependencies-and-module-machinery.ts";
import { placed, type PlacedFinding } from "./completion.ts";
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
 * Every finding of the run, each family's in table order, each placed in its component
 * by the one step that numbers the components minted for subjects that fall with none.
 */
export function findingsOf(input: EmitterInput): readonly PlacedFinding[] {
  return placed(
    input.swept,
    [...EMITTERS.values()].flatMap((emit) => emit(input)),
  );
}
