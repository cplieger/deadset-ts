import type { RunSweep } from "../analysis.ts";
import type { Config } from "../config.ts";
import type { Finding } from "../finding.ts";

/** What every emitter reads: the configuration the run resolved and the run's sweep. */
export interface EmitterInput {
  readonly config: Config;
  /** The production sweep a report is built from, beside the matrix it judged. */
  readonly swept: RunSweep;
}

/**
 * One kind family's rule over one run: the findings of the codes in its family's range
 * of the Contract's code space, in no particular order.
 */
export type Emitter = (input: EmitterInput) => readonly Finding[];

/** The emitter of each kind family, by the family's name in the Contract, in code order. */
export type Emitters = ReadonlyMap<string, Emitter>;
