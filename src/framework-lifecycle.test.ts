import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { runSweep, type RunSweep } from "./analysis.ts";
import { resolve } from "./resolve.ts";
import { run, type Writer } from "./run.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine } from "./session.ts";

const TARGET = fixture("projects", "framework-lifecycle");

/** The fixture swept for production, under its own configuration or the one given. */
function sweepFixture(document?: string): RunSweep {
  const path = join(TARGET, "deadset.json");
  const { config } = resolve({
    repository: document ?? readFileSync(path, "utf8"),
    repositoryLabel: path,
  });
  const host = nodeHost();
  return runSweep(openEngine({ collectTiming: false }), host, scopeForDir(host, TARGET), config, {
    marked: [],
    mode: { production: true },
  });
}

/** The display name of one declaration of the run. */
function nameOf(swept: RunSweep, id: string): string {
  return swept.matrix.union.symbols.find((symbol) => symbol.id === id)?.name ?? id;
}

/** Each record of the class, with its declaration, site and detail. */
function called(swept: RunSweep): string[] {
  return swept.retained
    .filter((held) => held.class === "framework-lifecycle")
    .map(
      (held) =>
        `${nameOf(swept, held.id)} ${held.site.path}:${String(held.site.line)}:${String(held.site.column)} ${held.detail}`,
    );
}

/** Each member the sweep reports dead. */
function deadMembers(swept: RunSweep): string[] {
  return swept.sweep.candidates
    .map((candidate) => nameOf(swept, candidate.id))
    .filter((name) => name.includes("."));
}

/** The fixture's configuration with the decorator class off, and with the contracts given. */
function withoutDecorator(contracts?: unknown): string {
  const own = JSON.parse(readFileSync(join(TARGET, "deadset.json"), "utf8")) as {
    ts: { lifecycle_contracts: unknown };
  };
  return JSON.stringify({
    target: { kind: "application" },
    exemptions: { disabled: ["decorator"] },
    ts: { lifecycle_contracts: contracts ?? own.ts.lifecycle_contracts },
  });
}

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

describe("framework-lifecycle", () => {
  it("retains each listed member of a component, by its base, its registration or its decorator", () => {
    expect(called(sweepFixture())).toEqual([
      "Counter.observedAttributes src/elements.ts:4:30 extends HTMLElement",
      "Counter.observedAttributes src/main.ts:7:36 registered by CustomElementRegistry.define",
      "Counter.connectedCallback src/elements.ts:4:30 extends HTMLElement",
      "Counter.connectedCallback src/main.ts:7:36 registered by CustomElementRegistry.define",
      "Counter.attributeChangedCallback src/elements.ts:4:30 extends HTMLElement",
      "Counter.attributeChangedCallback src/main.ts:7:36 registered by CustomElementRegistry.define",
      "Base.disconnectedCallback src/elements.ts:15:27 extends HTMLElement",
      "Fancy.connectedCallback src/elements.ts:20:28 extends HTMLElement",
      "Panel.mount src/views.ts:6:1 decorated by @view",
      "Panel.unmount src/views.ts:6:1 decorated by @view",
      "Dialog.mount src/views.ts:22:10 registered by register",
    ]);
  });

  it("reports a member no contract lists and a listed name on a class that is no component", () => {
    expect(deadMembers(sweepFixture(withoutDecorator()))).toEqual([
      "Counter.increment",
      "Fancy.render",
      "Plain.connectedCallback",
      "Panel.hidden",
      "Dialog.close",
      "Loose.mount",
    ]);
  });

  it("makes no class a component where the configuration declares no framework", () => {
    const swept = sweepFixture(withoutDecorator([]));

    expect(called(swept)).toEqual([]);
    expect(deadMembers(swept)).toContain("Counter.connectedCallback");
    expect(deadMembers(swept)).toContain("Panel.mount");
  });
});

describe("print-retained over a project whose classes are a framework's components", () => {
  it("prints each lifecycle member with what makes its class a component, and exits 0", async () => {
    const out = new MemoryWriter();
    const err = new MemoryWriter();

    expect(run(["print-retained", `--target=${TARGET}`], out, err, nodeHost())).toBe(0);
    expect(err.text).toBe("");
    await expect(
      out.text,
      "regenerate with `npx vitest --run -u src/framework-lifecycle.test.ts` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "framework-lifecycle.retained.txt"));
  });
});
