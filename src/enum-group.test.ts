import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { runSweep } from "./analysis.ts";
import { resolve } from "./resolve.ts";
import { run, type Writer } from "./run.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine } from "./session.ts";

const TARGET = fixture("projects", "reads-and-writes-enum-group");

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

describe("enum-group", () => {
  const { config } = resolve({
    repository: JSON.stringify({ target: { kind: "application" } }),
    repositoryLabel: "deadset.json",
  });
  const host = nodeHost();
  const swept = runSweep(
    openEngine({ collectTiming: false }),
    host,
    scopeForDir(host, TARGET),
    config,
    {
      marked: [],
      mode: { production: true },
    },
  );
  const nameOf = (id: string): string =>
    swept.matrix.union.symbols.find((symbol) => symbol.id === id)?.name ?? id;

  it("holds back each member a conversion can produce, with the conversion it found", () => {
    expect(
      swept.retained
        .filter((record) => record.class === "enum-group")
        .map((record) => `${nameOf(record.id)} ${record.detail}`),
    ).toEqual([
      "Angle.B converted from number",
      "Named.Y converted from string",
      "Returned.Q converted from number",
      "Spaced.N1 looked up by an element access on Spaced",
      "Spaced.N2 looked up by an element access on Spaced",
    ]);
  });

  it("leaves dead a member of an enum looked up by literal keys or asserted from its own member", () => {
    expect(swept.sweep.candidates.map((candidate) => nameOf(candidate.id))).toEqual([
      "Keyed.K2",
      "Self.S2",
    ]);
  });
});

describe("print-retained over a project whose enums each conversion form produces", () => {
  it("prints each member held back with its conversion, and exits 0", async () => {
    const out = new MemoryWriter();
    const err = new MemoryWriter();

    expect(run(["print-retained", `--target=${TARGET}`], out, err, nodeHost())).toBe(0);
    expect(err.text).toBe("");
    await expect(
      out.text,
      "regenerate with `npx vitest --run -u src/enum-group.test.ts` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "reads-and-writes-enum-group.retained.txt"));
  });
});
