import { SETUP_FAILURE_PREFIX, type SETUP_CLASSES } from "./contract/contract.generated.ts";

/**
 * A setup failure: a file or a component the analysis needs and the project does not
 * provide. Each one names what is missing and the fix, on one line of the error stream
 * that starts with its class.
 */

/** A class of setup failure the Contract names. */
type SetupClass = (typeof SETUP_CLASSES)[number]["class"];

export interface SetupFailure {
  readonly setupClass: SetupClass;
  /** What is missing and the fix, on one line. */
  readonly detail: string;
}

/** The failure as the one line of the error stream that names it. */
export function setupLine(failure: SetupFailure): string {
  return `${SETUP_FAILURE_PREFIX}${failure.setupClass}: ${failure.detail}`;
}

/**
 * A run that met a setup failure where none may be dropped: in a configuration the
 * configuration document or the scope declares, in a declared consumer, or in every
 * configuration discovery derived. It ends the run with the failure code and no finding
 * list.
 */
export class SetupError extends Error {
  readonly failures: readonly SetupFailure[];

  constructor(failures: readonly SetupFailure[]) {
    super(failures.map(setupLine).join("\n"));
    this.name = "SetupError";
    this.failures = failures;
  }
}
