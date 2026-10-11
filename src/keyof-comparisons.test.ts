import { describe, expect, it } from "vitest";
import { treeFindings } from "../__test-helpers__/tree-findings.ts";

describe("a literal compared with a value declared as a key of a type", () => {
  it("reads the member it names, through an equality and a case label, and no other", () => {
    const found = treeFindings({
      "main.ts": [
        "interface Payloads { ordinary: string; changed: undefined; switched: number; idle: boolean }",
        "interface Frame { type: keyof Payloads }",
        "export function deliver(evt: Frame): string {",
        '  if (evt.type === "changed") {',
        '    return "refetch";',
        "  }",
        "  switch (evt.type) {",
        '    case "switched":',
        '      return "switch";',
        "  }",
        '  return "dispatch";',
        "}",
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => one.includes("Payloads."))).toEqual([
      "DS1003 Payloads.ordinary",
      "DS1003 Payloads.idle",
    ]);
  });

  it("reads the member it names where the value is imported, by name, through a namespace or through a re-export", () => {
    const found = treeFindings({
      "keys.ts": [
        "export interface Payload { used: string; viaNamespace: string; viaReexport: string; extra: string }",
        'export const selected: keyof Payload = Math.random() > 0.5 ? "used" : "extra";',
        "",
      ].join("\n"),
      "again.ts": 'export { selected as again } from "./keys.ts";\n',
      "main.ts": [
        'import { selected } from "./keys.ts";',
        'import * as keys from "./keys.ts";',
        'import { again } from "./again.ts";',
        'export const picked = [selected === "used", keys.selected === "viaNamespace", again === "viaReexport"];',
        "",
      ].join("\n"),
    });

    expect(found.filter((one) => one.includes("Payload."))).toEqual(["DS1003 Payload.extra"]);
  });
});
