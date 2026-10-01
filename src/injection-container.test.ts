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

const TARGET = fixture("projects", "injection-container");

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
function injected(swept: RunSweep): string[] {
  return swept.retained
    .filter((held) => held.class === "injection-container")
    .map(
      (held) =>
        `${nameOf(swept, held.id)} ${held.site.path}:${String(held.site.line)}:${String(held.site.column)} ${held.detail}`,
    );
}

/** Each member of the services the sweep reports dead. */
function deadMembers(swept: RunSweep): string[] {
  return swept.sweep.candidates
    .map((candidate) => nameOf(swept, candidate.id))
    .filter((name) => /^(Mailer|Clock|Reporter|Plain)\./u.test(name));
}

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

describe("injection-container", () => {
  it("retains each decorated property of a class a container constructs, at what says it does", () => {
    expect(injected(sweepFixture())).toEqual([
      "Mailer.transport src/main.ts:6:22 registered by Container.bind",
      "Clock.zone src/main.ts:8:23 registered by Module",
      "Reporter.sink src/services.ts:21:3 injected by @inject",
    ]);
  });

  it("reports what no container injects once the decorator class is off", () => {
    const swept = sweepFixture(
      JSON.stringify({
        target: { kind: "application" },
        exemptions: { disabled: ["decorator"] },
        ts: {
          injection_registrations: [
            { module: "@example/container", name: "Container.bind" },
            { module: "@example/container", name: "Module" },
          ],
        },
      }),
    );

    expect(deadMembers(swept)).toEqual(["Mailer.helper", "Plain.value"]);
  });

  it("registers no class through a call where the configuration names no registration", () => {
    const swept = sweepFixture(
      JSON.stringify({
        target: { kind: "application" },
        exemptions: { disabled: ["decorator"] },
      }),
    );

    expect(injected(swept)).toEqual(["Reporter.sink src/services.ts:21:3 injected by @inject"]);
    expect(deadMembers(swept)).toEqual([
      "Mailer.transport",
      "Mailer.helper",
      "Clock.zone",
      "Plain.value",
    ]);
  });
});

describe("print-retained over a project whose classes a container constructs", () => {
  it("prints each injected property with the registration that holds it back, and exits 0", async () => {
    const out = new MemoryWriter();
    const err = new MemoryWriter();

    expect(run(["print-retained", `--target=${TARGET}`], out, err, nodeHost())).toBe(0);
    expect(err.text).toBe("");
    await expect(
      out.text,
      "regenerate with `npx vitest --run -u src/injection-container.test.ts` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "injection-container.retained.txt"));
  });
});
