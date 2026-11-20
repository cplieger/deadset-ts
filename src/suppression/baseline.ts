/**
 * The baseline write: the rows a fixpoint over the analysis records, the rows of other
 * schemes the document keeps, and the bytes grammar/suppression.md fixes, the same bytes
 * whichever analyzer writes the document last.
 */

import { jsonChunks } from "../json-chunks.ts";
import type { InventorySymbol } from "../inventory.ts";
import { reportedPath } from "../ref.ts";
import { bytewise } from "../text/compare.ts";
import { BASELINE_FILE } from "./documents.ts";
import { bind, namesKind, OWN_SCHEME, type Entry, type Suppressions } from "./records.ts";

/** One finding a row records: the three values a later run matches the row on. */
export interface Recorded {
  readonly code: string;
  readonly symbol: string;
  readonly path: string;
}

/** The analyzer a written row names as its provenance, as the same run's report names it. */
export interface Provenance {
  readonly analyzer: string;
  readonly version: string;
}

/** What a baseline row is recorded from: a finding's code, subject and file. */
export interface RecordableFinding {
  readonly code: string;
  readonly symbol: { readonly ref: string; readonly kind: string };
  readonly position: { readonly path: string };
}

/** One row's identity: its code, its symbol and its path. */
function rowKey(row: Recorded): string {
  return `${row.code}\u0000${row.symbol}\u0000${row.path}`;
}

/**
 * The rows one round records from its findings, in their order: one per finding whose
 * subject a row can name, since any other row would be stale on the first read back, and
 * one for two findings that would record the same row, two parts of one declaration
 * under one code.
 */
export function recordedRows(findings: readonly RecordableFinding[]): readonly Recorded[] {
  const rows = new Map<string, Recorded>();
  for (const finding of findings) {
    if (!namesKind(finding.symbol.kind, "baseline")) {
      continue;
    }
    const row = {
      code: finding.code,
      symbol: finding.symbol.ref,
      path: reportedPath(finding.position.path),
    };
    rows.set(rowKey(row), rows.get(rowKey(row)) ?? row);
  }
  return [...rows.values()];
}

/** The reason every row a baseline write records carries. */
export function rowReason(provenance: Provenance): string {
  return `recorded by ${provenance.analyzer} ${provenance.version}`;
}

/**
 * Rows a baseline write holds in memory, bound as the same rows read back would be, each
 * at a line of its own, so no two rows are read as one entry.
 */
export function bindRows(
  rows: readonly Recorded[],
  reason: string,
  symbols: readonly InventorySymbol[],
): Suppressions {
  return bind(
    rows.map((row, at) => ({
      ...row,
      reason,
      site: { path: BASELINE_FILE, line: at + 1, column: 1 },
    })),
    "baseline",
    symbols,
  );
}

/**
 * The rounds of a baseline write: the first reads no row, each later one reads back the
 * rows recorded so far. A round answers the rows it records, in report order, and the rows
 * it reports stale. Each round appends the rows not already held and not removed earlier,
 * and removes the stale ones, and the write ends with the first round that records and
 * removes nothing, so N distinct rows end within 2N + 1 rounds.
 */
export function fixpoint(
  round: (read: readonly Recorded[]) => {
    readonly recorded: readonly Recorded[];
    readonly stale: readonly Recorded[];
  },
): readonly Recorded[] {
  let rows: readonly Recorded[] = [];
  const removed = new Set<string>();
  for (;;) {
    const { recorded, stale } = round(rows);
    const gone = new Set(stale.map(rowKey));
    for (const key of gone) {
      removed.add(key);
    }
    const kept = rows.filter((row) => !gone.has(rowKey(row)));
    const held = new Set(kept.map(rowKey));
    const added = recorded.filter((row) => !removed.has(rowKey(row)) && !held.has(rowKey(row)));
    if (added.length === 0 && gone.size === 0) {
      return kept;
    }
    rows = [...kept, ...added];
  }
}

/**
 * Every row of another scheme than `scheme`, the scheme of the rows a write records, in
 * document order, which the write keeps member for member.
 */
export function otherRows(entries: readonly Entry[], scheme = OWN_SCHEME): readonly Entry[] {
  return entries.filter((entry) => !entry.symbol.startsWith(scheme));
}

/** The scheme name a reference opens with. */
function schemeOf(symbol: string): string {
  const end = symbol.indexOf("://");
  return end < 0 ? symbol : symbol.slice(0, end);
}

/** A surrogate half no other completes, which Go's encoding/json decodes as U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udfff]/gu;

/** One string with every lone surrogate written as U+FFFD. */
function wellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, "\ufffd");
}

/**
 * The pieces of a JSON document with U+2028 and U+2029 escaped, as Go's encoding/json
 * writes them. Neither is JSON syntax, so each stands inside a string.
 */
function* separatorsEscaped(pieces: Iterable<string>): Generator<string, void, undefined> {
  for (const piece of pieces) {
    yield piece.replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  }
}

/** What a written document says about itself, so the same report writes the same bytes. */
const BASELINE_DESCRIPTION =
  "Recorded findings: a run fails only on a finding this document does not hold. " +
  "Every reason is the analyzer that recorded the row, never an adjudication.";

/** One written row, its members in the order an entry writes them. */
interface WrittenRow {
  readonly code: string;
  readonly symbol: string;
  readonly path?: string;
  readonly reason?: string;
}

/**
 * The baseline document: one row per recorded finding, in the order given, each carrying
 * the provenance as its reason, and every row of another scheme the document keeps, the
 * rows ordered by their scheme compared bytewise and in the order given within one. A
 * recorded finding missing a value a row needs, or an identity missing its name or
 * version, is refused rather than written.
 */
export function writeBaseline(
  recorded: readonly Recorded[],
  provenance: Provenance,
  others: readonly Entry[] = [],
): Iterable<string> {
  if (provenance.analyzer === "" || provenance.version === "") {
    throw new Error(
      `a baseline row would carry no reason: the analyzer identity names ${JSON.stringify(provenance.analyzer)} at version ${JSON.stringify(provenance.version)}`,
    );
  }
  const reason = rowReason(provenance);
  const own = recorded.map((found): WrittenRow => {
    if (found.code === "" || found.symbol === "" || found.path === "") {
      throw new Error(
        `a baseline row would carry no reason: a finding names code ${JSON.stringify(found.code)}, symbol ${JSON.stringify(found.symbol)} and path ${JSON.stringify(found.path)}`,
      );
    }
    return { code: found.code, symbol: found.symbol, path: found.path, reason };
  });
  const kept = others.map(({ code, symbol, path, reason: written }): WrittenRow => ({
    code,
    symbol,
    ...(path === undefined ? {} : { path }),
    ...(written === undefined ? {} : { reason: written }),
  }));
  const rows = [...own, ...kept]
    .sort((a, b) => bytewise(schemeOf(a.symbol), schemeOf(b.symbol)))
    .map(({ code, symbol, path, reason: written }): WrittenRow => ({
      code: wellFormed(code),
      symbol: wellFormed(symbol),
      ...(path === undefined ? {} : { path: wellFormed(path) }),
      ...(written === undefined ? {} : { reason: wellFormed(written) }),
    }));
  return separatorsEscaped(jsonChunks({ description: BASELINE_DESCRIPTION, baseline: rows }, 2));
}
