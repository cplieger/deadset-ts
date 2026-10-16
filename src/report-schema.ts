/**
 * Holds a report to `contract/report.schema.json` and `contract/finding.schema.json`
 * before it is written, reading the schemas the generator copies from the Contract, so
 * this analyzer never writes a document a reader refuses. It evaluates the keywords the
 * Contract's schemas use; the schemas' patterns are written to match alike in RE2 and in
 * ECMAScript.
 */

import { REPORT_SCHEMAS, type Report } from "./contract/report.generated.ts";
import { bytewise } from "./text/compare.ts";
import { isRecord } from "./json-document.ts";

/** One value a schema refuses: its JSON Pointer, the keyword, and why. */
interface SchemaRefusal {
  readonly pointer: string;
  readonly keyword: string;
  readonly reason: string;
}

type Schema = Readonly<Record<string, unknown>>;
type Documents = Readonly<Record<string, Schema>>;

/**
 * Every keyword the validator evaluates or knows to carry no assertion. A schema naming
 * another fails every check rather than passing values the keyword would refuse.
 */
const KEYWORDS: ReadonlySet<string> = new Set([
  ...["$schema", "$id", "$comment", "$defs", "title", "description", "default", "examples"],
  ...["$ref", "type", "enum", "const", "pattern", "minLength", "minimum", "maximum"],
  ...["properties", "additionalProperties", "required", "minProperties"],
  ...["items", "minItems", "maxItems", "uniqueItems"],
  ...["allOf", "anyOf", "oneOf", "not", "if", "then", "else"],
]);

const patterns = new Map<string, RegExp>();

function pattern(source: string): RegExp {
  let held = patterns.get(source);
  if (held === undefined) {
    held = new RegExp(source, "u");
    patterns.set(source, held);
  }
  return held;
}

function typeOf(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

function hasType(value: unknown, name: string): boolean {
  const held = typeOf(value);
  return held === name || (name === "number" && held === "integer");
}

/** One value's encoding with object members sorted, so two equal values encode alike. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort(bytewise)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** A string's length in code points, which JSON Schema's minLength counts. */
function codePoints(value: string): number {
  let counted = 0;
  for (const _point of value) {
    counted += 1;
  }
  return counted;
}

const escape = (name: string): string => name.replaceAll("~", "~0").replaceAll("/", "~1");

/** A schema evaluated in the document it is read from, so a relative `$ref` resolves there. */
class Checker {
  private readonly documents: Documents;

  constructor(documents: Documents) {
    this.documents = documents;
  }

  resolve(doc: string, ref: string): readonly [string, Schema] {
    const [file = "", pointer = ""] = ref.split("#");
    const target = file === "" ? doc : file;
    let schema: unknown = this.documents[target];
    for (const token of pointer.split("/").filter((one) => one !== "")) {
      schema = isRecord(schema)
        ? schema[token.replaceAll("~1", "/").replaceAll("~0", "~")]
        : undefined;
    }
    if (!isRecord(schema)) {
      throw new Error(`report schema: ${ref} names no schema`);
    }
    return [target, schema];
  }

  matches(doc: string, schema: Schema, value: unknown, at: string): boolean {
    const found: SchemaRefusal[] = [];
    this.check(doc, schema, value, at, found);
    return found.length === 0;
  }

  check(doc: string, schema: Schema, value: unknown, at: string, found: SchemaRefusal[]): void {
    for (const keyword of Object.keys(schema)) {
      if (!KEYWORDS.has(keyword) && !keyword.startsWith("x-")) {
        throw new Error(
          `report schema: the keyword ${keyword} is not one this validator evaluates`,
        );
      }
    }
    const refuse = (keyword: string, reason: string, pointer = at): void => {
      found.push({ pointer, keyword, reason });
    };
    if (typeof schema["$ref"] === "string") {
      const [target, referenced] = this.resolve(doc, schema["$ref"]);
      this.check(target, referenced, value, at, found);
    }
    const types = schema["type"];
    const named = types === undefined ? [] : Array.isArray(types) ? types : [types];
    if (named.length > 0 && !named.some((one) => hasType(value, String(one)))) {
      refuse("type", `the value is ${typeOf(value)}, want ${named.join(", ")}`);
      return;
    }
    this.checkValue(schema, value, refuse);
    if (Array.isArray(value)) {
      this.checkArray(doc, schema, value, at, found, refuse);
    } else if (isRecord(value)) {
      this.checkObject(doc, schema, value, at, found, refuse);
    }
    this.checkApplicators(doc, schema, value, at, found, refuse);
  }

  private checkValue(
    schema: Schema,
    value: unknown,
    refuse: (keyword: string, reason: string) => void,
  ): void {
    const values = schema["enum"];
    if (Array.isArray(values) && !values.some((one) => canonical(one) === canonical(value))) {
      refuse("enum", `${canonical(value)} is not one of the values the schema lists`);
    }
    if (schema["const"] !== undefined && canonical(schema["const"]) !== canonical(value)) {
      refuse("const", `${canonical(value)} is not ${canonical(schema["const"])}`);
    }
    if (typeof value === "string") {
      if (typeof schema["pattern"] === "string" && !pattern(schema["pattern"]).test(value)) {
        refuse("pattern", `${JSON.stringify(value)} does not match ${schema["pattern"]}`);
      }
      if (typeof schema["minLength"] === "number" && codePoints(value) < schema["minLength"]) {
        refuse(
          "minLength",
          `${JSON.stringify(value)} is shorter than ${String(schema["minLength"])} characters`,
        );
      }
    }
    if (typeof value === "number") {
      if (typeof schema["minimum"] === "number" && value < schema["minimum"]) {
        refuse("minimum", `${String(value)} is below ${String(schema["minimum"])}`);
      }
      if (typeof schema["maximum"] === "number" && value > schema["maximum"]) {
        refuse("maximum", `${String(value)} is above ${String(schema["maximum"])}`);
      }
    }
  }

  private checkObject(
    doc: string,
    schema: Schema,
    value: Readonly<Record<string, unknown>>,
    at: string,
    found: SchemaRefusal[],
    refuse: (keyword: string, reason: string) => void,
  ): void {
    const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
    const additional = schema["additionalProperties"];
    for (const name of Object.keys(value).sort(bytewise)) {
      const member = `${at}/${escape(name)}`;
      const declared = properties[name];
      if (isRecord(declared)) {
        this.check(doc, declared, value[name], member, found);
      } else if (additional === false) {
        refuse(
          "additionalProperties",
          `the member ${JSON.stringify(name)} is not one the schema declares`,
        );
      } else if (isRecord(additional)) {
        this.check(doc, additional, value[name], member, found);
      }
    }
    for (const name of Array.isArray(schema["required"]) ? (schema["required"] as string[]) : []) {
      if (!Object.hasOwn(value, name)) {
        refuse("required", `the member ${JSON.stringify(name)} is absent`);
      }
    }
    const fewest = schema["minProperties"];
    if (typeof fewest === "number" && Object.keys(value).length < fewest) {
      refuse(
        "minProperties",
        `the object holds ${String(Object.keys(value).length)} members, fewer than ${String(fewest)}`,
      );
    }
  }

  private checkArray(
    doc: string,
    schema: Schema,
    value: readonly unknown[],
    at: string,
    found: SchemaRefusal[],
    refuse: (keyword: string, reason: string) => void,
  ): void {
    const items = schema["items"];
    if (isRecord(items)) {
      value.forEach((item, i) => {
        this.check(doc, items, item, `${at}/${String(i)}`, found);
      });
    }
    if (typeof schema["minItems"] === "number" && value.length < schema["minItems"]) {
      refuse(
        "minItems",
        `the array holds ${String(value.length)} items, fewer than ${String(schema["minItems"])}`,
      );
    }
    if (typeof schema["maxItems"] === "number" && value.length > schema["maxItems"]) {
      refuse(
        "maxItems",
        `the array holds ${String(value.length)} items, more than ${String(schema["maxItems"])}`,
      );
    }
    if (schema["uniqueItems"] === true && new Set(value.map(canonical)).size !== value.length) {
      refuse("uniqueItems", "the array lists one value twice");
    }
  }

  private checkApplicators(
    doc: string,
    schema: Schema,
    value: unknown,
    at: string,
    found: SchemaRefusal[],
    refuse: (keyword: string, reason: string) => void,
  ): void {
    const list = (keyword: string): readonly Schema[] =>
      Array.isArray(schema[keyword]) ? (schema[keyword] as Schema[]) : [];
    for (const each of list("allOf")) {
      this.check(doc, each, value, at, found);
    }
    const matching = (keyword: string): number =>
      list(keyword).filter((each) => this.matches(doc, each, value, at)).length;
    if (schema["anyOf"] !== undefined && matching("anyOf") === 0) {
      refuse("anyOf", "the value matches none of the alternatives");
    }
    if (schema["oneOf"] !== undefined && matching("oneOf") !== 1) {
      refuse(
        "oneOf",
        `the value matches ${String(matching("oneOf"))} of the alternatives, want exactly one`,
      );
    }
    if (isRecord(schema["not"]) && this.matches(doc, schema["not"], value, at)) {
      refuse("not", "the value matches a schema it must not match");
    }
    if (isRecord(schema["if"])) {
      const branch = this.matches(doc, schema["if"], value, at) ? schema["then"] : schema["else"];
      if (isRecord(branch)) {
        this.check(doc, branch, value, at, found);
      }
    }
  }
}

/**
 * A validator over one set of schema documents, each named as a `$ref` names it, rooted
 * at one of them: what it refuses in a value, none for an instance.
 */
export function schemaRefusals(
  documents: Documents,
  root: string,
): (value: unknown) => readonly SchemaRefusal[] {
  const checker = new Checker(documents);
  const top = documents[root];
  if (top === undefined) {
    throw new Error(`the schema set holds no document ${root}`);
  }
  return (value) => {
    const found: SchemaRefusal[] = [];
    checker.check(root, top, value, "", found);
    return found;
  };
}

const reportSchema = schemaRefusals(REPORT_SCHEMAS, "report.schema.json");

/**
 * What the report schema refuses in one report document, none for an instance, and, as
 * no schema keyword can state it, a components listing that is not one entry per
 * component a finding or an edge evaluation's finding names.
 */
export function reportRefusals(document: unknown): readonly SchemaRefusal[] {
  const found = reportSchema(document);
  return found.length > 0 ? found : listingRefusals(document as Report);
}

/** The components listing held to the components the findings name, once each. */
function listingRefusals(report: Report): readonly SchemaRefusal[] {
  if (report.components === undefined) {
    return [];
  }
  const refuse = (pointer: string, reason: string): SchemaRefusal[] => [
    { pointer, keyword: "components", reason },
  ];
  const listed = new Set<string>();
  for (const [i, entry] of report.components.entries()) {
    if (listed.has(entry.id)) {
      return refuse(
        `/components/${String(i)}`,
        `the entry lists component ${entry.id} a second time`,
      );
    }
    listed.add(entry.id);
  }
  const named = [
    ...report.findings.map(
      (finding, i) => [`/findings/${String(i)}`, finding.component.id] as const,
    ),
    ...report.edge_evaluations.flatMap((one, i) =>
      one.finding === undefined
        ? []
        : [[`/edge_evaluations/${String(i)}/finding`, one.finding.component.id] as const],
    ),
  ];
  for (const [pointer, id] of named) {
    if (!listed.has(id)) {
      return refuse(
        pointer,
        `the finding names component ${id}, which the components listing lacks`,
      );
    }
  }
  const ids = new Set(named.map(([, id]) => id));
  for (const [i, entry] of report.components.entries()) {
    if (!ids.has(entry.id)) {
      return refuse(
        `/components/${String(i)}`,
        `the entry lists component ${entry.id}, which no finding names`,
      );
    }
  }
  return [];
}
