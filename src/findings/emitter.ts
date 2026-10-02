import type { RunSweep } from "../analysis.ts";
import type { Config } from "../config.ts";
import type { Dependencies } from "../dependencies.ts";
import type { FileFacts } from "../file-facts.ts";
import type { Finding } from "../finding.ts";
import type { Implementations } from "../implementations.ts";
import type { IntraFunctionFacts } from "../intra-function-parts.ts";
import type { Stores } from "../stores.ts";
import type { Boundary } from "./boundary.ts";
import type { SelfCheckFacts } from "./self-check.ts";

/**
 * What every emitter reads: the configuration the run resolved, the run's sweep, and
 * the facts about the run each kind family reads beside the sweep.
 */
export interface EmitterInput {
  readonly config: Config;
  /** The production sweep a report is built from, beside the matrix it judged. */
  readonly swept: RunSweep;
  /** The declarations carrying the deprecation marker in any configuration of the run. */
  readonly deprecated: ReadonlySet<string>;
  /** The stores into the run's declarations and the reads of them, which the sweep does not keep. */
  readonly stores: Stores;
  /** What the target's manifest declares, and what its projects need of it. */
  readonly dependencies: Dependencies;
  /** How the run's interfaces are implemented by its classes. */
  readonly implementations: Implementations;
  /** The target's files beside the sweep: the source tree, and what a program holds by inclusion. */
  readonly files: FileFacts;
  /** What can reach the target from outside it: consumers, declared edges, and `exports`. */
  readonly boundary: Boundary;
  /** The run's suppression outcomes and configured roots, which the self-check family reports. */
  readonly selfCheck: SelfCheckFacts;
  /** The parts of the run's declarations, which the intra-function family reports. */
  readonly intraFunction: IntraFunctionFacts;
}

/**
 * One kind family's rule over one run: every finding of the codes in its family's range
 * of the Contract's code space, whatever severity and minimum confidence the
 * configuration sets, in no particular order.
 */
export type Emitter = (input: EmitterInput) => readonly Finding[];

/** The emitter of each kind family, by the family's name in the Contract, in code order. */
export type Emitters = ReadonlyMap<string, Emitter>;
