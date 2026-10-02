import { nodeHost } from "../bin/node-host.ts";
import { runEmitterInput, type RunSweep } from "../src/analysis.ts";
import type { Config } from "../src/config.ts";
import type { EmitterInput } from "../src/findings/emitter.ts";
import { NO_SELF_CHECK } from "../src/findings/self-check.ts";
import { scopeForDir } from "../src/scope.ts";
import { openEngine, type Engine } from "../src/session.ts";
import type { Mode } from "../src/sweep.ts";

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

/** What every emitter reads of one target, swept under one configuration. */
export function emitterInputOf(target: string, config: Config, by: SweptBy = {}): EmitterInput {
  const host = nodeHost();
  return runEmitterInput(
    by.engine ?? openEngine({ collectTiming: false }),
    host,
    {
      ...scopeForDir(host, target),
      consumers: (by.consumers ?? []).map((path) => ({ id: "", path })),
    },
    config,
    { marked: by.marked ?? [], mode: by.mode ?? { production: true } },
  );
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
    stores: { references: [], accessors: new Set(), exempt: new Set() },
    dependencies: {
      manifest: { package: ".", path: "package.json" },
      declared: [],
      installed: new Map(),
      needed: new Set(),
      lastUses: new Map(),
    },
    implementations: { classes: new Map(), bodies: new Map() },
    files: { tree: [], heldByInclusion: new Set() },
    boundary: { consumers: { declared: [], loaded: [] }, encapsulated: false, edges: [] },
    selfCheck: NO_SELF_CHECK,
    intraFunction: { parts: [], free: new Set(), discardedEverywhere: new Set() },
  };
}
