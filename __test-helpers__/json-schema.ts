/** One schema: an object, or `true` or `false`. */
type Schema = boolean | Readonly<Record<string, unknown>>;

/** One document of a schema set, by the name a `$ref` to it spells. */
type Documents = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** The keywords that carry no assertion, and the container of the named definitions. */
const ANNOTATIONS: ReadonlySet<string> = new Set(["$schema", "title", "description", "$defs"]);

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A validator for the JSON Schema 2020-12 keywords the Contract's report and finding
 * schemas use. A `$ref` names a definition of the document it is written in
 * (`#/$defs/<name>`) or another document of the set by its name. A keyword it does not
 * implement is an error, so a schema that grows one fails here rather than passing unread.
 */
export function schemaValidator(
  documents: Documents,
  root: string,
): (value: unknown) => readonly string[] {
  const check = (document: string, schema: Schema, value: unknown, at: string): string[] => {
    if (schema === true) {
      return [];
    }
    if (schema === false) {
      return [`${at}: no value is admitted`];
    }
    const errors: string[] = [];
    const fail = (message: string): void => {
      errors.push(`${at}: ${message}`);
    };
    const passes = (sub: Schema): boolean => check(document, sub, value, at).length === 0;
    for (const [keyword, argument] of Object.entries(schema)) {
      if (ANNOTATIONS.has(keyword) || keyword === "then" || keyword === "else") {
        continue;
      }
      switch (keyword) {
        case "$ref": {
          const ref = String(argument);
          if (ref.startsWith("#/$defs/")) {
            const definitions = (documents[document]?.["$defs"] ?? {}) as Readonly<
              Record<string, Schema>
            >;
            const target = definitions[ref.slice("#/$defs/".length)];
            if (target === undefined) {
              fail(`unresolved reference ${ref}`);
              break;
            }
            errors.push(...check(document, target, value, at));
            break;
          }
          const other = documents[ref];
          if (other === undefined) {
            fail(`unresolved reference ${ref}`);
            break;
          }
          errors.push(...check(ref, other, value, at));
          break;
        }
        case "type":
          if (
            !(Array.isArray(argument) ? argument : [argument]).some(
              (type) =>
                type === typeOf(value) || (type === "number" && typeOf(value) === "integer"),
            )
          ) {
            fail(`is ${typeOf(value)}, not ${JSON.stringify(argument)}`);
          }
          break;
        case "enum":
          if (!(argument as unknown[]).some((one) => same(one, value))) {
            fail(`${JSON.stringify(value)} is not one of ${JSON.stringify(argument)}`);
          }
          break;
        case "const":
          if (!same(argument, value)) {
            fail(`${JSON.stringify(value)} is not ${JSON.stringify(argument)}`);
          }
          break;
        case "pattern":
          if (typeof value === "string" && !new RegExp(String(argument), "u").test(value)) {
            fail(`${JSON.stringify(value)} does not match ${String(argument)}`);
          }
          break;
        case "minLength":
          if (typeof value === "string" && Array.from(value).length < Number(argument)) {
            fail(`is shorter than ${String(argument)}`);
          }
          break;
        case "minimum":
          if (typeof value === "number" && value < Number(argument)) {
            fail(`is below ${String(argument)}`);
          }
          break;
        case "maximum":
          if (typeof value === "number" && value > Number(argument)) {
            fail(`is above ${String(argument)}`);
          }
          break;
        case "required":
          if (isObject(value)) {
            for (const member of argument as string[]) {
              if (!Object.hasOwn(value, member)) {
                fail(`lacks ${member}`);
              }
            }
          }
          break;
        case "properties":
          if (isObject(value)) {
            for (const [member, sub] of Object.entries(argument as Record<string, Schema>)) {
              if (Object.hasOwn(value, member)) {
                errors.push(...check(document, sub, value[member], `${at}/${member}`));
              }
            }
          }
          break;
        case "additionalProperties":
          if (isObject(value)) {
            const declared = (schema["properties"] ?? {}) as Readonly<Record<string, unknown>>;
            for (const member of Object.keys(value)) {
              if (!Object.hasOwn(declared, member)) {
                errors.push(
                  ...check(document, argument as Schema, value[member], `${at}/${member}`),
                );
              }
            }
          }
          break;
        case "items":
          if (Array.isArray(value)) {
            value.forEach((item: unknown, index) => {
              errors.push(...check(document, argument as Schema, item, `${at}/${String(index)}`));
            });
          }
          break;
        case "minItems":
          if (Array.isArray(value) && value.length < Number(argument)) {
            fail(`holds fewer than ${String(argument)} items`);
          }
          break;
        case "maxItems":
          if (Array.isArray(value) && value.length > Number(argument)) {
            fail(`holds more than ${String(argument)} items`);
          }
          break;
        case "uniqueItems":
          if (
            argument === true &&
            Array.isArray(value) &&
            new Set(value.map((item: unknown) => JSON.stringify(item))).size !== value.length
          ) {
            fail("holds an item twice");
          }
          break;
        case "allOf":
          for (const sub of argument as Schema[]) {
            errors.push(...check(document, sub, value, at));
          }
          break;
        case "anyOf":
          if (!(argument as Schema[]).some(passes)) {
            fail("meets no branch of anyOf");
          }
          break;
        case "oneOf": {
          const met = (argument as Schema[]).filter(passes).length;
          if (met !== 1) {
            fail(`meets ${String(met)} branches of oneOf, not one`);
          }
          break;
        }
        case "not":
          if (passes(argument as Schema)) {
            fail(`meets ${JSON.stringify(argument)}, which it must not`);
          }
          break;
        case "if": {
          const branch = passes(argument as Schema) ? "then" : "else";
          const sub = schema[branch];
          if (sub !== undefined) {
            errors.push(...check(document, sub as Schema, value, at));
          }
          break;
        }
        default:
          fail(`the keyword ${keyword} is not implemented`);
      }
    }
    return errors;
  };

  const top = documents[root];
  if (top === undefined) {
    throw new Error(`the schema set holds no document ${root}`);
  }
  return (value) => check(root, top, value, "");
}
