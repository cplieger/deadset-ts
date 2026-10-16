import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { LANGUAGE } from "../src/product.ts";
import { stripped, Writer, type Schema } from "./gen-report.ts";

/**
 * Writes `src/contract/config.generated.ts`: contract/settings.json filtered to what this
 * analyzer reads, the types of the configuration it resolves, and the scope and edges schemas.
 *
 * A row this analyzer's language does not read keeps its key and role alone, so a
 * document naming it is accepted unread. A key written per language holds this
 * language's member alone, and an option is kept where a verb of this analyzer takes it.
 */

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/** The generated module's path, relative to the repository root. */
export const GENERATED_CONFIG = "src/contract/config.generated.ts";

type Reader = (path: string) => string;

interface Row {
  readonly key: string;
  readonly role: "section" | "setting" | "keyed" | "ignored";
  readonly read_by: readonly string[];
  readonly required?: boolean;
  readonly default?: unknown;
  readonly option?: string;
  readonly value?: Schema;
  readonly key_pattern?: string;
  readonly values?: readonly string[];
  readonly per_language?: readonly string[];
}

/** A per-language value schema with its object form narrowed to this language's member. */
function narrowed(row: Row): Schema {
  const alternatives = (row.value?.["oneOf"] ?? []) as readonly Schema[];
  return {
    oneOf: alternatives.map((alternative) => {
      const members = alternative["properties"] as Readonly<Record<string, Schema>> | undefined;
      if (alternative["type"] !== "object" || members?.[LANGUAGE] === undefined) {
        return alternative;
      }
      return {
        type: "object",
        additionalProperties: false,
        required: [LANGUAGE],
        properties: { [LANGUAGE]: members[LANGUAGE] },
      };
    }),
  };
}

/** The row as this analyzer reads it. */
function filtered(row: Row, options: ReadonlySet<string>): Record<string, unknown> {
  if (!row.read_by.includes(LANGUAGE)) {
    return { key: row.key, role: row.role, read: false };
  }
  const value = row.per_language === undefined ? row.value : narrowed(row);
  return {
    key: row.key,
    role: row.role,
    read: true,
    ...(row.required === true ? { required: true } : {}),
    ...(row.default === undefined ? {} : { default: row.default }),
    ...(row.option !== undefined && options.has(row.option) ? { option: row.option } : {}),
    ...(value === undefined ? {} : { value: stripped(value) }),
    ...(row.key_pattern === undefined ? {} : { keyPattern: row.key_pattern }),
    ...(row.role === "keyed" && row.values !== undefined ? { values: row.values } : {}),
    ...(row.per_language === undefined ? {} : { perLanguage: row.per_language }),
  };
}

/** The type of the resolved section at `at`, each member a section or a setting it holds. */
function sectionType(rows: readonly Row[], at: string, writer: Writer, partial: boolean): string {
  const prefix = at === "" ? "" : `${at}.`;
  const members = rows
    .filter((row) => row.key.startsWith(prefix) && !row.key.slice(prefix.length).includes("."))
    .filter((row) => row.read_by.includes(LANGUAGE) && row.role !== "ignored")
    .map((row) => {
      const name = row.key.slice(prefix.length);
      const unset = row.role === "setting" && row.default === undefined;
      const optional = unset && (partial || row.required !== true) ? "?" : "";
      return `readonly ${name}${optional}: ${memberType(rows, row, writer, partial)};`;
    });
  return `{\n${members.join("\n")}\n}`;
}

function memberType(rows: readonly Row[], row: Row, writer: Writer, partial: boolean): string {
  if (row.role === "section") {
    return sectionType(rows, row.key, writer, partial);
  }
  const name = row.key
    .split(/[._]/u)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
  const value = row.per_language === undefined ? (row.value ?? {}) : narrowed(row);
  const type = writer.typeOf("settings", `/${row.key}`, value, name);
  return row.role === "keyed" ? `Readonly<Record<string, ${type}>>` : type;
}

/** Whether a schema, at any depth, has a member named `$ref`; a string value `"$ref"` is not one. */
function holdsReference(node: unknown): boolean {
  if (node === null || typeof node !== "object") {
    return false;
  }
  return Object.hasOwn(node, "$ref") || Object.values(node).some(holdsReference);
}

/**
 * A Contract schema with each reference into another Contract document turned into one to
 * a copy, under the schema's own `$defs`, of the definition it names, so the validator
 * reads the schema as one document.
 */
export function bundled(schema: Schema, read: Reader): Schema {
  const defs: Record<string, unknown> = { ...(schema["$defs"] as Schema | undefined) };
  const copiedFrom = new Map<string, string>();
  const local = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(local);
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    const held = value as Schema;
    const ref = held["$ref"];
    if (typeof ref === "string" && !ref.startsWith("#")) {
      const [file = "", pointer = ""] = ref.split("#");
      const name = /^\/\$defs\/([^/]+)$/u.exec(pointer)?.[1];
      if (name === undefined || (Object.hasOwn(defs, name) && copiedFrom.get(name) !== ref)) {
        throw new Error(`${ref}: not a definition the schema can hold under its own name`);
      }
      if (!copiedFrom.has(name)) {
        const document = JSON.parse(read(`contract/${file}`)) as { $defs?: Schema };
        const definitions = document.$defs ?? {};
        const definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
        // A reference inside the copy would resolve against this schema, not its own document.
        const whole =
          typeof definition === "object" &&
          definition !== null &&
          !Array.isArray(definition) &&
          !holdsReference(definition);
        if (!whole) {
          throw new Error(`${ref}: names no definition the schema can copy whole`);
        }
        defs[name] = definition;
        copiedFrom.set(name, ref);
      }
      return { ...held, $ref: `#/$defs/${name}` };
    }
    return Object.fromEntries(Object.entries(held).map(([key, child]) => [key, local(child)]));
  };
  return { ...(local(schema) as Schema), $defs: defs };
}

/** The generated configuration module's text, formatted as the repository formats every file. */
export async function generatedConfig(read: Reader): Promise<string> {
  const settings = JSON.parse(read("contract/settings.json")) as {
    max_bytes: number;
    keys: readonly Row[];
  };
  const cli = JSON.parse(read("contract/cli.json")) as {
    analyzer_verbs: readonly { options: Readonly<Record<string, readonly string[]>> }[];
  };
  const scope = JSON.parse(read("contract/scope.schema.json")) as Schema;
  const edges = bundled(JSON.parse(read("contract/edges.schema.json")) as Schema, read);
  const options = new Set(cli.analyzer_verbs.flatMap((verb) => verb.options[LANGUAGE] ?? []));
  const writer = new Writer({});
  const resolved = sectionType(settings.keys, "", writer, false);
  const partial = sectionType(settings.keys, "", writer, true);
  const lines = [
    "// Code generated by scripts/gen-config.ts from the Contract copy under fixtures/ (npm run gen). DO NOT EDIT.",
    "",
    'import type { Language } from "./contract.generated.ts";',
    "",
    "/** One key of the closed key list, as this analyzer reads it. */",
    "export interface SettingRow {",
    "  readonly key: string;",
    '  readonly role: "section" | "setting" | "keyed" | "ignored";',
    "  readonly read: boolean;",
    "  readonly required?: true;",
    "  readonly default?: unknown;",
    "  readonly option?: string;",
    "  readonly value?: Readonly<Record<string, unknown>>;",
    "  readonly keyPattern?: string;",
    "  readonly values?: readonly string[];",
    "  readonly perLanguage?: readonly Language[];",
    "}",
    "",
    `export const SETTINGS: readonly SettingRow[] = ${JSON.stringify(settings.keys.map((row) => filtered(row, options)))};`,
    "",
    "/** The bound on a configuration document, in bytes. */",
    `export const CONFIG_MAX_BYTES = ${String(settings.max_bytes)};`,
    "",
    "/** The scope document's schema, as the validator reads it. */",
    `export const SCOPE_SCHEMA = ${JSON.stringify(stripped(scope))};`,
    "",
    "/** The edges document's schema, as the validator reads it. */",
    `export const EDGES_SCHEMA = ${JSON.stringify(stripped(edges))};`,
    "",
    ...writer.declarations.flatMap((declaration) => [declaration, ""]),
    "/** The resolved configuration: every key this analyzer reads, a required one included. */",
    `export interface ResolvedConfig ${resolved}`,
    "",
    "/** A configuration resolved with no setting required of its sources, for a question that asks none. */",
    `export interface PartialConfig ${partial}`,
    "",
  ];
  const path = join(ROOT, GENERATED_CONFIG);
  return format(lines.join("\n"), { ...((await resolveConfig(path)) ?? {}), filepath: path });
}
