import { describe, expect, it } from "vitest";
import { contractDocument } from "../__test-helpers__/fixtures.ts";
import { ConfigError } from "./config.ts";
import {
  checkDocument,
  declaredKeys,
  declaresSetting,
  nearestKey,
  SCHEMA_ROOT,
  settingPaths,
  type KeyNode,
} from "./schema.ts";

/**
 * Every key the Contract's configuration schema declares, as a dotted path, read
 * from the schema rather than from the analyzer's own list. A list's entry members
 * are spelled under the list's own path followed by empty brackets, the way a
 * refusal names the member of one entry.
 */
function schemaKeys(): string[] {
  const keys: string[] = [];
  const walk = (node: Record<string, unknown>, at: string): void => {
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
      keys.push(path);
      const items = record["items"];
      if (typeof items === "object" && items !== null) {
        walk(items as Record<string, unknown>, `${path}[]`);
        continue;
      }
      walk(record, path);
    }
  };
  walk(contractDocument("config.schema.json"), "");
  return keys.sort();
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
});

describe("declaresSetting", () => {
  it.each([
    { path: "analysis.min_confidence", declared: true },
    { path: "analysis.template_delimiters", declared: true },
    { path: "analysis.template_delimiters.left", declared: false },
    { path: "analysis", declared: false },
    { path: "severity.DS1101", declared: true },
    { path: "severity.DS9999", declared: true },
    { path: "severity", declared: false },
    { path: "severity.DS11.extra", declared: false },
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
    const text = '{"target":{"kind":"library"},"severity":{"DS1101":"warn"},"severity":{}}';

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
    expect(got.message).toContain('the nearest implemented key is "reporters.fail_on"');
  });

  it("accepts a member name a value merely contains", () => {
    expect(() =>
      checkDocument('{"roots":{"patterns":["kind","kind"]}}', SCHEMA_ROOT, "document.json"),
    ).not.toThrow();
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
