import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { runSweep, type RunSweep } from "./analysis.ts";
import { defaultConfig } from "./config.ts";
import { discoverProjects } from "./discover.ts";
import type { Evidence } from "./exempt.ts";
import { interfaceSatisfaction } from "./interface-satisfaction.ts";
import { inventory, type Inventory } from "./inventory.ts";
import { resolve } from "./resolve.ts";
import { run, type Writer } from "./run.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine, runSession } from "./session.ts";

const TARGET = fixture("projects", "interface-satisfaction");

/** The fixture swept for production under its own configuration, with the shipped detectors. */
function sweepFixture(): RunSweep {
  const document = join(TARGET, "deadset.json");
  const { config } = resolve({
    repository: readFileSync(document, "utf8"),
    repositoryLabel: document,
  });
  const host = nodeHost();
  return runSweep(openEngine({ collectTiming: true }), host, scopeForDir(host, TARGET), config, {
    marked: [],
    mode: { production: true },
  });
}

/** The display name of each retained record's declaration. */
function retainedNames(swept: RunSweep): string[] {
  return swept.retained.map(
    (held) => swept.matrix.union.symbols.find((symbol) => symbol.id === held.id)?.name ?? held.id,
  );
}

/** The display names of the members the sweep reports dead. */
function deadMembers(swept: RunSweep): string[] {
  return swept.sweep.candidates
    .map(
      (candidate) =>
        swept.matrix.union.symbols.find((symbol) => symbol.id === candidate.id)?.name ?? "",
    )
    .filter((name) => name.includes("."));
}

/** What the detector found over the fixture's one project, and the client requests it made. */
interface Measured {
  readonly held: Inventory;
  readonly evidence: readonly Evidence[];
  readonly requests: number;
}

function measure(): Measured {
  const host = nodeHost();
  const engine = openEngine({ collectTiming: true });
  const { configFiles } = discoverProjects(engine, host, scopeForDir(host, TARGET));
  const { projects } = runSession(engine, configFiles, (project) => {
    const held = inventory(project, host, TARGET);
    const before = engine.getTimingInfo().totals.requestCount;
    const evidence = interfaceSatisfaction({
      project,
      held,
      targetRoot: TARGET,
      templates: { delimiters: { left: "{{", right: "}}" }, files: [] },
      ts: defaultConfig().ts,
      consumers: [],
    });
    return { held, evidence, requests: engine.getTimingInfo().totals.requestCount - before };
  });
  const [only] = projects;
  if (only === undefined) {
    throw new Error("the fixture opened no project");
  }
  return only;
}

describe("interface satisfaction", () => {
  const swept = sweepFixture();

  it("retains the members an interface requires of each class whose value reaches it, by every flow", () => {
    expect(retainedNames(swept)).toEqual([
      "Assigned.area",
      "Passed.label",
      "Returned.label",
      "Returned.size",
      "Stored.area",
      "Pushed.label",
      "Base.label",
      "Boxed.label",
      "Declared.label",
    ]);
  });

  it("reports every member no reached interface requires, and the members of a class whose values reach none", () => {
    expect(deadMembers(swept)).toEqual([
      "Assigned.spare",
      "Passed.spare",
      "Returned.spare",
      "Stored.spare",
      "Pushed.spare",
      "Derived.spare",
      "Declared.spare",
      "Unconverted.area",
      "Unconverted.label",
    ]);
  });

  it("records each member at the place the value flows, the clause for a declared one", () => {
    const sites = swept.retained.map(
      (held) => `${held.detail} ${held.site.path}:${String(held.site.line)}`,
    );

    expect(sites).toEqual([
      "satisfies Shape src/main.ts:27",
      "satisfies Named src/main.ts:37",
      "satisfies Sized src/main.ts:23",
      "satisfies Sized src/main.ts:23",
      "satisfies Shape src/main.ts:28",
      "satisfies Named src/main.ts:30",
      "satisfies Named src/main.ts:38",
      "satisfies Named src/main.ts:39",
      "satisfies Named src/classes.ts:84",
    ]);
  });

  it("asks the client one batch for the positions, one for the pairs, and one question per interface", () => {
    const { requests } = measure();
    // Reading the conversion set: one batched type lookup over the class names, the
    // clause and the values; one target lookup for the first array type a value
    // carries, the project declaring a generic class; one batch of contextual lookups
    // over the seven values whose type is a class of the target.
    const reading = 1 + 1 + 1;
    // The eight pairs, asked in one batch: Assigned, Stored and Shape; Passed, Derived,
    // Boxed<number>, Pushed, Declared and Named; Returned and Sized.
    const pairs = 1;
    // One property list for each of Shape, Named and Sized.
    const interfaces = 3;
    // One property list for each class of a satisfied pair, naming its members.
    const classes = 8;

    expect(requests).toBe(reading + interfaces + pairs + classes);
  });
});

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

describe("print-retained over a project whose values reach interfaces", () => {
  it("prints each held-back member with its class, site and detail, and exits 0", async () => {
    const out = new MemoryWriter();
    const err = new MemoryWriter();

    expect(run(["print-retained", `--target=${TARGET}`], out, err, nodeHost())).toBe(0);
    expect(err.text).toBe("");
    await expect(
      out.text,
      "regenerate with `npx vitest --run -u src/interface-satisfaction.test.ts` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "interface-satisfaction.retained.txt"));
  });
});
