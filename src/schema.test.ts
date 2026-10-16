import { describe, expect, it } from "vitest";
import { firstRefusal, schemaRefusals, type Schema } from "./schema.ts";

const KIND: Schema = { type: "string", enum: ["application", "library"] };

/** A setting written as one string or as one member per language, as target.kind is. */
const PER_LANGUAGE: Schema = {
  oneOf: [
    KIND,
    {
      type: "object",
      additionalProperties: false,
      required: ["ts"],
      properties: { ts: KIND },
    },
  ],
};

const ENTRY: Schema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["symbol"],
      properties: { symbol: { type: "string", minLength: 1 } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["module", "name"],
      properties: {
        module: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1 },
      },
    },
  ],
};

describe("the first refusal", () => {
  it("is none for an instance", () => {
    expect(firstRefusal(PER_LANGUAGE, "library")).toBeUndefined();
    expect(firstRefusal(PER_LANGUAGE, { ts: "application" })).toBeUndefined();
  });

  it("names an object's own refusal before any inside it", () => {
    const schema: Schema = {
      type: "object",
      required: ["b"],
      properties: { a: KIND, b: KIND },
    };

    expect(firstRefusal(schema, { a: "service" })).toMatchObject({
      pointer: "",
      keyword: "required",
      member: "b",
    });
  });

  it("names, at one place, an undeclared member before a missing one before any other", () => {
    const schema: Schema = {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      minProperties: 3,
      properties: { kind: KIND },
    };

    expect(firstRefusal(schema, { other: 1 })).toMatchObject({
      keyword: "additionalProperties",
      member: "other",
    });
    expect(firstRefusal(schema, {})).toMatchObject({ keyword: "required", member: "kind" });
    expect(firstRefusal(schema, { kind: "library" })).toMatchObject({
      keyword: "minProperties",
      member: "",
    });
  });

  it("checks a member named __proto__ as the member it is, not as the prototype", () => {
    const closed: Schema = {
      type: "object",
      additionalProperties: false,
      properties: { kind: KIND },
    };
    const open: Schema = { type: "object", additionalProperties: PER_LANGUAGE };

    expect(firstRefusal(closed, JSON.parse('{"__proto__": 1}'))).toMatchObject({
      keyword: "additionalProperties",
      member: "__proto__",
    });
    expect(firstRefusal(open, JSON.parse('{"__proto__": "service"}'))).toMatchObject({
      pointer: "/__proto__",
      keyword: "enum",
    });
  });

  it("explains a oneOf no alternative matches by the alternative whose type admits the value", () => {
    expect(firstRefusal(PER_LANGUAGE, "service")).toMatchObject({ pointer: "", keyword: "enum" });
    expect(firstRefusal(PER_LANGUAGE, { ts: "service" })).toMatchObject({
      pointer: "/ts",
      keyword: "enum",
    });
    expect(firstRefusal(PER_LANGUAGE, {})).toMatchObject({ keyword: "required", member: "ts" });
  });

  it("keeps the oneOf's own refusal where no alternative admits the value's type", () => {
    expect(firstRefusal(PER_LANGUAGE, ["library"])).toMatchObject({
      pointer: "",
      keyword: "oneOf",
    });
  });

  it("explains an entry of an array by the alternative declaring the most of its members", () => {
    const list: Schema = { type: "array", items: ENTRY };

    expect(firstRefusal(list, [{ symbol: "a" }, { module: "m", name: "" }])).toMatchObject({
      pointer: "/1/name",
      keyword: "minLength",
    });
    expect(firstRefusal(list, [{ module: "m" }])).toMatchObject({
      pointer: "/0",
      keyword: "required",
      member: "name",
    });
  });

  it("takes the alternative declaring the fewest members among those naming as many", () => {
    expect(firstRefusal(ENTRY, { other: 1 })).toMatchObject({
      keyword: "additionalProperties",
      member: "other",
    });
  });

  it("keeps the oneOf's own refusal where two alternatives are as close", () => {
    const one = (name: string): Schema => ({
      type: "object",
      additionalProperties: false,
      required: [name],
      properties: { [name]: { type: "string" } },
    });

    expect(firstRefusal({ oneOf: [one("symbol"), one("global")] }, { other: 1 })).toMatchObject({
      pointer: "",
      keyword: "oneOf",
    });
  });
});

describe("a schema set's validator", () => {
  it("resolves a $ref into another document of the set", () => {
    const check = schemaRefusals(
      {
        "root.schema.json": { type: "object", properties: { kind: { $ref: "kind.schema.json" } } },
        "kind.schema.json": KIND,
      },
      "root.schema.json",
    );

    expect(check({ kind: "library" })).toEqual([]);
    expect(check({ kind: "service" })).toEqual([
      expect.objectContaining({ pointer: "/kind", keyword: "enum" }),
    ]);
  });

  it("refuses to build over a set lacking its root document", () => {
    expect(() => schemaRefusals({}, "absent.schema.json")).toThrow(/absent\.schema\.json/u);
  });
});
