/**
 * The records the three suppression mechanisms resolve to, grammar/suppression.md's
 * vocabulary for them, and the binding of an ignore entry or a baseline row to the run's
 * declarations. An inline directive is read by `inline.ts`, the two documents by
 * `documents.ts`; what a record does once it exists is `ledger.ts`'s.
 */

import {
  CODE,
  KIND_ROWS,
  REMEDIES,
  SYMBOL_SUBJECTS,
  type Subject,
} from "../contract/contract.generated.ts";
import type { InventorySymbol } from "../inventory.ts";
import { positionKey, type Position } from "../position.ts";
import { declarationKey, isRef } from "../ref.ts";
import { expression } from "../text/expression.ts";
import { UsageError } from "../usage.ts";

/** Which document a suppression is written in, spelled as a finding carries it. */
export type Mechanism = "inline" | "ignore" | "baseline";

/** The words a message names one suppression of each mechanism by. */
export const WRITTEN: Readonly<Record<Mechanism, string>> = {
  inline: "inline directive",
  ignore: "ignore entry",
  baseline: "baseline row",
};

/**
 * One suppression record: one code bound to one site. A directive naming two codes is two
 * records with one reason, and a directive above a line that declares two symbols, or an
 * entry naming a reference two declarations of one file share, is one record per
 * declaration.
 */
export interface SuppressionRecord {
  readonly code: string;
  /** The stable symbol reference named or bound, empty for a directive that bound nothing. */
  readonly symbol: string;
  /** The file the suppression names: the directive's own file, or the entry's `path`. */
  readonly path: string;
  /** Never blank: a suppression carrying no reason is a {@link Refusal}. */
  readonly reason: string;
  /** The declaration the record binds, empty where it bound none. */
  readonly bound: string;
  /** Where the suppression is written. */
  readonly site: Position;
  readonly mechanism: Mechanism;
}

/**
 * One suppression the grammar refuses with a finding rather than with an exit. It binds
 * nothing, and its finding reports the suppression as written.
 */
export interface Refusal {
  readonly reported: typeof CODE.suppressionWithoutReason | typeof CODE.unscopedIgnoreEntry;
  readonly code: string;
  /** The reference the entry names, empty for a directive. */
  readonly symbol: string;
  readonly path: string;
  readonly reason: string;
  readonly site: Position;
  readonly mechanism: Mechanism;
}

/** What the three documents of one target hold, in reading order. */
export interface Suppressions {
  /** Inline directives by position, then the ignore file's entries, then the baseline's rows. */
  readonly records: readonly SuppressionRecord[];
  readonly refusals: readonly Refusal[];
}

/**
 * One ignore entry or baseline row as the document writes it: a member the document leaves
 * out is absent.
 */
export interface Entry {
  readonly code: string;
  readonly symbol: string;
  readonly path?: string;
  readonly reason?: string;
  readonly site: Position;
}

/**
 * A directive, an entry or a document the grammar refuses before any finding exists: an
 * instruction the analysis cannot carry out. It is a malformed input, so the command line
 * answers it with the usage code.
 */
export class SuppressionError extends UsageError {
  constructor(mechanism: Mechanism, site: Position, text: string, want: string) {
    super(`${mechanism} ${siteText(site)}: ${text}: want ${want}`);
    this.name = "SuppressionError";
  }
}

/** Where a position is written, as an error names it: the document alone where it has no line. */
function siteText(site: Position): string {
  return site.line > 0 ? positionKey(site) : site.path;
}

/** An issue-kind code: `DS` and four digits. */
export const CODE_FORM = /^DS[0-9]{4}$/u;

/**
 * A path inside the target: relative to the target root, the solidus as separator, no
 * leading `./`, no trailing solidus, no `.` or `..` segment, never absolute, and no
 * control character; a backslash is a character of a name.
 */
export const PATH_EXPRESSION = String.raw`^(?:[^/.\x00-\x1f\x7f][^/\x00-\x1f\x7f]*|\.[^/.\x00-\x1f\x7f][^/\x00-\x1f\x7f]*|\.\.[^/\x00-\x1f\x7f]+)(?:/(?:[^/.\x00-\x1f\x7f][^/\x00-\x1f\x7f]*|\.[^/.\x00-\x1f\x7f][^/\x00-\x1f\x7f]*|\.\.[^/\x00-\x1f\x7f]+))*$`;

const PATH_FORM = expression(PATH_EXPRESSION);

/** Whether one value is a path in the form an entry's `path` takes. */
export function isEntryPath(value: string): boolean {
  return PATH_FORM.test(value);
}

/** The scheme of this analyzer's language, which opens every reference it binds. */
export const OWN_SCHEME = "ts://";

/** Whether a reason is absent, empty or whitespace only, which the grammar reads as none. */
function blankReason(reason: string | undefined): boolean {
  return reason === undefined || /^[ \t\r\n]*$/u.test(reason);
}

/** The subject of the kind each live code names. */
const SUBJECT_OF_CODE: ReadonlyMap<string, Subject> = new Map(
  KIND_ROWS.map((row): [string, Subject] => [row.code, row.subject]),
);

/** The subject a finding about one symbol kind is about. */
function subjectOf(kind: string): Subject | undefined {
  return Object.hasOwn(SYMBOL_SUBJECTS, kind)
    ? SYMBOL_SUBJECTS[kind as keyof typeof SYMBOL_SUBJECTS]
    : undefined;
}

/** Whether a finding's subject is a row of a document rather than a declaration. */
export function isRowSubject(kind: string): boolean {
  const subject = subjectOf(kind);
  return subject === "file" || subject === "dependency" || subject === "record";
}

/** The subject a code reports, which kinds.json's remedies table answers for. */
export function subjectOfCode(code: string): Subject | undefined {
  return SUBJECT_OF_CODE.get(code);
}

/**
 * Whether a record of `mechanism` can name a finding about `subject`, as kinds.json's
 * remedies table lists the suppressions of each subject. A subject the table does not
 * know is a declaration's.
 */
export function names(subject: Subject | undefined, mechanism: Mechanism): boolean {
  return (REMEDIES[subject ?? "declaration"].suppressions as readonly Mechanism[]).includes(
    mechanism,
  );
}

/** Whether a finding about a symbol of `kind` is one a record of `mechanism` can name. */
export function namesKind(kind: string, mechanism: Mechanism): boolean {
  return names(subjectOf(kind), mechanism);
}

/**
 * Whether a finding's subject is a part of the declaration its reference names: a part
 * has no reference of its own, so a finding about one names the declaration that holds
 * it, and the part is decided inside that declaration whatever uses it.
 */
export function isPartSubject(kind: string): boolean {
  return subjectOf(kind) === "part";
}

/**
 * Whether a code is a part kind, whose record withholds its finding and marks nothing:
 * the record says the part is wanted, not that the declaration holding it is.
 */
export function isPartKind(code: string): boolean {
  return SUBJECT_OF_CODE.get(code) === "part";
}

/** The reference of the declaration a parameter's reference names it under, or `ref` itself. */
function parameterHolder(ref: string): string {
  return ref.endsWith(")") ? ref.slice(0, ref.lastIndexOf("(")) : ref;
}

/** The form a malformed reference of this analyzer's scheme is told to take. */
const SYMBOL_WANT = "a stable symbol reference of ts://<package>/<source-path>#<fragment>";

/**
 * Binds the entries of one document to the run's declarations. An entry of another scheme
 * belongs to another analyzer and resolves to nothing, unread. An entry of this analyzer's
 * scheme whose reference takes no form the grammar admits is a {@link SuppressionError};
 * one carrying no reason, or naming no path, is a refusal for each rule it breaks; any
 * other binds every declaration its reference and file name, a parameter's entry binding
 * the declaration holding it, and is a record bound to nothing where it names none.
 */
export function bind(
  entries: readonly Entry[],
  mechanism: Mechanism,
  symbols: readonly InventorySymbol[],
): Suppressions {
  const byReference = new Map<string, InventorySymbol[]>();
  for (const symbol of symbols) {
    const key = declarationKey(symbol.ref, symbol.position.path);
    byReference.set(key, [...(byReference.get(key) ?? []), symbol]);
  }
  const records: SuppressionRecord[] = [];
  const refusals: Refusal[] = [];
  for (const entry of entries) {
    if (!entry.symbol.startsWith(OWN_SCHEME)) {
      continue;
    }
    if (!isRef(entry.symbol)) {
      throw new SuppressionError(mechanism, entry.site, JSON.stringify(entry.symbol), SYMBOL_WANT);
    }
    const written = {
      code: entry.code,
      symbol: entry.symbol,
      path: entry.path ?? "",
      reason: entry.reason ?? "",
      site: entry.site,
      mechanism,
    };
    const refused: Refusal[] = [
      ...(blankReason(entry.reason)
        ? [{ ...written, reported: CODE.suppressionWithoutReason }]
        : []),
      ...(written.path === "" ? [{ ...written, reported: CODE.unscopedIgnoreEntry }] : []),
    ];
    if (refused.length > 0) {
      refusals.push(...refused);
      continue;
    }
    const named =
      byReference.get(declarationKey(entry.symbol, written.path)) ??
      (isPartKind(entry.code)
        ? byReference.get(declarationKey(parameterHolder(entry.symbol), written.path))
        : undefined) ??
      [];
    records.push(
      ...(named.length === 0
        ? [{ ...written, bound: "" }]
        : named.map((one) => ({ ...written, bound: one.id }))),
    );
  }
  return { records, refusals };
}
