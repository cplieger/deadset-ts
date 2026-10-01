import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { runRoots, runSweep, type RunSweep } from "./analysis.ts";
import { resolve } from "./resolve.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine } from "./session.ts";

const TARGET = fixture("projects", "two-configurations");

/** The fixture's configuration document, resolved. */
function fixtureConfig(): ReturnType<typeof resolve> {
  const document = join(TARGET, "deadset.json");
  return resolve({ repository: readFileSync(document, "utf8"), repositoryLabel: document });
}

/**
 * The fixture whose two compiler configurations share one module, swept once for every
 * case below in the mode a report is built in.
 */
const SWEPT = ((): RunSweep => {
  const host = nodeHost();
  return runSweep(
    openEngine({ collectTiming: false }),
    host,
    scopeForDir(host, TARGET),
    fixtureConfig().config,
    { marked: [], mode: { production: true } },
  );
})();

/** Each declaration of the run by identifier, spelled by its file and display name. */
const NAMES = new Map(
  SWEPT.matrix.union.symbols.map((symbol) => [symbol.id, `${symbol.position.path}#${symbol.name}`]),
);

function named(ids: readonly string[]): string[] {
  return ids.map((id) => NAMES.get(id) ?? id);
}

/** Each candidate of the run, with the configurations it is dead in. */
function candidates(): string[] {
  return SWEPT.sweep.candidates.map(
    (candidate) =>
      `${NAMES.get(candidate.id) ?? candidate.id} ${candidate.configurations.join(",")}`,
  );
}

describe("a run over two compiler configurations", () => {
  it("names the configurations in the order the matrix lists them", () => {
    expect(SWEPT.matrix.configurations, "the scripts' configuration first, as declared").toEqual([
      "scripts",
      "app",
    ]);
  });

  it("reports only what is dead in every configuration that holds it, naming each", () => {
    expect(
      candidates(),
      "a function only the script uses is dead in the application and live in the " +
        "scripts' configuration, so it is no candidate, and the same holds the other way",
    ).toEqual([
      "src/main.ts#appOnlyDead app",
      "src/shared.ts#deadEverywhere scripts,app",
      "src/shared.ts#deadCaller scripts,app",
      "src/shared.ts#deadCallee scripts,app",
    ]);
  });

  it("records the relations that hold a declaration live in any configuration", () => {
    const id = [...NAMES].find(([, name]) => name === "src/shared.ts#usedByScript")?.[0] ?? "";

    expect(
      SWEPT.sweep.liveUnder.get(id),
      "dead under both in the application, live under both in the scripts' configuration",
    ).toEqual(["reference-counting", "reachability"]);
  });

  it("holds each declaration in the configurations whose project compiles its file", () => {
    const heldIn = (name: string): readonly string[] => {
      const at = SWEPT.matrix.union.symbols.findIndex(
        (symbol) => `${symbol.position.path}#${symbol.name}` === name,
      );
      return SWEPT.matrix.heldIn[at] ?? [];
    };

    expect(heldIn("src/shared.ts#usedByScript")).toEqual(["scripts", "app"]);
    expect(heldIn("src/main.ts#appOnlyLive"), "judged in the one project that holds it").toEqual([
      "app",
    ]);
  });

  it("counts a reference both configurations make at one position once", () => {
    const callee = SWEPT.sweep.candidates.find(
      (candidate) => NAMES.get(candidate.id) === "src/shared.ts#deadCallee",
    );

    expect(callee?.productionRefs, "one call, compiled by both configurations").toBe(1);
    expect(callee?.relation).toBe("reachability");
  });

  it("groups the run's dead set into components once, each identifier once", () => {
    const components = SWEPT.sweep.components;
    const ids = components.map((component) => component.id);

    expect(new Set(ids).size, `one identifier per component of the run: ${ids.join(" ")}`).toBe(
      ids.length,
    );
    expect(components.map((component) => named(component.members))).toEqual([
      ["src/main.ts#appOnlyDead"],
      ["src/shared.ts#deadEverywhere"],
      ["src/shared.ts#deadCaller"],
      ["src/shared.ts#deadCallee"],
    ]);
    expect(components.map((component) => component.id)).toEqual([
      "deadset-ts/c-0001",
      "deadset-ts/c-0002",
      "deadset-ts/c-0003",
      "deadset-ts/c-0004",
    ]);
  });

  it("names the configurations of the root set in the same order", () => {
    const host = nodeHost();
    const { config, provenance } = fixtureConfig();

    expect(
      runRoots(
        openEngine({ collectTiming: false }),
        host,
        scopeForDir(host, TARGET),
        config,
        provenance,
      ).configurations,
    ).toEqual(["scripts", "app"]);
  });
});
