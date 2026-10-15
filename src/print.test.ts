import { describe, expect, it } from "vitest";
import { defaultConfig, type Origin } from "./config.ts";
import { printConfig } from "./print.ts";

const SEVERITY: Origin = { source: "flag", label: "--severity" };
const ROOT: Origin = { source: "repository", label: "deadset.json" };
const DEFAULT: Origin = { source: "default", label: "" };

describe("the printed configuration", () => {
  it("writes the severity and provenance objects in ascending key order, whatever order they were named in", () => {
    const config = {
      ...defaultConfig(),
      severity: new Map([
        ["DS1301", "warn"],
        ["DS1602", "deny"],
        ["DS1001", "allow"],
        ["DS1202", "warn"],
      ] as const),
    };
    const provenance = new Map([
      ["severity.DS1301", SEVERITY],
      ["target.kind", DEFAULT],
      ["analysis.languages", DEFAULT],
      ["roots.patterns", ROOT],
    ]);

    const printed = JSON.parse(printConfig(config, provenance)) as {
      severity: Record<string, string>;
      provenance: Record<string, string>;
    };

    expect(Object.entries(printed.severity)).toEqual([
      ["DS1001", "allow"],
      ["DS1202", "warn"],
      ["DS1301", "warn"],
      ["DS1602", "deny"],
    ]);
    expect(Object.entries(printed.provenance)).toEqual([
      ["analysis.languages", "default"],
      ["roots.patterns", "repository: deadset.json"],
      ["severity.DS1301", "flag: --severity"],
      ["target.kind", "default"],
    ]);
  });
});
