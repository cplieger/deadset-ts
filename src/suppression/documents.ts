/**
 * The two file-backed suppression documents at the target root: the ignore file, whose
 * entries a maintainer writes, and the baseline, whose rows an analyzer writes. They share
 * one entry shape, so one strict reader serves both, and a row moves into the ignore file
 * by gaining a maintainer's reason.
 */

import type { Host } from "../host.ts";
import type { InventorySymbol } from "../inventory.ts";
import { readTargetDocument } from "../fs/document.ts";
import { hasRefShape } from "../ref.ts";
import { isRecord, positionAt, readStrict, StrictJSONError } from "../json-document.ts";
import type { Position } from "../position.ts";
import {
  bind,
  CODE_FORM,
  isEntryPath,
  SuppressionError,
  type Entry,
  type Mechanism,
  type Suppressions,
} from "./records.ts";

/** The name and the location the grammar fixes for the ignore file. */
export const IGNORE_FILE = "deadset-ignore.json";

/** The name and the location the grammar fixes for the baseline. */
export const BASELINE_FILE = "deadset-baseline.json";

/** One file-backed document as the reader sees it. */
interface Shape {
  readonly file: string;
  /** The member holding the entries. */
  readonly array: string;
  readonly mechanism: Mechanism;
  readonly documentWant: string;
  readonly entryWant: string;
}

const IGNORE_SHAPE: Shape = {
  file: IGNORE_FILE,
  array: "ignore",
  mechanism: "ignore",
  documentWant: "an object carrying the ignore array, and an optional description",
  entryWant: "an entry naming code, symbol, path and reason, each a string",
};

const BASELINE_SHAPE: Shape = {
  file: BASELINE_FILE,
  array: "baseline",
  mechanism: "baseline",
  documentWant: "an object carrying the baseline array, and an optional description",
  entryWant: "a row naming code, symbol, path and reason, each a string",
};

/** The closed key list of one entry or row. */
const ENTRY_KEYS: ReadonlySet<string> = new Set(["code", "symbol", "path", "reason"]);

const CODE_WANT = "DS followed by four digits";
const SYMBOL_WANT =
  "a stable symbol reference in the shape every document checks, <scheme>://<scope>#<fragment>";
const PATH_WANT = "a path relative to the target root, with the solidus as separator";

/** The document itself, for a defect no entry position describes. */
function documentSite(shape: Shape): Position {
  return { path: shape.file, line: 0, column: 0 };
}

/**
 * One entry or row as written, refusing every defect that ends the run: a value that is
 * no object, a member the grammar does not declare or that holds no string, a missing
 * code or symbol, and a code, a reference or a path outside its form. A reference is held
 * only to the shape every scheme shares; the analyzer of its language holds it to its form.
 */
function entryOf(value: unknown, site: Position, shape: Shape): Entry {
  const refuse = (text: string, want: string): never => {
    throw new SuppressionError(shape.mechanism, site, text, want);
  };
  if (!isRecord(value)) {
    return refuse(JSON.stringify(value), shape.entryWant);
  }
  for (const [key, held] of Object.entries(value)) {
    if (!ENTRY_KEYS.has(key)) {
      refuse(`the member ${JSON.stringify(key)} is not one the grammar declares`, shape.entryWant);
    }
    if (typeof held !== "string") {
      refuse(`the member ${JSON.stringify(key)} holds ${JSON.stringify(held)}`, shape.entryWant);
    }
  }
  const written = value as Readonly<Record<string, string | undefined>>;
  const { code, symbol, path, reason } = {
    code: written["code"],
    symbol: written["symbol"],
    path: written["path"],
    reason: written["reason"],
  };
  if (code === undefined) {
    return refuse("an entry naming no code", shape.entryWant);
  }
  if (symbol === undefined) {
    return refuse("an entry naming no symbol", shape.entryWant);
  }
  if (!CODE_FORM.test(code)) {
    return refuse(JSON.stringify(code), CODE_WANT);
  }
  if (!hasRefShape(symbol)) {
    return refuse(JSON.stringify(symbol), SYMBOL_WANT);
  }
  if (path !== undefined && path !== "" && !isEntryPath(path)) {
    return refuse(JSON.stringify(path), PATH_WANT);
  }
  return {
    code,
    symbol,
    ...(path === undefined ? {} : { path }),
    ...(reason === undefined ? {} : { reason }),
    site,
  };
}

/**
 * The entries of one document's text in document order, each at the brace that opens it.
 * The text is strict JSON: an object holding the array, required and possibly empty, and
 * an optional description the analysis does not read.
 */
function entriesOf(text: string, shape: Shape): readonly Entry[] {
  const malformed = (detail: string, site = documentSite(shape)): never => {
    throw new SuppressionError(shape.mechanism, site, detail, shape.documentWant);
  };
  let document;
  try {
    document = readStrict(text, shape.array);
  } catch (error: unknown) {
    if (!(error instanceof StrictJSONError)) {
      throw error;
    }
    return malformed(error.message, positionAt(text, shape.file, error.offset));
  }
  const parsed = document.value;
  if (!isRecord(parsed)) {
    return malformed(shape.file);
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
  return (held as readonly unknown[]).map((value, index) => {
    const offset = document.starts.get(index);
    const site = offset === undefined ? documentSite(shape) : positionAt(text, shape.file, offset);
    return entryOf(value, site, shape);
  });
}

/** One document at the target root bound against the run's declarations; an absent file is an empty one. */
function readDocument(
  host: Host,
  targetRoot: string,
  symbols: readonly InventorySymbol[],
  shape: Shape,
): Suppressions {
  const text = readTargetDocument(host, targetRoot, shape.file);
  return text === undefined
    ? { records: [], refusals: [] }
    : bind(entriesOf(text, shape), shape.mechanism, symbols);
}

/**
 * The ignore file at the target root, each entry bound to the declaration whose reference
 * and file both equal the ones it names, and never by glob, pattern or substring.
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
 * written.
 */
export function readBaseline(
  host: Host,
  targetRoot: string,
  symbols: readonly InventorySymbol[],
): Suppressions {
  return readDocument(host, targetRoot, symbols, BASELINE_SHAPE);
}

/** The rows a baseline document's text holds, as written, which a baseline write reads. */
export function baselineRows(text: string): readonly Entry[] {
  return entriesOf(text, BASELINE_SHAPE);
}
