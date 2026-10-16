import { EXEMPTION_CLASSES, type Language } from "./contract/contract.generated.ts";

/**
 * Whether a class may retain a member declared with the `private` modifier, and one
 * declared with a `#private` name. The modifier is a compile-time constraint only, so
 * such a member stays reachable by its name at run time; a private name cannot be
 * named from outside its class body at all.
 */
export interface TypeScriptVisibility {
  readonly private: boolean;
  readonly privateName: boolean;
}

type Row = (typeof EXEMPTION_CLASSES)[number];

/** The name of a class of the vocabulary. */
export type ExemptionClass = Row["class"];

/** The classes of the rows that list one language. */
type ClassesOf<R, L extends Language> = R extends {
  readonly class: infer C;
  readonly languages: readonly (infer Listed)[];
}
  ? L extends Listed
    ? C
    : never
  : never;

/** The name of a class that runs on TypeScript, the only classes this analyzer records. */
export type TSExemptionClass = ClassesOf<Row, "ts">;

function runsOnTS(row: Row): row is Extract<Row, { readonly class: TSExemptionClass }> {
  const languages: readonly Language[] = row.languages;
  return languages.includes("ts");
}

const TS_ROWS = EXEMPTION_CLASSES.filter(runsOnTS);

/** The classes that run on TypeScript, in the vocabulary's order. */
export const TS_EXEMPTION_CLASSES: readonly TSExemptionClass[] = TS_ROWS.map((row) => row.class);

const VISIBILITY: ReadonlyMap<TSExemptionClass, TypeScriptVisibility> = new Map(
  TS_ROWS.map((row) => [row.class, row.typescriptVisibility]),
);

/** Which private members one class that runs on TypeScript may retain. */
export function typescriptVisibilityOf(exemptionClass: TSExemptionClass): TypeScriptVisibility {
  return VISIBILITY.get(exemptionClass) ?? { private: false, privateName: false };
}
