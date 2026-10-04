import { describe, expect, it } from "vitest";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { analyzeRoot } from "../__test-helpers__/projects.ts";
import { DECLINED_CONVENTIONS } from "./entry-point-gaps.ts";

/**
 * The fixture holding one file each of the rules enters, beside a worker a computed
 * path addresses and a constructor of the target's own named like the platform's,
 * analyzed once for every case here.
 */
const ENTRY_RULES = analyzeRoot(fixture("projects", "entry-rules"), {
  references: { testFiles: ["**/*.test.{ts,tsx,mts,cts}"] },
  roots: {
    patterns: [],
    entryFiles: [],
    testFiles: ["**/*.test.{ts,tsx,mts,cts}"],
    publishedAPI: false,
  },
});
const SYMBOLS = ENTRY_RULES.inventories[0]?.symbols ?? [];
const ROOTS = ENTRY_RULES.roots[0]?.liveUnderReachability ?? [];

/** The rules that root each file of the fixture, by the file's path. */
function rulesRooting(path: string): string[] {
  const file = SYMBOLS.find((symbol) => symbol.kind === "file" && symbol.position.path === path);
  return ROOTS.filter((root) => root.id === file?.id).map((root) => `${root.kind} ${root.source}`);
}

describe("the entry-point rules", () => {
  it.each([
    [
      "vitest.config.ts",
      ["configuration-file <stem>.config.<ext>", "configuration-string ./vitest.config.ts"],
    ],
    ["setup.ts", ["configuration-string ./setup.ts"]],
    ["src/unit.test.ts", ["test-runner **/*.test.{ts,tsx,mts,cts}"]],
    ["eslint.config.mjs", ["configuration-file <stem>.config.<ext>"]],
    ["eslint.base.mjs", ["configuration-string ./eslint.base.mjs"]],
    ["define.ts", ["configuration-string ./define.ts"]],
    ["vitest.stryker.config.ts", ["configuration-file <stem>.<qualifier>.config.<ext>"]],
    ["playwright.config.ts", ["configuration-file <stem>.config.<ext>"]],
    ["vitest.workspace.ts", ["test-runner vitest.workspace.*"]],
    ["stryker.conf.mjs", ["mutation-testing stryker.conf.*"]],
    [
      "e2e/home.spec.ts",
      ["browser-tests **/*.{spec,test}.{js,ts,jsx,tsx,cjs,cts,cjsx,ctsx,mjs,mts,mjsx,mtsx}"],
    ],
    ["src/sw.ts", ["worker ./sw.ts"]],
    ["src/worker.ts", ["worker ./worker.ts"]],
  ])("roots %s", (path, rules) => {
    expect(rulesRooting(path)).toEqual(rules);
  });

  it("roots what a configuration file exports, which the tool reads", () => {
    const defaults = SYMBOLS.filter(
      (symbol) =>
        symbol.parent !== "" &&
        !symbol.position.path.includes("/") &&
        symbol.position.path.endsWith(".config.ts"),
    ).map((symbol) => symbol.id);

    expect(defaults.length, "each of the three configurations has a default export").toBe(3);
    expect(defaults.every((id) => ROOTS.some((root) => root.id === id))).toBe(true);
  });

  it.each([
    ["src/computed.ts", "a worker addressed by a computed path"],
    ["src/fake.ts", "a file a constructor of the target's own names"],
    ["e2e/helper.ts", "a file below the test directory that the test pattern does not match"],
    ["src/outside.spec.ts", "a file the test pattern matches outside the test directory"],
    ["nested/vitest.config.ts", "a configuration name in a directory that holds no manifest"],
    ["nested/nested-setup.ts", "a file only such a file's string names"],
  ])("does not root %s, %s", (path) => {
    expect(rulesRooting(path)).toEqual([]);
  });

  it("still references a file the lint configuration imports, through the import", () => {
    const base = SYMBOLS.find(
      (symbol) => symbol.position.path === "eslint.base.mjs" && symbol.parent !== "",
    );
    const reached = (ENTRY_RULES.references[0]?.references ?? []).filter(
      (reference) => reference.to === base?.id,
    );

    expect(reached.map((reference) => reference.position.path)).toEqual(["eslint.config.mjs"]);
  });
});

describe("the declined entry-point conventions", () => {
  it("name tools whose conventions no rule enters, each with a reason", () => {
    const tools = new Set(DECLINED_CONVENTIONS.map((row) => row.tool));

    expect(tools.has("jest"), "a test runner no rule reads").toBe(true);
    expect(tools.has("storybook"), "a convention outside the test runners").toBe(true);
    expect(DECLINED_CONVENTIONS.every((row) => row.reason.trim() !== "")).toBe(true);
  });

  it("decline only the conventions of a tool that no rule enters", () => {
    const whole = DECLINED_CONVENTIONS.filter((row) =>
      row.convention.startsWith("its configuration and every file"),
    ).map((row) => row.tool);

    expect(whole).not.toContain("vitest");
    expect(whole).not.toContain("eslint");
    expect(whole).not.toContain("stryker");
    expect(whole).not.toContain("playwright");
  });

  it("are ordered by tool and then by convention, each once", () => {
    const keys = DECLINED_CONVENTIONS.map((row) => `${row.tool}\u0000${row.convention}`);

    expect(keys).toEqual([...new Set(keys)].sort());
  });
});
