import { describe, expect, it } from "vitest";
import { CONVENTION_ROWS } from "./convention-rows.ts";
import { satisfies } from "./version-range.ts";

const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u;
const PLACEHOLDER = /<([A-Za-z]+)>/gu;

/** The framework plugin calls a Vite configuration writes, each as `module export`. */
const PLUGIN_CALLS = [
  "@builder.io/qwik-city/vite qwikCity",
  "@builder.io/qwik/optimizer qwikVite",
  "@remix-run/dev unstable_vitePlugin",
  "@remix-run/dev vitePlugin",
  "@solidjs/start/config solidStart",
  "@sveltejs/kit/vite sveltekit",
];

/** Every placeholder one template writes. */
function placeholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "");
}

describe("the convention rows", () => {
  it("are named as the configuration spells a row, and ordered by name", () => {
    const names = CONVENTION_ROWS.map((row) => row.name);

    expect(names.filter((name) => !NAME.test(name))).toEqual([]);
    expect(names).toEqual([...names].sort());
  });

  it("each carry a range some version satisfies", () => {
    for (const row of CONVENTION_ROWS) {
      const lowest = /\d+\.\d+\.\d+/u.exec(row.range)?.[0] ?? "";

      expect(satisfies(lowest, row.range), `${row.name} ${row.range}`).toBe(true);
    }
  });

  it("read options only from a plugin call a framework's Vite configuration writes", () => {
    const unknown = CONVENTION_ROWS.flatMap((row) =>
      row.moves.flatMap((move) =>
        move.readings.flatMap(({ call }) =>
          call === undefined || PLUGIN_CALLS.includes(`${call.module} ${call.export}`)
            ? []
            : [`${row.name} ${move.id}: ${call.module} ${call.export}`],
        ),
      ),
    );

    expect(unknown).toEqual([]);
  });

  it("of one name cover disjoint ranges", () => {
    for (const row of CONVENTION_ROWS) {
      const others = CONVENTION_ROWS.filter((one) => one !== row && one.name === row.name);
      const bounds = [...row.range.matchAll(/\d+\.\d+\.\d+/gu)].map((match) => match[0]);
      for (const other of others) {
        for (const version of bounds.filter((one) => satisfies(one, row.range))) {
          expect(satisfies(version, other.range), `${row.name} ${version}`).toBe(false);
        }
      }
      expect(new Set(others.map((one) => one.package)).size).toBeLessThanOrEqual(1);
    }
  });

  it("write a placeholder only for a move declared before it is read", () => {
    for (const row of CONVENTION_ROWS) {
      const declared: string[] = [];
      for (const move of row.moves) {
        const read = [...(move.base === undefined ? [] : [move.base]), ...move.defaults];

        expect(read.flatMap(placeholders).filter((id) => !declared.includes(id))).toEqual([]);
        expect(declared, `${row.name} declares ${move.id} twice`).not.toContain(move.id);
        declared.push(move.id);
      }
      const globs = [...row.entries, ...(row.excludes ?? [])];

      expect(globs.flatMap(placeholders).filter((id) => !declared.includes(id))).toEqual([]);
    }
  });
});
