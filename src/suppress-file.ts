/**
 * The two file-backed suppression documents at the target root: the ignore file, whose
 * entries a maintainer writes, and the baseline, whose rows an analyzer writes. They share
 * one record shape, so one decoder and one matcher serve both, and a row moves into the
 * ignore file by gaining a maintainer's reason.
 */

import type { Host } from "./host.ts";
import type { InventorySymbol } from "./inventory.ts";
import { joinPath } from "./paths.ts";
import { positionAt, walkDocument } from "./json-document.ts";
import type { Position } from "./position.ts";
import {
  CODE_FORM,
  SUPPRESSION_WITHOUT_REASON,
  SuppressionError,
  UNSCOPED_ENTRY,
  blankReason,
  isEntryPath,
  isSymbolRef,
  siteText,
  type Mechanism,
  type Refusal,
  type SuppressionRecord,
  type Suppressions,
} from "./suppress.ts";

/** The name and the location the grammar fixes for the ignore file. */
export const IGNORE_FILE = "deadset-ignore.json";

/** The name and the location the grammar fixes for the baseline. */
export const BASELINE_FILE = "deadset-baseline.json";

/** One file-backed document as a reader sees it. */
interface Shape {
  readonly file: string;
  /** The member holding the records. */
  readonly array: string;
  readonly mechanism: Mechanism;
  readonly documentWant: string;
  readonly recordWant: string;
}

const IGNORE_SHAPE: Shape = {
  file: IGNORE_FILE,
  array: "ignore",
  mechanism: "ignore",
  documentWant: "an object carrying the ignore array, and an optional description",
  recordWant: "an entry naming code, symbol, path and reason, each a string",
};

const BASELINE_SHAPE: Shape = {
  file: BASELINE_FILE,
  array: "baseline",
  mechanism: "baseline",
  documentWant: "an object carrying the baseline array, and an optional description",
  recordWant: "a row naming code, symbol, path and reason, each a string",
};

/** The closed key list of one entry or row. */
const RECORD_KEYS: ReadonlySet<string> = new Set(["code", "symbol", "path", "reason"]);

const CODE_WANT = "DS followed by four digits";
const SYMBOL_WANT =
  "a stable symbol reference, go://<import-path>#<fragment> or ts://<package>/<source-path>#<fragment>";
const PATH_WANT = "a path relative to the target root, with the solidus as separator";

/** The document itself, for a defect no record position describes. */
function documentSite(shape: Shape): Position {
  return { path: shape.file, line: 0, column: 0 };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What one entry or row resolves to. */
interface Read {
  readonly records: readonly SuppressionRecord[];
  readonly refusals: readonly Refusal[];
}

/** The declarations of the run by reference and file, which is what an entry names. */
type ByReference = ReadonlyMap<string, readonly InventorySymbol[]>;

function referenceKey(ref: string, path: string): string {
  return `${ref}\u0000${path}`;
}

/**
 * Reads one entry or row: the records it binds, the refusals it carries, or the
 * malformed value that ends the run.
 */
function readRecord(value: unknown, site: Position, byReference: ByReference, shape: Shape): Read {
  const refuse = (text: string, want: string): never => {
    throw new SuppressionError(shape.mechanism, `${shape.file} ${siteText(site)}`, text, want);
  };
  if (!isObject(value)) {
    return refuse(JSON.stringify(value), shape.recordWant);
  }
  for (const [key, held] of Object.entries(value)) {
    if (!RECORD_KEYS.has(key)) {
      refuse(`the member ${JSON.stringify(key)} is not one the grammar declares`, shape.recordWant);
    }
    if (typeof held !== "string") {
      refuse(`the member ${JSON.stringify(key)} holds ${JSON.stringify(held)}`, shape.recordWant);
    }
  }
  const entry = value as Readonly<Record<string, string | undefined>>;
  const { code, symbol, path, reason } = {
    code: entry["code"],
    symbol: entry["symbol"],
    path: entry["path"],
    reason: entry["reason"],
  };
  if (code === undefined) {
    return refuse("a record naming no code", shape.recordWant);
  }
  if (symbol === undefined) {
    return refuse("a record naming no symbol", shape.recordWant);
  }
  if (!CODE_FORM.test(code)) {
    return refuse(JSON.stringify(code), CODE_WANT);
  }
  if (!isSymbolRef(symbol)) {
    return refuse(JSON.stringify(symbol), SYMBOL_WANT);
  }
  if (path !== undefined && path !== "" && !isEntryPath(path)) {
    return refuse(JSON.stringify(path), PATH_WANT);
  }

  const written = {
    code,
    symbol,
    path: path ?? "",
    reason: reason ?? "",
    site,
    mechanism: shape.mechanism,
  };
  const refusals: Refusal[] = [];
  if (blankReason(reason)) {
    refusals.push({ ...written, reported: SUPPRESSION_WITHOUT_REASON });
  }
  if (written.path === "") {
    refusals.push({ ...written, reported: UNSCOPED_ENTRY });
  }
  if (refusals.length > 0) {
    return { records: [], refusals };
  }
  const named = byReference.get(referenceKey(symbol, written.path)) ?? [];
  if (named.length === 0) {
    return { records: [{ ...written, bound: "" }], refusals: [] };
  }
  return { records: named.map((one) => ({ ...written, bound: one.id })), refusals: [] };
}

/** Reads one document at the target root, binding each record against the run's declarations. */
function readDocument(
  host: Host,
  targetRoot: string,
  symbols: readonly InventorySymbol[],
  shape: Shape,
): Suppressions {
  const file = joinPath(targetRoot, shape.file);
  if (host.kindOf(file) === "absent") {
    return { records: [], refusals: [] };
  }
  const text = host.readFile(file);
  const malformed = (detail: string, site = documentSite(shape)): never => {
    throw new SuppressionError(shape.mechanism, siteText(site), detail, shape.documentWant);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    return malformed(`${shape.file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(parsed)) {
    return malformed(shape.file);
  }
  const walk = walkDocument(text, shape.array);
  if (walk.twice !== undefined) {
    malformed(
      `the member ${JSON.stringify(walk.twice.name)} is written twice, so neither value is chosen`,
      positionAt(text, shape.file, walk.twice.offset),
    );
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "description" && key !== shape.array) {
      malformed(`the member ${JSON.stringify(key)} is not one the grammar declares`);
    }
  }
  const description = parsed["description"];
  const held = parsed[shape.array];
  if ((description !== undefined && typeof description !== "string") || !Array.isArray(held)) {
    return malformed(shape.file);
  }

  const byReference = new Map<string, InventorySymbol[]>();
  for (const symbol of symbols) {
    const key = referenceKey(symbol.ref, symbol.position.path);
    byReference.set(key, [...(byReference.get(key) ?? []), symbol]);
  }
  const records: SuppressionRecord[] = [];
  const refusals: Refusal[] = [];
  (held as readonly unknown[]).forEach((value, index) => {
    const offset = walk.opened[index];
    const site = offset === undefined ? documentSite(shape) : positionAt(text, shape.file, offset);
    const read = readRecord(value, site, byReference, shape);
    records.push(...read.records);
    refusals.push(...read.refusals);
  });
  return { records, refusals };
}

/**
 * The ignore file at the target root, each entry bound to the declaration whose reference
 * and file both equal the ones it names, and never by glob, pattern or substring. An
 * absent file is an empty one.
 */
export function readIgnoreFile(
  host: Host,
  targetRoot: string,
  symbols: readonly InventorySymbol[],
): Suppressions {
  return readDocument(host, targetRoot, symbols, IGNORE_SHAPE);
}

/**
 * The baseline at the target root, each row matched exactly as an ignore entry is. A row's
 * reason is the provenance an analyzer wrote, never a maintainer's judgement: the finding
 * it records is real, and the row says only that it was there when the baseline was
 * written. An absent file is an empty one.
 */
export function readBaseline(
  host: Host,
  targetRoot: string,
  symbols: readonly InventorySymbol[],
): Suppressions {
  return readDocument(host, targetRoot, symbols, BASELINE_SHAPE);
}

/** One finding a written row records: what a later run matches the row on. */
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

/** What a written document says about itself, so the same report writes the same bytes. */
const BASELINE_DESCRIPTION =
  "Recorded findings: a run fails only on a finding this document does not hold. " +
  "Every reason is the analyzer that recorded the row, never an adjudication.";

/**
 * A baseline holding one row per finding, in the order given, which is the report's. Every
 * row carries the provenance as its reason. A finding missing a value a row needs, and an
 * identity missing its name or version, are refused rather than written, because the
 * grammar requires a reason on every row.
 */
export function writeBaseline(findings: readonly Recorded[], provenance: Provenance): string {
  if (provenance.analyzer === "" || provenance.version === "") {
    throw new Error(
      `a baseline row would carry no reason: the analyzer identity names ${JSON.stringify(provenance.analyzer)} at version ${JSON.stringify(provenance.version)}`,
    );
  }
  const reason = `recorded by ${provenance.analyzer} ${provenance.version}`;
  const baseline = findings.map((found) => {
    if (found.code === "" || found.symbol === "" || found.path === "") {
      throw new Error(
        `a baseline row would carry no reason: a finding names code ${JSON.stringify(found.code)}, symbol ${JSON.stringify(found.symbol)} and path ${JSON.stringify(found.path)}`,
      );
    }
    return { code: found.code, symbol: found.symbol, path: found.path, reason };
  });
  return `${JSON.stringify({ description: BASELINE_DESCRIPTION, baseline }, null, 2)}\n`;
}
