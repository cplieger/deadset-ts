import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { contractDocument, fixture } from "../__test-helpers__/fixtures.ts";
import { runSweep, type RunSweep } from "./analysis.ts";
import { listing, type Component } from "./components.ts";
import type { InventorySymbol } from "./inventory.ts";
import { matrixOf, sweepMatrix } from "./matrix.ts";
import type { Reference } from "./references.ts";
import { resolve } from "./resolve.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine } from "./session.ts";

/**
 * The fixture holding one instance of each component shape, swept once in the mode a
 * report is built in, for every case below.
 */
const COMPONENTS = ((): RunSweep => {
  const target = fixture("projects", "components");
  const document = join(target, "deadset.json");
  const { config } = resolve({
    repository: readFileSync(document, "utf8"),
    repositoryLabel: document,
  });
  const host = nodeHost();
  return runSweep(openEngine({ collectTiming: false }), host, scopeForDir(host, target), config, {
    marked: [],
    mode: { production: true },
  });
})();

/** The fixture's declarations by identifier, each spelled by its file and display name. */
const NAMES = new Map(
  COMPONENTS.matrix.union.symbols.map((symbol) => [
    symbol.id,
    `${symbol.position.path}#${symbol.name}`,
  ]),
);

function named(ids: readonly string[]): string[] {
  return ids.map((id) => NAMES.get(id) ?? id);
}

/** The component whose members include the declaration one name spells. */
function componentOf(name: string): Component | undefined {
  return COMPONENTS.sweep.components.find((component) => named(component.members).includes(name));
}

/** The golden table: one line per component, so a diff names the component that moved. */
function goldenText(swept: RunSweep): string {
  const refs = new Map(swept.matrix.union.symbols.map((symbol) => [symbol.id, symbol.ref]));
  const spelled = (ids: readonly string[]): string =>
    ids.length === 0 ? "-" : ids.map((id) => refs.get(id) ?? id).join(" ");
  return swept.sweep.components
    .map(
      (component) =>
        `${component.id}\tlines=${String(component.deletableLines)}\n` +
        `\troots\t${spelled(component.roots)}\n` +
        `\tmembers\t${spelled(component.members)}\n` +
        `\tfalls\t${spelled(component.falls)}\n`,
    )
    .join("");
}

describe("the dead components of one project", () => {
  it("is the committed golden table, component for component", async () => {
    await expect(
      goldenText(COMPONENTS),
      "the table is produced by the production path; to record a reviewed change run " +
        "`npx vitest --run -u src/components.test.ts` and read the diff as production code",
    ).toMatchFileSnapshot(fixture("golden", "components.components.txt"));
  });

  it("places a dead class's members in the class's component, rooted at the class", () => {
    const held = componentOf("src/types.ts#Unused");

    expect(named(held?.members ?? [])).toEqual([
      "src/types.ts#Unused",
      "src/types.ts#Unused.count",
      "src/types.ts#Unused.bump",
    ]);
    expect(named(held?.roots ?? []), "a member of a dead container is never a root").toEqual([
      "src/types.ts#Unused",
    ]);
    expect(held?.deletableLines, "the class's own lines, its members written inside them").toBe(8);
  });

  it("places a dead interface's members in the interface's component", () => {
    expect(named(componentOf("src/types.ts#Shape")?.members ?? [])).toEqual([
      "src/types.ts#Shape",
      "src/types.ts#Shape.name",
      "src/types.ts#Shape.area",
    ]);
  });

  it("groups a ring of dead functions into one component with every member a root", () => {
    const held = componentOf("src/cycle.ts#first");

    expect(named(held?.members ?? [])).toEqual([
      "src/cycle.ts#first",
      "src/cycle.ts#second",
      "src/cycle.ts#third",
    ]);
    expect(named(held?.roots ?? []), "no dead component outside the ring references one").toEqual(
      named(held?.members ?? []),
    );
  });

  it("puts a test of dead code in the component of the declarations it exercises", () => {
    const admitted = COMPONENTS.sweep.candidates
      .filter((candidate) => candidate.testOfDeadCode)
      .map((candidate) => NAMES.get(candidate.id));

    expect(admitted, "the test referencing only dead declarations, and not the other").toEqual([
      "src/catalog.test.ts#testDeadOnly",
    ]);
    expect(named(componentOf("src/catalog.test.ts#testDeadOnly")?.members ?? [])).toEqual([
      "src/catalog.test.ts#testDeadOnly",
      "src/catalog.ts#deadOne",
      "src/catalog.ts#deadTwo",
    ]);
  });

  it("counts what only a root's component reaches, and not what two roots share", () => {
    expect(named(componentOf("src/shared.ts#left")?.falls ?? [])).toEqual([
      "src/shared.ts#left",
      "src/shared.ts#onlyLeft",
    ]);
    expect(named(componentOf("src/shared.ts#right")?.falls ?? [])).toEqual(["src/shared.ts#right"]);
    expect(
      named(componentOf("src/shared.ts#sharedHelper")?.falls ?? []),
      "the shared helper falls with neither, and is counted by its own component",
    ).toEqual(["src/shared.ts#sharedHelper"]);
  });

  it("orders each component before every component it reaches", () => {
    const place = (name: string): number =>
      COMPONENTS.sweep.components.findIndex((component) => named(component.members).includes(name));

    expect(place("src/shared.ts#left")).toBeLessThan(place("src/shared.ts#onlyLeft"));
    expect(place("src/shared.ts#right")).toBeLessThan(place("src/shared.ts#sharedHelper"));
  });

  it("mints identifiers of the form the finding schema declares, prefixed with this analyzer", () => {
    const schema = contractDocument("finding.schema.json") as {
      properties: { component: { properties: { id: { pattern: string } } } };
    };
    const pattern = new RegExp(schema.properties.component.properties.id.pattern, "u");
    const ids = COMPONENTS.sweep.components.map((component) => component.id);

    expect(ids.filter((id) => !pattern.test(id) || !id.startsWith("deadset-ts/"))).toEqual([]);
    expect(new Set(ids).size, "one identifier per component").toBe(ids.length);
  });
});

describe("the cascade modes", () => {
  const held = componentOf("src/types.ts#Unused");

  it("are the modes the configuration schema declares", () => {
    const schema = contractDocument("config.schema.json") as {
      properties: { reporters: { properties: { cascade: { enum: string[] } } } };
    };

    expect(schema.properties.reporters.properties.cascade.enum).toEqual(["roots", "full"]);
  });

  it("names the roots and what falls by default, and every member in full", () => {
    if (held === undefined) {
      throw new Error("the fixture's dead class has no component");
    }

    expect(listing(held, "roots")).toEqual({
      roots: held.roots,
      members: [],
      symbolCount: 3,
      deletableLines: 8,
    });
    expect(listing(held, "full").members).toEqual(held.members);
  });
});

describe("a chain of dead declarations far longer than any call stack", () => {
  const LINKS = 100_000;

  it("is walked without growing the call stack, one component per link", () => {
    const path = "src/chain.ts";
    const symbols: InventorySymbol[] = Array.from({ length: LINKS }, (_unused, index) => ({
      id: `${path}:${String(index + 1)}:1`,
      ref: `ts://@example/memory/${path}#link${String(index)}`,
      name: `link${String(index)}`,
      kind: "function",
      position: { path, line: index + 1, column: 1 },
      endLine: index + 1,
      parent: "",
      exported: false,
      visibility: "public",
      static: false,
    }));
    const references: Reference[] = symbols.slice(1).map((symbol, index) => ({
      from: symbols[index]?.id ?? "",
      to: symbol.id,
      position: symbol.position,
      use: "read",
      resolution: "batch",
      test: false,
    }));
    const result = sweepMatrix(
      matrixOf([{ configuration: "memory", symbols, references, roots: [], testFiles: [] }]),
      { marked: [], mode: { production: true } },
    );

    expect(result.components.length, "a chain has no cycle").toBe(LINKS);
    expect(result.components[0]?.roots, "the head is where the deletion starts").toEqual([
      symbols[0]?.id,
    ]);
    expect(result.components[0]?.falls.length, "and the whole chain falls with it").toBe(LINKS);
  });
});
