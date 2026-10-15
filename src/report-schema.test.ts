import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { reportRefusals, schemaRefusals } from "./report-schema.ts";

/** Every report document the pinned vectors publish, by its path below the fixtures. */
const REPORTS = ["sarif", "baseline"].flatMap((family) =>
  readdirSync(fixture("vectors", family), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `vectors/${family}/${entry.name}/report.json`),
);

const read = (path: string): unknown => JSON.parse(readFileSync(fixture(path), "utf8"));

interface Negative {
  readonly file: string;
  readonly schema: string;
  readonly constraint: string;
  readonly instance_path: string;
}

const NEGATIVES = (
  read("examples/negatives/index.json") as { negatives: readonly Negative[] }
).negatives.filter((row) => row.schema === "contract/report.schema.json");

describe("the report validator", () => {
  it.each(REPORTS)("admits %s", (path) => {
    expect(reportRefusals(read(path))).toEqual([]);
  });

  it.each(NEGATIVES.map((row) => [row.file, row] as const))(
    "refuses %s at its constraint",
    (_, row) => {
      const found = reportRefusals(read(`examples/negatives/${row.file}`));
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((one) => one.pointer === row.instance_path)).toBe(true);
      expect(found.map((one) => one.keyword)).toContain(row.constraint);
    },
  );

  it("refuses a components listing naming a component no finding names", () => {
    const listed = read(
      "vectors/sarif/component-member-sharing-the-finding-reference/report.json",
    ) as {
      components: { id: string; members: unknown[] }[];
    };
    const planted = {
      ...listed,
      components: [...listed.components, { id: "deadset-ts/c-99", members: [] }],
    };
    expect(reportRefusals(planted)).toEqual([
      expect.objectContaining({
        pointer: `/components/${String(listed.components.length)}`,
        keyword: "components",
      }),
    ]);
  });

  it("refuses a schema naming a keyword it does not evaluate", () => {
    const check = schemaRefusals(
      { "one.schema.json": { type: "string", format: "uri" } },
      "one.schema.json",
    );
    expect(() => check("x")).toThrow(/format/u);
  });
});
