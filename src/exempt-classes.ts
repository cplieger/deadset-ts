/**
 * The exemption classes of the Contract's vocabulary, in its order: each class's name,
 * the languages it runs on and the confidence it is recorded at.
 *
 * The rows are written out rather than read from the Contract at run time, for the
 * reason the fixed severity codes are, and a test holds them equal to the Contract
 * release this analyzer implements. A class name is a type, so a detector table or a
 * record naming a class the vocabulary does not hold, or one that runs on another
 * language only, does not compile.
 */

import type { Confidence, Language } from "./config.ts";

/** One class of the vocabulary. */
interface ExemptionClassRow {
  readonly class: string;
  readonly languages: readonly Language[];
  readonly confidence: Confidence;
}

/** Every class of the vocabulary, in the order the Contract lists them. */
export const EXEMPTION_CLASSES = [
  { class: "interface-satisfaction", languages: ["go", "ts"], confidence: "certain" },
  { class: "encoding-reflection", languages: ["go"], confidence: "certain" },
  { class: "format-verb-contract", languages: ["go"], confidence: "certain" },
  { class: "errors-duck-typing", languages: ["go"], confidence: "certain" },
  { class: "enum-group", languages: ["go", "ts"], confidence: "certain" },
  { class: "generated-file", languages: ["go"], confidence: "certain" },
  { class: "linkname-cgo-asm-plugin", languages: ["go"], confidence: "certain" },
  { class: "template-field", languages: ["go", "ts"], confidence: "possible" },
  { class: "reflective-lookup", languages: ["go", "ts"], confidence: "possible" },
  { class: "decorator", languages: ["ts"], confidence: "certain" },
  { class: "injection-container", languages: ["ts"], confidence: "certain" },
  { class: "framework-lifecycle", languages: ["ts"], confidence: "certain" },
  { class: "serialization-contract", languages: ["ts"], confidence: "certain" },
] as const satisfies readonly ExemptionClassRow[];

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

/** The classes that run on TypeScript, in the vocabulary's order. */
export const TS_EXEMPTION_CLASSES: readonly TSExemptionClass[] = EXEMPTION_CLASSES.filter(
  runsOnTS,
).map((row) => row.class);

/** Whether one name is a class of the vocabulary, whichever language it runs on. */
export function isExemptionClass(name: string): name is ExemptionClass {
  return EXEMPTION_CLASSES.some((row) => row.class === name);
}
