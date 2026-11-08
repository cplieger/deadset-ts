import { rmSync } from "node:fs";
import { join } from "node:path";
import { isCallExpression, type CallExpression, type Node } from "@typescript/native/ast";
import type { Checker, Type } from "@typescript/native/sync";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { writeProject } from "../../__test-helpers__/projects.ts";
import { runSweep } from "../analysis.ts";
import { resolve } from "../resolve.ts";
import { scopeForDir } from "../scope.ts";
import { openEngine } from "../session.ts";

/** How the callee declares the parameter the class reaches. */
const SHAPES = [
  "fixed",
  "optional",
  "rest",
  "rest tuple",
  "type parameter rest",
  "type parameter rest tuple",
  "union of tuples",
  "tuple or array union",
  "intersection rest",
  "branded rest",
  "overloads",
  "array interface rest",
  "readonly array interface rest",
  "readonly array rest",
  "array-like rest",
  "index signature rest",
] as const;
type Shape = (typeof SHAPES)[number];

/** The shapes whose rest is a union. */
const UNIONS: readonly Shape[] = ["union of tuples", "tuple or array union"];

/** The rests typed by an array-like type other than a tuple or `T[]`, written as their own property. */
const ARRAY_LIKE: readonly Shape[] = [
  "array interface rest",
  "readonly array interface rest",
  "readonly array rest",
  "array-like rest",
  "index signature rest",
];

/** The shapes whose rest takes the class at any place from the parameter's on. */
const REPEATING: readonly Shape[] = ["rest", "type parameter rest", ...ARRAY_LIKE];

/**
 * Array-like rest types that are no tuple, each numbering a string member for every place
 * before the reached one; `Unknown…` is no type reference, so it has no type argument to
 * read a place count from. TypeScript rejects `ArrayLike<T>` and `Indexed<T>` as a rest's
 * type, and its checker still types each place of one.
 */
const INTERFACES = [0, 1, 2].flatMap((count) => {
  const numbered = (readonly: string): string =>
    strings(count, "string")
      .map((type, at) => `${readonly}${String(at)}: ${type};`)
      .join(" ");
  return [
    `interface Listed${String(count)}<T> extends Array<T | string> { ${numbered("")} }`,
    `interface UnknownListed${String(count)} extends Array<unknown> { ${numbered("")} }`,
    `interface ReadonlyListed${String(count)}<T> extends ReadonlyArray<T | string> { ${numbered("readonly ")} }`,
    `interface UnknownReadonlyListed${String(count)} extends ReadonlyArray<unknown> { ${numbered("readonly ")} }`,
  ];
});

/** How many string places come before that parameter. */
const PLACES = [0, 1, 2] as const;

/** How the arguments before the class are written. */
const PREFIXES = ["none", "one", "two", "one spread", "two spread", "array spread"] as const;
type Prefix = (typeof PREFIXES)[number];

/** How the class is written. */
const VALUES = ["plain", "tuple spread", "array spread", "iterable spread"] as const;
type Value = (typeof VALUES)[number];

/** What follows the class. */
const SUFFIXES = ["none", "array spread"] as const;
type Suffix = (typeof SUFFIXES)[number];

/** What the callee does with the parameter. */
const SINKS = ["generic", "unknown", "outside generic", "outside unknown"] as const;
type Sink = (typeof SINKS)[number];

/** How the call reaches the callee. */
const FORMS = ["direct", "call", "apply", "apply a list", "bind"] as const;
type Form = (typeof FORMS)[number];

/**
 * How a call writes a class at a leading `object` place beside a string for the
 * parameter a destination reads, each a tuple of known length or plain arguments.
 */
const WRITINGS = [
  "one tuple",
  "class plain",
  "class tuple then plain",
  "two tuples",
  "class last in one tuple",
] as const;
type Writing = (typeof WRITINGS)[number];

/** One callee and the arguments one call passes it. */
interface Case {
  readonly shape: Shape;
  /** How many string places come before the parameter, after the leading place if any. */
  readonly place: number;
  /** Whether the callee leads with an `object` place. */
  readonly lead: boolean;
  /** The arguments written for the class `name`. */
  readonly args: (name: string) => string;
  /** Whether a spread of unknown length comes at or before the class. */
  readonly unknownLength: boolean;
  /** What the case is called in a violation. */
  readonly label: string;
}

function identifier(text: string): string {
  return text.replaceAll(/[^\w$]/gu, "_");
}

function strings(count: number, text: string): string[] {
  return Array.from({ length: count }, () => text);
}

/** The arguments the first property writes before, at and after the class. */
function argumentsOf(prefix: Prefix, value: Value, suffix: Suffix, name: string): string {
  const before = {
    none: [],
    one: ['"s"'],
    two: ['"s"', '"s"'],
    "one spread": ["...one"],
    "two spread": ["...two"],
    "array spread": ["...strings"],
  }[prefix];
  const at = {
    plain: `new ${name}()`,
    "tuple spread": `...([new ${name}()] as [${name}])`,
    "array spread": `...([new ${name}()] as ${name}[])`,
    "iterable spread": `...new Set([new ${name}()])`,
  }[value];
  return [...before, at, ...(suffix === "none" ? [] : ["...strings"])].join(", ");
}

/** The arguments the second property writes, `count` strings between the class and the last. */
function writtenOf(writing: Writing, count: number, name: string): string {
  const between = strings(count, '"s"');
  const typed = strings(count, "string");
  switch (writing) {
    case "one tuple":
      return `...([new ${name}(), ${[...between, '"s"'].join(", ")}] as [${[name, ...typed, "string"].join(", ")}])`;
    case "class plain":
      return [`new ${name}()`, ...between, '"s"'].join(", ");
    case "class tuple then plain":
      return `...([${[`new ${name}()`, ...between].join(", ")}] as [${[name, ...typed].join(", ")}]), "s"`;
    case "two tuples":
      return `...([new ${name}()] as [${name}]), ...([${[...between, '"s"'].join(", ")}] as [${[...typed, "string"].join(", ")}])`;
    case "class last in one tuple":
      return `...([${["{}", ...between, `new ${name}()`].join(", ")}] as [${["object", ...typed, name].join(", ")}])`;
  }
}

const CASES: readonly Case[] = SHAPES.flatMap((shape) =>
  PLACES.flatMap((place) =>
    PREFIXES.flatMap((prefix) =>
      VALUES.flatMap((value) =>
        SUFFIXES.map((suffix): Case => ({
          shape,
          place,
          lead: false,
          args: (name) => argumentsOf(prefix, value, suffix, name),
          unknownLength:
            prefix === "array spread" || (value !== "plain" && value !== "tuple spread"),
          label: `${shape}@${String(place)} (${argumentsOf(prefix, value, suffix, "P")})`,
        })),
      ),
    ),
  ),
);

const MIXED: readonly Case[] = SHAPES.flatMap((shape) =>
  [0, 1].flatMap((place) =>
    WRITINGS.map((writing): Case => ({
      shape,
      place,
      lead: true,
      args: (name) => writtenOf(writing, place, name),
      unknownLength: false,
      label: `object, ${shape}@${String(place + 1)} (${writtenOf(writing, place, "P")})`,
    })),
  ),
);

/** The parameters before the one the class reaches: the leading `object` place, then strings. */
function before(place: number, lead: boolean): string[] {
  return [
    ...(lead ? ["c: object"] : []),
    ...Array.from({ length: place }, (_unused, at) => `a${String(at)}: string`),
  ];
}

/** The element types of a rest tuple whose last element is `type`. */
function tupleOf(place: number, type: string): string {
  return [...strings(place, "string"), type].join(", ");
}

/**
 * The type parameters and parameter list of a callee of one shape, the reached parameter
 * typed `type`; a rest typed by a type parameter is constrained so `unknown` is its element.
 * The leading `object` place is part of a rest only where the rest is a union, whose
 * tuple members each start with it, so that an argument at a place of the rest that keeps
 * its value's type is asked about. `overloads` is the second of two overloads, the first
 * of which is `shorterOf`.
 */
function signatureOf(shape: Shape, place: number, type: string, lead: boolean): string {
  const generic = type === "T" ? "<T>" : "";
  const leading = lead ? "c: object, " : "";
  const member = (elements: readonly string[]): string =>
    `[${[...(lead ? ["object"] : []), ...elements].join(", ")}]`;
  switch (shape) {
    case "fixed":
      return `${generic}(${[...before(place, lead), `v: ${type}`].join(", ")})`;
    case "optional":
      return `${generic}(${[...before(place, lead), `v?: ${type}`].join(", ")})`;
    case "rest":
      return `${generic}(${[...before(place, lead), `...v: ${type}[]`].join(", ")})`;
    case "rest tuple":
      return `${generic}(${leading}...v: [${tupleOf(place, type)}])`;
    case "type parameter rest":
      return `<A extends unknown[]>(${[...before(place, lead), "...v: A"].join(", ")})`;
    case "type parameter rest tuple":
      return `<A extends [${tupleOf(place, "unknown")}]>(${leading}...v: A)`;
    case "union of tuples":
      return `${generic}(...v: ${member([tupleOf(place, type)])} | ${member(strings(place, "string"))})`;
    case "tuple or array union":
      return `${generic}(...v: ${member([tupleOf(place, type)])} | number[])`;
    case "intersection rest":
      return `${generic}(${leading}...v: [${tupleOf(place, type)}] & unknown[])`;
    case "branded rest":
      return `${generic}(${leading}...v: [${tupleOf(place, type)}] & { readonly brand?: never })`;
    case "overloads":
      return signatureOf("fixed", place, type, lead);
    case "array interface rest":
      return `${generic}(${leading}...v: ${type === "T" ? `Listed${String(place)}<T>` : `UnknownListed${String(place)}`})`;
    case "readonly array interface rest":
      return `${generic}(${leading}...v: ${type === "T" ? `ReadonlyListed${String(place)}<T>` : `UnknownReadonlyListed${String(place)}`})`;
    case "readonly array rest":
      return `${generic}(${[...before(place, lead), `...v: readonly ${type}[]`].join(", ")})`;
    case "array-like rest":
      return `${generic}(${[...before(place, lead), `...v: ArrayLike<${type}>`].join(", ")})`;
    case "index signature rest":
      return `${generic}(${[...before(place, lead), `...v: Indexed<${type}>`].join(", ")})`;
  }
}

/**
 * The overload declared before an `overloads` callee's: a rest tuple of the places before
 * the reached one, which has no place for an argument there.
 */
function shorterOf(place: number, lead: boolean): string {
  return `(...v: [${[...(lead ? ["object"] : []), ...strings(place, "string")].join(", ")}])`;
}

/** The declarations `keyword` writes of a callee of one shape, overloads first. */
function declarationsOf(keyword: string, name: string, one: Case, signature: string): string {
  const shorter =
    one.shape === "overloads" ? [`${keyword} ${name}${shorterOf(one.place, one.lead)}: void;`] : [];
  return [...shorter, `${keyword} ${name}${signature}: void;`].join(" ");
}

/**
 * The signature the oracle declares for a shape: one whose type parameter the checker
 * infers at each place, so the instantiated type there says where the class lands.
 */
function oracleSignatureOf(shape: Shape, place: number, lead: boolean): string {
  switch (shape) {
    case "rest":
    case "type parameter rest":
      return `<T extends unknown[]>(${[...before(place, lead), "...v: T"].join(", ")})`;
    case "type parameter rest tuple":
      return signatureOf("rest tuple", place, "T", lead);
    default:
      return signatureOf(shape, place, "T", lead);
  }
}

/**
 * The sinks a case is called through. A callee whose rest a type parameter types is
 * generic whatever the sink, so only the generic sinks are written for it. A project
 * function that serializes a union rest holding the leading `object` place serializes the
 * value there too, which the checker's binding does not say, so such a rest is written
 * only as an outside callee, as overloads are, whose implementation is one more signature.
 */
function sinksOf(one: Case): readonly Sink[] {
  if (one.shape.startsWith("type parameter")) {
    return SINKS.filter((sink) => sink.endsWith("generic"));
  }
  return one.shape === "overloads" || (one.lead && UNIONS.includes(one.shape))
    ? SINKS.filter((sink) => sink.startsWith("outside"))
    : SINKS;
}

function calleeName(one: Case, sink: Sink): string {
  return identifier(`${sink}_${one.shape}_${one.lead ? "lead_" : ""}${String(one.place)}`);
}

/** The call one form writes. */
function callOf(form: Form, callee: string, args: string): string {
  switch (form) {
    case "direct":
      return `${callee}(${args});`;
    case "call":
      return `${callee}.call(undefined, ${args});`;
    case "apply":
      return `${callee}.apply(undefined, [${args}]);`;
    case "apply a list":
      return `${callee}.apply(undefined, listed(${args}));`;
    case "bind":
      return `${callee}.bind(undefined, ${args})();`;
  }
}

const COMMON = [
  'const one: [string] = ["s"];',
  'const two: [string, string] = ["s", "s"];',
  "const strings: string[] = [];",
];

/** The types the callees' rests are declared by, in both files. */
const DECLARED = [
  ...INTERFACES,
  "interface Indexed<T> { readonly [i: number]: T; readonly length: number }",
];

/** Whether the type is the class `name`, or a union holding it. */
function holdsClass(type: Type, name: string): boolean {
  const parts = type.isUnionType() ? (type.getTypes() ?? []) : [type];
  return parts.some((part) => part.getSymbol()?.name === name);
}

/** What the checker says of one line: whether it rejects it, and its first call's signature. */
interface Checked {
  readonly rejected: boolean;
  readonly call: CallExpression | undefined;
}

/** Each line of `main.ts` in a project written from `files`, read by one client's checker. */
function checkedLines<R>(
  files: Readonly<Record<string, string>>,
  read: (checker: Checker, lines: readonly Checked[]) => R,
): R {
  const root = writeProject(files);
  const engine = openEngine({ collectTiming: false });
  try {
    const snapshot = engine.createSnapshot([join(root, "tsconfig.json")]);
    try {
      const project = snapshot.getConfiguredProject(join(root, "tsconfig.json"));
      const file = project?.program.getSourceFile(join(root, "main.ts"));
      if (project === undefined || file === undefined) {
        throw new Error("the checked project did not open");
      }
      const lineOf = (node: Node): number =>
        file.text.slice(0, node.getStart()).split("\n").length - 1;
      const rejected = new Set(
        project.program
          .getSemanticDiagnostics(join(root, "main.ts"))
          .flatMap((diagnostic) => diagnostic.startPosition?.line ?? []),
      );
      const calls = new Map<number, CallExpression>();
      const visit = (node: Node): void => {
        if (isCallExpression(node) && !calls.has(lineOf(node))) {
          calls.set(lineOf(node), node);
        }
        node.forEachChild(visit);
      };
      file.forEachChild(visit);
      const count = file.text.split("\n").length;
      return read(
        project.checker,
        Array.from({ length: count }, (_unused, at) => ({
          rejected: rejected.has(at),
          call: calls.get(at),
        })),
      );
    } finally {
      snapshot.dispose();
    }
  } finally {
    engine.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The cases the checker accepts, each with whether the class reaches the parameter: read
 * from the checker's own resolved signature of the direct call, the instantiated type at
 * the parameter's place holding the class. A rest parameter is declared as a tuple type
 * parameter, so the checker infers the type at each of its places rather than one element
 * type every argument there must meet. Each case is on its own line, so a diagnostic names
 * the case it rejects.
 */
function checkerOracle(cases: readonly Case[]): ReadonlyMap<Case, boolean> {
  const oracleName = (one: Case): string =>
    identifier(`oracle_${one.shape}_${one.lead ? "lead_" : ""}${String(one.place)}`);
  const declared = new Map<string, string>();
  for (const one of cases) {
    const signature = oracleSignatureOf(one.shape, one.place, one.lead);
    declared.set(
      oracleName(one),
      declarationsOf("declare function", oracleName(one), one, signature),
    );
  }
  const lines = [...COMMON, ...DECLARED, ...declared.values()];
  const first = lines.length;
  cases.forEach((one, at) => {
    lines.push(
      `class K${String(at)} { id = 1; } ${oracleName(one)}(${one.args(`K${String(at)}`)});`,
    );
  });
  return checkedLines({ "main.ts": `${lines.join("\n")}\n` }, (checker, checked) => {
    const found = new Map<Case, boolean>();
    cases.forEach((one, at) => {
      const line = checked[first + at];
      if (line === undefined || line.rejected || line.call === undefined) {
        return;
      }
      const signature = checker.getResolvedSignature(line.call);
      const place = one.place + (one.lead ? 1 : 0);
      // A rest place is any from the parameter's on; past the last argument the type is `any`.
      const places = REPEATING.includes(one.shape)
        ? [0, 1, 2, 3, 4, 5].map((more) => place + more)
        : [place];
      found.set(
        one,
        places.some((index) =>
          holdsClass(checker.getParameterType(signature, index), `K${String(at)}`),
        ),
      );
    });
    return found;
  });
}

/**
 * The violations of the property over `cases`: every case the checker accepts is called
 * through every sink and form, each with its own class, and the run's retained members are
 * read against the oracle.
 */
function violations(cases: readonly Case[]): readonly string[] {
  const oracle = checkerOracle(cases);
  const outside = SINKS.filter((sink) => sink.startsWith("outside"));
  const callees = new Map<string, string>();
  const declarations = new Map<string, string>();
  for (const one of oracle.keys()) {
    for (const sink of sinksOf(one)) {
      const name = calleeName(one, sink);
      const type = sink.endsWith("generic") ? "T" : "unknown";
      const signature = signatureOf(one.shape, one.place, type, one.lead);
      if (outside.includes(sink)) {
        declarations.set(name, declarationsOf("export declare function", name, one, signature));
      } else {
        callees.set(name, `function ${name}${signature}: string { return JSON.stringify(v); }`);
      }
    }
  }
  const lines = [
    ...COMMON,
    ...DECLARED,
    `import { ${[...declarations.keys()].join(", ")} } from "./outside.ts";`,
    "function listed<A extends unknown[]>(...items: A): A { return items; }",
    ...callees.values(),
  ];
  interface Written {
    readonly name: string;
    readonly one: Case;
    readonly sink: Sink;
    readonly form: Form;
    readonly reached: boolean;
  }
  const written: Written[] = [];
  const first = lines.length;
  for (const [one, reached] of oracle) {
    for (const sink of sinksOf(one)) {
      for (const form of FORMS) {
        const name = `C${String(written.length)}`;
        written.push({ name, one, sink, form, reached });
        lines.push(
          `class ${name} { id = 1; toString(): string { return ""; } } ${callOf(form, calleeName(one, sink), one.args(name))}`,
        );
      }
    }
  }
  const files = {
    "package.json": JSON.stringify({ name: "@example/tree", private: true, type: "module" }),
    "main.ts": `${lines.join("\n")}\n`,
    "outside.ts": `${[...DECLARED, ...declarations.values()].join("\n")}\n`,
  };
  // A call the checker rejects is instantiated however its inference fell, so it is not read.
  const accepted = checkedLines(
    files,
    (_checker, checked) =>
      new Set(written.flatMap((_one, at) => (checked[first + at]?.rejected === false ? [at] : []))),
  );
  // Each shape reaches the class somewhere, and every form of a call is read somewhere.
  expect(new Set([...oracle].filter(([, reached]) => reached).map(([one]) => one.shape))).toEqual(
    new Set(cases.map((one) => one.shape)),
  );
  expect(new Set(written.filter((_one, at) => accepted.has(at)).map((one) => one.form))).toEqual(
    new Set(FORMS),
  );
  const root = writeProject(files);
  try {
    const { config } = resolve({
      repository: {
        text: JSON.stringify({
          target: { kind: "application" },
          ts: { entry_files: ["main.ts"] },
        }),
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
    return written.flatMap(({ name, one, sink, form, reached }, at) => {
      if (!accepted.has(at)) {
        return [];
      }
      const id = held.has(`${name}.id`);
      const converted = held.has(`${name}.toString`);
      const label = `${form} ${sink} ${one.label}`;
      const errors: string[] = [];
      if (reached && !id) {
        errors.push(`${label}: id reported dead`);
      }
      if (!reached && id && !one.unknownLength) {
        errors.push(`${label}: id held back, which the checker binds elsewhere`);
      }
      if (converted !== (id && sink.startsWith("outside"))) {
        errors.push(`${label}: toString ${converted ? "held back" : "reported dead"}`);
      }
      return errors;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Property: a class passed to a call is held back exactly where the checker binds it to
 * the parameter a destination reads, for every way the arguments are written, every way
 * the callee declares the parameter and every way the call reaches it. Where a spread of
 * unknown length comes at or before the class, the class may be held back where the
 * checker binds it elsewhere, never the reverse. The oracle is the checker's resolved signature of the
 * direct call, read independently of the product.
 */
describe("the parameter place each argument of a call binds", () => {
  it("holds back a class exactly where the checker binds it to the parameter a destination reads", () => {
    expect(violations(CASES.filter((one) => !ARRAY_LIKE.includes(one.shape)))).toEqual([]);
  }, 600_000);

  // The array-like rests are swept as two projects, so each stays inside the timeout under load.
  it.each([
    ["an interface over an array", (shape: Shape) => shape.endsWith("interface rest")],
    ["another array-like type", (shape: Shape) => !shape.endsWith("interface rest")],
  ])(
    "holds back a class exactly where the checker binds it to a rest typed by %s",
    (_kind, kind) => {
      expect(
        violations(CASES.filter((one) => ARRAY_LIKE.includes(one.shape) && kind(one.shape))),
      ).toEqual([]);
    },
    600_000,
  );

  it("holds back a class a tuple of known length spreads only at the place the checker binds it", () => {
    expect(violations(MIXED)).toEqual([]);
  }, 600_000);
});

/** Mapped types over a type parameter `T`, each with the type parameters it declares. */
const MAPPED = [
  ["Readonly", "<T>", "Readonly<T>"],
  ["Partial", "<T>", "Partial<T>"],
  ["Required", "<T>", "Required<T>"],
  ["Pick", "<T, K extends keyof T>", "Pick<T, K>"],
  ["Omit", "<T, K extends keyof T>", "Omit<T, K>"],
  ["Omit a literal key", "<T>", 'Omit<T, "x">'],
  ["Omit never", "<T>", "Omit<T, never>"],
  ["written", "<T>", "{ [K in keyof T]: T[K] }"],
  ["Exclude-keyed", "<T>", '{ [P in Exclude<keyof T, "x">]: T[P] }'],
  ["Extract-keyed", "<T>", "{ [P in Extract<keyof T, string>]: T[P] }"],
  ["as remapping", "<T>", "{ [K in keyof T as `get${string & K}`]: () => T[K] }"],
  ["as filtering", "<T>", '{ [K in keyof T as K extends "x" ? never : K]: T[K] }'],
  ["nested", "<T>", "Partial<Readonly<T>>"],
  ["recursive", "<T>", "Deep<T>"],
] as const;

/** What an outside callee's result is declared as. */
const RESULTS = ["void", "T", "the same mapped type", "{ [K in keyof T]: T[K] }"] as const;

const MAPPED_FORMS = ["direct", "call", "apply", "bind"] as const;

/**
 * The violations of the mapped-type property: a class with a private member is passed to a
 * place typed by a mapped type over `T`, of an outside callee whatever its result names or
 * of a project function that serializes it, through every form of a call and after zero
 * or one string argument. Every member of the value is held back wherever the checker
 * accepts the call, because the value at that place reaches a serializer at run time.
 */
function mappedViolations(): readonly string[] {
  const deep = "type Deep<T> = { [K in keyof T]?: Deep<T[K]> };";
  const declarations: string[] = [deep];
  const callees: string[] = [];
  interface Written {
    readonly name: string;
    readonly label: string;
    readonly kind: string;
  }
  const written: Written[] = [];
  const calls: string[] = [];
  for (const [kind, parameters, mapped] of MAPPED) {
    for (const place of [0, 1]) {
      const leading = place === 0 ? "" : "a: string, ";
      const sinks = [
        ...RESULTS.map((result) => {
          const name = identifier(`outside_${kind}_${result}_${String(place)}`);
          const returned = result === "the same mapped type" ? mapped : result;
          declarations.push(
            `export declare function ${name}${parameters}(${leading}x: ${mapped}): ${returned};`,
          );
          return { name, sink: `outside returning ${result}` };
        }),
        (() => {
          const name = identifier(`project_${kind}_${String(place)}`);
          callees.push(
            `function ${name}${parameters}(${leading}x: ${mapped}): string { return JSON.stringify(x); }`,
          );
          return { name, sink: "project" };
        })(),
      ];
      for (const { name: callee, sink } of sinks) {
        for (const form of MAPPED_FORMS) {
          const name = `M${String(written.length)}`;
          const args = [...(place === 0 ? [] : ['"s"']), `new ${name}()`].join(", ");
          written.push({ name, kind, label: `${form} ${sink} ${kind}@${String(place)}` });
          calls.push(`class ${name} { private secret = 1; id = 2; } ${callOf(form, callee, args)}`);
        }
      }
    }
  }
  const lines = [
    `import { ${declarations
      .slice(1)
      .map((one) => /function (\w+)/u.exec(one)?.[1])
      .join(", ")} } from "./outside.ts";`,
    ...callees,
  ];
  const first = lines.length;
  lines.push(...calls);
  const files = {
    "package.json": JSON.stringify({ name: "@example/tree", private: true, type: "module" }),
    "main.ts": `${lines.join("\n")}\n`,
    "outside.ts": `${declarations.join("\n")}\n`,
  };
  const accepted = checkedLines(
    files,
    (_checker, checked) =>
      new Set(written.flatMap((_one, at) => (checked[first + at]?.rejected === false ? [at] : []))),
  );
  expect(new Set(written.filter((_one, at) => accepted.has(at)).map((one) => one.kind))).toEqual(
    new Set(MAPPED.map(([kind]) => kind)),
  );
  const root = writeProject(files);
  try {
    const { config } = resolve({
      repository: {
        text: JSON.stringify({
          target: { kind: "application" },
          ts: { entry_files: ["main.ts"] },
        }),
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
    return written.flatMap(({ name, label }, at) =>
      accepted.has(at)
        ? ["id", "secret"].flatMap((member) =>
            held.has(`${name}.${member}`) ? [] : [`${label}: ${member} reported dead`],
          )
        : [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("a value passed to a place typed by a mapped type over a type parameter", () => {
  it("holds back every member of the value, whatever the mapping keeps and the result names", () => {
    expect(mappedViolations()).toEqual([]);
  }, 600_000);
});
