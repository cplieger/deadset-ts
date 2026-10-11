/**
 * The exemption classes of the Contract's vocabulary, in its order: each class's name, its
 * languages and, for a TypeScript class, which private members it may retain. The rows are
 * written out, as the fixed severity codes are, and a test holds them equal to the Contract.
 * A class name is a type, so a table or a record naming a class outside the vocabulary, or
 * one of another language only, does not compile.
 */

import type { Language } from "./config.ts";

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

/** One class of the vocabulary. */
interface ExemptionClassRow {
  readonly class: string;
  readonly languages: readonly Language[];
  /** Present exactly on a class that runs on TypeScript. */
  readonly typescriptVisibility?: TypeScriptVisibility;
}

/** Every class of the vocabulary, in the order the Contract lists them. */
export const EXEMPTION_CLASSES = [
  {
    class: "interface-satisfaction",
    languages: ["go", "ts"],
    typescriptVisibility: { private: false, privateName: false },
  },
  { class: "encoding-reflection", languages: ["go"] },
  { class: "format-verb-contract", languages: ["go"] },
  { class: "errors-duck-typing", languages: ["go"] },
  {
    class: "enum-group",
    languages: ["go", "ts"],
    typescriptVisibility: { private: false, privateName: false },
  },
  {
    class: "generated-file",
    languages: ["go", "ts"],
    typescriptVisibility: { private: true, privateName: false },
  },
  { class: "linkname-cgo-asm-plugin", languages: ["go"] },
  {
    class: "template-field",
    languages: ["go", "ts"],
    typescriptVisibility: { private: true, privateName: false },
  },
  {
    class: "reflective-lookup",
    languages: ["go", "ts"],
    typescriptVisibility: { private: true, privateName: false },
  },
  {
    class: "decorator",
    languages: ["ts"],
    typescriptVisibility: { private: true, privateName: false },
  },
  {
    class: "injection-container",
    languages: ["ts"],
    typescriptVisibility: { private: true, privateName: false },
  },
  {
    class: "framework-lifecycle",
    languages: ["ts"],
    typescriptVisibility: { private: true, privateName: false },
  },
  {
    class: "serialization-contract",
    languages: ["ts"],
    typescriptVisibility: { private: true, privateName: false },
  },
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

/** Whether one name is a class of the vocabulary, whichever language it runs on. */
export function isExemptionClass(name: string): name is ExemptionClass {
  return EXEMPTION_CLASSES.some((row) => row.class === name);
}
