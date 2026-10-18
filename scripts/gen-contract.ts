import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { GENERATED_CONFIG, generatedConfig } from "./gen-config.ts";
import { GENERATED_REPORT, generatedReport } from "./gen-report.ts";

/**
 * Writes `src/contract/contract.generated.ts`, the Contract's closed vocabularies as
 * TypeScript values, from the copy of the Contract release `corpus.lock.json` pins
 * under `fixtures/`. The analyzer compiles the module in rather than reading the
 * documents at run time. Run it with `npm run gen`; a test regenerates the module in
 * memory and fails when the committed one differs.
 */

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/** The generated module's path, relative to the repository root. */
export const GENERATED = "src/contract/contract.generated.ts";

/** Reads one document of the pinned copy by its path below `fixtures/`. */
type Reader = (path: string) => string;

interface KindsDocument {
  readonly prefix: string;
  readonly severities: readonly string[];
  readonly reachability_classes: readonly string[];
  readonly fixabilities: readonly string[];
  readonly subjects: readonly string[];
  readonly symbol_kinds: Readonly<Record<string, string>>;
  readonly ranges: readonly {
    readonly start: string;
    readonly end: string;
    readonly family: string;
    readonly title: string;
    readonly status: string;
  }[];
  readonly kinds: readonly Readonly<Record<string, unknown>>[];
}

/** The members of a kinds.json row the module carries, by the name it carries each under. */
const KIND_MEMBERS: readonly (readonly [string, string])[] = [
  ["code", "code"],
  ["name", "name"],
  ["languages", "languages"],
  ["subject", "subject"],
  ["holds_live", "holdsLive"],
  ["rule", "rule"],
  ["precondition", "precondition"],
  ["details", "details"],
  ["default_enabled", "defaultEnabled"],
  ["default_severity", "defaultSeverity"],
  ["max_class", "maxClass"],
  ["fixability", "fixability"],
  ["finding_fixabilities", "findingFixabilities"],
  ["overlap", "overlap"],
  ["derived_from", "derivedFrom"],
  ["fixed", "fixed"],
];

function picked(
  row: Readonly<Record<string, unknown>>,
  members: readonly (readonly [string, string])[],
): Record<string, unknown> {
  const held: Record<string, unknown> = {};
  for (const [from, to] of members) {
    if (row[from] !== undefined) {
      held[to] = row[from];
    }
  }
  return held;
}

/** A vocabulary name spelled as a TypeScript property: each hyphenated word after the first capitalised. */
const camel = (name: string): string =>
  name.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());

/** The key naming one range's family: the part its first and last code share. */
function familyKey(range: { readonly start: string; readonly end: string }): string {
  let length = 0;
  while (length < range.start.length && range.start[length] === range.end[length]) {
    length++;
  }
  return range.start.slice(0, length);
}

const union = (values: readonly string[]): string =>
  values.map((value) => JSON.stringify(value)).join(" | ");

/** The generated module's text, formatted as the repository formats every file. */
export async function generated(read: Reader): Promise<string> {
  const doc = (path: string): unknown => JSON.parse(read(path));
  const kinds = doc("contract/kinds.json") as KindsDocument;
  const contract = doc("contract/contract.json") as {
    contract_version: string;
    schema_versions: readonly string[];
  };
  const corpus = doc("corpus-document/corpus.json") as { corpus_version: string };
  const exemptions = doc("contract/exemptions.json") as {
    exemptions: readonly Readonly<Record<string, unknown>>[];
  };
  const exits = doc("contract/exit-codes.json") as {
    exit_codes: readonly { code: number; name: string }[];
    failure_classes: Readonly<
      Record<string, { prefix: string; classes: readonly { class: string }[] }>
    >;
  };
  const confidence = doc("contract/confidence.json") as {
    evidence: readonly Readonly<Record<string, unknown>>[];
  };
  const config = doc("contract/config.schema.json") as {
    properties: {
      reporters: { properties: { formats: { items: { enum: readonly string[] } } } };
    };
  };
  const languages = doc("contract/languages.json") as {
    languages: readonly {
      language: string;
      analyzer?: string;
      markers: readonly string[];
      skipped_directories: readonly string[];
    }[];
  };
  const formats = config.properties.reporters.properties.formats.items.enum;
  const languageIds = languages.languages.map((row) => row.language);
  const familyKeyLengths = new Set(kinds.ranges.map((range) => familyKey(range).length));
  if (familyKeyLengths.size !== 1) {
    throw new Error("contract/kinds.json: the ranges' family keys differ in length");
  }
  const [familyKeyLength] = familyKeyLengths;
  const lines = [
    "// Code generated by scripts/gen-contract.ts from the Contract copy under fixtures/ (npm run gen). DO NOT EDIT.",
    "",
    `export const CONTRACT_VERSION = ${JSON.stringify(contract.contract_version)};`,
    `export const SCHEMA_VERSIONS = ${JSON.stringify(contract.schema_versions)} as const;`,
    `export const SCHEMA_VERSION = ${JSON.stringify(contract.schema_versions.at(-1))};`,
    `export const CORPUS_VERSION = ${JSON.stringify(corpus.corpus_version)};`,
    `export const CODE_PREFIX = ${JSON.stringify(kinds.prefix)};`,
    `export const FAMILY_KEY_LENGTH = ${String(familyKeyLength)};`,
    "",
    `export type Language = ${union(languageIds)};`,
    `export type Severity = ${union(kinds.severities)};`,
    `export type Confidence = ${union(kinds.reachability_classes)};`,
    `export type Fixability = ${union(kinds.fixabilities)};`,
    `export type Subject = ${union(kinds.subjects)};`,
    `export type Format = ${union(formats)};`,
    `export const LANGUAGES = ${JSON.stringify(languageIds)} as const satisfies readonly Language[];`,
    `export const SEVERITIES = ${JSON.stringify(kinds.severities)} as const satisfies readonly Severity[];`,
    `export const CONFIDENCES = ${JSON.stringify(kinds.reachability_classes)} as const satisfies readonly Confidence[];`,
    `export const FORMATS = ${JSON.stringify(formats)} as const satisfies readonly Format[];`,
    "",
    "/** Each analyzed language's row: its analyzer, the names that mark it and the directories it skips. */",
    `export const LANGUAGE_ROWS = ${JSON.stringify(
      Object.fromEntries(
        languages.languages.flatMap((row) =>
          row.analyzer === undefined
            ? []
            : [
                [
                  row.language,
                  {
                    analyzer: row.analyzer,
                    markers: row.markers,
                    skippedDirectories: row.skipped_directories,
                  },
                ],
              ],
        ),
      ),
    )} as const satisfies Readonly<
      Partial<
        Record<
          Language,
          {
            readonly analyzer: string;
            readonly markers: readonly string[];
            readonly skippedDirectories: readonly string[];
          }
        >
      >
    >;`,
    "",
    ...exits.exit_codes.map(
      (exit) => `export const EXIT_${exit.name.toUpperCase()} = ${String(exit.code)};`,
    ),
    "",
    "export interface KindRow {",
    "  readonly code: string;",
    "  readonly name: string;",
    "  readonly languages: readonly Language[];",
    "  readonly subject: Subject;",
    "  readonly holdsLive: boolean;",
    "  readonly rule: string;",
    "  readonly precondition?: string;",
    '  readonly details?: Readonly<Record<string, "required" | "optional" | readonly Language[]>>;',
    "  readonly defaultEnabled: boolean;",
    "  readonly defaultSeverity: Severity;",
    "  readonly maxClass: Confidence;",
    "  readonly fixability: Fixability;",
    "  readonly findingFixabilities?: readonly Fixability[];",
    "  readonly overlap?: Readonly<Partial<Record<Language, readonly string[]>>>;",
    "  readonly derivedFrom?: readonly string[];",
    "  readonly fixed: boolean;",
    "}",
    "",
    `export const KIND_ROWS = ${JSON.stringify(kinds.kinds.map((row) => picked(row, KIND_MEMBERS)))} as const satisfies readonly KindRow[];`,
    "",
    'export type Code = (typeof KIND_ROWS)[number]["code"];',
    "",
    `export const CODE = ${JSON.stringify(
      Object.fromEntries(kinds.kinds.map((row) => [camel(String(row["name"])), row["code"]])),
    )} as const satisfies Readonly<Record<string, Code>>;`,
    "",
    `export const FAMILIES = ${JSON.stringify(
      kinds.ranges.map((range) => ({
        key: familyKey(range),
        name: range.family,
        title: range.title,
        status: range.status,
      })),
    )} as const;`,
    "",
    `export const SYMBOL_SUBJECTS = ${JSON.stringify(kinds.symbol_kinds)} as const satisfies Readonly<Record<string, Subject>>;`,
    "",
    `export const EXEMPTION_CLASSES = ${JSON.stringify(
      exemptions.exemptions.map((row) =>
        picked(row, [
          ["class", "class"],
          ["languages", "languages"],
          ["confidence", "confidence"],
          ["retains_kinds", "retainsKinds"],
          ["typescript_visibility", "typescriptVisibility"],
        ]),
      ),
    ).replaceAll('"private_name"', '"privateName"')} as const;`,
    "",
    `export const EVIDENCE = ${JSON.stringify(
      confidence.evidence.map((row) =>
        picked(row, [
          ["evidence", "evidence"],
          ["rule", "rule"],
          ["class", "class"],
          ["languages", "languages"],
          ["codes", "codes"],
        ]),
      ),
    )} as const;`,
    "",
    "/** Each group of failure classes, and the text opening the line that names one of its failures. */",
    `export const FAILURE_PREFIXES = ${JSON.stringify(Object.fromEntries(Object.entries(exits.failure_classes).map(([group, row]) => [group, row.prefix])))} as const;`,
    "",
    "/** Each failure class the Contract names, and its group. */",
    `export const FAILURE_CLASSES = ${JSON.stringify(Object.fromEntries(Object.entries(exits.failure_classes).flatMap(([group, row]) => row.classes.map((one) => [one.class, group]))))} as const;`,
    "",
  ];
  const path = join(ROOT, GENERATED);
  return format(lines.join("\n"), { ...((await resolveConfig(path)) ?? {}), filepath: path });
}

/** Reads the pinned copy under the repository's `fixtures/`. */
export const fixturesReader: Reader = (path) => readFileSync(join(ROOT, "fixtures", path), "utf8");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(join(ROOT, GENERATED), await generated(fixturesReader));
  writeFileSync(join(ROOT, GENERATED_REPORT), await generatedReport(fixturesReader));
  writeFileSync(join(ROOT, GENERATED_CONFIG), await generatedConfig(fixturesReader));
}
