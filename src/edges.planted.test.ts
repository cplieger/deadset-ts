import { describe, expect, it, vi } from "vitest";
import { negativeDocument } from "../__test-helpers__/fixtures.ts";
import type * as Generated from "./contract/config.generated.ts";
import { EDGES_FILE, readEdgeSides } from "./edges.ts";
import type { Host } from "./host.ts";
import { joinPath } from "./paths.ts";

/** The generated edges schema with one edge member and one identifier form the Contract lacks. */
vi.mock("./contract/config.generated.ts", async (original) => {
  const actual = await original<typeof Generated>();
  const schema = structuredClone(actual.EDGES_SCHEMA) as {
    properties: { edges: { additionalProperties: { properties: Record<string, unknown> } } };
    $defs: { edge_identifier: { pattern: string } };
  };
  schema.properties.edges.additionalProperties.properties["line"] = { type: "integer" };
  schema.$defs.edge_identifier.pattern = "^[A-Za-z /]+$";
  return { ...actual, EDGES_SCHEMA: schema };
});

const ROOT = "/target";

function hostWith(document: string): Host {
  const held = (path: string): boolean => path === joinPath(ROOT, EDGES_FILE);
  return {
    workingDirectory: () => ROOT,
    readFile: (path) => (held(path) ? document : ""),
    readDirectory: () => [],
    kindOf: (path) => (held(path) ? "file" : "absent"),
    realPath: (path) => path,
    analyzerVersion: () => "0.0.0-devel",
    temporaryDirectory: () => {
      throw new Error("no temporary directory");
    },
    componentMapperCommand: () => [],
    writeDocument: (path) => {
      throw new Error(`${path}: this host writes nothing`);
    },
  };
}

describe("the edges document under an edited generated schema", () => {
  it("admits the member the schema now declares", () => {
    expect(readEdgeSides(hostWith(negativeDocument("edges-unknown-member.json")), ROOT)).toEqual([
      {
        edge: "wire/ServerEvent",
        side: "used_by",
        symbol: "ts://@example/app/src/wire.ts#ServerEvent",
      },
    ]);
  });

  it("takes the identifier form the schema now states", () => {
    expect(readEdgeSides(hostWith(negativeDocument("edges-identifier-form.json")), ROOT)).toEqual([
      { edge: "wire event", side: "used_by", symbol: "ts://@example/app/src/wire.ts#ServerEvent" },
    ]);
  });
});
