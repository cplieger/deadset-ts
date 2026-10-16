import { describe, expect, it } from "vitest";
import {
  dotted,
  locatedFault,
  placeIn,
  pointerOf,
  pointerSegments,
  readStrict,
  StrictJSONError,
} from "./json-document.ts";

/** At each element the read keeps, an object's first member name, else the element's first character. */
function startsAt(text: string, array: string): string[] {
  return [...readStrict(text, array).starts.values()].map(
    (offset) => /^\{\s*"([^"]*)"/u.exec(text.slice(offset))?.[1] ?? text.charAt(offset),
  );
}

function refusal(text: string): StrictJSONError {
  try {
    readStrict(text);
  } catch (error: unknown) {
    if (error instanceof StrictJSONError) {
      return error;
    }
    throw error;
  }
  throw new Error(`readStrict accepted ${text}`);
}

describe("a strict read of one document", () => {
  it("decodes what JSON.parse decodes", () => {
    const text = '{"a":[1,-2.5e3,true,false,null,"x\\u00e9\\n"],"b":{},"c":[]}';

    expect(readStrict(text).value).toEqual(JSON.parse(text));
  });

  it("keeps the offset of each element of the top-level array member it names, alone", () => {
    const text = JSON.stringify(
      {
        other: [{ a: 1 }],
        meta: { findings: [{ b: 2 }] },
        findings: [{ c: 3 }, [{ d: 4 }], { e: 5 }],
      },
      null,
      2,
    );

    expect(startsAt(text, "findings")).toEqual(["c", "[", "e"]);
    expect(readStrict(text).starts.size).toBe(0);
  });

  it("reads a document written compact or with white space around every token", () => {
    expect(
      startsAt(' { "findings" : [ { "a" : 1 } , { "b" : [ 1 , 2 ] } ] } ', "findings"),
    ).toEqual(["a", "b"]);
    expect(startsAt('{"findings":[{"a":1},{"b":2}]}', "findings")).toEqual(["a", "b"]);
  });

  it("refuses the first member one object writes twice, at the offset of its name, by its pointer", () => {
    const text = '{\n  "x": {"a\\"b": 1,\n  "c": 2,\n  "a\\"b": 3,\n  "c": 4}\n}';
    const got = refusal(text);

    expect(got.offset).toBe(text.indexOf('"a\\"b": 3'));
    expect(got.place).toEqual(["x", 'a"b']);
    expect(got.message).toBe('the member "a\\"b" is written twice, so neither value is chosen');
  });

  it("refuses a member written twice under two spellings of one name", () => {
    expect(refusal('{"target":{},"\\u0074arget":{}}').place).toEqual(["target"]);
  });

  it("refuses a member written twice inside one entry of an array, naming the entry", () => {
    const got = refusal('{"list":[{"id":"a"} , {"id":"b","id":"c"}]}');

    expect(dotted(got.place)).toBe("list[1].id");
  });

  it.each([
    ['{"0":1,"0":2}', "0"],
    ['{"a":{"7":[1,{"x":1,"x":2}]}}', "a.7[1].x"],
    ['[{"1":[0,{"y":1,"y":2}]}]', "[0].1[1].y"],
  ])("names a member spelled in digits as a member and an index as an index: %s", (text, at) => {
    expect(dotted(refusal(text).place)).toBe(at);
  });

  it("accepts a member name a value merely contains, and strings holding braces and quotes", () => {
    expect(readStrict('{"a":["kind","kind"],"b":"{\\"}\\\\"}').value).toEqual({
      a: ["kind", "kind"],
      b: '{"}\\',
    });
  });

  it("keeps the text of every number written with a fraction or an exponent, by its pointer", () => {
    const read = readStrict('{"a":100.0,"b":[1,1e2],"c":7}');

    expect([...read.fractions]).toEqual([
      ["/a", "100.0"],
      ["/b/1", "1e2"],
    ]);
  });

  it("holds a member named __proto__ as its own member", () => {
    const value = readStrict('{"__proto__":{"polluted":true}}').value as Record<string, unknown>;

    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it.each([
    ["data after the value", '{"a":1} {}', "data follows the document's value"],
    ["a trailing comma", '{"a":1,}', "a member name is expected"],
    ["a missing colon", '{"a" 1}', "a colon after the member name is expected"],
    ["a missing comma", "[1 2]", "a comma or a closing bracket is expected"],
    ["an unquoted name", "{a:1}", "a member name is expected"],
    ["a single-quoted string", "['a']", "a value is expected"],
    ["a raw control character in a string", '["a\u0001"]', "a value is expected"],
    ["a number with a leading zero", "[01]", "a comma or a closing bracket is expected"],
    ["an empty text", "", "the document ends where a value is expected"],
  ])("refuses %s", (_, text, reason) => {
    expect(refusal(text).message).toBe(reason);
  });

  it("refuses values nested deeper than its bound rather than exhausting the stack", () => {
    const deep = `${"[".repeat(5000)}${"]".repeat(5000)}`;

    expect(refusal(deep).message).toBe("values nest deeper than 1000 levels");
    expect(() => readStrict(`${"[".repeat(1000)}${"]".repeat(1000)}`)).not.toThrow();
  });

  it("states a fault with the line and column it is at", () => {
    const text = '{\n  "a": 1,\n  "a": 2\n}';

    expect(locatedFault(text, refusal(text))).toBe(
      'line 3, column 3: the member "a" is written twice, so neither value is chosen',
    );
  });
});

describe("a place inside a document", () => {
  it("spells a JSON Pointer as member names and indexes, escapes undone", () => {
    expect(pointerSegments("/a~1b/0/c~0d")).toEqual(["a/b", "0", "c~d"]);
    expect(pointerOf(["a/b", "0", "c~d"])).toBe("/a~1b/0/c~0d");
    expect(pointerSegments("")).toEqual([]);
  });

  it("names a place as a refusal does: full stops, an index in brackets", () => {
    expect(dotted(["ts", "serializers", 0, "returns"])).toBe("ts.serializers[0].returns");
    expect(dotted([0, "name"])).toBe("[0].name");
    expect(dotted(["target", "0"])).toBe("target.0");
    expect(dotted([])).toBe("");
  });

  it("reads a JSON Pointer's segments as the value holds them, the member last", () => {
    const value = { ts: { serializers: [{ "0": {} }] } };

    expect(placeIn(value, "/ts/serializers/0/0", "returns")).toEqual([
      "ts",
      "serializers",
      0,
      "0",
      "returns",
    ]);
    expect(placeIn(value, "")).toEqual([]);
    expect(placeIn([[1]], "/0/0")).toEqual([0, 0]);
  });
});
