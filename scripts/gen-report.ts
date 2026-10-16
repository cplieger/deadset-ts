import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";

/**
 * Writes `src/contract/report.generated.ts`: the report document's types, one interface
 * per object of `contract/report.schema.json` and `contract/finding.schema.json` in the
 * schemas' member order, and the two schemas themselves, stripped of what no check reads,
 * for the validator in `src/report-schema.ts`.
 */

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Reads one document of the pinned Contract copy by its path below `fixtures/`. */
type Reader = (path: string) => string;

/** The generated module's path, relative to the repository root. */
export const GENERATED_REPORT = "src/contract/report.generated.ts";

export type Schema = Readonly<Record<string, unknown>>;

/** The keywords that annotate a schema and that no check reads. */
const ANNOTATIONS = new Set(["description", "title", "$comment", "examples", "default", "$schema"]);

/** The keywords whose object's member names are names, never keywords. */
const NAMING = new Set(["properties", "patternProperties", "$defs"]);

/** A schema with every annotation removed, at every depth. */
export function stripped(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripped);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !ANNOTATIONS.has(key) && !key.startsWith("x-"))
        .map(([key, child]) => [key, NAMING.has(key) ? named(child) : stripped(child)]),
    );
  }
  return value;
}

/** An object of schemas under their names, each name kept and each schema stripped. */
function named(value: unknown): unknown {
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>).map(([name, child]) => [
      name,
      stripped(child),
    ]),
  );
}

/** A member name spelled as a type name: each word capitalised. */
const pascal = (name: string): string =>
  name
    .replace(/^\$/u, "")
    .split(/[_-]/u)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");

/** Names a generated type may not take, because a global of the language holds them. */
const RESERVED = new Set([
  "Symbol",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Map",
  "Set",
  "Error",
]);

export class Writer {
  readonly declarations: string[] = [];
  private readonly named = new Map<string, string>();
  private readonly used = new Set<string>();

  private readonly documents: Readonly<Record<string, Schema>>;

  constructor(documents: Readonly<Record<string, Schema>>) {
    this.documents = documents;
  }

  /** The type of the schema at one location, naming every object it holds. */
  typeOf(doc: string, pointer: string, schema: Schema, name: string, owner = ""): string {
    const ref = schema["$ref"];
    if (typeof ref === "string") {
      return this.refType(doc, ref);
    }
    const values = schema["enum"];
    if (Array.isArray(values)) {
      return values.map((one) => JSON.stringify(one)).join(" | ");
    }
    if (schema["const"] !== undefined) {
      return JSON.stringify(schema["const"]);
    }
    const branches = schema["oneOf"] ?? schema["anyOf"];
    if (Array.isArray(branches) && schema["properties"] === undefined) {
      return (branches as Schema[])
        .map((branch, i) =>
          this.typeOf(
            doc,
            `${pointer}/oneOf/${String(i)}`,
            branch,
            `${name}${String(i + 1)}`,
            owner,
          ),
        )
        .join(" | ");
    }
    switch (schema["type"]) {
      case "string":
        return "string";
      case "integer":
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      case "array":
        return `readonly (${this.typeOf(doc, `${pointer}/items`, schema["items"] as Schema, `${name}Entry`, owner)})[]`;
      case "object":
        return this.object(doc, pointer, schema, name, owner);
      default:
        throw new Error(`${doc}#${pointer}: no type`);
    }
  }

  /** The type a reference names, from the document holding it. */
  private refType(doc: string, ref: string): string {
    const [file, pointer = ""] = ref.split("#");
    const target = file === "" || file === undefined ? doc : file;
    let schema: unknown = this.documents[target];
    for (const token of pointer.split("/").filter((one) => one !== "")) {
      schema = (schema as Schema)[token];
    }
    const last = pointer.split("/").at(-1) ?? "";
    const name = pointer === "" ? pascal(target.replace(".schema.json", "")) : pascal(last);
    return this.typeOf(target, pointer, schema as Schema, name);
  }

  /** The interface an object schema declares, written once under its name. */
  private object(
    doc: string,
    pointer: string,
    schema: Schema,
    wanted: string,
    owner: string,
  ): string {
    const key = `${doc}#${pointer}`;
    const held = this.named.get(key);
    if (held !== undefined) {
      return held;
    }
    const name = this.used.has(wanted) || RESERVED.has(wanted) ? `${owner}${wanted}` : wanted;
    this.used.add(name);
    this.named.set(key, name);
    const properties = (schema["properties"] ?? {}) as Readonly<Record<string, Schema>>;
    const required = new Set((schema["required"] ?? []) as readonly string[]);
    const members = Object.entries(properties).map(([member, child]) => {
      const type = this.typeOf(doc, `${pointer}/properties/${member}`, child, pascal(member), name);
      return `  readonly ${member}${required.has(member) ? "" : "?"}: ${type};`;
    });
    this.declarations.push(
      `/** The object at ${doc}#${pointer}. */\nexport interface ${name} {\n${members.join("\n")}\n}`,
    );
    return name;
  }
}

/** The generated report module's text, formatted as the repository formats every file. */
export async function generatedReport(read: Reader): Promise<string> {
  const documents = {
    "report.schema.json": JSON.parse(read("contract/report.schema.json")) as Schema,
    "finding.schema.json": JSON.parse(read("contract/finding.schema.json")) as Schema,
  };
  const writer = new Writer(documents);
  writer.typeOf("finding.schema.json", "", documents["finding.schema.json"], "Finding");
  writer.typeOf("report.schema.json", "", documents["report.schema.json"], "Report");
  const lines = [
    "// Code generated by scripts/gen-report.ts from the Contract copy under fixtures/ (npm run gen). DO NOT EDIT.",
    "",
    ...writer.declarations.flatMap((declaration) => [declaration, ""]),
    "/** The report and finding schemas, as the validator reads them. */",
    `export const REPORT_SCHEMAS = ${JSON.stringify(stripped(documents))} as const;`,
    "",
  ];
  const path = join(ROOT, GENERATED_REPORT);
  return format(lines.join("\n"), { ...((await resolveConfig(path)) ?? {}), filepath: path });
}
