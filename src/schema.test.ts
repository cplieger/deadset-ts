import { describe, expect, it } from "vitest";
import { contractDocument } from "../__test-helpers__/fixtures.ts";
import { ConfigError } from "./config.ts";
import {
  checkDocument,
  declaredKeys,
  declaresSetting,
  nearestKey,
  nestFlags,
  SCHEMA_ROOT,
  settingPaths,
  type KeyNode,
} from "./schema.ts";

/**
 * Every key the Contract's configuration schema declares, as a dotted path, read
 * from the schema rather than from the analyzer's own list. A list's entry members
 * are spelled under the list's own path followed by empty brackets, the way a
 * refusal names the member of one entry, and an entry the schema admits in several
 * shapes declares the members of every shape.
 */
function schemaKeys(): string[] {
  const keys = new Set<string>();
  const walk = (node: Record<string, unknown>, at: string): void => {
    const shapes = node["oneOf"];
    if (Array.isArray(shapes)) {
      for (const shape of shapes as unknown[]) {
        walk(shape as Record<string, unknown>, at);
      }
    }
    const properties = node["properties"];
    if (typeof properties !== "object" || properties === null) {
      return;
    }
    for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
      if (typeof child !== "object" || child === null) {
        continue;
      }
      const record = child as Record<string, unknown>;
      const path = at === "" ? name : `${at}.${name}`;
      keys.add(path);
      const items = record["items"];
      if (typeof items === "object" && items !== null) {
        walk(items as Record<string, unknown>, `${path}[]`);
        continue;
      }
      walk(record, path);
    }
  };
  walk(contractDocument("config.schema.json"), "");
  return [...keys].sort();
}

describe("the closed key list", () => {
  it("declares exactly the keys the Contract's configuration schema declares", () => {
    expect(declaredKeys()).toEqual(schemaKeys());
  });

  it("closes every object the schema closes", () => {
    const open: string[] = [];
    const walk = (node: Record<string, unknown>, at: string): void => {
      const properties = node["properties"];
      if (node["type"] === "object" && node["additionalProperties"] !== false) {
        const patterns = node["patternProperties"];
        if (typeof patterns !== "object" || patterns === null) {
          open.push(at);
        }
      }
      const items = node["items"];
      if (typeof items === "object" && items !== null) {
        walk(items as Record<string, unknown>, `${at}[]`);
      }
      const shapes = node["oneOf"];
      if (Array.isArray(shapes)) {
        (shapes as unknown[]).forEach((shape, index) => {
          walk(shape as Record<string, unknown>, `${at}<${String(index)}>`);
        });
      }
      if (typeof properties !== "object" || properties === null) {
        return;
      }
      for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
        if (typeof child === "object" && child !== null) {
          walk(child as Record<string, unknown>, at === "" ? name : `${at}.${name}`);
        }
      }
    };
    walk(contractDocument("config.schema.json"), "");

    expect(open).toEqual([]);
  });

  it("names every setting that holds one value, and no section", () => {
    const paths = settingPaths();

    expect(paths).toContain("analysis.min_confidence");
    expect(paths).toContain("analysis.configurations");
    expect(paths).toContain("analysis.template_delimiters");
    expect(paths).not.toContain("analysis");
    expect(paths).not.toContain("analysis.matrix");
    expect(paths).not.toContain("analysis.template_delimiters.left");
    expect(paths).not.toContain("severity");
  });

  it("lists the settings in ascending order, each one a key the list declares", () => {
    const paths = settingPaths();
    const declared = new Set(declaredKeys());

    expect(paths).toEqual([...paths].sort());
    expect(paths.filter((path) => !declared.has(path))).toEqual([]);
  });
});

describe("declaresSetting", () => {
  it.each([
    { path: "analysis.min_confidence", declared: true },
    { path: "analysis.template_delimiters", declared: true },
    { path: "analysis.template_delimiters.left", declared: false },
    { path: "analysis", declared: false },
    { path: "severity.DS1501", declared: true },
    { path: "severity.DS9999", declared: true },
    { path: "severity", declared: false },
    { path: "severity.DS11.extra", declared: false },
    { path: "severity.", declared: false },
    { path: "severitys", declared: false },
    { path: "nope", declared: false },
  ])("answers $declared for $path", ({ path, declared }) => {
    expect(declaresSetting(path)).toBe(declared);
  });
});

describe("nearestKey", () => {
  it.each([
    { key: "reporters.fail_under", nearest: "reporters.fail_on" },
    { key: "analysis.min_confidences", nearest: "analysis.min_confidence" },
    { key: "targets", nearest: "target" },
    { key: "ts.formats", nearest: "ts" },
    { key: "zz.matrix", nearest: "analysis" },
    { key: "gx", nearest: "go" },
  ])("answers $nearest for $key", ({ key, nearest }) => {
    expect(nearestKey(key)).toBe(nearest);
  });
});

describe("the document walk", () => {
  function refuse(text: string, node: KeyNode = SCHEMA_ROOT): ConfigError {
    try {
      checkDocument(text, node, "document.json");
    } catch (error: unknown) {
      if (error instanceof ConfigError) {
        return error;
      }
      throw error;
    }
    throw new Error(`checkDocument accepted ${text}`);
  }

  it("names a member one object writes twice, which a parse cannot report", () => {
    const text = '{"target":{"kind":"library"},"severity":{"DS1501":"warn"},"severity":{}}';

    expect(JSON.parse(text), "a parse keeps the last value and reports nothing").toMatchObject({
      severity: {},
    });
    expect(refuse(text).key).toBe("severity");
    expect(refuse(text).kind).toBe("malformed");
  });

  it("names a repeated member at any depth", () => {
    const got = refuse('{"analysis":{"min_confidence":"certain","min_confidence":"possible"}}');

    expect(got.key).toBe("analysis.min_confidence");
  });

  it("names a repeated member spelled with an escape, decoded", () => {
    const got = refuse('{"target":{"kind":"library"},"\\u0074arget":{}}');

    expect(got.key).toBe("target");
  });

  it("names a repeated member inside one entry of a list", () => {
    const got = refuse(
      '{"analysis":{"configurations":[{"id":"a","id":"b","os":"linux","arch":"amd64"}]}}',
    );

    expect(got.key).toBe("analysis.configurations[0].id");
  });

  it("names an undeclared member and the nearest key the list declares", () => {
    const got = refuse('{"reporters":{"fail_under":"warn"}}');

    expect(got.kind).toBe("unimplemented-key");
    expect(got.key).toBe("reporters.fail_under");
    expect(got.message).toContain('The nearest implemented key is "reporters.fail_on"');
  });

  it("accepts a member name a value merely contains", () => {
    expect(() =>
      checkDocument('{"roots":{"patterns":["kind","kind"]}}', SCHEMA_ROOT, "document.json"),
    ).not.toThrow();
  });

  it("names the entry of a list a repeated member is in, past space before a comma", () => {
    const got = refuse('{"analysis":{"configurations":[{"id":"a"} , {"id":"b","id":"c"}]}}');

    expect(got.key).toBe("analysis.configurations[1].id");
  });

  it("names an undeclared member of a list written as an object", () => {
    const got = refuse('{"analysis":{"configurations":{"nope":1}}}');

    expect(got.kind).toBe("unimplemented-key");
    expect(got.key).toBe("analysis.configurations.nope");
  });

  it("names an undeclared member of a setting written as an object", () => {
    const got = refuse(
      '{"analysis":{"template_delimiters":{"left":"[","right":"]","middle":"|"}}}',
    );

    expect(got.kind).toBe("unimplemented-key");
    expect(got.key).toBe("analysis.template_delimiters.middle");
  });

  it.each([
    { name: "space before a colon", text: '{"target" : {"kind":"library"}}' },
    {
      name: "a fraction where no integer is declared",
      text: '{"analysis":{"min_confidence":1.5}}',
    },
    { name: "an object inside an array setting", text: '{"roots":{"patterns":[{"any":1}]}}' },
  ])("leaves the value's type to the decoder and accepts $name", ({ text }) => {
    expect(() => checkDocument(text, SCHEMA_ROOT, "document.json")).not.toThrow();
  });

  it("accepts a document whose strings hold braces and escaped quotes", () => {
    expect(() =>
      checkDocument(
        '{"analysis":{"template_delimiters":{"left":"{\\"","right":"}\\\\"}}}',
        SCHEMA_ROOT,
        "document.json",
      ),
    ).not.toThrow();
  });
});

describe("the flag document", () => {
  it("nests each dotted path as the objects the key list declares", () => {
    expect(
      nestFlags({ "analysis.matrix.complete": true, "reporters.sort": "size" }, "flags"),
    ).toEqual({ analysis: { matrix: { complete: true } }, reporters: { sort: "size" } });
  });

  it("refuses the first path in ascending order that names no setting", () => {
    expect(() => nestFlags({ "zeta.one": 1, "alpha.two": 1 }, "flags")).toThrow(
      'flags: key "alpha.two" is not implemented',
    );
  });

  it("refuses a declared key that holds no value of its own, saying it is written as nested objects", () => {
    expect(() => nestFlags({ "analysis.template_delimiters.left": "[" }, "flags")).toThrow(
      'flags: key "analysis.template_delimiters.left" is not implemented. ' +
        '"analysis.template_delimiters.left" is one setting written as nested objects, not as one key',
    );
  });
});
