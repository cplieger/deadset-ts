/**
 * The members of a finding its emitter decides: the code, where the subject is,
 * what the subject is, and the sentence the finding reports. They are the
 * Contract's finding members of the same names, spelled in this language's case.
 *
 * Every other member the finding schema requires follows from these and from the
 * run: the kind's name, its fixability and its ceiling come from the code's row of
 * the issue-kind vocabulary, the severity and the confidence from the resolved
 * configuration, the language from the analyzer. A report completes them, so an
 * emitter cannot state one that disagrees with the vocabulary.
 */

/** Where the subject of a finding is. */
export interface FindingPosition {
  /** The file below the target root, with the solidus as separator. */
  readonly path: string;
  /** The line of the subject's first character, counted from one. */
  readonly line: number;
  /** The column of the subject's first character, counted from one in UTF-16 code units. */
  readonly column: number;
  /** The line of the subject's last character. */
  readonly endLine: number;
}

/** What a finding is about. */
export interface FindingSubject {
  /** The stable symbol reference, or for a configured root the root as written. */
  readonly ref: string;
  /** The subject kind, from the closed vocabulary of the finding schema. */
  readonly kind: string;
  /** The display name a text line renders. */
  readonly name: string;
  /** The number of source lines the subject spans. */
  readonly sizeLines: number;
}

/** One finding, as its emitter states it. */
export interface Finding {
  readonly code: string;
  readonly position: FindingPosition;
  readonly symbol: FindingSubject;
  readonly message: string;
}
