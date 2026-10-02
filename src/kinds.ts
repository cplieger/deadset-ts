import type { Confidence, Severity } from "./config.ts";

/** What a mechanical edit may do with a finding of one kind. */
export type Fixability = "deletable" | "narrowable" | "manual" | "none";

/** One live row of the issue-kind vocabulary, as far as an analyzer reads it. */
export interface KindRow {
  readonly code: string;
  /** The kind's name, which a finding carries as its `kind`. */
  readonly name: string;
  /** The severity a finding carries where no severity key names its code or its family. */
  readonly defaultSeverity: Severity;
  /** The highest confidence a finding of the kind carries. */
  readonly maxClass: Confidence;
  readonly fixability: Fixability;
  /**
   * Whether the Contract fixes the kind on at its default severity, so a severity key
   * naming the code, or a family prefix whose range holds it, is an unimplemented key.
   */
  readonly fixed: boolean;
}

/**
 * Every live row of the issue-kind vocabulary, in ascending code order, written out
 * rather than read at run time, because a product that read the Contract while running
 * would need it installed beside itself. A test compares this table against the
 * Contract release the analyzer is written against.
 */
const ROWS: readonly KindRow[] = [
  row("DS1001", "unused-exported", "deny", "deletable"),
  row("DS1002", "unused-unexported", "deny", "deletable"),
  row("DS1003", "unused-member", "deny", "deletable"),
  row("DS1004", "test-only-use", "deny", "deletable"),
  row("DS1005", "test-of-dead-code", "deny", "deletable"),
  row("DS1006", "deprecated-unused", "deny", "deletable"),
  row("DS1101", "unnecessary-export", "warn", "narrowable"),
  row("DS1102", "unnecessary-exposure", "warn", "narrowable"),
  row("DS1103", "unreachable-export", "deny", "deletable"),
  row("DS1104", "redundant-export-keyword", "warn", "narrowable"),
  row("DS1201", "unused-interface", "deny", "deletable"),
  row("DS1203", "uncalled-interface-method", "warn", "manual"),
  row("DS1204", "unused-satisfaction-assertion", "deny", "deletable"),
  row("DS1301", "write-only-symbol", "deny", "deletable"),
  row("DS1302", "unused-enum-member", "deny", "deletable"),
  row("DS1303", "unused-type-parameter", "deny", "deletable"),
  row("DS1501", "file-never-built", "deny", "deletable"),
  row("DS1502", "file-never-imported", "deny", "deletable"),
  row("DS1601", "unused-dependency", "deny", "manual"),
  row("DS1605", "unused-module-directive", "warn", "deletable"),
  row("DS1701", "suppression-without-reason", "deny", "none"),
  row("DS1702", "unscoped-ignore-entry", "deny", "none"),
  { ...row("DS1703", "stale-suppression", "deny", "none"), fixed: true },
  { ...row("DS1704", "unmatched-root", "deny", "none"), fixed: true },
  row("DS1705", "stale-cross-language-edge", "deny", "none"),
  row("DS1801", "unused-parameter", "warn", "manual"),
  row("DS1802", "unused-receiver", "warn", "deletable"),
  row("DS1803", "unused-result", "warn", "manual"),
  row("DS1805", "unreachable-statement", "deny", "deletable"),
  row("DS1807", "dead-store", "deny", "deletable"),
  row("DS1809", "unreachable-case", "deny", "deletable"),
];

/** A row at the `certain` ceiling whose severity a configuration may set. */
function row(
  code: string,
  name: string,
  defaultSeverity: Severity,
  fixability: Fixability,
): KindRow {
  return { code, name, defaultSeverity, maxClass: "certain", fixability, fixed: false };
}

/** Every live row of the issue-kind vocabulary, by its code, in ascending code order. */
export const KINDS: ReadonlyMap<string, KindRow> = new Map(ROWS.map((one) => [one.code, one]));

/**
 * The code of every live issue kind, in ascending order. A severity key names one of
 * them or a family prefix whose range holds one; a key naming a retired code, an
 * unassigned code or a range holding no live kind is an unimplemented key, so every
 * severity a configuration sets is one some analyzer reports under.
 */
export const LIVE_CODES: readonly string[] = ROWS.map((one) => one.code);

/** The issue-kind codes whose severity the Contract fixes, in ascending order. */
export const FIXED_SEVERITY_CODES: readonly string[] = ROWS.filter((one) => one.fixed).map(
  (one) => one.code,
);
