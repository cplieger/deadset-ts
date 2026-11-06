import { elementAccess } from "../element-access.ts";
import { indexedAccess } from "../indexed-access.ts";
import { keyofComparisons } from "../keyof-comparisons.ts";
import { moduleDeclarations } from "../module-declarations.ts";
import { overrides } from "../overrides.ts";
import { isAnswered } from "../query.ts";
import { iteration } from "../symbol-keys.ts";
import { typeParameterReads } from "../type-parameter-reads.ts";
import { unimplementedCallees } from "../unimplemented-callees.ts";
import type { Read, ReadContext, ReadRule } from "./read-rule.ts";

/** The member kinds a hold of every member names. */
const MEMBER_KINDS: ReadonlySet<string> = new Set([
  "method",
  "class-member",
  "interface-method",
  "type-member",
  "enum-member",
]);

/**
 * Every read rule, each run over every side's walked files with the reference sources:
 * a consumer's read of a target member is a reference as the target's own is.
 */
export const READ_RULES: readonly ReadRule[] = [
  overrides,
  indexedAccess,
  elementAccess,
  keyofComparisons,
  iteration,
  typeParameterReads,
  unimplementedCallees,
  moduleDeclarations,
];

/** The declarations one hold names, with the declaration whose read it is. */
export function heldBy<Brand>(
  read: Extract<Read, { kind: "held" }>,
  { project, held, chains }: ReadContext<Brand>,
): readonly string[] {
  const ids = [...(read.from === "" ? [] : [read.from]), ...(read.ids ?? [])];
  for (const name of read.names ?? []) {
    ids.push(...(held.byName.get(name) ?? []));
  }
  for (const type of read.types ?? []) {
    const properties = project.queries.propertiesOf(type);
    for (const property of isAnswered(properties) ? properties : []) {
      ids.push(...chains.declarationsOf(property));
    }
  }
  if (read.members === true) {
    ids.push(...held.symbols.filter((one) => MEMBER_KINDS.has(one.kind)).map((one) => one.id));
  }
  return ids;
}
