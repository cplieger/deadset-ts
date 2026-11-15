import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { emitterInputOf, findingsOf } from "../../__test-helpers__/emitter-input.ts";
import { readFixture } from "../../__test-helpers__/fixtures.ts";
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
function diagnosticsOf(
  root: string,
  files: readonly string[] = ["main.ts", "outside.ts", "classes.ts"],
): readonly string[] {
  const engine = openEngine({ collectTiming: false });
  try {
    const snapshot = engine.createSnapshot([join(root, "tsconfig.json")]);
    try {
      const project = snapshot.getConfiguredProject(join(root, "tsconfig.json"));
      if (project === undefined) {
        return ["the checked project did not open"];
      }
      return files.flatMap((file) =>
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

/** What a drawn form needs beside its own lines: the outside package, or a JSX factory. */
type OracleNeed = "package" | "jsx";

/** The lines one use declares, the expression whose value it serializes, and what it needs. */
interface OracleForm {
  readonly lines: readonly string[];
  readonly value: string;
  /** The use's payload class, where the form declares its own. */
  readonly payload?: string;
  readonly needs?: readonly OracleNeed[];
  /** What the sweep must report dead where the form is drawn alone, a control of its precision. */
  readonly dead?: readonly string[];
}

const bagOf = (n: string): string =>
  `interface Bag${n} { [k: string]: number | undefined; m${n}k?: number }`;
const keyOf = (n: string): string => `(JSON.parse('"m${n}k"') as string)`;
const keyListOf = (n: string): string => `(JSON.parse('["m${n}k"]') as string[])`;
const decodedBag = (n: string): string => `const s${n}: Bag${n} = JSON.parse('{"m${n}k":1}');`;

/** A form whose key fills `Bag<n>.m<n>k` on `b<n>`, through `write`. */
const bag =
  (write: (n: string) => readonly string[], declared = true) =>
  (n: string) => ({
    lines: [bagOf(n), ...(declared ? [`const b${n}: Bag${n} = {};`] : []), ...write(n)],
    value: `b${n}`,
  });

/** A form whose payload is a subclass `P<n>` of a base `Base<n>`, filled through the base. */
const subclass =
  (
    fill: (n: string) => readonly string[],
    generic = false,
    body: ((n: string) => string) | undefined = undefined,
  ) =>
  (n: string): OracleForm => {
    const base = generic ? `Base${n}<number>` : `Base${n}`;
    return {
      lines: [
        generic
          ? `class Base${n}<T> { i${n}: T; [key: string]: number | T; constructor(i: T) { this.i${n} = i; } }`
          : `class Base${n} { i${n} = 1; [key: string]: number; }`,
        `class P${n} extends ${base} { declare m${n}s: number;${body === undefined ? "" : ` ${body(n)}`} }`,
        ...fill(n),
      ],
      payload: "",
      value: body === undefined ? `s${n}` : `new P${n}()`,
    };
  };
const subclassHeld = (n: string): string => `const s${n} = new P${n}();`;

/** The wrappers that keep the value a literal evaluates to, each around `{ i<n>: 1 }`. */
const LITERAL_WRAPPERS = {
  "`as`": (n: string) => `{ i${n}: 1 } as { i${n}: number }`,
  "`satisfies`": (n: string) => `{ i${n}: 1 } satisfies { i${n}: number }`,
  "an angle assertion": (n: string) => `<{ i${n}: number }>{ i${n}: 1 }`,
  "a non-null assertion": (n: string) => `({ i${n}: 1 } as { i${n}: number } | undefined)!`,
  parentheses: (n: string) => `({ i${n}: 1 })`,
} as const;

/** A form's name with `%s` replaced by a wrapper's. */
type Behind<Name extends string> = Name extends `${infer Before}%s${infer After}`
  ? `${Before}${keyof typeof LITERAL_WRAPPERS}${After}`
  : never;

/** One form of `name` for each literal wrapper, `%s` naming it. */
function literalsBehind<Name extends string>(
  name: Name,
  form: (n: string, literal: string) => OracleForm,
): Record<Behind<Name>, (n: string) => OracleForm> {
  return Object.fromEntries(
    Object.entries(LITERAL_WRAPPERS).map(([wrapper, literal]) => [
      name.replace("%s", wrapper),
      (n: string) => form(n, literal(n)),
    ]),
  ) as Record<Behind<Name>, (n: string) => OracleForm>;
}

/** A form whose payload goes through `wide<n>.p<n>` on a literal `src<n>` read at its own type. */
const widened =
  (source: (n: string) => readonly string[], value = (n: string) => `src${n}`) =>
  (n: string): OracleForm => ({ lines: source(n), value: value(n) });
const wide = (n: string): string => `{ i${n}: number; p${n}?: P${n} }`;

/**
 * The object types a program declares that a sent value is assignable to, each written
 * `W<n>` with a member `p<n>` a value of `P<n>` is written through, and the source `src<n>`
 * a value of which is sent: the rule's subjects decided by assignability, drawn directly.
 */
const VIEW_KINDS = {
  "an interface": (n: string) => [
    `interface W${n} { i${n}: number; p${n}?: P${n} }`,
    `const src${n} = { i${n}: 1 };`,
  ],
  "a type alias": (n: string) => [
    `type W${n} = { i${n}: number; p${n}?: P${n} };`,
    `const src${n} = { i${n}: 1 };`,
  ],
  "an intersection": (n: string) => [
    `type W${n} = { i${n}: number } & { p${n}?: P${n} };`,
    `const src${n} = { i${n}: 1 };`,
  ],
  "a generic interface's instance": (n: string) => [
    `interface G${n}<T> { i${n}: number; p${n}?: T }`,
    `type W${n} = G${n}<P${n}>;`,
    `const src${n} = { i${n}: 1 };`,
  ],
  "an index signature": (n: string) => [
    `type W${n} = { [k: string]: number | P${n} | undefined; p${n}?: P${n} };`,
    `const src${n} = { i${n}: 1 };`,
  ],
  "a keyless source": (n: string) => [
    `interface W${n} { p${n}?: P${n} }`,
    `const src${n}: Record<string, unknown> = {};`,
  ],
} as const;

/** The routes a sent value takes to a view, each writing `p<n>` through it. */
const VIEW_ROUTES = {
  "by a variable": (n: string) => [`const w${n}: W${n} = src${n};`, `w${n}.p${n} = new P${n}();`],
  "through any": (n: string) => [
    `const a${n}: any = src${n};`,
    `const w${n}: W${n} = a${n};`,
    `w${n}.p${n} = new P${n}();`,
  ],
  "through a double assertion": (n: string) => [
    `const w${n} = src${n} as unknown as W${n};`,
    `w${n}.p${n} = new P${n}();`,
  ],
  "through a Function parameter": (n: string) => [
    `function later${n}(f: Function, x: unknown): void { f(x); }`,
    `later${n}((w: W${n}) => { w.p${n} = new P${n}(); }, src${n});`,
  ],
  "iterated from a Map": (n: string) => [
    `let w${n}!: W${n};`,
    `for ([, w${n}] of new Map([["k", src${n}]])) { w${n}.p${n} = new P${n}(); }`,
  ],
  "iterated from a generator": (n: string) => [
    `function* gen${n}() { yield src${n}; }`,
    `let w${n}!: W${n};`,
    `for (w${n} of gen${n}()) { w${n}.p${n} = new P${n}(); }`,
  ],
  "by a this parameter through call": (n: string) => [
    `function fill${n}(this: W${n}): void { this.p${n} = new P${n}(); }`,
    `fill${n}.call(src${n});`,
  ],
  "sent inside a generic function": (n: string) => [
    `const w${n}: W${n} = src${n};`,
    `w${n}.p${n} = new P${n}();`,
    `function sendIn${n}<T>(x: T): void { out.push(JSON.stringify(x)); }`,
    `sendIn${n}(src${n});`,
  ],
} as const;

/** One form for each view kind and route, the source sent. */
function viewsReached(): Record<
  `view of ${keyof typeof VIEW_KINDS} ${keyof typeof VIEW_ROUTES}`,
  (n: string) => OracleForm
> {
  return Object.fromEntries(
    Object.entries(VIEW_KINDS).flatMap(([kind, declared]) =>
      Object.entries(VIEW_ROUTES).map(([route, lines]) => [
        `view of ${kind} ${route}`,
        (n: string) => ({ lines: [...declared(n), ...lines(n)], value: `src${n}` }),
      ]),
    ),
  ) as unknown as Record<
    `view of ${keyof typeof VIEW_KINDS} ${keyof typeof VIEW_ROUTES}`,
    (n: string) => OracleForm
  >;
}

/** The assertion wrappers around a literal whose method captures `this`. */
const THIS_WRAPPERS = {
  "`as`": (n: string, body: string) => `({ i${n}: 1, ${body} }) as N${n}`,
  "`satisfies`": (n: string, body: string) => `({ i${n}: 1, ${body} }) satisfies N${n}`,
  "an angle assertion": (n: string, body: string) => `<N${n}>({ i${n}: 1, ${body} })`,
} as const;

/** One form for each wrapper: a literal whose method keeps `this`, written through a wider view. */
function thisCaptured(): Record<
  `literal keeping this behind ${keyof typeof THIS_WRAPPERS} at a wider place`,
  (n: string) => OracleForm
> {
  return Object.fromEntries(
    Object.entries(THIS_WRAPPERS).map(([wrapper, literal]) => [
      `literal keeping this behind ${wrapper} at a wider place`,
      (n: string): OracleForm => ({
        lines: [
          `interface N${n} { i${n}: number; init(): void }`,
          `let keep${n}: N${n} | undefined;`,
          `const w${n}: N${n} & { p${n}?: P${n} } = ${literal(n, "init() { keep" + n + " = this; }")};`,
          `w${n}.init();`,
          `w${n}.p${n} = new P${n}();`,
        ],
        value: `keep${n}`,
      }),
    ]),
  ) as Record<
    `literal keeping this behind ${keyof typeof THIS_WRAPPERS} at a wider place`,
    (n: string) => OracleForm
  >;
}

/**
 * The generators of the oracle's grammar, one per form: each puts an instance of a use's
 * payload `P<n>`, or a key it writes, where a serializer reads it, by the form its name says.
 */
const ORACLE_GENERATORS = {
  direct: (n: string) => ({ lines: [], value: `new P${n}()` }),
  "method through any": (n: string) => ({
    lines: [
      `class H${n} { get(): P${n} { return new P${n}(); } }`,
      `void new H${n}().get;`,
      `const h${n}: any = new H${n}();`,
    ],
    value: `h${n}.get()`,
  }),
  "getter through any": (n: string) => ({
    lines: [
      `class H${n} { get p(): P${n} { return new P${n}(); } }`,
      `void new H${n}().p;`,
      `const h${n}: any = new H${n}();`,
    ],
    value: `h${n}.p`,
  }),
  "static method through any": (n: string) => ({
    lines: [
      `class H${n} { static make(): P${n} { return new P${n}(); } }`,
      `void H${n}.make;`,
      `const C${n}: any = H${n};`,
    ],
    value: `C${n}.make()`,
  }),
  "static field through any": (n: string) => ({
    lines: [
      `class H${n} { static cache: P${n} = new P${n}(); }`,
      `void H${n}.cache;`,
      `const C${n}: any = H${n};`,
    ],
    value: `C${n}.cache`,
  }),
  "class into an interface then any": (n: string) => ({
    lines: [
      `interface N${n} { i${n}: number }`,
      `class H${n} implements N${n} { i${n} = 1; get(): P${n} { return new P${n}(); } }`,
      `void new H${n}().get;`,
      `const v${n}: N${n} = new H${n}();`,
    ],
    value: `(v${n} as any).get()`,
  }),
  "method through unknown": (n: string) => ({
    lines: [
      `class H${n} { get(): P${n} { return new P${n}(); } }`,
      `void new H${n}().get;`,
      `const v${n}: unknown = new H${n}();`,
    ],
    value: `(v${n} as { get(): unknown }).get()`,
  }),
  "literal method into a narrower type": (n: string) => ({
    lines: [
      `const lit${n} = { i${n}: 1, get(): P${n} { return new P${n}(); } };`,
      `const v${n}: { i${n}: number } = lit${n};`,
    ],
    value: `(v${n} as any).get()`,
  }),
  "interface method into a narrower type": (n: string) => ({
    lines: [
      `interface Src${n} { i${n}: number; get(): P${n} }`,
      `const src${n}: Src${n} = { i${n}: 1, get: () => new P${n}() };`,
      `void src${n}.get;`,
      `const v${n}: { i${n}: number } = src${n};`,
    ],
    value: `(v${n} as any).get()`,
  }),
  "union target": (n: string) => ({
    lines: [`const v${n}: P${n} | { tag: string } = new P${n}();`],
    value: `v${n}`,
  }),
  "intersection target": (n: string) => ({
    lines: [`const v${n}: P${n} & { t${n}?: string } = new P${n}();`],
    value: `v${n}`,
  }),
  "constrained type parameter into an interface": (n: string) => ({
    lines: [
      `interface S${n} { m${n}a: number }`,
      `function run${n}<T extends P${n}>(v: T): unknown { const box: S${n} = v; return box; }`,
    ],
    value: `run${n}(new P${n}())`,
  }),
  "indexed access into an interface": (n: string) => ({
    lines: [
      `interface S${n} { m${n}a: number }`,
      `function run${n}<T extends { p: P${n} }>(v: T["p"]): unknown { const box: S${n} = v; return box; }`,
    ],
    value: `run${n}<{ p: P${n} }>(new P${n}())`,
  }),
  "key from data": bag((n) => [`for (const k of ${keyListOf(n)}) { b${n}[k] = 1; }`]),
  "constant key": bag((n) => [`const k${n} = "m${n}k";`, `b${n}[k${n}] = 1;`]),
  "literal key": bag((n) => [`b${n}["m${n}k"] = 1;`]),
  "property write": bag((n) => [`b${n}.m${n}k = 1;`]),
  "object literal property": bag((n) => [`const b${n}: Bag${n} = { m${n}k: 1 };`], false),
  "key from data tested by in": bag((n) => [
    `for (const k of ${keyListOf(n)}) { if (!(k in b${n})) { b${n}[k] = 1; } }`,
  ]),
  "literal key tested by in": bag((n) => [
    `if (!("m${n}k" in b${n})) { Object.defineProperty(b${n}, "m${n}k", { value: 1, enumerable: true }); }`,
  ]),
  "computed key from data": bag(
    (n) => [`const k${n}: string = ${keyOf(n)};`, `const b${n}: Bag${n} = { [k${n}]: 1 };`],
    false,
  ),
  "spread of a decode": bag((n) => [decodedBag(n), `const b${n}: Bag${n} = { ...s${n} };`], false),
  "destructuring rest": bag(
    (n) => [
      `const { i${n}, ...b${n} }: Bag${n} & { i${n}: number } = JSON.parse('{"i${n}":0,"m${n}k":1}');`,
      `void i${n};`,
    ],
    false,
  ),
  "for...in": bag((n) => [decodedBag(n), `for (const k in s${n}) { b${n}[k] = s${n}[k]; }`]),
  "destructuring by a computed name": bag((n) => [
    decodedBag(n),
    `const k${n} = ${keyOf(n)};`,
    `const { [k${n}]: got${n} } = s${n};`,
    `b${n}[k${n}] = got${n};`,
  ]),
  "Object.keys": bag((n) => [
    decodedBag(n),
    `for (const k of Object.keys(s${n})) { b${n}[k] = s${n}[k]; }`,
  ]),
  "Object.entries": bag((n) => [
    decodedBag(n),
    `for (const [k, v] of Object.entries(s${n})) { b${n}[k] = v; }`,
  ]),
  "Object.values": bag((n) => [
    decodedBag(n),
    `const vs${n} = Object.values(s${n});`,
    `b${n}[Object.keys(s${n})[0] ?? ""] = vs${n}[0];`,
  ]),
  "Object.assign": bag((n) => [decodedBag(n), `Object.assign(b${n}, s${n});`]),
  "Object.getOwnPropertyNames": bag((n) => [
    decodedBag(n),
    `for (const k of Object.getOwnPropertyNames(s${n})) { b${n}[k] = s${n}[k]; }`,
  ]),
  "Object.getOwnPropertyDescriptor": bag((n) => [
    decodedBag(n),
    `const k${n} = ${keyOf(n)};`,
    `const d${n} = Object.getOwnPropertyDescriptor(s${n}, k${n});`,
    `if (d${n} !== undefined) { Object.defineProperty(b${n}, k${n}, { ...d${n}, enumerable: true }); }`,
  ]),
  "Object.getOwnPropertyDescriptors": bag((n) => [
    decodedBag(n),
    `Object.defineProperties(b${n}, Object.getOwnPropertyDescriptors(s${n}));`,
  ]),
  "Object.defineProperty": bag((n) => [
    `Object.defineProperty(b${n}, ${keyOf(n)}, { value: 1, enumerable: true });`,
  ]),
  "Object.fromEntries": bag(
    (n) => [
      `const b${n}: Bag${n} = Object.fromEntries(JSON.parse('[["m${n}k",1]]') as [string, number][]);`,
    ],
    false,
  ),
  "Reflect.set": bag((n) => [`for (const k of ${keyListOf(n)}) { Reflect.set(b${n}, k, 1); }`]),
  "key on a type parameter": bag((n) => [
    `function fill${n}<T extends Bag${n}>(t: T, k: string): void { Reflect.set(t, k, 1); }`,
    `fill${n}(b${n}, ${keyOf(n)});`,
  ]),
  "subclass key on a base this": subclass(
    () => [],
    false,
    (n) =>
      `constructor() { super(); const self: Base${n} = this; self[JSON.parse('"m${n}s"') as string] = 1; }`,
  ),
  "subclass key on a generic base": subclass(
    () => [],
    true,
    (n) =>
      `constructor() { super(1); const self: Base${n}<number> = this; self[JSON.parse('"m${n}s"') as string] = 1; }`,
  ),
  "subclass key on a base variable": subclass((n) => [
    subclassHeld(n),
    `const base${n}: Base${n} = s${n};`,
    `base${n}[JSON.parse('"m${n}s"') as string] = 1;`,
  ]),
  "subclass key tested by in on a base": subclass((n) => [
    `function fill${n}(b: Base${n}, k: string): void { if (!(k in b)) { b[k] = 1; } }`,
    subclassHeld(n),
    `fill${n}(s${n}, JSON.parse('"m${n}s"') as string);`,
  ]),
  "subclass Object.assign onto a base": subclass((n) => [
    `function fill${n}(b: Base${n}): void { Object.assign(b, JSON.parse('{"m${n}s":1}')); }`,
    subclassHeld(n),
    `fill${n}(s${n});`,
  ]),
  "subclass Reflect.set on a base": subclass((n) => [
    `function fill${n}(b: Base${n}, k: string): void { Reflect.set(b, k, 1); }`,
    subclassHeld(n),
    `fill${n}(s${n}, JSON.parse('"m${n}s"') as string);`,
  ]),
  "subclass Object.defineProperty on a base": subclass((n) => [
    `function fill${n}(b: Base${n}, k: string): void { Object.defineProperty(b, k, { value: 1, enumerable: true }); }`,
    subclassHeld(n),
    `fill${n}(s${n}, JSON.parse('"m${n}s"') as string);`,
  ]),
  "member only a wider view declares": widened((n) => [
    `const src${n}: { i${n}: number } = { i${n}: 1 };`,
    `const wide${n}: ${wide(n)} = src${n};`,
    `wide${n}.p${n} = new P${n}();`,
  ]),
  "literal variable into a wider view": widened((n) => [
    `const src${n} = { i${n}: 1 };`,
    `const wide${n}: ${wide(n)} = src${n};`,
    `wide${n}.p${n} = new P${n}();`,
  ]),
  "literal result into a wider view": widened((n) => [
    `function mk${n}() { return { i${n}: 1 }; }`,
    `const src${n} = mk${n}();`,
    `const wide${n}: ${wide(n)} = src${n};`,
    `wide${n}.p${n} = new P${n}();`,
  ]),
  "literal into a wider parameter": widened((n) => [
    `function fill${n}(w: ${wide(n)}): void { w.p${n} = new P${n}(); }`,
    `const src${n} = { i${n}: 1 };`,
    `fill${n}(src${n});`,
  ]),
  "spread of a literal written through a wider view": widened(
    (n) => [
      `const src${n} = { i${n}: 1 };`,
      `const wide${n}: ${wide(n)} = src${n};`,
      `wide${n}.p${n} = new P${n}();`,
    ],
    (n) => `{ ...src${n} }`,
  ),
  "satisfies literal into a wider parameter": widened((n) => [
    `const src${n} = { i${n}: 1 } satisfies { i${n}: number };`,
    `function fill${n}(w: ${wide(n)}): void { w.p${n} = new P${n}(); }`,
    `fill${n}(src${n});`,
  ]),
  "wider view through a type parameter's constraint": widened((n) => [
    `function fill${n}<T extends ${wide(n)}>(w: T): T { w.p${n} = new P${n}(); return w; }`,
    `const src${n} = { i${n}: 1 };`,
    `fill${n}(src${n});`,
  ]),
  "wider view through a generic class method's constraint": widened((n) => [
    `class F${n}<T extends ${wide(n)}> { fill(w: T): void { w.p${n} = new P${n}(); } }`,
    `const src${n} = { i${n}: 1 };`,
    `new F${n}<{ i${n}: number }>().fill(src${n});`,
  ]),
  "wider view through a generic constructor's constraint": widened((n) => [
    `class F${n}<T extends ${wide(n)}> { constructor(w: T) { w.p${n} = new P${n}(); } }`,
    `const src${n} = { i${n}: 1 };`,
    `new F${n}(src${n});`,
  ]),
  "callback with a wider parameter at Array forEach": widened((n) => [
    `const src${n} = { i${n}: 1 };`,
    `[src${n}].forEach((w: ${wide(n)}) => { w.p${n} = new P${n}(); });`,
  ]),
  "callback with a wider parameter at Array some": widened((n) => [
    `const src${n} = { i${n}: 1 };`,
    `[src${n}].some((w: ${wide(n)}) => { w.p${n} = new P${n}(); return false; });`,
  ]),
  "callback with a wider parameter at Set forEach": widened((n) => [
    `const src${n} = { i${n}: 1 };`,
    `new Set([src${n}]).forEach((w: ${wide(n)}) => { w.p${n} = new P${n}(); });`,
  ]),
  "callback with a wider parameter at Map forEach": widened((n) => [
    `const src${n} = { i${n}: 1 };`,
    `new Map([["k", src${n}]]).forEach((w: ${wide(n)}) => { w.p${n} = new P${n}(); });`,
  ]),
  "the wider view's own member": widened((n) => [
    `interface W${n} { i${n}: number; t${n}?: string; p${n}?: P${n} }`,
    `const src${n} = { i${n}: 1 };`,
    `const w${n}: W${n} = src${n};`,
    `w${n}.t${n} = "x";`,
    `w${n}.p${n} = new P${n}();`,
  ]),
  "the wider view's own member through a type alias": widened((n) => [
    `type W${n} = { i${n}: number; t${n}?: string; p${n}?: P${n} };`,
    `const src${n} = { i${n}: 1 };`,
    `const w${n}: W${n} = src${n};`,
    `w${n}.t${n} = "x";`,
    `w${n}.p${n} = new P${n}();`,
  ]),
  ...literalsBehind("literal behind %s at a wider place", (n, literal) => ({
    lines: [`const wide${n}: ${wide(n)} = ${literal};`, `wide${n}.p${n} = new P${n}();`],
    value: `{ i${n}: 1 }`,
    dead: [`P${n}.m${n}a`, `P${n}.m${n}b`],
  })),
  ...literalsBehind("collection literal behind %s only stored into", (n, literal) => ({
    lines: [`const b${n}: Record<string, number> = ${literal};`, `b${n}["z"] = 2;`],
    value: `new P${n}()`,
    dead: [`b${n}`],
  })),
  "collection literal a let assigned nowhere else holds, only stored into": (n: string) => ({
    lines: [`let b${n}: Record<string, number> = { i${n}: 1 };`, `b${n}["z"] = 2;`],
    value: `new P${n}()`,
    dead: [`b${n}`],
  }),
  ...viewsReached(),
  ...thisCaptured(),
  "literal behind a conditional inside `as` at a wider place": (n: string) => ({
    lines: [
      `const c${n} = out.length === 0;`,
      `const wide${n}: ${wide(n)} = (c${n} ? { i${n}: 1 } : { i${n}: 2 }) as { i${n}: number };`,
      `wide${n}.p${n} = new P${n}();`,
    ],
    value: `{ i${n}: 1 }`,
    dead: [`P${n}.m${n}a`, `P${n}.m${n}b`],
  }),
  "literal behind ?? inside `as` at a wider place": (n: string) => ({
    lines: [
      `const m${n} = JSON.parse("null") as { i${n}: number } | null;`,
      `const wide${n}: ${wide(n)} = (m${n} ?? { i${n}: 1 }) as { i${n}: number };`,
      `wide${n}.p${n} = new P${n}();`,
    ],
    value: `{ i${n}: 1 }`,
    dead: [`P${n}.m${n}a`, `P${n}.m${n}b`],
  }),
  "literal behind an intersection assertion at a wider place": (n: string) => ({
    lines: [
      `const wide${n}: ${wide(n)} = { i${n}: 1 } as { i${n}: number } & { i${n}: number };`,
      `wide${n}.p${n} = new P${n}();`,
    ],
    value: `{ i${n}: 1 }`,
    dead: [`P${n}.m${n}a`, `P${n}.m${n}b`],
  }),
  "collection literal a let holds whose name an inner scope assigns, only stored into": (
    n: string,
  ) => ({
    lines: [
      `let b${n} = { i${n}: 1 } as Record<string, number>;`,
      `function shadow${n}(): number { let b${n} = 0; b${n} = 1; return b${n}; }`,
      `b${n}["z"] = shadow${n}();`,
    ],
    value: `new P${n}()`,
    dead: [`b${n}`],
  }),
  "numeric literal key": (n: string) => ({
    lines: [`const k${n}: { 0?: number; i${n}: number } = { i${n}: 1 };`, `k${n}[0] = 2;`],
    value: `k${n}`,
  }),
  "binding default": (n: string) => ({
    lines: [`const { v${n} = new P${n}() }: { v${n}?: P${n} } = {};`],
    value: `v${n}`,
  }),
  "logical assignment": (n: string) => ({
    lines: [`let v${n}: P${n} | undefined;`, `v${n} ??= new P${n}();`],
    value: `v${n}`,
  }),
  "argument of a project function": (n: string) => ({
    lines: [`function pass${n}(x: object): object { return x; }`],
    value: `pass${n}(new P${n}())`,
  }),
  "tagged template": (n: string) => ({
    lines: [`function tag${n}(_s: TemplateStringsArray, v: unknown): unknown { return v; }`],
    value: `tag${n}\`\${new P${n}()}\``,
  }),
  "arrow body": (n: string) => ({ lines: [], value: `(() => new P${n}())()` }),
  "generator yield": (n: string) => ({
    lines: [`function* gen${n}(): Generator<object> { yield new P${n}(); }`],
    value: `gen${n}().next().value`,
  }),
  "yield*": (n: string) => ({
    lines: [`function* all${n}(): Generator<object> { yield* [new P${n}()]; }`],
    value: `all${n}().next().value`,
  }),
  "array spread": (n: string) => ({ lines: [], value: `[...[new P${n}()]]` }),
  "object spread": (n: string) => ({ lines: [], value: `{ ...{ w${n}: new P${n}() } }` }),
  "shorthand property": (n: string) => ({
    lines: [],
    value: `((w${n}: object) => ({ w${n} }))(new P${n}())`,
  }),
  satisfies: (n: string) => ({
    lines: [],
    value: `({ w${n}: new P${n}() } satisfies { w${n}: object })`,
  }),
  assertion: (n: string) => ({ lines: [], value: `(new P${n}() as object)` }),
  "destructuring assignment": (n: string) => ({
    lines: [
      `const t${n}: { w${n}: object } = { w${n}: {} };`,
      `({ w${n}: t${n}.w${n} } = { w${n}: new P${n}() });`,
    ],
    value: `t${n}`,
  }),
  "destructuring assignment of a variable": (n: string) => ({
    lines: [
      `const t${n}: { w${n}: object } = { w${n}: {} };`,
      `const src${n} = { w${n}: new P${n}(), r${n}: 1 };`,
      `({ w${n}: t${n}.w${n} } = src${n});`,
    ],
    value: `t${n}`,
  }),
  "async result": (n: string) => ({
    lines: [],
    value: `await (async (): Promise<object> => new P${n}())()`,
  }),
  call: (n: string) => ({
    lines: [`function keep${n}(x: object): object { return x; }`],
    value: `keep${n}.call(undefined, new P${n}())`,
  }),
  apply: (n: string) => ({
    lines: [`function keep${n}(x: object): object { return x; }`],
    value: `keep${n}.apply(undefined, [new P${n}()])`,
  }),
  bind: (n: string) => ({
    lines: [`function keep${n}(x: object): object { return x; }`],
    value: `keep${n}.bind(undefined, new P${n}())()`,
  }),
  "constructor return": (n: string) => ({
    lines: [`class W${n} { constructor() { return new P${n}(); } }`],
    value: `new W${n}()`,
  }),
  "subclass held as its base": (n: string) => ({
    lines: [`class Q${n} extends P${n} { m${n}q = 3; }`],
    value: `((b: P${n}) => b)(new Q${n}())`,
  }),
  "recursive type": (n: string) => ({
    lines: [
      `interface R${n} { m${n}a: number; next?: R${n} }`,
      `const r${n}: R${n} = { m${n}a: 0, next: new P${n}() };`,
    ],
    value: `r${n}`,
  }),
  "into object": (n: string) => ({
    lines: [`const v${n}: object = new P${n}();`],
    value: `v${n}`,
  }),
  "into {}": (n: string) => ({ lines: [`const v${n}: {} = new P${n}();`], value: `v${n}` }),
  "generic instance both ways": (n: string) => ({
    lines: [
      `interface Box${n}<T> { v: T }`,
      `const a${n}: Box${n}<P${n}> = { v: new P${n}() };`,
      `const b${n}: Box${n}<object> = a${n};`,
    ],
    value: `b${n}`,
  }),
  "list into a list": (n: string) => ({
    lines: [`const a${n}: P${n}[] = [new P${n}()];`, `const l${n}: object[] = a${n};`],
    value: `l${n}`,
  }),
  "element write": (n: string) => ({
    lines: [`const arr${n}: object[] = [];`, `arr${n}[0] = new P${n}();`],
    value: `arr${n}`,
  }),
  "into an index signature": (n: string) => ({
    lines: [`const m${n}: Record<string, object> = { w${n}: new P${n}() };`],
    value: `m${n}`,
  }),
  "signature result": (n: string) => ({
    lines: [`const f${n}: () => object = () => new P${n}();`],
    value: `f${n}()`,
  }),
  "signature parameter backward": (n: string) => ({
    lines: [
      `let got${n}: unknown;`,
      `const f${n}: (p: P${n}) => void = (p: object) => { got${n} = p; };`,
      `f${n}(new P${n}());`,
    ],
    value: `got${n}`,
  }),
  "class into an interface": (n: string) => ({
    lines: [`interface N${n} { m${n}a: number }`, `const v${n}: N${n} = new P${n}();`],
    value: `v${n}`,
  }),
  "interface into a narrower interface": (n: string) => ({
    lines: [
      `interface Wide${n} { m${n}a: number; m${n}b: number }`,
      `interface Thin${n} { m${n}a: number }`,
      `const w${n}: Wide${n} = new P${n}();`,
      `const t${n}: Thin${n} = w${n};`,
    ],
    value: `t${n}`,
  }),
  "Set into ReadonlySet": (n: string) => ({
    lines: [`const s${n}: ReadonlySet<P${n}> = new Set([new P${n}()]);`],
    value: `[...s${n}]`,
  }),
  "Map read by Object.fromEntries": (n: string) => ({
    lines: [],
    value: `Object.fromEntries(new Map<string, object>([["w", new P${n}()]]))`,
  }),
  "six levels deep": (n: string) => ({
    lines: [
      `type D${n} = { a: { a: { a: { a: { a: { a: object } } } } } };`,
      `const d${n}: D${n} = { a: { a: { a: { a: { a: { a: new P${n}() } } } } } };`,
    ],
    value: `d${n}`,
  }),
  throw: (n: string) => ({
    lines: [],
    value: `(() => { try { throw new P${n}(); } catch (error) { return error; } })()`,
  }),
  "spread argument": (n: string) => ({
    lines: [`function first${n}(...xs: object[]): object | undefined { return xs[0]; }`],
    value: `first${n}(...[new P${n}()])`,
  }),
  "JSX expression": (n: string) => ({
    lines: [],
    value: `<i v={new P${n}()} />`,
    needs: ["jsx"],
  }),
  "JSX spread attribute": (n: string) => ({
    lines: [],
    value: `<i {...{ w${n}: new P${n}() }} />`,
    needs: ["jsx"],
  }),
  "for...of into an existing target": (n: string) => ({
    lines: [`let t${n}: object = {};`, `for (t${n} of [new P${n}()]) { void t${n}; }`],
    value: `t${n}`,
  }),
  "class read as a value": (n: string) => ({
    lines: [`const C${n}: new () => object = P${n};`],
    value: `new C${n}()`,
  }),
  "class expression": (n: string) => ({
    lines: [`const E${n} = [class extends P${n} {}][0]!;`],
    value: `new E${n}()`,
  }),
  "decorated class": (n: string) => ({
    lines: [
      `function dec${n}<T>(c: T, _context: ClassDecoratorContext): T { return c; }`,
      `@dec${n} class D${n} extends P${n} {}`,
    ],
    value: `new D${n}()`,
  }),
  "direct eval": (n: string) => ({ lines: [`eval("void 0");`], value: `new P${n}()` }),
  arguments: (n: string) => ({
    lines: [`function take${n}(_x: object): unknown { return arguments[0]; }`],
    value: `take${n}(new P${n}())`,
  }),
  "Object.assign copy": (n: string) => ({
    lines: [],
    value: `Object.assign({}, new P${n}())`,
  }),
  "property over a type parameter": (n: string) => ({
    lines: [
      `class Box${n}<T> { v?: T; }`,
      `const b${n} = new Box${n}<object>();`,
      `b${n}.v = new P${n}();`,
    ],
    value: `b${n}`,
  }),
  "package callee": (n: string) => ({
    lines: [],
    value: `outside.pass(new P${n}())`,
    needs: ["package"],
  }),
  "package callee through call": (n: string) => ({
    lines: [],
    value: `outside.pass.call(undefined, new P${n}())`,
    needs: ["package"],
  }),
  "class extending a package's class": (n: string) => ({
    lines: [],
    payload: `class P${n} extends outside.Base { m${n}a = 1; m${n}b = 2; }`,
    value: `(new P${n}(), outside.last())`,
    needs: ["package"],
  }),
  "ambient variable": (n: string) => ({
    lines: [],
    value: `(outsideStore.hold(new P${n}()), outsideStore.held())`,
    needs: ["package"],
  }),
  "rooted function": (n: string) => ({
    lines: [`export function made${n}(): P${n} { return new P${n}(); }`],
    value: `made${n}()`,
  }),
  "implementation through its interface": (n: string) => ({
    lines: [
      `interface I${n} { get(): object }`,
      `class H${n} implements I${n} { get(): P${n} { return new P${n}(); } }`,
      `const i${n}: I${n} = new H${n}();`,
    ],
    value: `i${n}.get()`,
  }),
  "overload implementation": (n: string) => ({
    lines: [
      `function over${n}(x: number): object;`,
      `function over${n}(x: unknown): unknown { void x; return new P${n}(); }`,
    ],
    value: `over${n}(1)`,
  }),
  "generic method of an interface": (n: string) => ({
    lines: [
      `interface G${n} { pick<U extends object>(u: U): U }`,
      `const g${n}: G${n} = { pick: (u) => u };`,
    ],
    value: `g${n}.pick(new P${n}())`,
  }),
  "self-instantiating generic": (n: string) => ({
    lines: [
      `interface Chain${n}<T> { v: T; next?: Chain${n}<{ w: T }> }`,
      `const c${n}: Chain${n}<P${n}> = { v: new P${n}() };`,
    ],
    value: `c${n}`,
  }),
  "decode re-sent": (n: string) => ({
    lines: [`const v${n}: P${n} = JSON.parse('{"m${n}c":3}');`],
    payload: `class P${n} { m${n}a = 1; m${n}b = 2; m${n}c?: number; }`,
    value: `v${n}`,
  }),
  "parameter property": (n: string) => ({
    lines: [],
    payload: `class P${n} { m${n}b = 2; constructor(public m${n}a = 1) {} }`,
    value: `new P${n}()`,
  }),
} satisfies Record<string, (n: string) => OracleForm>;

type OracleFormName = keyof typeof ORACLE_GENERATORS;
const VIEW_FORMS = Object.keys(viewsReached()) as OracleFormName[];
const ORACLE_FORMS = Object.keys(ORACLE_GENERATORS) as OracleFormName[];
/**
 * The forms the rule as stated reports dead though the program, run, serializes them. The
 * oracle does not draw them until the rule is redesigned; no row of CLAIMED_FORMS names one.
 */
const PENDING_FORMS: ReadonlySet<OracleFormName> = new Set<OracleFormName>([
  ...VIEW_FORMS,
  "method through any",
  "getter through any",
  "static method through any",
  "static field through any",
  "class into an interface then any",
  "method through unknown",
  "literal method into a narrower type",
  "interface method into a narrower type",
  "constrained type parameter into an interface",
  "indexed access into an interface",
  "key from data",
  "key from data tested by in",
  "literal key tested by in",
  "computed key from data",
  "Object.defineProperty",
  "Object.fromEntries",
  "Reflect.set",
  "key on a type parameter",
  "subclass key on a base this",
  "subclass key on a generic base",
  "subclass key on a base variable",
  "subclass key tested by in on a base",
  "subclass Object.assign onto a base",
  "subclass Reflect.set on a base",
  "subclass Object.defineProperty on a base",
  "member only a wider view declares",
  "literal variable into a wider view",
  "literal result into a wider view",
  "literal into a wider parameter",
  "spread of a literal written through a wider view",
  "satisfies literal into a wider parameter",
  "wider view through a type parameter's constraint",
  "wider view through a generic class method's constraint",
  "wider view through a generic constructor's constraint",
  "callback with a wider parameter at Array forEach",
  "callback with a wider parameter at Array some",
  "callback with a wider parameter at Set forEach",
  "callback with a wider parameter at Map forEach",
  "the wider view's own member",
  "the wider view's own member through a type alias",
  "tagged template",
  "generator yield",
  "yield*",
  "shorthand property",
  "constructor return",
  "signature result",
  "signature parameter backward",
  "class into an interface",
  "interface into a narrower interface",
  "throw",
  "JSX expression",
  "for...of into an existing target",
  "class read as a value",
  "arguments",
  "class extending a package's class",
  "ambient variable",
  "implementation through its interface",
  "overload implementation",
]);
const DRAWN_FORMS = ORACLE_FORMS.filter((form) => !PENDING_FORMS.has(form));
const ORACLE_WRAPS = ["none", "generic identity", "array", "object", "promise"] as const;
const ORACLE_SINKS = ["JSON.stringify", "unknown parameter", "any parameter", "replacer"] as const;

/**
 * The forms references-ts.41 claims, each a fragment of its text with the generators that
 * draw it; a clause that states no form says why. Every clause of the rule holds a fragment.
 */
const CLAIMED_FORMS: readonly {
  readonly claim: string;
  readonly forms: readonly OracleFormName[];
  readonly notAForm?: string;
}[] = [
  {
    claim: "holds back every data member of every class the value can be",
    forms: ["into object", "into {}", "list into a list", "generic instance both ways"],
  },
  {
    claim: "This holds at every destination of the `serialization-contract` exemption",
    forms: ["direct", "decode re-sent"],
  },
  {
    claim: "A type is fully concrete only where it is a primitive or a literal type",
    forms: ["union target", "recursive type", "six levels deep"],
  },
  {
    claim: "A value holds the type of each of its data members and index signatures",
    forms: [
      "property write",
      "object literal property",
      "Object.assign",
      "Object.assign copy",
      "parameter property",
    ],
  },
  {
    claim: "Every other type is not fully concrete",
    forms: [
      "intersection target",
      "into an index signature",
      "Set into ReadonlySet",
      "Map read by Object.fromEntries",
      "async result",
    ],
  },
  {
    claim:
      "The result of a call or `new` expression whose callee is outside the analysis or ambient",
    forms: ["package callee", "package callee through call", "direct eval"],
  },
  {
    claim: "The classes the value can be are read from the checker",
    forms: ["satisfies", "assertion"],
  },
  {
    claim: "They are each class of the target, with each class of the target that extends it",
    forms: ["class expression", "decorated class", "generic method of an interface"],
  },
  {
    claim: "every class of the target where that walk is cut",
    forms: [],
    notAForm: "a bound on the walk, which no program the oracle draws reaches",
  },
  {
    claim: "and the classes of each value that flows into the argument",
    forms: ["argument of a project function", "arrow body"],
  },
  {
    claim: "Those values are what a function of the project the argument calls returns",
    forms: ["call", "apply", "bind", "rooted function"],
  },
  {
    claim: "what the variable the argument names is initialized with, iterates over or is assigned",
    forms: [
      "binding default",
      "logical assignment",
      "destructuring assignment",
      "destructuring assignment of a variable",
      "destructuring rest",
      "destructuring by a computed name",
      "for...in",
    ],
  },
  {
    claim: "the argument each call passes at the parameter the argument names",
    forms: ["spread argument", "JSX spread attribute"],
  },
  {
    claim: "what the object of a property or element access other than `this` holds",
    forms: [
      "constant key",
      "literal key",
      "numeric literal key",
      "spread of a decode",
      "Object.keys",
      "Object.entries",
      "Object.values",
      "Object.getOwnPropertyNames",
      "Object.getOwnPropertyDescriptor",
      "Object.getOwnPropertyDescriptors",
    ],
  },
  {
    claim: "the elements, property values, spreads and getter results of a literal",
    forms: [
      "array spread",
      "object spread",
      "literal behind `as` at a wider place",
      "literal behind `satisfies` at a wider place",
      "literal behind an angle assertion at a wider place",
      "literal behind a non-null assertion at a wider place",
      "literal behind parentheses at a wider place",
      "literal keeping this behind `as` at a wider place",
      "literal keeping this behind `satisfies` at a wider place",
      "literal keeping this behind an angle assertion at a wider place",
      "literal behind a conditional inside `as` at a wider place",
      "literal behind ?? inside `as` at a wider place",
      "literal behind an intersection assertion at a wider place",
    ],
  },
  {
    claim: "and what the `toJSON` of each class the value can be returns",
    forms: [],
    notAForm:
      "the rows of serialization-contract.test.ts decide it, since a payload's own toJSON changes what the oracle reads",
  },
  {
    claim: "For each type parameter the argument's type is written over",
    forms: ["property over a type parameter", "self-instantiating generic"],
  },
  {
    claim: "each type argument a call of that function writes",
    forms: ["generic instance both ways"],
  },
  {
    claim: "for a class's type parameter, the type argument at its position",
    forms: ["self-instantiating generic"],
  },
  {
    claim: "the object and the other arguments of each call the function is passed to",
    forms: ["call", "apply"],
  },
  {
    claim: "and every class of the target where the function is read as a value any other way",
    forms: ["bind", "rooted function"],
  },
  {
    claim: "A fully concrete argument type keeps the member reach the exemption states",
    forms: ["direct", "subclass held as its base"],
  },
  {
    claim: "The name an element access stores through",
    forms: [
      "element write",
      "collection literal behind `as` only stored into",
      "collection literal behind `satisfies` only stored into",
      "collection literal behind an angle assertion only stored into",
      "collection literal behind a non-null assertion only stored into",
      "collection literal behind parentheses only stored into",
      "collection literal a let assigned nowhere else holds, only stored into",
      "collection literal a let holds whose name an inner scope assigns, only stored into",
    ],
  },
];

/**
 * The clauses of references-ts.41: its sentences, each split at its semicolons, and the
 * sentence of references-ts.25 on a name an element access stores through, whose literal
 * the oracle's precision controls draw.
 */
function claimedClauses(): readonly string[] {
  const text = readFixture("contract", "grammar", "analysis", "references-ts.md");
  const paragraph = (marker: string): string =>
    (text.split("\n").find((line) => line.startsWith(marker)) ?? "").slice(marker.length);
  const sentences = (one: string): readonly string[] => one.split(/(?<=\.) (?=[A-Z(`])/u);
  return [
    ...sentences(paragraph("**references-ts.41** ")).flatMap((sentence) => sentence.split("; ")),
    ...sentences(paragraph("**references-ts.25** ")).filter((sentence) =>
      sentence.startsWith("The name an element access stores through"),
    ),
  ];
}

describe("the forms the oracle draws", () => {
  it("cover every clause references-ts.41 states, and each generator draws a claimed form", () => {
    const clauses = claimedClauses();
    expect(clauses.length).toBeGreaterThan(20);
    expect(
      clauses.filter((clause) => !CLAIMED_FORMS.some((one) => clause.includes(one.claim))),
      "a clause no row of the table claims",
    ).toEqual([]);
    expect(
      CLAIMED_FORMS.filter((one) => !clauses.some((clause) => clause.includes(one.claim))).map(
        (one) => one.claim,
      ),
      "a row whose fragment the rule no longer states",
    ).toEqual([]);
    expect(
      CLAIMED_FORMS.filter((one) => (one.forms.length === 0) === (one.notAForm === undefined)).map(
        (one) => one.claim,
      ),
      "a claimed form with no generator, or a clause that is no form with one",
    ).toEqual([]);
    const claimed = new Set(CLAIMED_FORMS.flatMap((one) => one.forms));
    expect(
      ORACLE_FORMS.filter((form) => claimed.has(form) === PENDING_FORMS.has(form)),
      "a generator no claimed form names, or a pending form a claim names",
    ).toEqual([]);
  });
});

/** One use of a drawn program: how its payload gets out, what wraps it and what serializes it. */
interface OracleUse {
  readonly form: OracleFormName;
  readonly wrap: (typeof ORACLE_WRAPS)[number];
  readonly sink: (typeof ORACLE_SINKS)[number];
}

/** The package outside the analysis that drawn programs import, and what it puts on `globalThis`. */
const OUTSIDE_PACKAGE: Readonly<Record<string, string>> = {
  "node_modules/outpkg/package.json": JSON.stringify({
    name: "outpkg",
    version: "1.0.0",
    type: "module",
    main: "index.js",
    types: "index.d.ts",
  }),
  "node_modules/outpkg/index.js": [
    "let made;",
    "export function pass(x) { return x; }",
    "export class Base { constructor() { made = this; } }",
    "export function last() { return made; }",
    "let held;",
    "globalThis.outsideStore = { hold(x) { held = x; }, held() { return held; } };",
  ].join("\n"),
  "node_modules/outpkg/index.d.ts": [
    "export declare function pass(x: object): object;",
    "export declare class Base { constructor(); }",
    "export declare function last(): object;",
  ].join("\n"),
};

/** The program a draw writes, each use pushing what its sink returns into `out`. */
function oracleProgram(uses: readonly OracleUse[]): {
  readonly text: string;
  readonly needs: ReadonlySet<OracleNeed>;
  readonly dead: readonly string[];
} {
  const needs = new Set<OracleNeed>();
  const body: string[] = [];
  const dead: string[] = [];
  uses.forEach((use, at) => {
    const n = String(at);
    const form: OracleForm = ORACLE_GENERATORS[use.form](n);
    for (const need of form.needs ?? []) {
      needs.add(need);
    }
    dead.push(...(form.dead ?? []));
    const payload = form.payload ?? `class P${n} { m${n}a = 1; m${n}b = 2; }`;
    body.push(...(payload === "" ? [] : [payload]), ...form.lines);
    const value = form.value;
    const sink = (argument: string): string => {
      switch (use.sink) {
        case "JSON.stringify":
          return `JSON.stringify(${argument})`;
        case "unknown parameter":
          return `save(${argument})`;
        case "any parameter":
          return `saveAny(${argument})`;
        case "replacer":
          return `JSON.stringify(${argument}, (_key: string, value: unknown) => value)`;
      }
    };
    switch (use.wrap) {
      case "none":
        body.push(`out.push(${sink(value)});`);
        break;
      case "generic identity":
        body.push(`out.push(${sink(`identity(${value})`)});`);
        break;
      case "array":
        body.push(`out.push(${sink(`[${value}]`)});`);
        break;
      case "object":
        body.push(`out.push(${sink(`{ wrap: ${value} }`)});`);
        break;
      case "promise":
        body.push(`void Promise.resolve(${value}).then((v) => { out.push(${sink("v")}); });`);
        break;
    }
  });
  const lines = [
    ...(needs.has("package")
      ? [
          'import * as outside from "outpkg";',
          // A namespace import nothing but a type reads is elided, and the package
          // installs a global.
          'import "outpkg";',
          "declare const outsideStore: { hold(x: object): void; held(): unknown };",
        ]
      : []),
    ...(needs.has("jsx")
      ? [
          "declare global { namespace JSX { type Element = string; interface IntrinsicElements { i: Record<string, unknown> } } }",
          "function h(_tag: string, props: Record<string, unknown> | null): string { return JSON.stringify(props); }",
        ]
      : []),
    "export const out: string[] = [];",
    "function identity<T>(x: T): T { return x; }",
    "function save(x: unknown): string { return JSON.stringify(x); }",
    "function saveAny(x: any): string { return JSON.stringify(x); }",
    "class K { k1 = 1; k2 = 2; }",
    "export const kept = new K().k1;",
    ...body,
  ];
  return { text: lines.join("\n"), needs, dead };
}

/** A preload that records every string `JSON.stringify` returns and prints them all at exit. */
const CAPTURE = [
  "const stringify = JSON.stringify;",
  "const seen = [];",
  "JSON.stringify = function (...args) {",
  "  const text = Reflect.apply(stringify, this, args);",
  '  if (typeof text === "string") seen.push(text);',
  "  return text;",
  "};",
  'process.on("exit", () => { process.stdout.write(`\\n${stringify(seen)}\\n`); });',
].join("\n");

/** Every object key in one serialized JSON text, at any depth. */
function keysOf(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const one of value) {
      keysOf(one, into);
    }
  } else if (typeof value === "object" && value !== null) {
    for (const [key, one] of Object.entries(value)) {
      into.add(key);
      keysOf(one, into);
    }
  }
}

let oracleDead = 0;

/**
 * The members deadset-ts reports dead that the program, run, serializes: each payload's
 * member names are unique to it, so a key the output holds is that member.
 */
function oracleViolations(uses: readonly OracleUse[]): readonly string[] {
  const { text: main, needs, dead: expected } = oracleProgram(uses);
  const file = needs.has("jsx") ? "main.tsx" : "main.ts";
  const root = writeProject({
    "package.json": JSON.stringify({
      name: "@example/tree",
      private: true,
      type: "module",
      ...(needs.has("package") ? { dependencies: { outpkg: "1.0.0" } } : {}),
    }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "es2022",
        module: "nodenext",
        jsx: "react",
        jsxFactory: "h",
      },
      include: ["*.ts", "*.tsx"],
    }),
    [file]: `${main}\n`,
    ...(needs.has("package") ? OUTSIDE_PACKAGE : {}),
  });
  try {
    expect(diagnosticsOf(root, [file])).toEqual([]);
    // The run reads the tree before it writes its compiled copy into it. Every finding
    // counts, a write-only one included, since deleting its subject changes what is sent.
    const { config } = resolve({
      repository: {
        text: JSON.stringify({
          target: { kind: "application" },
          analysis: { min_confidence: "possible" },
          ts: { entry_files: [file] },
        }),
        label: "deadset.json",
      },
    });
    const dead = findingsOf(emitterInputOf(root, config)).map((finding) => finding.symbol.name);
    writeFileSync(join(root, "capture.mjs"), `${CAPTURE}\n`);
    // The program runs as TypeScript compiles it, so a form type stripping cannot run, JSX,
    // a parameter property or a decorator, runs too.
    const emitted = ts.transpileModule(main, {
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.React,
        jsxFactory: "h",
      },
    }).outputText;
    writeFileSync(join(root, "main.mjs"), emitted);
    const ran = spawnSync(process.execPath, ["--import", "./capture.mjs", "main.mjs"], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(ran.status, `${main}\n${ran.stderr}`).toBe(0);
    const serialized = new Set<string>();
    const last = ran.stdout.trim().split("\n").at(-1) ?? "[]";
    for (const text of JSON.parse(last) as string[]) {
      keysOf(JSON.parse(text), serialized);
    }
    oracleDead += dead.length;
    // Another use can let every class escape, so a form's own precision is read alone.
    const missed = uses.length === 1 ? expected.filter((name) => !dead.includes(name)) : [];
    return [
      ...dead.flatMap((name) => {
        const member = name.slice(name.lastIndexOf(".") + 1).replace(/^'(.*)'$/u, "$1");
        return name.includes(".") && serialized.has(member)
          ? [`${name} reported dead and serialized at runtime in:\n${main}`]
          : [];
      }),
      ...missed.map((name) => `${name} not reported dead, though nothing keeps it, in:\n${main}`),
    ];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const oracleUse: fc.Arbitrary<OracleUse> = fc.record({
  form: fc.constantFrom(...DRAWN_FORMS),
  wrap: fc.constantFrom(...ORACLE_WRAPS),
  sink: fc.constantFrom(...ORACLE_SINKS),
});

/** The draws and the seed CI runs; the weekly job raises the one and varies the other. */
const ORACLE_RUNS = Number(process.env["DEADSET_ORACLE_RUNS"] ?? "60");
const ORACLE_SEED = Number(process.env["DEADSET_ORACLE_SEED"] ?? "20261113");
/** A bound of 20 s a program, its run under node and its sweep included. */
const ORACLE_BUDGET = (ORACLE_RUNS + DRAWN_FORMS.length) * 20_000;

/**
 * Property, with the runtime as the oracle: a drawn program is run under node, and no
 * member deadset-ts reports dead is among what `JSON.stringify` emitted. Every form alone
 * runs first, then drawn programs of up to three uses at a fixed seed.
 */
describe("a member serialized when the program runs", () => {
  it(
    "is never reported dead",
    () => {
      oracleDead = 0;
      fc.assert(
        fc.property(fc.array(oracleUse, { minLength: 1, maxLength: 3 }), (uses) => {
          expect(oracleViolations(uses)).toEqual([]);
        }),
        {
          numRuns: ORACLE_RUNS,
          seed: ORACLE_SEED,
          examples: DRAWN_FORMS.map((form) => [
            [{ form, wrap: "none" as const, sink: "JSON.stringify" as const }],
          ]),
          plugins: [fc.interruptAfterTimeLimit(ORACLE_BUDGET, { failOnInterrupt: true })],
        },
      );
      // The class `K` no use serializes is reported in every draw, so the oracle reads a sweep.
      expect(oracleDead).toBeGreaterThan(0);
    },
    ORACLE_BUDGET + 60_000,
  );
});
