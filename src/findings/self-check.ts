import { REPOSITORY_DOCUMENT } from "../config.ts";
import type { Finding, FindingDetails, SuppressionEntry } from "../finding.ts";
import type { InventorySymbol } from "../inventory.ts";
import type { Position } from "../position.ts";
import {
  STALE_SUPPRESSION,
  SUPPRESSION_WITHOUT_REASON,
  type Mechanism,
  type Refusal,
  type SuppressionRecord,
} from "../suppress.ts";
import type { Emitter } from "./emitter.ts";

/** The code a configured root that matches nothing is reported under. */
const UNMATCHED_ROOT = "DS1704";

/** The code a configured declaration that names nothing is reported under. */
const UNMATCHED_DECLARATION = "DS1706";

/** The subject kind of a finding about a configured declaration. */
const DECLARATION_SUBJECT = "configured-declaration";

/** The subject kind of a finding about a suppression record. */
const SUPPRESSION_SUBJECT = "suppression";

/** The subject kind of a finding about a configured root. */
const ROOT_SUBJECT = "root";

/** The fixed position of a finding about a document rather than about a line of one. */
const DOCUMENT_POSITION = 1;

/** One record no finding matched, and the codes its declaration reports instead. */
export interface StaleRecord {
  readonly record: SuppressionRecord;
  /** The codes the bound declaration would report, none of them the record's own. */
  readonly reports: readonly string[];
}

/** What the self-check family reads: the run's refused suppressions and its configured roots. */
export interface SelfCheckFacts {
  /** The suppressions the grammar refused with a finding, in reading order. */
  readonly refusals: readonly Refusal[];
  /** Every configured root or pattern that matched nothing in any project. */
  readonly unmatchedRoots: readonly string[];
  /** The document below the target root that declared the roots, empty where none did. */
  readonly rootsDocument: string;
  /** Every configured declaration that named no declaration in any project, in reading order. */
  readonly unmatchedDeclarations: readonly UnmatchedDeclaration[];
}

/** One configured declaration that named nothing, and the document that configured it. */
interface UnmatchedDeclaration {
  /** The entry as a finding's subject reference spells it. */
  readonly ref: string;
  /** The dotted path of the key that holds the entry. */
  readonly key: string;
  /** The document below the target root that declared the key, empty where none did. */
  readonly document: string;
}

/** A run with nothing for the self-check family to report. */
export const NO_SELF_CHECK: SelfCheckFacts = {
  refusals: [],
  unmatchedRoots: [],
  rootsDocument: "",
  unmatchedDeclarations: [],
};

/** The words a message names a mechanism by. */
const WRITTEN: Readonly<Record<Mechanism, string>> = {
  inline: "inline directive",
  ignore: "ignore entry",
  baseline: "baseline row",
};

/** The file references of a run's declarations, by path. */
export function fileRefsOf(symbols: readonly InventorySymbol[]): FileRefs {
  const byPath = new Map(
    symbols
      .filter((symbol) => symbol.kind === "file")
      .map((symbol) => [symbol.position.path, symbol.ref]),
  );
  return (path) => byPath.get(path);
}

/** A list of codes as a sentence names them. */
function spelled(codes: readonly string[]): string {
  if (codes.length < 2) {
    return codes.join("");
  }
  return `${codes.slice(0, -1).join(", ")} and ${codes.at(-1) ?? ""}`;
}

/** A finding about one suppression, at the suppression's own site. */
function aboutSuppression(
  code: string,
  ref: string,
  site: Position,
  message: string,
  details: FindingDetails,
): Finding {
  return {
    code,
    position: { ...site, endLine: site.line },
    symbol: { ref, kind: SUPPRESSION_SUBJECT, name: ref, sizeLines: 1 },
    message,
    details,
  };
}

/** Whether a reason holds a character other than whitespace. */
const STATED = /[^ \t\r\n]/u;

/** A refused suppression as written: a member it lacks is absent. */
function writtenEntry(refused: Refusal): SuppressionEntry {
  return {
    code: refused.code,
    ...(refused.symbol === "" ? {} : { symbol: refused.symbol }),
    ...(refused.path === "" ? {} : { path: refused.path }),
    ...(STATED.test(refused.reason) ? { reason: refused.reason } : {}),
  };
}

/** Each file of the run by its path, as the reference of the file it is. */
export type FileRefs = (path: string) => string | undefined;

/**
 * The reference a finding about a suppression names: the symbol it names or bound, else
 * the file form of the document that holds it, else that document's path.
 */
function suppressionRef(symbol: string, path: string, files: FileRefs): string {
  return symbol === "" ? (files(path) ?? path) : symbol;
}

/** One finding per refused suppression: the grammar's reason refusal and its scope refusal. */
export function refusedSuppressions(
  refusals: readonly Refusal[],
  files: FileRefs,
): readonly Finding[] {
  return refusals.map((refused) =>
    aboutSuppression(
      refused.reported,
      suppressionRef(refused.symbol, refused.path, files),
      refused.site,
      `${WRITTEN[refused.mechanism]} for ${refused.code} ${
        refused.reported === SUPPRESSION_WITHOUT_REASON
          ? "carries no reason"
          : "names a symbol and no path"
      }`,
      { mechanism: refused.mechanism, entry: writtenEntry(refused) },
    ),
  );
}

/** One stale suppression as the report's stale-suppression record carries it. */
export interface StaleSuppression {
  readonly code: typeof STALE_SUPPRESSION;
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

/**
 * One record per site at which a suppression matched nothing, whatever the number of
 * codes or declarations written there: the first record names the entry, and the message
 * names every code the site's records named and every code the declaration reports
 * instead, so the maintainer corrects the code rather than hunting for it.
 */
export function staleSuppressions(
  stale: readonly StaleRecord[],
  files: FileRefs,
): readonly StaleSuppression[] {
  const bySite = new Map<string, { first: SuppressionRecord; records: StaleRecord[] }>();
  for (const one of stale) {
    const { site, mechanism } = one.record;
    const key = `${mechanism}\u0000${site.path}\u0000${String(site.line)}\u0000${String(site.column)}`;
    const held = bySite.get(key) ?? { first: one.record, records: [] };
    held.records.push(one);
    bySite.set(key, held);
  }
  return [...bySite.values()].map(({ first, records }) => {
    const codes = [...new Set(records.map((one) => one.record.code))].sort();
    const reports = [...new Set(records.flatMap((one) => one.reports))]
      .filter((code) => !codes.includes(code))
      .sort();
    const instead = reports.length === 0 ? "" : `, and its declaration reports ${spelled(reports)}`;
    return {
      code: STALE_SUPPRESSION,
      mechanism: first.mechanism,
      entry: {
        code: first.code,
        ...(first.symbol === "" ? {} : { symbol: first.symbol }),
        path: first.path,
        reason: first.reason,
      },
      position: first.site,
      symbol: suppressionRef(first.symbol, first.path, files),
      message: `${WRITTEN[first.mechanism]} for ${spelled(codes)} matches no current finding${instead}`,
    };
  });
}

/** The first position of the document that configured a setting, or of the conventional one. */
function documentPosition(document: string): Finding["position"] {
  return {
    path: document === "" ? REPOSITORY_DOCUMENT : document,
    line: DOCUMENT_POSITION,
    column: DOCUMENT_POSITION,
    endLine: DOCUMENT_POSITION,
  };
}

/**
 * One finding per configured declaration that named no declaration in any project, at the
 * first position of the document that configured its key, as a configured root's is.
 */
function unmatchedDeclarationFindings(
  unmatched: readonly UnmatchedDeclaration[],
): readonly Finding[] {
  return unmatched.map((one) => ({
    code: UNMATCHED_DECLARATION,
    position: documentPosition(one.document),
    symbol: { ref: one.ref, kind: DECLARATION_SUBJECT, name: one.ref, sizeLines: 1 },
    message: `${one.key} entry names no declaration in any project`,
  }));
}

/**
 * One finding per configured root or pattern that named nothing in any project. A finding
 * names the document that declared the roots, or the conventional repository configuration
 * where no document of the target did, and every finding of one run sits at that
 * document's first position: the roots are an array whose members carry no line of their
 * own, so the string each finding names tells one from another.
 */
export function unmatchedRootFindings(
  sources: readonly string[],
  document: string,
): readonly Finding[] {
  const position = documentPosition(document);
  return sources.map((source) => ({
    code: UNMATCHED_ROOT,
    position,
    symbol: { ref: source, kind: ROOT_SUBJECT, name: source, sizeLines: 1 },
    message:
      source.includes("*") || source.includes("?")
        ? "configured root pattern matches no symbol of the inventory"
        : "configured root matches no symbol of the inventory",
  }));
}

/**
 * The findings of the self-check family, `DS1700` to `DS1799`: a suppression refused for
 * carrying no reason or naming no path, and a configured root or declaration that named
 * nothing. A
 * suppression that matched nothing is a record of the report's stale suppressions, which
 * {@link staleSuppressions} builds, and a stale cross-language edge is the merge's to report.
 */
export const selfCheck: Emitter = ({ selfCheck: facts, swept }) => [
  ...refusedSuppressions(facts.refusals, fileRefsOf(swept.matrix.union.symbols)),
  ...unmatchedRootFindings(facts.unmatchedRoots, facts.rootsDocument),
  ...unmatchedDeclarationFindings(facts.unmatchedDeclarations),
];
