/**
 * What this analyzer states about its own conformance: its recorded result over the
 * conformance corpus and every capability it declines, which `describe` and every report
 * name.
 */
import { RECORD } from "./conformance-record.ts";

/**
 * The result one product reached over the conformance corpus. A declared gap never lowers
 * it: the result is `pass` when no fixture fails, gaps or not, and `fail` otherwise.
 */
export interface Conformance {
  readonly corpusVersion: string;
  readonly result: "pass" | "fail";
  /** `sha256:` and the lowercase hexadecimal SHA-256 of the results document the run wrote. */
  readonly digest: string;
}

/** One capability this analyzer declines, as `conformance.json` declares it. */
export interface DeclaredGap {
  readonly fixture: string;
  /** The one expectation the gap covers, where it is narrower than the fixture. */
  readonly symbol?: string;
  readonly capability: string;
  readonly reason: string;
}

/** The conformance run this analyzer records. */
export const CONFORMANCE: Conformance = RECORD.conformance;

/** Every capability this analyzer declines, in the order `conformance.json` declares them. */
export const DECLARED_GAPS: readonly DeclaredGap[] = RECORD.gaps;
