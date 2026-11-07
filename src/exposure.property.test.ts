import { rmSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { emitterInputOf } from "../__test-helpers__/emitter-input.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { narrowings } from "./findings/visibility-narrowing.ts";
import { resolve } from "./resolve.ts";
import { openEngine, type Engine } from "./session.ts";

/**
 * One iteration writes a library whose entry declares one target per drawn row and
 * re-exports the row's carrier, so each target is a published export the package alone
 * references, and sweeps it; then it asks the same client for the declaration output of
 * the carriers' file.
 * An iteration costs a sweep and an emit, about a second, so the property carries its own
 * time bound and the case's timeout is raised above it.
 */
const RUNS = 20;

/** The declaration a row's outermost carrier is, which the entry re-exports. */
const DECLARATIONS = [
  "parameter",
  "result",
  "inferred",
  "predicate",
  "assertion",
  "constraint",
  "default",
  "variable",
  "interface member",
  "class property",
  "class method",
  "class constraint",
  "interface default",
  "alias",
  "namespace member",
  "interface base",
  "asserted initializer",
  "satisfied initializer",
  "call type argument",
  "annotated default",
  "unannotated default",
  "function expression parameter",
  "object literal property",
  "conditional initializer",
] as const;
type Declaration = (typeof DECLARATIONS)[number];

/** A composite one level of a row's type is spelled through. */
const WRAPS = [
  "union",
  "intersection",
  "tuple",
  "array",
  "type argument",
  "index signature",
  "mapped value",
  "mapped template",
  "function parameter",
  "function result",
  "conditional branch",
  "keyof",
  "unexported alias",
  "unexported interface",
  "unexported base",
  "alias default",
] as const;
type Wrap = (typeof WRAPS)[number];

/** One drawn row: a target type, and the carrier that names it or only uses it in a body. */
interface Row {
  readonly declaration: Declaration;
  /** The composites between the carrier and the target, innermost last. */
  readonly wraps: readonly Wrap[];
  /** A class, whose checker type keeps its name, or an alias of a primitive, whose does not. */
  readonly target: "class" | "alias";
  /** Whether the target is named only inside the carrier's body, so nothing outside holds it. */
  readonly hidden: boolean;
}

const row: fc.Arbitrary<Row> = fc.record({
  declaration: fc.constantFrom(...DECLARATIONS),
  wraps: fc.array(fc.constantFrom(...WRAPS), { maxLength: 2 }),
  target: fc.constantFrom<Row["target"]>("class", "alias"),
  hidden: fc.boolean(),
});

/** The type text one row spells, and the unexported declarations that text needs. */
function spelled(one: Row, at: number): { readonly type: string; readonly helpers: string[] } {
  const helpers: string[] = [];
  let type = `T${String(at)}`;
  [...one.wraps].reverse().forEach((wrap, depth) => {
    const helper = `H${String(at)}x${String(depth)}`;
    switch (wrap) {
      case "union":
        type = `${type} | undefined`;
        return;
      case "intersection":
        type = `(${type}) & { readonly tag: 1 }`;
        return;
      case "tuple":
        type = `readonly [${type}, number]`;
        return;
      case "array":
        type = `ReadonlyArray<${type}>`;
        return;
      case "type argument":
        type = `Promise<${type}>`;
        return;
      case "index signature":
        type = `{ readonly [key: string]: ${type} }`;
        return;
      case "mapped value":
        type = `{ readonly [K in "a" | "b"]: ${type} }`;
        return;
      case "mapped template":
        helpers.push(`type ${helper}<X> = { readonly [K in keyof X]: ${type} };`);
        type = `${helper}<{ a: number }>`;
        return;
      case "function parameter":
        type = `(value: ${type}) => void`;
        return;
      case "function result":
        type = `() => ${type}`;
        return;
      case "conditional branch":
        helpers.push(`type ${helper}<X> = X extends string ? ${type} : never;`);
        type = `${helper}<string>`;
        return;
      case "keyof":
        type = `keyof { readonly k: ${type} } | keyof Readonly<${type}>`;
        return;
      case "unexported alias":
        helpers.push(`type ${helper} = ${type};`);
        type = helper;
        return;
      case "unexported interface":
        helpers.push(`interface ${helper} {\n  readonly v: ${type};\n}`);
        type = helper;
        return;
      case "unexported base":
        helpers.push(`interface ${helper}b {\n  readonly b: ${type};\n}`);
        helpers.push(`interface ${helper} extends ${helper}b {}`);
        type = helper;
        return;
      case "alias default":
        helpers.push(`type ${helper}<X = ${type}> = { readonly x: X };`);
        type = helper;
        return;
    }
  });
  return { type, helpers };
}

/** The carrier one row declares as `K<at>`, which names its type in its declaration. */
function carrierOf(one: Row, at: number, type: string): string {
  const name = `K${String(at)}`;
  const value = `undefined as unknown as (${type})`;
  switch (one.declaration) {
    case "parameter":
      return `export function ${name}(value: ${type}): boolean {\n  return value === undefined;\n}`;
    case "result":
      return `export function ${name}(): ${type} {\n  return ${value};\n}`;
    case "inferred":
      return `export function ${name}() {\n  const held: ${type} = ${value};\n  return held;\n}`;
    case "predicate":
      return `export function ${name}(value: unknown): value is ${type} {\n  return value !== null;\n}`;
    case "assertion":
      return `export function ${name}(value: unknown): asserts value is ${type} {\n  if (value === null) {\n    throw new Error("null");\n  }\n}`;
    case "constraint":
      return `export function ${name}<X extends ${type}>(value: X): X {\n  return value;\n}`;
    case "default":
      return `export function ${name}<X = ${type}>(value?: X): X | undefined {\n  return value;\n}`;
    case "variable":
      return `export const ${name}: ${type} = ${value};`;
    case "interface member":
      return `export interface ${name} {\n  readonly v: ${type};\n}`;
    case "class property":
      return `export class ${name} {\n  readonly v: ${type} = ${value};\n}`;
    case "class method":
      return `export class ${name} {\n  m(): ${type} {\n    return ${value};\n  }\n}`;
    case "class constraint":
      return `export class ${name}<X extends ${type}> {\n  constructor(readonly x: X) {}\n}`;
    case "interface default":
      return `export interface ${name}<X = ${type}> {\n  readonly x: X;\n}`;
    case "alias":
      return `export type ${name} = ${type};`;
    case "namespace member":
      return `export namespace ${name} {\n  export function f(): ${type} {\n    return ${value};\n  }\n}`;
    case "interface base":
      return `interface ${name}w<X> {\n  readonly w: X;\n}\nexport interface ${name} extends ${name}w<${type}> {}`;
    case "asserted initializer":
      return `export const ${name} = ${value};`;
    case "satisfied initializer":
      return `export const ${name} = 1 satisfies number | (${type});`;
    case "call type argument":
      return `export const ${name} = Array.of<${type}>().length;`;
    case "annotated default":
      return `export function ${name}(n: number = [${value}].length): number {\n  return n;\n}`;
    case "unannotated default":
      return `export function ${name}(value = ${value}): boolean {\n  return value === undefined;\n}`;
    case "function expression parameter":
      return `export const ${name} = (value: ${type}): boolean => value === undefined;`;
    case "object literal property":
      return `export const ${name} = { v: ${value} };`;
    case "conditional initializer":
      return `export const ${name} = Math.random() > 0.5 ? (${value}) : undefined;`;
  }
}

/** A carrier of the same kind of declaration whose signature names no target. */
function hiddenOf(at: number, type: string): string {
  return `export function K${String(at)}(): number {\n  const held: ${type} | undefined = undefined;\n  return held === undefined ? 1 : 0;\n}`;
}

/** The library a draw becomes. */
function projectOf(rows: readonly Row[]): Record<string, string> {
  const carriers = rows.flatMap((one, at) => {
    const { type, helpers } = spelled(one, at);
    return [...helpers, one.hidden ? hiddenOf(at, type) : carrierOf(one, at, type)];
  });
  const names = rows.map((_one, at) => `T${String(at)}`);
  const carrierNames = rows.map((_one, at) => `K${String(at)}`);
  return {
    "package.json": JSON.stringify({
      name: "@example/drawn",
      type: "module",
      exports: { ".": "./src/index.ts" },
    }),
    "src/index.ts": [
      `export { ${carrierNames.join(", ")} } from "./api.js";`,
      ...rows.map((one, at) =>
        one.target === "class"
          ? `export class T${String(at)} {\n  readonly t${String(at)} = 1;\n}`
          : `export type T${String(at)} = string;`,
      ),
      "",
    ].join("\n"),
    "src/api.ts": [
      `import type { ${names.join(", ")} } from "./index.js";`,
      "",
      ...carriers,
      "",
    ].join("\n"),
  };
}

/**
 * Property: a type is exposed exactly where the declaration output of what a reference
 * from outside reaches names it. For every drawn carrier, nesting and target, `DS1501`
 * reports the target where, and only where, the compiler's own declaration output of
 * the carriers' file does not name it; that output writes each unexported type it needs
 * beside the exported ones, so it is the transitive surface the rule reads.
 */
describe("a type a published declaration's surface names", () => {
  it("is narrowed exactly where the declaration output does not name it", () => {
    const { config } = resolve({
      repository: {
        text: JSON.stringify({ target: { kind: "library" }, consumers: { complete: true } }),
        label: "deadset.json",
      },
    });
    // One client serves every draw, each in its own snapshot: a run closes the client it
    // is handed, so the run is handed one whose close is left to this test.
    const client = openEngine({ collectTiming: false });
    const shared: Engine = { ...client, close: () => undefined };
    try {
      fc.assert(
        fc.property(fc.array(row, { minLength: 1, maxLength: 6 }), (rows) => {
          const root = writeProject(projectOf(rows));
          try {
            const snapshot = shared.createSnapshot([join(root, "tsconfig.json")]);
            let output: string;
            try {
              const project = snapshot.getConfiguredProject(join(root, "tsconfig.json"));
              const emitted = project?.program.getDeclarationEmit([join(root, "src", "api.ts")]);
              output = [...(emitted?.outputFiles.values() ?? [])]
                .map((file) => file.text)
                .join("\n");
            } finally {
              snapshot.dispose();
            }
            expect(output).toContain("K0");
            const reported = narrowings(emitterInputOf(root, config, { engine: shared }))
              .filter((finding) => finding.code === "DS1501")
              .map((finding) => finding.symbol.name)
              .filter((name) => /^T\d+$/u.test(name));
            const expected = rows.flatMap((_one, at) =>
              new RegExp(`\\bT${String(at)}\\b`, "u").test(output) ? [] : [`T${String(at)}`],
            );
            expect([...reported].sort()).toEqual([...expected].sort());
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        }),
        {
          numRuns: RUNS,
          plugins: [fc.interruptAfterTimeLimit(120_000, { failOnInterrupt: true })],
        },
      );
    } finally {
      client.close();
    }
  }, 150_000);
});
