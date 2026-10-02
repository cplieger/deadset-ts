import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { emitterInputOf } from "../../__test-helpers__/emitter-input.ts";
import { fixture } from "../../__test-helpers__/fixtures.ts";
import type { Config } from "../config.ts";
import { resolve } from "../resolve.ts";
import type { PlacedFinding } from "./completion.ts";
import { findingsOf } from "./emitters.ts";

/** The configuration one target's own document resolves to. */
function configOf(target: string): Config {
  const path = join(target, "deadset.json");
  return resolve({ repository: readFileSync(path, "utf8"), repositoryLabel: path }).config;
}

/** Each finding as its code, its subject and the component it is placed in. */
function placements(findings: readonly PlacedFinding[]): string[] {
  return findings.map(
    ({ code, symbol, component }) =>
      `${code} ${symbol.name} ${component.id}${component.root ? " root" : ""} ${String(component.symbolCount)} ${String(component.deletableLines)}`,
  );
}

describe("the placement of every family's findings in their components", () => {
  it("keeps a dead subject's computed component and numbers a live subject's own past them, across families", () => {
    const target = fixture("projects", "reads-and-writes");
    const input = emitterInputOf(target, configOf(target));

    expect(input.swept.sweep.components).toHaveLength(5);
    expect(placements(findingsOf(input))).toEqual([
      "DS1002 Unused deadset-ts/c-0005 root 3 4",
      "DS1104 Flag deadset-ts/c-0006 root 1 4",
      "DS1301 written deadset-ts/c-0007 root 1 1",
      "DS1301 shared deadset-ts/c-0008 root 1 1",
      "DS1301 Gauge.#samples deadset-ts/c-0009 root 1 1",
      "DS1301 slots deadset-ts/c-0010 root 1 1",
      "DS1302 Mode.Write deadset-ts/c-0004 root 1 1",
      "DS1303 first<T> deadset-ts/c-0001 root 1 1",
      "DS1303 Box.open<V> deadset-ts/c-0002 root 1 1",
    ]);
  });

  it("places a dead subject its emitter names no component for in the component it falls in", () => {
    const target = fixture("projects", "interfaces");
    const placed = placements(findingsOf(emitterInputOf(target, configOf(target))));

    expect(placed).toContain("DS1201 Unused deadset-ts/c-0001 root 3 4");
    expect(placed).toContain("DS1201 OnlyDead deadset-ts/c-0002 3 6");
  });

  describe("over a manifest row", () => {
    const root = mkdtempSync(join(tmpdir(), "deadset-ts-completion-"));
    cpSync(fixture("projects", "dependencies"), root, { recursive: true });
    renameSync(join(root, "installed"), join(root, "node_modules"));
    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it("gives each unused dependency a component of its own, as the finding schema requires", () => {
      const input = emitterInputOf(root, configOf(root));
      const rows = findingsOf(input).filter((finding) => finding.code === "DS1601");

      expect(input.swept.sweep.components).toHaveLength(2);
      expect(placements(rows)).toEqual([
        "DS1601 unused-runtime deadset-ts/c-0003 root 1 1",
        "DS1601 @types/bundled deadset-ts/c-0004 root 1 1",
        "DS1601 optional-peer deadset-ts/c-0005 root 1 1",
        "DS1601 unused-dev deadset-ts/c-0006 root 1 1",
        "DS1601 peer-unused deadset-ts/c-0007 root 1 1",
      ]);
    });
  });
});
