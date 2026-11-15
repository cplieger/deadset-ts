import { CODE } from "../contract/contract.generated.ts";
import { REPOSITORY_DOCUMENT } from "../config.ts";
import type { Finding, FindingDetails, SuppressionEntry } from "../finding.ts";
import { displayName, type InventorySymbol } from "../inventory.ts";
import type { Position } from "../position.ts";
import { WRITTEN, type Refusal } from "../suppression/records.ts";
import type { Emitter } from "./emitter.ts";

/** The subject kind of a finding about a configured declaration. */
const DECLARATION_SUBJECT = "configured-declaration";

/** The subject kind of a finding about a suppression record. */
const SUPPRESSION_SUBJECT = "suppression";

/** The subject kind of a finding about a configured root. */
const ROOT_SUBJECT = "root";

/** The fixed position of a finding about a document rather than about a line of one. */
const DOCUMENT_POSITION = 1;

/** What the configuration family reads: the run's refused suppressions and its configured roots. */
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

/** The file references of a run's declarations, by path. */
export function fileRefsOf(symbols: readonly InventorySymbol[]): FileRefs {
  const byPath = new Map(
    symbols
      .filter((symbol) => symbol.kind === "file")
      .map((symbol) => [symbol.position.path, symbol.ref]),
  );
  return (path) => byPath.get(path);
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
    symbol: { ref, kind: SUPPRESSION_SUBJECT, name: displayName(ref), sizeLines: 1 },
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
type FileRefs = (path: string) => string | undefined;

/**
 * The reference a finding about a suppression names: the symbol it names or bound, else
 * the file form of the document that holds it, else that document's path.
 */
export function suppressionRef(symbol: string, path: string, files: FileRefs): string {
  return symbol === "" ? (files(path) ?? path) : symbol;
}

/** One finding per refused suppression: the grammar's reason refusal and its scope refusal. */
function refusedSuppressions(refusals: readonly Refusal[], files: FileRefs): readonly Finding[] {
  return refusals.map((refused) => {
    const ref = suppressionRef(refused.symbol, refused.path, files);
    return aboutSuppression(
      refused.reported,
      ref,
      refused.site,
      `${WRITTEN[refused.mechanism]} for ${refused.code} on ${displayName(ref)} ${
        refused.reported === CODE.suppressionWithoutReason
          ? "carries no reason"
          : "names a symbol and no path"
      }`,
      { mechanism: refused.mechanism, entry: writtenEntry(refused) },
    );
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
  return unmatched.map((one) => {
    const name = displayName(one.ref);
    return {
      code: CODE.unmatchedConfiguredDeclaration,
      position: documentPosition(one.document),
      symbol: { ref: one.ref, kind: DECLARATION_SUBJECT, name, sizeLines: 1 },
      message: `${one.key} entry ${name} names no declaration in any project`,
    };
  });
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
  return sources.map((source) => {
    const name = displayName(source);
    return {
      code: CODE.unmatchedRoot,
      position,
      symbol: { ref: source, kind: ROOT_SUBJECT, name, sizeLines: 1 },
      message: `configured root ${source.includes("*") || source.includes("?") ? "pattern " : ""}${name} matches no symbol of the inventory`,
    };
  });
}

/**
 * The findings of the configuration family, `DS9000` to `DS9099`: a suppression refused for
 * carrying no reason or naming no path, and a configured root or declaration that named
 * nothing. A suppression that matched nothing is a record of the report's stale
 * suppressions, and a stale cross-language edge is the merge's to report.
 */
export const selfCheck: Emitter = ({ selfCheck: facts, swept }) => [
  ...refusedSuppressions(facts.refusals, fileRefsOf(swept.matrix.union.symbols)),
  ...unmatchedRootFindings(facts.unmatchedRoots, facts.rootsDocument),
  ...unmatchedDeclarationFindings(facts.unmatchedDeclarations),
];
