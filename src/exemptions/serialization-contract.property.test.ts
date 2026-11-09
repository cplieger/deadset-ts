import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { writeProject } from "../../__test-helpers__/projects.ts";
import { runSweep } from "../analysis.ts";
import { resolve } from "../resolve.ts";
import { scopeForDir } from "../scope.ts";
import { openEngine } from "../session.ts";

/** The constraints a case puts on its type parameter; `class` constrains it to the case's own class. */
const CONSTRAINTS = ["none", "object", "{}", "class"] as const;
type Constraint = (typeof CONSTRAINTS)[number];

/**
 * Types over a type parameter `T`, each with a value of the class `name` written to fit a
 * parameter of that type.
 */
const FORMS: readonly (readonly [string, string, (name: string) => string])[] = [
  ["T", "T", (name) => `new ${name}()`],
  ["Readonly", "Readonly<T>", (name) => `new ${name}()`],
  ["Partial", "Partial<T>", (name) => `new ${name}()`],
  ["Pick", "Pick<T, keyof T>", (name) => `new ${name}()`],
  ["Omit", 'Omit<T, "x">', (name) => `new ${name}()`],
  [
    "object template",
    '{ [K in "box"]: { value: T } }',
    (name) => `{ box: { value: new ${name}() } }`,
  ],
  ["intersection", "T & { tag?: string }", (name) => `new ${name}()`],
  ["conditional", "T extends object ? T : never", (name) => `new ${name}()`],
  ["Iterable", "Iterable<T>", (name) => `[new ${name}()]`],
  ["Map", "Map<string, T>", (name) => `new Map([["a", new ${name}()]])`],
  ["ReadonlySet", "ReadonlySet<T>", (name) => `new Set([new ${name}()])`],
  ["Promise", "Promise<T>", (name) => `Promise.resolve(new ${name}())`],
  ["callback", "() => T", (name) => `() => new ${name}()`],
  ["method interface", "Source<T>", (name) => `{ get: () => new ${name}() }`],
];

/**
 * A serialized value written without a type parameter: the declarations it needs, the value
 * of the class `name`, and the call that serializes `argument`, `JSON.stringify` by default.
 */
interface Direct {
  readonly form: string;
  readonly setup?: (name: string) => readonly string[];
  readonly value: (name: string) => string;
  readonly sink?: (name: string, argument: string) => string;
}

const DIRECT: readonly Direct[] = [
  { form: "Object.freeze", value: (name) => `Object.freeze(new ${name}())` },
  { form: "structuredClone", value: (name) => `structuredClone(new ${name}())` },
  { form: "concrete class", value: (name) => `new ${name}()` },
  { form: "object literal", value: (name) => `{ held: new ${name}() }` },
  {
    form: "spread of a value typed object",
    setup: (name) => [`const v${name}: object = new ${name}();`],
    value: (name) => `{ ...v${name} }`,
  },
  {
    form: "spread of a value an interface types",
    setup: (name) => [
      `interface H${name} { id: number }`,
      `const v${name}: H${name} = new ${name}();`,
    ],
    value: (name) => `{ ...v${name} }`,
  },
  {
    form: "object literal getter",
    setup: (name) => [`const v${name} = new ${name}();`],
    value: (name) => `{ get held() { return v${name}; } }`,
  },
  {
    form: "toJSON",
    setup: (name) => [`class W${name} { toJSON() { return new ${name}(); } }`],
    value: (name) => `new W${name}()`,
  },
  {
    form: "toJSON typed unknown",
    setup: (name) => [`class W${name} { toJSON(): unknown { return new ${name}(); } }`],
    value: (name) => `new W${name}()`,
  },
  {
    form: "generic subclass of a concrete base",
    setup: (name) => [
      `class B${name} { n = 1; }`,
      `class D${name}<T> extends B${name} { constructor(public held: T) { super(); } }`,
      `const v${name}: B${name} = new D${name}(new ${name}());`,
    ],
    value: (name) => `v${name}`,
  },
  {
    form: "member typed unknown its initializer writes",
    setup: (name) => [`class M${name} { held: unknown = new ${name}(); }`],
    value: (name) => `new M${name}()`,
  },
  {
    form: "member typed object a this assignment writes",
    setup: (name) => [
      `class M${name} { held: object; constructor() { this.held = new ${name}(); } }`,
    ],
    value: (name) => `new M${name}()`,
  },
  {
    form: "Object.assign onto this",
    setup: (name) => [`class A${name} { constructor(x: ${name}) { Object.assign(this, x); } }`],
    value: (name) => `new A${name}(new ${name}())`,
  },
  {
    form: "generic method a non-generic interface method dispatches to",
    setup: (name) => [
      `interface N${name} { save(x: unknown): string }`,
      `class S${name} implements N${name} { save<T>(x: T): string { return JSON.stringify(x); } }`,
      `const n${name}: N${name} = new S${name}();`,
    ],
    value: (name) => `new ${name}()`,
    sink: (name, argument) => `n${name}.save(${argument})`,
  },
];

/** How many `Box` levels hold the value. */
const DEPTHS = [0, 1, 2, 3, 4, 5] as const;

/** `type` inside `depth` levels of `Box`. */
function boxed(type: string, depth: number): string {
  return depth === 0 ? type : `Box<${boxed(type, depth - 1)}>`;
}

/** `value` inside `depth` levels of an object literal a `Box` types. */
function wrapped(value: string, depth: number): string {
  return depth === 0 ? value : `{ v: ${wrapped(value, depth - 1)} }`;
}

/** The type parameter list of a case: `T` under its constraint. */
function parameterOf(constraint: Constraint, name: string): string {
  const bound = {
    none: "",
    object: " extends object",
    "{}": " extends {}",
    class: ` extends ${name}`,
  };
  return `<T${bound[constraint]}>`;
}

/** One serialized argument: the code that writes it, and the case it is reported under. */
interface Written {
  readonly name: string;
  readonly label: string;
}

/**
 * The cases, each with its own class of a private and a public data member, so a
 * retention names the case it holds. A project function serializes its parameter of each
 * form, constraint and depth; an outside function returns each form at each depth, and its
 * result is serialized; a generic function serializes each form where the program calls it
 * only through a callback or an interface; and each form of `DIRECT` is serialized at each
 * depth.
 */
function program(): {
  readonly files: Readonly<Record<string, string>>;
  readonly written: readonly Written[];
} {
  const outside = ["export interface Box<U> { v: U }", "export interface Source<U> { get(): U }"];
  const classes: string[] = [];
  const lines: string[] = [];
  const written: Written[] = [];
  const next = (label: string): string => {
    const name = `C${String(written.length)}`;
    written.push({ name, label: `${label} (${name})` });
    classes.push(`export class ${name} { private secret = 1; id = 2; }`);
    return name;
  };
  for (const [form, type, value] of FORMS) {
    for (const constraint of CONSTRAINTS) {
      for (const depth of DEPTHS) {
        const label = `${form}, constraint ${constraint}, depth ${String(depth)}`;
        const own = next(`project parameter ${label}`);
        lines.push(
          `function s${own}${parameterOf(constraint, own)}(x: ${boxed(type, depth)}): string { return JSON.stringify(x); }`,
          `export const o${own} = s${own}(${wrapped(value(own), depth)});`,
        );
        const result = next(`outside result ${label}`);
        outside.push(
          `export declare function r${result}${parameterOf(constraint, result)}(x: T): ${boxed(type, depth)};`,
        );
        lines.push(`export const o${result} = JSON.stringify(r${result}(new ${result}()));`);
      }
    }
  }
  // A generic serializer the program calls only through a callback or an interface.
  for (const [form, type, value] of FORMS) {
    const callback = next(`callback ${form}`);
    lines.push(
      `function s${callback}<T>(x: ${type}): string { return JSON.stringify(x); }`,
      `export const o${callback} = [${value(callback)}].map((one) => s${callback}(one));`,
      `export const p${callback} = [${value(callback)}].map(s${callback});`,
    );
    const dispatched = next(`interface method ${form}`);
    lines.push(
      `interface I${dispatched} { save<T>(x: ${type}): string }`,
      `class S${dispatched} implements I${dispatched} { save<T>(x: ${type}): string { return JSON.stringify(x); } }`,
      `const i${dispatched}: I${dispatched} = new S${dispatched}();`,
      `export const o${dispatched} = i${dispatched}.save(${value(dispatched)});`,
    );
  }
  for (const { form, setup, value, sink } of DIRECT) {
    for (const depth of DEPTHS) {
      const name = next(`${form}, depth ${String(depth)}`);
      const argument = wrapped(value(name), depth);
      lines.push(
        ...(setup?.(name) ?? []),
        `export const o${name} = ${sink?.(name, argument) ?? `JSON.stringify(${argument})`};`,
      );
    }
  }
  const imported = outside.flatMap((line) => /function (\w+)/u.exec(line)?.[1] ?? []);
  const named = `{ ${written.map((one) => one.name).join(", ")} }`;
  return {
    files: {
      "package.json": JSON.stringify({ name: "@example/tree", private: true, type: "module" }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          lib: ["es2022", "dom"],
        },
        include: ["*.ts"],
      }),
      "main.ts": [
        `import { type Box, type Source, ${imported.join(", ")} } from "./outside.ts";`,
        `import ${named} from "./classes.ts";`,
        ...lines,
        "",
      ].join("\n"),
      "outside.ts": [`import type ${named} from "./classes.ts";`, ...outside, ""].join("\n"),
      "classes.ts": `${classes.join("\n")}\n`,
    },
    written,
  };
}

/** What the checker rejects in the written project, as `file:line message`. */
function diagnosticsOf(root: string): readonly string[] {
  const engine = openEngine({ collectTiming: false });
  try {
    const snapshot = engine.createSnapshot([join(root, "tsconfig.json")]);
    try {
      const project = snapshot.getConfiguredProject(join(root, "tsconfig.json"));
      if (project === undefined) {
        return ["the checked project did not open"];
      }
      return ["main.ts", "outside.ts", "classes.ts"].flatMap((file) =>
        project.program
          .getSemanticDiagnostics(join(root, file))
          .map((one) => `${file}:${String(one.startPosition?.line ?? -1)} ${one.text}`),
      );
    } finally {
      snapshot.dispose();
    }
  } finally {
    engine.close();
  }
}

/**
 * The violations of the property: every member of every class a serialized value can
 * be is held back, whatever type its argument has, so no case's `id` or `secret` is
 * reported dead.
 */
function violations(): readonly string[] {
  const { files, written } = program();
  const root = writeProject(files);
  try {
    expect(diagnosticsOf(root)).toEqual([]);
    const { config } = resolve({
      repository: {
        text: JSON.stringify({ target: { kind: "application" }, ts: { entry_files: ["main.ts"] } }),
        label: "deadset.json",
      },
    });
    const host = nodeHost();
    const swept = runSweep(
      openEngine({ collectTiming: false }),
      host,
      scopeForDir(host, root),
      config,
      { marked: [], mode: { production: true } },
    );
    const names = new Map(swept.matrix.union.symbols.map((symbol) => [symbol.id, symbol.name]));
    const held = new Set(
      swept.sweep.retained
        .filter((one) => one.class === "serialization-contract")
        .map((one) => names.get(one.id) ?? one.id),
    );
    return written.flatMap(({ name, label }) =>
      ["id", "secret"].flatMap((member) =>
        held.has(`${name}.${member}`) ? [] : [`${label}: ${member} reported dead`],
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Property: a value that reaches a serializer has every member of every class it can be
 * held back, for every form of type its argument has: a class, an object literal, a type
 * parameter under each constraint, mapped, intersected and conditional types over it, a
 * library's containers, a promise, a callback and a method-only interface over it, a
 * library's result, spreads, getters, `toJSON` results, subclasses, members written by an
 * initializer, `this` or `Object.assign`, each held at depths 0 to 5, and a generic
 * serializer reached through a callback or an interface.
 */
describe("a serialized value whose argument type is not concrete", () => {
  it("holds back every member of every class the value can be", () => {
    expect(violations()).toEqual([]);
  }, 600_000);
});
