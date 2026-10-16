import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../__test-helpers__/fixtures.ts";
import { bundled, GENERATED_CONFIG, generatedConfig } from "./gen-config.ts";
import { fixturesReader, GENERATED, generated } from "./gen-contract.ts";
import { GENERATED_REPORT, generatedReport, type Schema } from "./gen-report.ts";

describe("the generated contract module", () => {
  it("is what the generator writes from the pinned Contract copy", async () => {
    expect(readFileSync(join(ROOT, GENERATED), "utf8")).toBe(await generated(fixturesReader));
  });

  it("moves when a planted kinds edit moves the copy it is written from", async () => {
    const planted = (path: string): string =>
      path === "contract/kinds.json"
        ? fixturesReader(path).replace('"name": "unused-member"', '"name": "planted-member"')
        : fixturesReader(path);

    const text = await generated(planted);

    expect(text).toContain('"planted-member"');
    expect(text).not.toBe(await generated(fixturesReader));
  });

  it("writes the report module the generator writes from the pinned schemas", async () => {
    expect(readFileSync(join(ROOT, GENERATED_REPORT), "utf8")).toBe(
      await generatedReport(fixturesReader),
    );
  });

  it("moves the report module when a planted schema edit moves the copy", async () => {
    const planted = (path: string): string =>
      path === "contract/report.schema.json"
        ? fixturesReader(path).replace(
            '"excluded_by_cgo": {',
            '"planted_member": { "type": "string" },\n    "excluded_by_cgo": {',
          )
        : fixturesReader(path);

    const text = await generatedReport(planted);

    expect(text).toContain("planted_member");
    expect(text).not.toBe(await generatedReport(fixturesReader));
  });

  it("writes the configuration module the generator writes from the pinned settings table", async () => {
    expect(readFileSync(join(ROOT, GENERATED_CONFIG), "utf8")).toBe(
      await generatedConfig(fixturesReader),
    );
  });

  it("keeps only the key and role of a row this analyzer's language does not read", async () => {
    const settings = JSON.parse(fixturesReader("contract/settings.json")) as {
      keys: { key: string; read_by: string[] }[];
    };
    for (const row of settings.keys) {
      if (row.key === "analysis.min_confidence") {
        row.read_by = row.read_by.filter((language) => language !== "ts");
      }
    }
    const planted = (path: string): string =>
      path === "contract/settings.json" ? JSON.stringify(settings) : fixturesReader(path);

    const text = await generatedConfig(planted);

    expect(text).toContain('{ key: "analysis.min_confidence", role: "setting", read: false }');
    expect(text).not.toContain("readonly min_confidence");
  });

  it("makes a setting this analyzer reads, with no default and not required, optional in both types", async () => {
    const settings = JSON.parse(fixturesReader("contract/settings.json")) as {
      keys: Record<string, unknown>[];
    };
    settings.keys.push({
      key: "reporters.planted_optional",
      role: "setting",
      read_by: ["ts"],
      value: { type: "string" },
    });
    const planted = (path: string): string =>
      path === "contract/settings.json" ? JSON.stringify(settings) : fixturesReader(path);

    const text = await generatedConfig(planted);
    const declared = (name: string): string =>
      text.slice(text.indexOf(`export interface ${name} {`)).split("\n}\n")[0] ?? "";

    expect(declared("ResolvedConfig")).toContain("readonly planted_optional?: string;");
    expect(declared("PartialConfig")).toContain("readonly planted_optional?: string;");
  });

  it("moves the edges schema the configuration module carries when a planted edit moves the copy", async () => {
    const planted = (path: string): string =>
      path === "contract/edges.schema.json"
        ? fixturesReader(path).replace(
            '"because": {',
            '"planted_member": { "type": "string" },\n        "because": {',
          )
        : fixturesReader(path);

    const text = await generatedConfig(planted);

    expect(text).toContain("planted_member");
    expect(text).not.toBe(await generatedConfig(fixturesReader));
  });

  it.each([
    ["names no definition", "#/$defs/edge_identifer", "names no definition"],
    ["names a definition holding a reference", "#/$defs/position", "names no definition"],
  ])(
    "refuses to write the edges schema where a reference into another document %s",
    async (_name, pointer, text) => {
      const planted = (path: string): string =>
        path === "contract/edges.schema.json"
          ? fixturesReader(path).replace(
              '"finding.schema.json#/$defs/edge_identifier"',
              `"finding.schema.json${pointer}"`,
            )
          : fixturesReader(path);

      await expect(generatedConfig(planted)).rejects.toThrow(text);
    },
  );

  it("refuses to write the edges schema where the definition another document names holds a reference in an array", async () => {
    const planted = (path: string): string =>
      path === "contract/finding.schema.json"
        ? fixturesReader(path).replace(
            /("edge_identifier": \{[^}]*"type": "string",)/u,
            '$1 "allOf": [{ "$$ref": "#/$$defs/relative_path" }],',
          )
        : fixturesReader(path);
    expect(JSON.parse(planted("contract/finding.schema.json"))).toHaveProperty(
      ["$defs", "edge_identifier", "allOf"],
      [{ $ref: "#/$defs/relative_path" }],
    );

    await expect(generatedConfig(planted)).rejects.toThrow("names no definition");
  });

  it("copies a definition another document names whose description is the text $ref", async () => {
    const planted = (path: string): string =>
      path === "contract/finding.schema.json"
        ? fixturesReader(path).replace(
            /("edge_identifier": \{\s*"description": )"[^"]*"/u,
            '$1"$$ref"',
          )
        : fixturesReader(path);
    expect(planted("contract/finding.schema.json")).toMatch(
      /"edge_identifier": \{\s*"description": "\$ref",/u,
    );

    const edges = bundled(JSON.parse(planted("contract/edges.schema.json")) as Schema, planted);

    expect(edges).toHaveProperty(["$defs", "edge_identifier", "description"], "$ref");
    await expect(generatedConfig(planted)).resolves.toContain("edge_identifier");
  });

  it("copies a definition two references into another document name once", async () => {
    const planted = (path: string): string =>
      path === "contract/edges.schema.json"
        ? fixturesReader(path).replace(
            '"because": {',
            '"planted_member": { "$ref": "finding.schema.json#/$defs/edge_identifier" },\n        "because": {',
          )
        : fixturesReader(path);

    const text = await generatedConfig(planted);

    expect(text).toMatch(/planted_member: \{ \$ref: "#\/\$defs\/edge_identifier" \}/u);
  });

  it("carries a member named as an annotation keyword in the edges schema", async () => {
    expect(await generatedConfig(fixturesReader)).toMatch(
      /EDGES_SCHEMA = \{[^]*properties: \{\s*description: \{ type: "string" \}/u,
    );
  });
});
