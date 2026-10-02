import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { deprecatedDeclarations } from "./deprecation.ts";
import { discoverProjects } from "./discover.ts";
import { inventory } from "./inventory.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine, runSession } from "./session.ts";

/** The display names of the deprecated declarations of one written project, and what reading them cost. */
function deprecatedIn(files: Readonly<Record<string, string>>): {
  readonly names: readonly string[];
  readonly requests: number;
} {
  const root = writeProject(files);
  try {
    const host = nodeHost();
    const engine = openEngine({ collectTiming: true });
    const configFiles = discoverProjects(engine, host, scopeForDir(host, root)).configFiles;
    let requests = 0;
    const { projects } = runSession(engine, configFiles, (project) => {
      const held = inventory(project, host, root);
      const before = engine.getTimingInfo().totals.requestCount;
      const ids = new Set(deprecatedDeclarations(project, held));
      requests += engine.getTimingInfo().totals.requestCount - before;
      return held.symbols.filter((symbol) => ids.has(symbol.id)).map((symbol) => symbol.name);
    });
    return { names: projects.flat(), requests };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("deprecated declarations", () => {
  it("are the declarations whose documentation carries the tag, each name of a list included", () => {
    const { names } = deprecatedIn({
      "src/a.ts": [
        "/**",
        " * Replaced.",
        " *",
        " * @deprecated use fresh",
        " */",
        "export function old(): number { return 1; }",
        "/** Current. */",
        "export function fresh(): number { return 2; }",
        "// @deprecated in a line comment, which is no documentation",
        "export function lineComment(): number { return 3; }",
        "/** @deprecatedish */",
        "export function near(): number { return 4; }",
        "/**",
        " * @deprecated covers both names",
        " */",
        "export const first = 1,",
        "  second = 2;",
        "export class Counter {",
        "  /**",
        "   * @deprecated",
        "   */",
        "  get value(): number { return 1; }",
        "  set value(_v: number) {}",
        "  live = 0;",
        "}",
        "export interface Shape {",
        "  /**",
        "   * @deprecated",
        "   */",
        "  area: number;",
        "}",
        "export { old as renamed };",
        "",
      ].join("\n"),
    });

    expect(names).toEqual(["old", "first", "second", "Counter.value", "Shape.area"]);
  });

  it("are read from every declaration of a symbol, so each overload carries one signature's tag", () => {
    const { names } = deprecatedIn({
      "src/a.ts": [
        "/** @deprecated pass a number */",
        "export function over(a: string): void;",
        "export function over(a: number): void;",
        "export function over(_a: unknown): void {}",
        "",
      ].join("\n"),
    });

    expect(names).toEqual(["over", "over", "over"]);
  });

  it("cost no request in a project whose files hold no tag", () => {
    const { names, requests } = deprecatedIn({
      "src/a.ts": "/** Current. */\nexport function fresh(): number { return 2; }\n",
    });

    expect(names).toEqual([]);
    expect(requests).toBe(0);
  });
});
