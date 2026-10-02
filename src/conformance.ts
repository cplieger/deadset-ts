/**
 * What this analyzer states about its own conformance: the corpus version it is written
 * against and its recorded result over that corpus, which `describe` and every report name.
 */

/** The result one product reached over the conformance corpus. */
export interface Conformance {
  readonly corpusVersion: string;
  readonly result: "pass" | "fail";
  /** `sha256:` and the lowercase hexadecimal SHA-256 of the results document the runner wrote. */
  readonly digest: string;
}

/** The version of the conformance corpus this analyzer is written against. */
const CORPUS_VERSION = "1.9.0";

/** The SHA-256 of zero bytes, which is the digest of a results document no run wrote. */
const EMPTY_DIGEST = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * The conformance run this analyzer records, or undefined where it records none. A
 * description states exactly this, so a reader that requires a pass refuses an analyzer
 * that has not answered the corpus.
 */
export const RECORDED_CONFORMANCE: Conformance | undefined = undefined;

/**
 * The conformance a report states. A report requires the block, so an analyzer that
 * records no run states a failed one over the results document no run wrote, which a merge
 * refuses as it refuses any result other than a pass.
 */
export function reportedConformance(recorded: Conformance | undefined): Conformance {
  return recorded ?? { corpusVersion: CORPUS_VERSION, result: "fail", digest: EMPTY_DIGEST };
}
