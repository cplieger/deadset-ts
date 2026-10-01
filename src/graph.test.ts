import { describe, expect, it } from "vitest";
import { contractDocument } from "../__test-helpers__/fixtures.ts";
import { swept } from "./graph.ts";
import type { SymbolKind } from "./inventory.ts";

/**
 * Every kind of declaration the inventory enumerates. The record's type makes the list
 * whole: a kind the inventory gains fails the type check here until it is listed.
 */
const KINDS: Readonly<Record<SymbolKind, true>> = {
  file: true,
  function: true,
  class: true,
  interface: true,
  type: true,
  enum: true,
  namespace: true,
  variable: true,
  "export-alias": true,
  method: true,
  "class-member": true,
  "interface-method": true,
  "type-member": true,
  "enum-member": true,
  "type-parameter": true,
};

/** The subject kinds the finding schema gives no liveness relation. */
function relationless(): ReadonlySet<string> {
  const schema = contractDocument("finding.schema.json") as {
    allOf: {
      if?: {
        anyOf?: { properties?: { symbol?: { properties?: { kind?: { enum?: string[] } } } } }[];
      };
      then?: { not?: { required?: string[] } };
    }[];
  };
  const branch = schema.allOf.find((rule) => rule.then?.not?.required?.[0] === "liveness_relation");
  return new Set(branch?.if?.anyOf?.[0]?.properties?.symbol?.properties?.kind?.enum ?? []);
}

describe("the kinds the sweep judges", () => {
  it("are every kind but the ones the finding schema gives no liveness relation", () => {
    const absent = relationless();
    const kinds = Object.keys(KINDS) as SymbolKind[];

    expect(absent.size, "the schema's list is read, not assumed empty").toBeGreaterThan(0);
    expect(
      kinds.filter((kind) => swept(kind) === absent.has(kind)),
      "a kind is judged exactly when a finding about it carries the relation that judged it",
    ).toEqual([]);
  });
});
