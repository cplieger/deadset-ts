import { KIND_ROWS, type KindRow } from "./contract/contract.generated.ts";

/** Every live row of the issue-kind vocabulary, by its code, in ascending code order. */
export const KINDS: ReadonlyMap<string, KindRow> = new Map(
  KIND_ROWS.map((one): [string, KindRow] => [one.code, one]),
);

/**
 * The code of every live issue kind, in ascending order. A severity key names one of
 * them or a family prefix whose range holds one; a key naming a retired code, an
 * unassigned code or a range holding no live kind is an unimplemented key, so every
 * severity a configuration sets is one some analyzer reports under.
 */
export const LIVE_CODES: readonly string[] = KIND_ROWS.map((one) => one.code);

/** The issue-kind codes whose severity the Contract fixes, in ascending order. */
export const FIXED_SEVERITY_CODES: readonly string[] = KIND_ROWS.filter((one) => one.fixed).map(
  (one) => one.code,
);
