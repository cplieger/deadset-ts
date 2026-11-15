import type { CompletedFinding } from "../finding.ts";
import { declarationKey } from "../ref.ts";
import { completed } from "./completion.ts";
import { dependenciesAndModuleMachinery } from "./dependencies-and-module-machinery.ts";
import type { Emitter, EmitterInput, Emitters } from "./emitter.ts";
import { interfaces } from "./interfaces.ts";
import { intraFunction } from "./intra-function.ts";
import { nonCodeArtifacts } from "./non-code-artifacts.ts";
import { readsAndWrites } from "./reads-and-writes.ts";
import { selfCheck } from "./self-check.ts";
import { subjectsOf, type Subjects } from "./subjects.ts";
import { fallenMembers, unusedDeclarations } from "./unused-declarations.ts";
import { visibilityNarrowing } from "./visibility-narrowing.ts";

/** Every emitter this analyzer runs, by the name its tests select it by. */
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
 * Every emitter's findings over one sweep completed by one step, so every component number
 * is minted once, but none about a declaration that falls with a write-only subject: that
 * subject's finding names it, so no finding about it exists for a record to match.
 * `withFallen` adds the finding each member of a dead container would carry were its
 * container live, which a record on such a member is matched against.
 */
export function runEmitters(input: EmitterInput, withFallen = false): readonly CompletedFinding[] {
  const s = subjectsOf(input);
  const falls = keysOf(s, s.written().falls);
  const emitters = [...EMITTERS.values(), ...(withFallen ? [fallenMembers] : [])];
  return completed(
    input,
    emitters.flatMap((emit) => emit(input)),
  ).filter((finding) => !falls.has(findingKey(finding)));
}

/** The keys of the declarations the identifiers name, as {@link findingKey} keys a finding. */
export function keysOf(s: Subjects, ids: Iterable<string>): ReadonlySet<string> {
  return new Set(
    [...ids].flatMap((id) => {
      const symbol = s.symbol(id);
      return symbol === undefined ? [] : [declarationKey(symbol.ref, symbol.position.path)];
    }),
  );
}

/** The key of the declaration a finding is about, or of the one holding the part it is about. */
export function findingKey(finding: CompletedFinding): string {
  return declarationKey(finding.symbol.holder ?? finding.symbol.ref, finding.position.path);
}
