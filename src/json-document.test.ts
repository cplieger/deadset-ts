import { describe, expect, it } from "vitest";
import { walkDocument } from "./json-document.ts";

/** The first member name of the object opening at each offset the walk reports. */
function openedAt(text: string, array: string): string[] {
  return walkDocument(text, array).opened.map(
    (offset) =>
      /^\{\s*"([^"]*)"/u.exec(text.slice(offset))?.[1] ?? `no object at ${String(offset)}`,
  );
}

describe("a walk of one document", () => {
  it("finds the records of the top-level array member alone", () => {
    const text = JSON.stringify(
      {
        other: [{ a: 1 }],
        meta: { findings: [{ b: 2 }] },
        findings: [{ c: 3 }, [{ d: 4 }], { e: 5 }],
      },
      null,
      2,
    );

    expect(openedAt(text, "findings")).toEqual(["c", "e"]);
  });

  it("reads a document written compact or with white space around every token", () => {
    const records = ' { "findings" : [ { "a" : 1 } , { "b" : [ 1 , 2 ] } ] } ';

    expect(openedAt(records, "findings")).toEqual(["a", "b"]);
    expect(openedAt('{"findings":[{"a":1},{"b":2}]}', "findings")).toEqual(["a", "b"]);
  });

  it("names the first member one object writes twice, at the offset of its name", () => {
    const text = '{\n  "a\\"b": 1,\n  "c": 2,\n  "a\\"b": 3,\n  "c": 4\n}';

    expect(walkDocument(text, "findings").twice).toEqual({
      name: 'a"b',
      offset: text.indexOf('"a\\"b": 3'),
    });
  });

  it("finds nothing in a document that is one value", () => {
    expect(walkDocument("12", "findings")).toEqual({ opened: [], twice: undefined });
  });
});
