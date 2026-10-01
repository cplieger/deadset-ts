import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { runSweep, type RunSweep } from "./analysis.ts";
import { resolve } from "./resolve.ts";
import { run, type Writer } from "./run.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine } from "./session.ts";

const TARGET = fixture("projects", "named-members");

/** The fixture swept for production under its own configuration, with the shipped detectors. */
function sweepFixture(): RunSweep {
  const document = join(TARGET, "deadset.json");
  const { config } = resolve({
    repository: readFileSync(document, "utf8"),
    repositoryLabel: document,
  });
  const host = nodeHost();
  return runSweep(openEngine({ collectTiming: false }), host, scopeForDir(host, TARGET), config, {
    marked: [],
    mode: { production: true },
  });
}

/** One line per record of one class: the declaration's name, the site and the detail. */
function records(swept: RunSweep, exemptionClass: string): string[] {
  return swept.retained
    .filter((held) => held.class === exemptionClass)
    .map((held) => {
      const name = swept.matrix.union.symbols.find((symbol) => symbol.id === held.id)?.name;
      return `${name ?? held.id} ${held.site.path}:${String(held.site.line)}:${String(held.site.column)} ${held.detail}`;
    });
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

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

describe("template field", () => {
  const swept = sweepFixture();

  it("retains each member an action of a configured template names, at the configured delimiters", () => {
    expect(records(swept, "template-field")).toEqual([
      "Page.title templates/page.html:1:8 named by [[title]]",
      "Page.title templates/partial/footer.html:1:12 named by [[title | upper]]",
      "Page.body templates/page.html:2:12 named by [[page.body]]",
    ]);
  });

  it("holds back no private name, no static member, nothing a quoted string or an unclosed action names", () => {
    expect(deadMembers(swept)).toEqual([
      "Page.#secret",
      "Page.subtitle",
      "Page.draft",
      "Page.count",
      "Server.restart",
      "Server.#token",
    ]);
  });

  it("refuses a configured directory the target does not hold, as a usage error", () => {
    const root = writeProject({
      "deadset.json": `${JSON.stringify({
        target: { kind: "application" },
        analysis: { template_dirs: ["templates", "../outside"] },
      })}\n`,
      "src/main.ts": "export const main: number = 1;\n",
      "templates/page.html": "[[ main ]]\n",
    });
    const out = new MemoryWriter();
    const err = new MemoryWriter();
    try {
      expect(run(["print-retained", `--target=${root}`], out, err, nodeHost())).toBe(2);
      expect(out.text).toBe("");
      expect(err.text.split("\n")[0]).toBe(
        'deadset-ts: analysis.template_dirs: "../outside" is not a directory below the target root',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads no directory once the class is switched off", () => {
    const root = writeProject({
      "deadset.json": `${JSON.stringify({
        target: { kind: "application" },
        analysis: { template_dirs: ["absent"] },
        exemptions: { disabled: ["template-field"] },
      })}\n`,
      "src/main.ts": "export const main: number = 1;\n",
    });
    const out = new MemoryWriter();
    const err = new MemoryWriter();
    try {
      expect(run(["print-retained", `--target=${root}`], out, err, nodeHost())).toBe(0);
      expect({ out: out.text, err: err.text }).toEqual({ out: "", err: "" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
