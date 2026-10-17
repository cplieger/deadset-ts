import { FAILURE_CLASSES, FAILURE_PREFIXES } from "./contract/contract.generated.ts";
import type { LocatedDiagnostic } from "./load/diagnostics.ts";
import { PRODUCT } from "./product.ts";

/** A class of failure the Contract's exit-code table names, of either group. */
type FailureClass = keyof typeof FAILURE_CLASSES;

/** One cause the run ends with the failure code for. */
export interface Failure {
  readonly failureClass: FailureClass;
  /** What fails and the fix, on one line. */
  readonly detail: string;
}

/** The failure as a class line of the error stream, opened by its group's prefix. */
export function failureLine(failure: Failure): string {
  return `${FAILURE_PREFIXES[FAILURE_CLASSES[failure.failureClass]]}${failure.failureClass}: ${failure.detail}`;
}

/**
 * The lines of the error stream that name the failures: the first one's class line, the run's
 * only one, then each further failure as its class and detail with no group prefix.
 */
export function failureLines([first, ...further]: readonly [Failure, ...Failure[]]): string[] {
  return [failureLine(first), ...further.map((one) => `${one.failureClass}: ${one.detail}`)];
}

/**
 * A run the analysis cannot answer. It ends the run with the failure code and no finding
 * list, printing the compiler's located errors and then the failures' lines.
 */
export class FailureExit extends Error {
  readonly failures: readonly [Failure, ...Failure[]];
  /** The compiler's errors behind the failures, in the order it reported them. */
  readonly diagnostics: readonly LocatedDiagnostic[];

  constructor(
    failures: readonly [Failure, ...Failure[]],
    diagnostics: readonly LocatedDiagnostic[] = [],
  ) {
    super(failureLines(failures).join("\n"));
    this.name = "FailureExit";
    this.failures = failures;
    this.diagnostics = diagnostics;
  }
}

/** A failure exit of one failure. */
export function failureExit(
  failureClass: FailureClass,
  detail: string,
  diagnostics: readonly LocatedDiagnostic[] = [],
): FailureExit {
  return new FailureExit([{ failureClass, detail }], diagnostics);
}

/** A fault of this analyzer itself, `fault` saying what it cannot do. */
export function productFault(fault: string): FailureExit {
  return failureExit(
    "product-fault",
    `${PRODUCT} ${fault}: reinstall ${PRODUCT}, and report the fault to its maintainers if a reinstalled ${PRODUCT} fails the same way`,
  );
}
