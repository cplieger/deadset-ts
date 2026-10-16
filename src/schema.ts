/**
 * Holds a value to a JSON Schema the generator copies from the Contract. It evaluates the
 * keywords the Contract's schemas use; the schemas' patterns are written to match alike in
 * RE2 and in ECMAScript.
 */

import { isRecord, pointerOf, pointerSegments } from "./json-document.ts";
import { bytewise } from "./text/compare.ts";

/**
 * One value a schema refuses: its JSON Pointer, the keyword, and why. `member` names the
 * member a `required`, `additionalProperties` or `propertyNames` refusal is about, the
 * object being at `pointer`, and is empty for every other keyword.
 */
export interface SchemaRefusal {
  readonly pointer: string;
  readonly keyword: string;
  readonly reason: string;
  readonly member: string;
}

export type Schema = Readonly<Record<string, unknown>>;
type Documents = Readonly<Record<string, Schema>>;

/**
 * Every keyword the validator evaluates or knows to carry no assertion. A schema naming
 * another fails every check rather than passing values the keyword would refuse.
 */
const KEYWORDS: ReadonlySet<string> = new Set([
  ...["$schema", "$id", "$comment", "$defs", "title", "description", "default", "examples"],
  ...["$ref", "type", "enum", "const", "pattern", "minLength", "minimum", "maximum"],
  ...["properties", "additionalProperties", "propertyNames", "required", "minProperties"],
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

/** The types a schema names, none where it names no type. */
function typesOf(schema: Schema): readonly string[] {
  const types = schema["type"];
  if (types === undefined) {
    return [];
  }
  return (Array.isArray(types) ? types : [types]).filter((one) => typeof one === "string");
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

/** The schemas of a list keyword, none where the schema does not write it. */
function listOf(schema: Schema, keyword: string): readonly Schema[] {
  const held = schema[keyword];
  return Array.isArray(held) ? (held as Schema[]) : [];
}

/** Whether a reader fixes refusal `a` before `b`: an object's before one inside it, then by kind. */
function before(a: SchemaRefusal, b: SchemaRefusal): boolean {
  if (a.pointer === b.pointer) {
    return rank(a) < rank(b);
  }
  return b.pointer.startsWith(`${a.pointer}/`);
}

/** The order of the refusals of one place: an undeclared member, a missing one, any other. */
function rank(refusal: SchemaRefusal): number {
  if (refusal.keyword === "additionalProperties" || refusal.keyword === "propertyNames") {
    return 0;
  }
  return refusal.keyword === "required" ? 1 : 2;
}

/** The value one JSON Pointer segment names inside `value`, or undefined. */
function valueAt(value: unknown, segment: string): unknown {
  if (Array.isArray(value)) {
    return /^[0-9]+$/u.test(segment) ? value[Number(segment)] : undefined;
  }
  return isRecord(value) && Object.hasOwn(value, segment) ? value[segment] : undefined;
}

/**
 * The schema `properties` declares for the member `name`, or undefined: a member named as an
 * `Object.prototype` property, such as `__proto__`, is declared only where it is written.
 */
function declaredMember(properties: Readonly<Record<string, unknown>>, name: string): unknown {
  return Object.hasOwn(properties, name) ? properties[name] : undefined;
}

/** A schema with the document it is read from, so a relative `$ref` resolves there. */
type Located = readonly [string, Schema];

/** The keyword checks over one set of schema documents, each named as a `$ref` names it. */
class Checker {
  private readonly documents: Documents;

  constructor(documents: Documents) {
    this.documents = documents;
  }

  resolve(doc: string, ref: string): Located {
    const [file = "", pointer = ""] = ref.split("#");
    const target = file === "" ? doc : file;
    let schema: unknown = this.documents[target];
    for (const token of pointerSegments(pointer)) {
      schema = isRecord(schema) ? schema[token] : undefined;
    }
    if (!isRecord(schema)) {
      throw new Error(`schema: ${ref} names no schema`);
    }
    return [target, schema];
  }

  refusals(doc: string, schema: Schema, value: unknown, at: string): readonly SchemaRefusal[] {
    const found: SchemaRefusal[] = [];
    this.check(doc, schema, value, at, found);
    return found;
  }

  matches(doc: string, schema: Schema, value: unknown, at: string): boolean {
    return this.refusals(doc, schema, value, at).length === 0;
  }

  check(doc: string, schema: Schema, value: unknown, at: string, found: SchemaRefusal[]): void {
    for (const keyword of Object.keys(schema)) {
      if (!KEYWORDS.has(keyword) && !keyword.startsWith("x-")) {
        throw new Error(`schema: the keyword ${keyword} is not one this validator evaluates`);
      }
    }
    const refuse = (keyword: string, reason: string, member = ""): void => {
      found.push({ pointer: at, keyword, reason, member });
    };
    if (typeof schema["$ref"] === "string") {
      const [target, referenced] = this.resolve(doc, schema["$ref"]);
      this.check(target, referenced, value, at, found);
    }
    const named = typesOf(schema);
    if (named.length > 0 && !named.some((one) => hasType(value, one))) {
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
      refuse("enum", `${canonical(value)} is not one of ${values.map(canonical).join(", ")}`);
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
    refuse: (keyword: string, reason: string, member?: string) => void,
  ): void {
    const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
    const additional = schema["additionalProperties"];
    const names = schema["propertyNames"];
    for (const name of Object.keys(value).sort(bytewise)) {
      const [refusedName] = isRecord(names) ? this.refusals(doc, names, name, at) : [];
      if (refusedName !== undefined) {
        refuse(
          "propertyNames",
          `the member name ${JSON.stringify(name)}: ${refusedName.reason}`,
          name,
        );
      }
      const member = `${at}${pointerOf([name])}`;
      const declared = declaredMember(properties, name);
      if (isRecord(declared)) {
        this.check(doc, declared, value[name], member, found);
      } else if (additional === false) {
        refuse(
          "additionalProperties",
          `the member ${JSON.stringify(name)} is not one the schema declares`,
          name,
        );
      } else if (isRecord(additional)) {
        this.check(doc, additional, value[name], member, found);
      }
    }
    for (const name of Array.isArray(schema["required"]) ? (schema["required"] as string[]) : []) {
      if (!Object.hasOwn(value, name)) {
        refuse("required", `the member ${JSON.stringify(name)} is absent`, name);
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
    for (const each of listOf(schema, "allOf")) {
      this.check(doc, each, value, at, found);
    }
    const matching = (keyword: string): number =>
      listOf(schema, keyword).filter((each) => this.matches(doc, each, value, at)).length;
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

  /**
   * The refusal of `value` a reader fixes first, none for an instance: an object's
   * refusal before any inside it, at one place an undeclared member, then a missing one,
   * then any other, else the order the check finds them in. A oneOf no alternative
   * matches is explained by the first refusal of the alternative the value was written
   * for: the one whose type admits it, or of several, the one declaring the most of an
   * object's members, then the fewest. Where two remain, the refusal is the oneOf's own.
   */
  first(doc: string, schema: Schema, value: unknown, at: string): SchemaRefusal | undefined {
    const found: SchemaRefusal[] = [];
    this.check(doc, schema, value, at, found);
    let first = found[0];
    for (const other of found.slice(1)) {
      if (first !== undefined && before(other, first)) {
        first = other;
      }
    }
    if (first?.keyword !== "oneOf") {
      return first;
    }
    let held = value;
    let holders: readonly Located[] = [[doc, schema]];
    for (const segment of pointerSegments(first.pointer.slice(at.length))) {
      holders = holders.flatMap(([d, s]) =>
        this.applied(d, s, held).flatMap(([d2, s2]) => this.member(d2, s2, held, segment)),
      );
      held = valueAt(held, segment);
    }
    for (const [d, holder] of holders) {
      const alternatives = listOf(holder, "oneOf");
      if (alternatives.some((each) => this.matches(d, each, held, first.pointer))) {
        continue;
      }
      const alternative = closest(alternatives, held);
      const inner = alternative && this.first(d, alternative, held, first.pointer);
      if (inner !== undefined) {
        return inner;
      }
    }
    return first;
  }

  /** The schemas checked at one place when `schema` is: it, its `$ref`, its allOf and its if branch. */
  private applied(doc: string, schema: Schema, value: unknown): readonly Located[] {
    const held: Located[] = [[doc, schema]];
    if (typeof schema["$ref"] === "string") {
      const [target, referenced] = this.resolve(doc, schema["$ref"]);
      held.push(...this.applied(target, referenced, value));
    }
    for (const each of listOf(schema, "allOf")) {
      held.push(...this.applied(doc, each, value));
    }
    if (isRecord(schema["if"])) {
      const branch = this.matches(doc, schema["if"], value, "") ? schema["then"] : schema["else"];
      if (isRecord(branch)) {
        held.push(...this.applied(doc, branch, value));
      }
    }
    return held;
  }

  /** The schemas `schema` checks the member or the entry `segment` names in `value` with. */
  private member(doc: string, schema: Schema, value: unknown, segment: string): readonly Located[] {
    if (Array.isArray(value)) {
      return isRecord(schema["items"]) ? [[doc, schema["items"]]] : [];
    }
    const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
    const declared = declaredMember(properties, segment);
    if (isRecord(declared)) {
      return [[doc, declared]];
    }
    const additional = schema["additionalProperties"];
    return isRecord(additional) ? [[doc, additional]] : [];
  }
}

/** The alternative a value matching none of them was written for, or none where none or two remain. */
function closest(alternatives: readonly Schema[], value: unknown): Schema | undefined {
  const typed = alternatives.filter((each) => {
    const types = typesOf(each);
    return types.length === 0 || types.some((one) => hasType(value, one));
  });
  if (typed.length === 1 || !isRecord(value)) {
    return typed.length === 1 ? typed[0] : undefined;
  }
  let best: Schema[] = [];
  let most = -1;
  let fewest = 0;
  for (const alternative of typed) {
    const properties = isRecord(alternative["properties"]) ? alternative["properties"] : {};
    const named = Object.keys(value).filter((name) => Object.hasOwn(properties, name)).length;
    const declared = Object.keys(properties).length;
    if (named > most || (named === most && declared < fewest)) {
      [best, most, fewest] = [[alternative], named, declared];
    } else if (named === most && declared === fewest) {
      best.push(alternative);
    }
  }
  return best.length === 1 ? best[0] : undefined;
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

/**
 * The refusal of `value` a reader fixes first under one schema, none for an instance. A
 * `$ref` the schema holds names a place in the schema itself.
 */
export function firstRefusal(schema: Schema, value: unknown): SchemaRefusal | undefined {
  return new Checker({ "": schema }).first("", schema, value, "");
}
