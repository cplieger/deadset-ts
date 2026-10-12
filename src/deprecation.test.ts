import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { deprecatedDeclarations } from "./deprecation.ts";
import { discoverProjects } from "./discover.ts";
import { inventory } from "./inventory.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine, runSession, type Engine } from "./session.ts";

/**
 * The display names of the deprecated declarations of one written project, of those whose
 * marker went unanswered, and what reading them cost. `panicsOn` names the questions the
 * compiler server fails, by accessor.
 */
function deprecatedIn(
  files: Readonly<Record<string, string>>,
  panicsOn: (accessor: string) => boolean = () => false,
): {
  readonly names: readonly string[];
  readonly unanswered: readonly string[];
  readonly requests: number;
} {
  const root = writeProject(files);
  try {
    const host = nodeHost();
    const opened = openEngine({ collectTiming: true });
    const engine: Engine = {
      ...opened,
      ask: (accessor, locations, question) => {
        if (panicsOn(accessor)) {
          throw new Error(`panic: ${accessor}`);
        }
        return opened.ask(accessor, locations, question);
      },
    };
    const configFiles = discoverProjects(engine, host, scopeForDir(host, root)).configFiles;
    let requests = 0;
    const { projects } = runSession(engine, configFiles, (project) => {
      const held = inventory(project, host, root);
      const before = engine.getTimingInfo().totals.requestCount;
      const found = deprecatedDeclarations(project, held);
      requests += engine.getTimingInfo().totals.requestCount - before;
      const named = (ids: readonly string[]): string[] =>
        held.symbols.filter((symbol) => ids.includes(symbol.id)).map((symbol) => symbol.name);
      return { names: named(found.deprecated), unanswered: named(found.unanswered) };
    });
    return {
      names: projects.flatMap((one) => one.names),
      unanswered: projects.flatMap((one) => one.unanswered),
      requests,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A module holding one deprecated function beside a current one. */
const MARKED = {
  "src/a.ts": [
    "/** @deprecated use fresh */",
    "export function old(): number { return 1; }",
    "/** Current. */",
    "export function fresh(): number { return 2; }",
    "",
  ].join("\n"),
};

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

  it("cost no request where the documentation holds other tags alone", () => {
    const { names, requests } = deprecatedIn({
      "src/a.ts": [
        "/** @remarks covers both names */",
        "export const first = 1,",
        "  second = 2;",
        "/** @see first */",
        "export function fresh(): number { return 2; }",
        "",
      ].join("\n"),
    });

    expect(names).toEqual([]);
    expect(requests).toBe(0);
  });

  it("are read for a symbol merged across files where one file's declaration holds the tag", () => {
    const { names } = deprecatedIn({
      "src/a.ts":
        "export {};\ndeclare global {\n  /** @deprecated use Fresh */\n  interface Legacy {\n    a: number;\n  }\n}\n",
      "src/b.ts": "export {};\ndeclare global {\n  interface Legacy {\n    b: number;\n  }\n}\n",
    });

    expect(names).toEqual(["global.Legacy", "global.Legacy"]);
  });
  it("are unknown for every declaration of a file holding the tag whose symbol went unanswered", () => {
    const { names, unanswered } = deprecatedIn(
      MARKED,
      (accessor) => accessor === "getSymbolAtLocation",
    );

    expect(names, "the tag is read from the tree for a declaration list alone").toEqual([]);
    expect(unanswered).toEqual(["old", "fresh"]);
  });

  it("are unknown for every declaration whose symbol's tags went unanswered", () => {
    const { names, unanswered } = deprecatedIn(MARKED, (accessor) => accessor === "getJsDocTags");

    expect(names).toEqual([]);
    expect(unanswered).toEqual(["old", "fresh"]);
  });

  it("are known for every declaration the checker answered", () => {
    expect(deprecatedIn(MARKED)).toMatchObject({ names: ["old"], unanswered: [] });
  });
});
