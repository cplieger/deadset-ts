import { rmSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { emitterInputOf } from "../../__test-helpers__/emitter-input.ts";
import { writeProject } from "../../__test-helpers__/projects.ts";
import { resolve } from "../resolve.ts";
import { openEngine, type Engine } from "../session.ts";
import { findingsOf } from "./emitters.ts";

/**
 * One iteration writes a project and sweeps it in a fresh snapshot of one shared client,
 * with the standard library limited to one edition and no ambient type packages, so the
 * draws fit the suite's time bound. The case's own timeout is raised above that bound, so
 * the property's interrupt is what reports a draw that grew too expensive.
 */
const RUNS = 30;

/** The compiler configuration a drawn project carries. */
const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    target: "ESNext",
    lib: ["ES2023"],
    types: [],
    module: "NodeNext",
    moduleResolution: "nodenext",
    noEmit: true,
  },
  include: ["**/*.ts"],
});

/** Where a drawn declaration is written: the module, a namespace, a nested one, or a class. */
type Container = "module" | "namespace" | "nested" | "class";

/** One drawn declaration, which nothing references. */
interface Drawn {
  readonly container: Container;
  /** For a module or namespace declaration: whether its export table names it. */
  readonly exported: boolean;
  /** For a module or namespace declaration: what it declares. */
  readonly shape: "function" | "variable" | "class";
  /** For a class member: its visibility, a private name included. */
  readonly visibility: "public" | "protected" | "private" | "#private";
  readonly member: "method" | "property";
  readonly isStatic: boolean;
}

const drawn: fc.Arbitrary<Drawn> = fc.record({
  container: fc.constantFrom<Container>("module", "namespace", "nested", "class"),
  exported: fc.boolean(),
  shape: fc.constantFrom("function", "variable", "class"),
  visibility: fc.constantFrom("public", "protected", "private", "#private"),
  member: fc.constantFrom("method", "property"),
  isStatic: fc.boolean(),
});

/** The source of one drawn declaration named `name`. */
function sourceOf(one: Drawn, name: string): string {
  if (one.container === "class") {
    const modifier =
      one.visibility === "#private" || one.visibility === "public" ? "" : `${one.visibility} `;
    const spelled = `${modifier}${one.isStatic ? "static " : ""}${one.visibility === "#private" ? "#" : ""}${name}`;
    return one.member === "method" ? `  ${spelled}(): number { return 1; }` : `  ${spelled} = 1;`;
  }
  const keyword = one.exported ? "export " : "";
  switch (one.shape) {
    case "function":
      return `${keyword}function ${name}(): number { return 1; }`;
    case "variable":
      return `${keyword}const ${name} = 1;`;
    case "class":
      return `${keyword}class ${name} {}`;
  }
}

/** The display name the inventory gives one drawn declaration named `name`. */
function displayName(one: Drawn, name: string): string {
  switch (one.container) {
    case "module":
      return name;
    case "namespace":
      return `Space.${name}`;
    case "nested":
      return `Space.Inner.${name}`;
    case "class":
      return `Box.${one.visibility === "#private" ? "#" : ""}${name}`;
  }
}

/** The code the family reports an unreferenced declaration under, by where it sits. */
function codeFor(one: Drawn): string {
  if (one.container === "class") {
    return "DS1003";
  }
  return one.exported ? "DS1001" : "DS1002";
}

/**
 * The project a draw becomes: an entry file that reaches one anchor in each container,
 * so every container is live and every drawn declaration is referenced by nothing.
 */
function projectOf(declarations: readonly Drawn[]): Record<string, string> {
  const placed = (container: Container): string[] =>
    declarations.flatMap((one, at) =>
      one.container === container ? [sourceOf(one, `d${String(at)}`)] : [],
    );
  const indent = (lines: readonly string[], by: string): string[] =>
    lines.map((text) => `${by}${text}`);
  return {
    "tsconfig.json": TSCONFIG,
    "package.json": JSON.stringify({
      name: "@example/drawn",
      private: true,
      type: "module",
      main: "./main.ts",
    }),
    "main.ts": [
      'import { Box, Space } from "./decls.js";',
      "if (new Box().anchor + Space.anchor + Space.Inner.anchor !== 0) {",
      '  throw new Error("an anchor is not zero");',
      "}",
      "",
    ].join("\n"),
    "decls.ts": [
      ...placed("module"),
      "export class Box {",
      "  anchor = 0;",
      ...placed("class"),
      "}",
      "export namespace Space {",
      "  export const anchor = 0;",
      ...indent(placed("namespace"), "  "),
      "  export namespace Inner {",
      "    export const anchor = 0;",
      ...indent(placed("nested"), "    "),
      "  }",
      "}",
      "",
    ].join("\n"),
  };
}

/**
 * Property dead-code-suite/P2: an unreferenced declaration with no exemption is reported.
 * Each declaration a draw writes, at every member visibility and container depth with
 * every container live, is reported once under the code its place selects, by reference
 * counting, at `certain` for an application, as the root of its own component; nothing
 * else is reported, because every anchor is referenced.
 */
describe("an unreferenced declaration with no exemption", () => {
  it("is reported, under the code its place selects", () => {
    const { config } = resolve({
      repository: '{ "target": { "kind": "application" } }',
      repositoryLabel: "deadset.json",
    });
    // One client serves every draw, each in its own snapshot: a run closes the client it
    // is handed, so the run is handed one whose close is left to this test.
    const client = openEngine({ collectTiming: false });
    const shared: Engine = { ...client, close: () => undefined };
    try {
      fc.assert(
        fc.property(fc.array(drawn, { minLength: 1, maxLength: 6 }), (declarations) => {
          const root = writeProject(projectOf(declarations));
          try {
            const reported = findingsOf(emitterInputOf(root, config, { engine: shared }))
              .filter((finding) => finding.code.startsWith("DS10"))
              .map(
                (finding) =>
                  `${finding.code} ${finding.symbol.name} ${finding.livenessRelation ?? "-"} ${finding.confidence} ${finding.component.root ? "root" : "falls"}`,
              );
            const expected = declarations.map(
              (one, at) =>
                `${codeFor(one)} ${displayName(one, `d${String(at)}`)} reference-counting certain root`,
            );
            expect([...reported].sort()).toEqual([...expected].sort());
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        }),
        { numRuns: RUNS },
      );
    } finally {
      client.close();
    }
  }, 20_000);
});
