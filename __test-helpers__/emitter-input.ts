import { nodeHost } from "../bin/node-host.ts";
import { DETECTORS, emitterInputOver, readEmitterRun, type RunSweep } from "../src/analysis.ts";
import type { Config } from "../src/config.ts";
import type { CompletedFinding } from "../src/finding.ts";
import type { EmitterInput } from "../src/findings/emitter.ts";
import { decidedFindings } from "../src/findings/emitters.ts";
import type { SelfCheckFacts } from "../src/findings/self-check.ts";
import { scopeForDir } from "../src/scope.ts";
import { openEngine, type Engine } from "../src/session.ts";
import type { Mode } from "../src/sweep.ts";

/** A run with nothing for the self-check family to report. */
const NO_SELF_CHECK: SelfCheckFacts = {
  refusals: [],
  unmatchedRoots: [],
  rootsDocument: "",
  unmatchedDeclarations: [],
};

/**
 * How one target is swept: by which client, in which mode, production by default, under
 * which marks, and beside which consumer directories, none by default.
 */
export interface SweptBy {
  readonly engine?: Engine;
  readonly mode?: Mode;
  readonly marked?: readonly string[];
  readonly consumers?: readonly string[];
}

/**
 * What every emitter reads of one target, swept under one configuration. The run reads
 * no suppression document, so the self-check family has nothing to report.
 */
export function emitterInputOf(target: string, config: Config, by: SweptBy = {}): EmitterInput {
  const host = nodeHost();
  const scope = {
    ...scopeForDir(host, target),
    consumers: (by.consumers ?? []).map((path) => ({ id: "", path })),
  };
  const mode = by.mode ?? { production: true };
  const engine = by.engine ?? openEngine({ collectTiming: false });
  const read = readEmitterRun(engine, host, scope, config, mode, DETECTORS);
  return emitterInputOver(
    host,
    scope,
    config,
    read,
    { marked: by.marked ?? [], mode },
    NO_SELF_CHECK,
  );
}

/** Every finding the run reports, each family's in table order. */
export function findingsOf(input: EmitterInput): readonly CompletedFinding[] {
  return decidedFindings(input).findings;
}

/**
 * The input of a sweep built by hand, with no fact beside it: no deprecation marker,
 * store, dependency, implementation or file, and a boundary naming nothing.
 */
export function sweepOnly(config: Config, swept: RunSweep): EmitterInput {
  return {
    config,
    swept,
    deprecated: new Set(),
    stores: { references: [], readInTests: new Set(), accessors: new Set(), exempt: new Set() },
    dependencies: {
      declared: [],
      needed: new Set(),
      ran: new Set(),
      unbuilt: new Set(),
      lastUses: new Map(),
    },
    implementations: { classes: new Map(), bodies: new Map(), unknown: new Set() },
    files: { tree: [], heldByInclusion: new Set() },
    boundary: { consumers: { declared: [], loaded: [] }, encapsulated: false, edges: [] },
    selfCheck: NO_SELF_CHECK,
    intraFunction: {
      parts: [],
      free: new Set(),
      freeButValued: new Set(),
      discardedEverywhere: new Set(),
    },
  };
}
