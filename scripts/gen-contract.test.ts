import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../__test-helpers__/fixtures.ts";
import { fixturesReader, GENERATED, generated } from "./gen-contract.ts";
import { GENERATED_REPORT, generatedReport } from "./gen-report.ts";

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
});
