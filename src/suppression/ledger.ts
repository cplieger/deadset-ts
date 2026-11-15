/**
 * What each suppression record did, as grammar/suppression.md decides it: in effect when it
 * withholds a finding the run would otherwise report, dormant when the configuration or a
 * hold of the analysis withholds every finding it matches anyway, and stale otherwise; the
 * stale suppressions a report carries; and the two counts it totals.
 */

import { CODE, REMEDIES, type Subject } from "../contract/contract.generated.ts";
import type { Finding } from "../finding.ts";
import { FIXED_SEVERITY_CODES } from "../kinds.ts";
import { positionKey, type Position } from "../position.ts";
import { bytewise } from "../text/compare.ts";
import {
  names,
  subjectOfCode,
  WRITTEN,
  type Mechanism,
  type SuppressionRecord,
} from "./records.ts";

/** What a record did, as the ledger decides it. */
type Verdict = "in-effect" | "dormant" | "stale";

/**
 * The configuration's dials, as the ledger reads them. Each decides whether a run reports
 * a finding rather than whether one exists, so a record whose finding one of them
 * withholds is dormant.
 */
export interface Dials<F extends Finding = Finding> {
  /** Whether the configuration sets the severity of one code to `allow`. */
  readonly allows: (code: string) => boolean;
  /** Whether it withholds one finding: by its severity, its confidence, or its component's root. */
  readonly withholds: (finding: F) => boolean;
}

/**
 * What the analysis holds because it cannot decide it: a hold is a gap, not evidence that
 * the code changed, so a record it touches is dormant.
 */
export interface Holds<F extends Finding = Finding> {
  /** Whether a hold withholds one finding: a type error's skip, or a hold of its declaration. */
  readonly withholds: (finding: F) => boolean;
  /** Whether a hold keeps the declaration one record binds live, so no finding about it is computed. */
  readonly holdsRecord: (record: SuppressionRecord) => boolean;
}

/** What the ledger reads of the run beside its records and its findings. */
export interface Judged<F extends Finding = Finding> {
  readonly dials: Dials<F>;
  readonly holds: Holds<F>;
  /**
   * The declaration a finding is about, or the one holding the part it is about, as a
   * record's `bound` names it, and empty where the finding is about no declaration.
   */
  readonly declarationOf: (finding: F) => string;
}

/** What every record did, and the findings the records withhold. */
export interface Ledger {
  /** One verdict per record, in reading order. */
  readonly verdicts: readonly Verdict[];
  /** Whether a record withholds one finding of the run. */
  readonly withheld: (finding: Finding) => boolean;
}

/** One finding's identity across codes: its code and the position of the thing it names. */
function claimKey(finding: Finding): string {
  return `${finding.code}\u0000${positionKey(finding.position)}`;
}

/** The identity of what a record was written as: its mechanism, its site and its code. */
function suppressionKey(record: SuppressionRecord): string {
  return `${record.mechanism}\u0000${positionKey(record.site)}\u0000${record.code}`;
}

/** The identity of where a record was written: its mechanism and its site. */
function siteKey(record: SuppressionRecord): string {
  return `${record.mechanism}\u0000${positionKey(record.site)}`;
}

/**
 * Whether one record names one finding under a code its mechanism can name. A directive
 * names what is written in its own file about the declaration it bound or a part of it.
 * An entry or a row names a finding carrying its reference, or a part's holder's, in its
 * path; where its entry resolved to several declarations, a finding about one of them is
 * that declaration's record's alone.
 */
function pairs(
  record: SuppressionRecord,
  bound: readonly string[],
  finding: Finding,
  declaration: string,
): boolean {
  if (record.code !== finding.code || !names(subjectOfCode(record.code), record.mechanism)) {
    return false;
  }
  if (record.mechanism === "inline") {
    return (
      record.bound !== "" &&
      declaration === record.bound &&
      record.site.path === finding.position.path
    );
  }
  if (
    record.path !== finding.position.path ||
    (record.symbol !== finding.symbol.ref && record.symbol !== finding.symbol.holder)
  ) {
    return false;
  }
  return declaration === "" || !bound.includes(declaration) || declaration === record.bound;
}

/**
 * Decides every record, in reading order, against `would`, the findings the run would
 * produce were no record there. A record claims every finding it names that no earlier
 * record claimed, so a later one naming only claimed findings is stale. A record is
 * dormant when the dials or a hold withhold every finding it claims, or when it is bound,
 * claims none, and its code is at `allow` or a hold keeps its declaration live.
 */
export function decide<F extends Finding>(
  records: readonly SuppressionRecord[],
  would: readonly F[],
  judged: Judged<F>,
): Ledger {
  const { dials, holds } = judged;
  const declarations = would.map(judged.declarationOf);
  const bound = new Map<string, string[]>();
  for (const record of records) {
    if (record.bound !== "") {
      const key = suppressionKey(record);
      bound.set(key, [...(bound.get(key) ?? []), record.bound]);
    }
  }
  const taken = new Set<string>();
  const verdicts = records.map((record): Verdict => {
    const resolved = bound.get(suppressionKey(record)) ?? [];
    const claimed = would.filter(
      (finding, at) =>
        !taken.has(claimKey(finding)) && pairs(record, resolved, finding, declarations[at] ?? ""),
    );
    if (claimed.length === 0) {
      return record.bound !== "" && (dials.allows(record.code) || holds.holdsRecord(record))
        ? "dormant"
        : "stale";
    }
    for (const finding of claimed) {
      taken.add(claimKey(finding));
    }
    return claimed.every((finding) => dials.withholds(finding) || holds.withholds(finding))
      ? "dormant"
      : "in-effect";
  });
  return { verdicts, withheld: (finding) => taken.has(claimKey(finding)) };
}

/**
 * One record per stale suppression, in reading order: a directive's code, an entry or a
 * row is stale when every record it resolved to is stale, so one naming two declarations
 * with one of them in effect is not.
 */
export function staleRecords(
  records: readonly SuppressionRecord[],
  ledger: Ledger,
): readonly SuppressionRecord[] {
  const live = new Set(
    records.filter((_record, at) => ledger.verdicts[at] !== "stale").map(suppressionKey),
  );
  const reported = new Set<string>();
  return records.filter((record) => {
    const key = suppressionKey(record);
    if (live.has(key) || reported.has(key)) {
      return false;
    }
    reported.add(key);
    return true;
  });
}

/** One stale suppression as the report's stale-suppression record carries it. */
export interface StaleSuppression {
  readonly code: typeof CODE.staleSuppression;
  readonly mechanism: Mechanism;
  readonly entry: {
    readonly code: string;
    readonly symbol?: string;
    readonly path: string;
    readonly reason: string;
  };
  readonly position: Position;
  readonly symbol: string;
  readonly message: string;
}

/** A list of codes as a sentence names them. */
function spelled(codes: readonly string[]): string {
  if (codes.length < 2) {
    return codes.join("");
  }
  return `${codes.slice(0, -1).join(", ")} and ${codes.at(-1) ?? ""}`;
}

/** A list as a sentence names alternatives. */
function spelledOr(items: readonly string[]): string {
  return items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} or ${items.at(-1) ?? ""}`;
}

/** A record's written name with its indefinite article. */
function articled(name: string): string {
  return `${/^[aeiou]/u.test(name) ? "an" : "a"} ${name}`;
}

/**
 * Why a record of `mechanism` naming `codes` can match nothing, one clause per subject whose
 * findings kinds.json's remedies table lets no record of that mechanism name, in subject order.
 */
function unnameable(codes: readonly string[], mechanism: Mechanism): readonly string[] {
  return (Object.keys(REMEDIES) as Subject[]).flatMap((subject) => {
    const named = codes.filter((code) => subjectOfCode(code) === subject);
    if (named.length === 0 || names(subject, mechanism)) {
      return [];
    }
    const { names: what, suppressions } = REMEDIES[subject];
    const reports = `${spelled(named)} ${named.length === 1 ? "reports" : "each report"} ${what}`;
    if (suppressions.length > 0) {
      const records = suppressions.map((one) => articled(WRITTEN[one]));
      return [`${reports}, which only ${spelledOr(records)} can name`];
    }
    const settable = named.filter((code) => !FIXED_SEVERITY_CODES.includes(code));
    const remedy =
      settable.length === 0
        ? "fix what the finding names instead"
        : `fix what the finding names or set the severity of ${spelled(settable)} instead`;
    return [`${reports}, which no suppression can name; ${remedy}`];
  });
}

/**
 * The stale suppressions a report carries: the records {@link staleRecords} returns, one
 * per mechanism and site, since a maintainer edits one line. The message names every code
 * the site's records named, why no record of that mechanism can name them where that is the
 * reason, and every code a declaration the site bound would report instead, so the
 * maintainer corrects the code rather than hunting for it. `subjectOf` is the reference a
 * record's finding names.
 */
export function staleSuppressions<F extends Finding>(
  stale: readonly SuppressionRecord[],
  would: readonly F[],
  judged: Pick<Judged<F>, "declarationOf">,
  subjectOf: (record: SuppressionRecord) => string,
): readonly StaleSuppression[] {
  const sites = new Map<string, SuppressionRecord[]>();
  for (const record of stale) {
    sites.set(siteKey(record), [...(sites.get(siteKey(record)) ?? []), record]);
  }
  return [...sites.values()].flatMap((site): StaleSuppression[] => {
    const [first] = site;
    if (first === undefined) {
      return [];
    }
    const codes = [...new Set(site.map((one) => one.code))].sort(bytewise);
    const declared = new Set(site.flatMap((one) => (one.bound === "" ? [] : [one.bound])));
    const reports = [
      ...new Set(
        would
          .filter((finding) => declared.has(judged.declarationOf(finding)))
          .map((finding) => finding.code),
      ),
    ]
      .filter((code) => !codes.includes(code))
      .sort(bytewise);
    const beside = reports.length === 0 ? "" : `its declaration reports ${spelled(reports)}`;
    const because = unnameable(codes, first.mechanism);
    const subject = subjectOf(first);
    const instead =
      because.length > 0
        ? `, because ${because.join("; ")}${beside === "" ? "" : `; ${beside}`}`
        : beside === ""
          ? ""
          : `, and ${beside}`;
    return [
      {
        code: CODE.staleSuppression,
        mechanism: first.mechanism,
        entry: {
          code: first.code,
          ...(first.symbol === "" ? {} : { symbol: first.symbol }),
          path: first.path,
          reason: first.reason,
        },
        position: first.site,
        symbol: subject,
        message: `${WRITTEN[first.mechanism]} for ${spelled(codes)} on ${subject} matches no current finding${instead}`,
      },
    ];
  });
}

/** The two suppression counts a report's totals carry. */
interface SuppressionCounts {
  /** The records in effect. */
  readonly inEffect: number;
  /** The directives, entries and rows that carry a reason, each once whatever its codes. */
  readonly reasonsRecorded: number;
}

/** The suppression counts of one run's records and the ledger over them. */
export function counts(records: readonly SuppressionRecord[], ledger: Ledger): SuppressionCounts {
  return {
    inEffect: ledger.verdicts.filter((verdict) => verdict === "in-effect").length,
    reasonsRecorded: new Set(records.map(siteKey)).size,
  };
}
