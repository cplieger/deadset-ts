/**
 * The suppression grammar's records, and the ledger that decides what each one did. A
 * record is one code bound to one site with its reason, from an inline directive, an
 * ignore entry or a baseline row. A bound record marks its declaration live before the
 * sweep, and is in effect when it withholds the finding its code would have produced
 * there, dormant when the configuration withholds that finding anyway, and stale otherwise.
 */

import { ConfigError } from "./config.ts";
import type { Finding } from "./finding.ts";
import { positionKey, type Position } from "./position.ts";
import { isRef } from "./ref.ts";

/** Which document a suppression is written in, spelled as a finding carries it. */
export type Mechanism = "inline" | "ignore" | "baseline";

/** The code a suppression that carries no reason is reported under. */
export const SUPPRESSION_WITHOUT_REASON = "DS1701";

/** The code an ignore entry or a baseline row that names no path is reported under. */
export const UNSCOPED_ENTRY = "DS1702";

/** The code a suppression that withholds nothing is reported under. */
export const STALE_SUPPRESSION = "DS1703";

/**
 * One suppression record: one code bound to one site. A directive naming two codes is two
 * records with one reason, and a directive above a line that declares two symbols is one
 * record per symbol.
 */
export interface SuppressionRecord {
  readonly code: string;
  /** The stable symbol reference named or bound, empty for a directive that bound nothing. */
  readonly symbol: string;
  /** The file the suppression names: the directive's own file, or the entry's `path`. */
  readonly path: string;
  /** Never blank: a suppression carrying no reason is a {@link Refusal}. */
  readonly reason: string;
  /** The declaration the record marks live, empty where it bound none. */
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
  readonly reported: typeof SUPPRESSION_WITHOUT_REASON | typeof UNSCOPED_ENTRY;
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
 * A directive, an entry or a document the grammar refuses before any finding exists: an
 * instruction the analysis cannot carry out. It is a malformed input, so the command line
 * answers it with the usage code.
 */
export class SuppressionError extends ConfigError {
  constructor(mechanism: Mechanism, at: string, text: string, want: string) {
    super("malformed", at, `${mechanism} ${at}: ${text}: want ${want}`);
    this.name = "SuppressionError";
  }
}

/** Where a position is written, as an error names it. */
export function siteText(site: Position): string {
  return site.line > 0 ? positionKey(site) : site.path;
}

/** An issue-kind code: `DS` and four digits. */
export const CODE_FORM = /^DS[0-9]{4}$/u;

/**
 * A path inside the target: relative to the target root, the solidus as separator, no
 * leading `./`, no trailing solidus, no `.` or `..` segment, never absolute.
 */
export const PATH_EXPRESSION = String.raw`^(?:[^/\\.\r\n][^/\\\r\n]*|\.[^/\\.\r\n][^/\\\r\n]*|\.\.[^/\\\r\n]+)(?:/(?:[^/\\.\r\n][^/\\\r\n]*|\.[^/\\.\r\n][^/\\\r\n]*|\.\.[^/\\\r\n]+))*$`;

const PATH_FORM = new RegExp(PATH_EXPRESSION, "u");

/** Whether one value is a path in the form an entry's `path` takes. */
export function isEntryPath(value: string): boolean {
  return PATH_FORM.test(value);
}

const GO_IDENT = String.raw`(?:[A-Za-z_]|[^\x00-\x7F])(?:[A-Za-z0-9_]|[^\x00-\x7F])*`;
const GO_PATH = String.raw`[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*`;
const GO_VERSION = String.raw`[A-Za-z0-9.+-]+`;
const GO_FILE = String.raw`[^/\\:#\r\n]+\.go`;

/**
 * The reference forms of the Go analyzer's grammar. One target holds one ignore file,
 * whose entries may name a symbol of either language, so an entry naming a Go symbol is
 * well formed here and binds nothing.
 */
export const GO_REF_EXPRESSIONS: readonly string[] = [
  `^go://${GO_PATH}#$`,
  `^go://${GO_PATH}#${GO_IDENT}$`,
  `^go://${GO_PATH}#${GO_IDENT}(?:\\.${GO_IDENT})+$`,
  `^go://${GO_PATH}#${GO_IDENT}(?:\\.${GO_IDENT})?\\[${GO_IDENT}\\]$`,
  `^go://${GO_PATH}#${GO_FILE}:file$`,
  `^go://${GO_PATH}#${GO_PATH}(?:@${GO_VERSION})?:require$`,
  `^go://${GO_PATH}#${GO_PATH}(?:@${GO_VERSION})?:replace$`,
];

const GO_REF_FORMS: readonly RegExp[] = GO_REF_EXPRESSIONS.map(
  (expression) => new RegExp(expression, "u"),
);

/** Whether one value is a stable symbol reference of either language's grammar. */
export function isSymbolRef(value: string): boolean {
  return isRef(value) || GO_REF_FORMS.some((form) => form.test(value));
}

/** Whether a reason is absent, empty or whitespace only, which the grammar reads as none. */
export function blankReason(reason: string | undefined): boolean {
  return reason === undefined || /^[ \t\r\n]*$/u.test(reason);
}

/** What a record did, as the ledger decides it. */
export type Verdict = "in-effect" | "dormant" | "stale";

/**
 * The configuration's dials, as the ledger reads them. Each is a dial that decides whether
 * a run reports a finding rather than whether one exists, so a record whose finding one of
 * them withholds is dormant.
 */
export interface Dials<F extends Finding = Finding> {
  /** Whether the configuration withholds every finding of one code from one declaration. */
  readonly withholdsCode: (code: string, bound: string) => boolean;
  /** Whether it withholds one finding: by its severity, its confidence, or its component's root. */
  readonly withholds: (finding: F) => boolean;
}

/** What every record did, and the findings the records withhold. */
export interface Ledger {
  /** One verdict per record, in reading order. */
  readonly verdicts: readonly Verdict[];
  /** Whether a record withholds one finding of the run. */
  readonly withheld: (finding: Finding) => boolean;
}

/**
 * The subject kinds that are a row of a document rather than a declaration of the program,
 * each with the codes that report one. A record binds to a declaration, so nothing
 * withholds a finding about one.
 */
const ROW_SUBJECTS: ReadonlyMap<string, readonly string[]> = new Map([
  ["file", ["DS1501", "DS1502"]],
  ["dependency", ["DS1601"]],
  ["module-directive", ["DS1605"]],
  ["root", ["DS1704"]],
  ["configured-declaration", ["DS1706"]],
  ["suppression", ["DS1701", "DS1702", "DS1703"]],
  ["edge", ["DS1705"]],
]);

/** Whether a finding's subject is a row of a document, which no record can withhold. */
export function isRowSubject(kind: string): boolean {
  return ROW_SUBJECTS.has(kind);
}

/** Whether a code reports a row of a document, so no record naming it can match. */
export function isRowCode(code: string): boolean {
  return [...ROW_SUBJECTS.values()].some((codes) => codes.includes(code));
}

/**
 * The subject kinds that are a part of a declaration rather than a declaration: a part
 * has no reference of its own, so a finding about one names the declaration that holds
 * it, and the part is decided inside that declaration whatever uses it.
 */
const PART_SUBJECTS: ReadonlySet<string> = new Set([
  "parameter",
  "receiver",
  "result",
  "statement",
  "case",
  "store",
]);

/** Whether a finding's subject is a part of the declaration its reference names. */
export function isPartSubject(kind: string): boolean {
  return PART_SUBJECTS.has(kind);
}

/** The prefix of the codes of the part kinds, the intra-function range. */
const PART_KIND_PREFIX = "DS18";

/**
 * Whether a code is a part kind, whose record withholds its finding and marks nothing:
 * the record says the part is wanted, not that the declaration holding it is.
 */
export function isPartKind(code: string): boolean {
  return code.startsWith(PART_KIND_PREFIX);
}

/** One finding's identity: its code and the position of the thing it names. */
function claimKey(finding: Finding): string {
  return `${finding.code}\u0000${positionKey(finding.position)}`;
}

/**
 * Whether one record names one finding. A record reaches a finding in two ways: it bound
 * the declaration at the finding's position, or it names the finding's reference and the
 * file the finding is reported in, each exactly. The second is how an entry copied from a
 * finding about a part of a declaration reaches the part.
 */
export function pairs(record: SuppressionRecord, finding: Finding): boolean {
  if (record.code !== finding.code || ROW_SUBJECTS.has(finding.symbol.kind)) {
    return false;
  }
  if (record.bound !== "" && record.bound === positionKey(finding.position)) {
    return true;
  }
  return record.symbol === finding.symbol.ref && record.path === finding.position.path;
}

/**
 * Decides every record against `would`, the findings the run would produce were no record
 * there: swept with no mark, where a kind about liveness reports the marked declaration,
 * and as swept, where a kind whose subject the sweep holds live reports it. The first
 * record in reading order claims a finding, so a second naming it is stale. A record whose
 * code the dials withhold from its declaration, or whose claimed finding they withhold, is
 * dormant.
 */
export function ledgerOf<F extends Finding>(
  records: readonly SuppressionRecord[],
  would: readonly F[],
  dials: Dials<F>,
): Ledger {
  const taken = new Set<string>();
  const verdicts: Verdict[] = [];
  for (const record of records) {
    if (record.bound !== "" && dials.withholdsCode(record.code, record.bound)) {
      verdicts.push("dormant");
      continue;
    }
    const claimed = would.find(
      (finding) => !taken.has(claimKey(finding)) && pairs(record, finding),
    );
    if (claimed === undefined) {
      verdicts.push("stale");
      continue;
    }
    taken.add(claimKey(claimed));
    verdicts.push(dials.withholds(claimed) ? "dormant" : "in-effect");
  }
  return {
    verdicts,
    withheld: (finding) => taken.has(claimKey(finding)) && !ROW_SUBJECTS.has(finding.symbol.kind),
  };
}

/** The two suppression counts a report's totals carry. */
interface SuppressionCounts {
  /** The records in effect. */
  readonly inEffect: number;
  /** The directives, entries and rows that carry a reason, each once whatever its codes. */
  readonly reasonsRecorded: number;
}

/** The suppression counts of one run's records and the ledger over them. */
export function suppressionCounts(
  records: readonly SuppressionRecord[],
  ledger: Ledger,
): SuppressionCounts {
  const sites = new Set(
    records.map((record) => `${record.mechanism}\u0000${positionKey(record.site)}`),
  );
  return {
    inEffect: ledger.verdicts.filter((verdict) => verdict === "in-effect").length,
    reasonsRecorded: sites.size,
  };
}
