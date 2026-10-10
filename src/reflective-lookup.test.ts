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

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

describe("reflective lookup", () => {
  const swept = sweepFixture();

  it("retains each member a literal key of an element access or a global Reflect call spells, at the key, unless a typed key reads it", () => {
    expect(
      swept.retained
        .filter((held) => held.class === "reflective-lookup")
        .map((held) => {
          const name = swept.matrix.union.symbols.find((symbol) => symbol.id === held.id)?.name;
          return `${name ?? held.id} ${held.site.path}:${String(held.site.line)}:${String(held.site.column)} ${held.detail}`;
        }),
    ).toEqual([
      'Server.refresh src/main.ts:11:8 looked up by ["refresh"]',
      "Server.hidden src/main.ts:14:21 looked up by Reflect.has",
    ]);
  });

  it("holds back nothing a computed key, a local Reflect or a private name's spelling reaches", () => {
    const dead = swept.sweep.candidates.map(
      (candidate) =>
        swept.matrix.union.symbols.find((symbol) => symbol.id === candidate.id)?.name ?? "",
    );

    expect(dead).toContain("Server.restart");
    expect(dead).toContain("Server.#token");
  });
});

describe("print-retained over a project whose templates and keys name members", () => {
  it("prints both low-confidence classes' records and exits 0", async () => {
    const out = new MemoryWriter();
    const err = new MemoryWriter();

    expect(run(["print-retained", `--target=${TARGET}`], out, err, nodeHost())).toBe(0);
    expect(err.text).toBe("");
    await expect(
      out.text,
      "regenerate with `npx vitest --run -u src/reflective-lookup.test.ts` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "named-members.retained.txt"));
  });
});
