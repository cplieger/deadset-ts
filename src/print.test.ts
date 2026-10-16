import { describe, expect, it } from "vitest";
import { SETTINGS } from "./contract/config.generated.ts";
import { printConfig } from "./print.ts";
import { resolve } from "./resolve.ts";

/** The configuration and provenance one repository configuration resolves to. */
function resolved(document: string): ReturnType<typeof resolve> {
  return resolve({ repository: { text: document, label: "deadset.json" } });
}

describe("the printed configuration", () => {
  it("writes the severity and provenance objects in ascending key order, whatever order they were named in", () => {
    const { config, provenance } = resolved(
      '{"severity":{"DS1301":"warn","DS1602":"deny","DS1001":"allow","DS1202":"warn"},' +
        '"target":{"kind":"library"}}',
    );

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
    expect(Object.keys(printed.provenance)).toEqual(Object.keys(printed.provenance).sort());
    expect(printed.provenance["severity.DS1301"]).toBe("repository: deadset.json");
    expect(printed.provenance["target.kind"]).toBe("repository: deadset.json");
  });

  it("prints one text for one configuration, whatever order its documents write members in", () => {
    const one = resolved(
      '{"target":{"kind":"library"},"analysis":{"template_delimiters":{"left":"[","right":"]"},' +
        '"configurations":[{"id":"a","os":"linux","arch":"amd64"}]}}',
    );
    const other = resolved(
      '{"analysis":{"configurations":[{"arch":"amd64","os":"linux","id":"a"}],' +
        '"template_delimiters":{"right":"]","left":"["}},"target":{"kind":"library"}}',
    );

    expect(printConfig(other.config, other.provenance)).toBe(
      printConfig(one.config, one.provenance),
    );
  });

  it("writes the keys this analyzer reads in the closed key list's order", () => {
    const { config, provenance } = resolved('{"target":{"kind":"library"}}');
    const top = SETTINGS.filter((row) => row.read && !row.key.includes(".")).map((row) => row.key);

    expect(Object.keys(JSON.parse(printConfig(config, provenance)) as object)).toEqual(top);
  });

  it("is a repository configuration that resolves to what it was printed from", () => {
    const { config, provenance } = resolved(
      '{"target":{"kind":{"go":"application","ts":"library"}},"severity":{"DS14":"allow"}}',
    );
    const printed = printConfig(config, provenance);

    expect(resolved(printed).config).toEqual(config);
    expect(printed.endsWith("}\n")).toBe(true);
  });
});
