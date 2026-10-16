import { describe, expect, it, vi } from "vitest";
import type { Inputs } from "./config.ts";
import type * as Generated from "./contract/config.generated.ts";
import type { SettingRow } from "./contract/config.generated.ts";
import { resolve } from "./resolve.ts";

/** Rows the Contract's table does not hold today, each a shape resolution must read from its row. */
const PLANTED = vi.hoisted((): readonly SettingRow[] => [
  { key: "reporters.planted_optional", role: "setting", read: true, value: { type: "string" } },
  {
    key: "planted_keyed",
    role: "keyed",
    read: true,
    default: { A: "warn" },
    keyPattern: "^[A-Z]$",
    value: { type: "string" },
  },
]);

vi.mock("./contract/config.generated.ts", async (original) => {
  const actual = await original<typeof Generated>();
  return { ...actual, SETTINGS: [...actual.SETTINGS, ...PLANTED] };
});

function repository(document: Record<string, unknown>): Inputs {
  return {
    repository: {
      text: JSON.stringify({ target: { kind: "library" }, ...document }),
      label: "deadset.json",
    },
  };
}

/** The resolved value at one dotted key, read past the generated type the planted rows are not in. */
function at(config: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>((into, name) => (into as Record<string, unknown> | undefined)?.[name], config);
}

describe("a setting the table marks neither required nor defaulted", () => {
  it("is left unset where no source supplies it", () => {
    const { config, provenance } = resolve(repository({}));

    expect(at(config, "reporters.planted_optional")).toBeUndefined();
    expect(provenance.has("reporters.planted_optional")).toBe(false);
  });

  it("takes the value a source supplies", () => {
    const { config } = resolve(repository({ reporters: { planted_optional: "x" } }));

    expect(at(config, "reporters.planted_optional")).toBe("x");
  });
});

describe("a keyed section whose default names members", () => {
  it("resolves to its default, each member's origin the default", () => {
    const { config, provenance } = resolve(repository({}));

    expect(at(config, "planted_keyed")).toEqual({ A: "warn" });
    expect(provenance.get("planted_keyed.A")).toEqual({ source: "default", label: "" });
    expect(provenance.has("planted_keyed")).toBe(false);
  });

  it("overlays a source's members on its default", () => {
    const { config, provenance } = resolve(repository({ planted_keyed: { B: "deny" } }));

    expect(Object.entries(at(config, "planted_keyed") as object)).toEqual([
      ["A", "warn"],
      ["B", "deny"],
    ]);
    expect(provenance.get("planted_keyed.A")?.source).toBe("default");
    expect(provenance.get("planted_keyed.B")?.source).toBe("repository");
  });
});
