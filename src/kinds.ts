import { KIND_ROWS, type KindRow } from "./contract/contract.generated.ts";

/** Every live row of the issue-kind vocabulary, by its code, in ascending code order. */
export const KINDS: ReadonlyMap<string, KindRow> = new Map(
  KIND_ROWS.map((one): [string, KindRow] => [one.code, one]),
);

/** The issue-kind codes whose severity the Contract fixes, in ascending order. */
export const FIXED_SEVERITY_CODES: readonly string[] = KIND_ROWS.filter((one) => one.fixed).map(
  (one) => one.code,
);
