import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { emitterInputOf, findingsOf } from "../__test-helpers__/emitter-input.ts";
import { analyzeProject, writeProject } from "../__test-helpers__/projects.ts";
import type { ReferenceCost } from "./references.ts";
import { resolve } from "./resolve.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Each finding of an application rooted at `src/main.ts`, as its code, subject, line and message. */
function findings(files: Readonly<Record<string, string>>): string[] {
  const root = writeProject({
    "package.json": '{ "name": "@example/app", "type": "module", "main": "./src/main.ts" }\n',
    ...files,
  });
  roots.push(root);
  const { config } = resolve({
    repository: '{ "target": { "kind": "application" } }',
    repositoryLabel: "deadset.json",
  });
  return findingsOf(emitterInputOf(root, config)).map(
    ({ code, symbol, position, message }) =>
      `${code} ${symbol.name} ${String(position.line)}: ${message}`,
  );
}

/** One module's text, a line per argument. */
function lines(...text: readonly string[]): string {
  return `${text.join("\n")}\n`;
}

/**
 * Each use the contextual types of one written module make, as its line and column, whether
 * it writes or reads, and the member it names.
 */
function contextualUsesOf(text: string): string[] {
  const analyzed = analyzeProject({ "unit.ts": text }, { references: { testFiles: [] } });
  const symbols = analyzed.inventories[0]?.symbols ?? [];
  return (analyzed.references[0]?.references ?? [])
    .filter((reference) => reference.resolution === "contextual")
    .map(
      (reference) =>
        `${String(reference.position.line)}:${String(reference.position.column)} ${reference.use} ${symbols.find((symbol) => symbol.id === reference.to)?.name ?? reference.to}`,
    );
}

/** Every request the reference pass accounts for. */
function accounted(cost: ReferenceCost): number {
  return (
    cost.fileBatches +
    cost.residueFallbacks +
    cost.shorthandLookups +
    cost.aliasSteps +
    cost.patternBatches +
    cost.patternLookups +
    cost.contextualBatches +
    cost.contextualLookups +
    cost.typedLookups
  );
}

/**
 * The contextual batches and per-type lookups one written module costs, once the client's
 * own count of the pass's requests is checked against what the pass accounts for.
 */
function contextualCost(text: string): readonly [number, number] {
  const analyzed = analyzeProject({ "unit.ts": text }, { references: { testFiles: [] } });
  const cost = analyzed.references[0]?.cost;
  expect(cost, "one reference pass").toBeDefined();
  if (cost === undefined) {
    return [0, 0];
  }
  expect(analyzed.referenceRequests, "the client measured no request the pass left out").toBe(
    accounted(cost),
  );
  return [cost.contextualBatches, cost.contextualLookups];
}

describe("the uses a contextual type makes", () => {
  it("writes the member of the contextual type each object-literal property names", () => {
    expect(
      findings({
        "src/main.ts":
          'interface Row {\n  label: string;\n  note: string;\n}\nconst row: Row = { label: "a", note: "" };\nconsole.log(row.label);\n',
      }),
    ).toEqual(["DS1301 Row.note 3: type member Row.note is written once and never read"]);
  });

  it("writes the member of every union constituent that declares the property", () => {
    expect(
      findings({
        "src/main.ts":
          'interface Circle {\n  kind: "circle";\n  size: number;\n}\ninterface Square {\n  kind: "square";\n  size: number;\n}\nconst shape: Circle | Square = { kind: "circle", size: 1 };\nconsole.log(shape.kind);\n',
      }),
    ).toEqual([
      "DS1301 Circle.size 3: type member Circle.size is written once and never read",
      "DS1301 Square.kind 6: type member Square.kind is written once and never read",
      "DS1301 Square.size 7: type member Square.size is written once and never read",
    ]);
  });

  it("reads the member a satisfies target declares wherever the literal property checked against it is read", () => {
    expect(
      findings({
        "src/main.ts":
          'interface Options {\n  name: string;\n  size: number;\n}\nconst options = { name: "a", size: 1 } satisfies Options;\nconsole.log(options.name);\n',
      }),
    ).toEqual(["DS1301 Options.size 3: type member Options.size is written once and never read"]);
  });

  it("reads each member of a value that the object type of the position it reaches declares", () => {
    expect(
      findings({
        "src/main.ts":
          "interface Source {\n  id: number;\n  extra: number;\n}\ninterface Target {\n  id: number;\n}\nfunction take(target: Target): number {\n  return target.id;\n}\nconst source: Source = { id: 1, extra: 2 };\nconsole.log(take(source));\n",
      }),
    ).toEqual(["DS1301 Source.extra 3: type member Source.extra is written once and never read"]);
  });

  it("reads the members a position declares through the elements of an array", () => {
    expect(
      findings({
        "src/main.ts":
          'interface Key {\n  order: number;\n}\ninterface Tab {\n  order: number;\n  title: string;\n}\nfunction first(keys: readonly Key[]): number {\n  return keys[0]?.order ?? 0;\n}\nconst tabs: Tab[] = [{ order: 2, title: "b" }];\nconsole.log(first(tabs));\n',
      }),
    ).toEqual(["DS1301 Tab.title 6: type member Tab.title is written once and never read"]);
  });

  it("reads the members a position declares through array elements nested at any depth", () => {
    expect(
      findings({
        "src/main.ts":
          'interface Key {\n  order: number;\n}\ninterface Tab {\n  order: number;\n  title: string;\n}\nfunction first(keys: readonly (readonly (readonly (readonly Key[])[])[])[]): number {\n  return keys[0]?.[0]?.[0]?.[0]?.order ?? 0;\n}\nconst tabs: Tab[][][][] = [[[[{ order: 2, title: "b" }]]]];\nconsole.log(first(tabs));\n',
      }),
    ).toEqual(["DS1301 Tab.title 6: type member Tab.title is written once and never read"]);
  });

  it("reads the members a function's parameter declares from the values the position passes it", () => {
    expect(
      findings({
        "src/main.ts":
          'interface Key {\n  order: number;\n}\ninterface Tab {\n  order: number;\n  title: string;\n}\nfunction byOrder(a: Key, b: Key): number {\n  return a.order - b.order;\n}\nconst tabs: Tab[] = [{ order: 2, title: "b" }];\nconsole.log([...tabs].sort(byOrder).length);\n',
      }),
    ).toEqual(["DS1301 Tab.title 6: type member Tab.title is written once and never read"]);
  });

  it("reads no member of a value a type assertion names another object type", () => {
    expect(
      findings({
        "src/main.ts":
          "interface Source {\n  id: number;\n  extra: number;\n}\ninterface Target {\n  id: number;\n}\nconst source: Source = { id: 1, extra: 2 };\nconst target = source as Target;\nconsole.log(target.id);\n",
      }),
    ).toEqual([
      "DS1301 Source.id 2: type member Source.id is written once and never read",
      "DS1301 Source.extra 3: type member Source.extra is written once and never read",
    ]);
  });

  it("reads no member of a value whose type is itself one of the position's object types", () => {
    expect(
      findings({
        "src/main.ts":
          "interface Wide {\n  shared: number;\n  label?: string;\n}\ninterface Narrow {\n  shared: number;\n  label?: string;\n}\nfunction size(options: Wide | Narrow): number {\n  return options.shared;\n}\nconst wide: Wide = { shared: 1 };\nconsole.log(size(wide));\n",
      }),
    ).toEqual([
      "DS1003 Wide.label 3: type member has no reference in the target",
      "DS1003 Narrow.label 7: type member has no reference in the target",
    ]);
  });

  it("reads each member of a target type that a value of a type declared outside the target declares", () => {
    expect(
      findings({
        "src/main.ts":
          'interface Problem {\n  message: string;\n  code?: number;\n}\nconst problem: Problem = new Error("failed");\nproblem.message = "failed again";\nproblem.code = 1;\n',
      }),
    ).toEqual(["DS1301 Problem.code 3: type member Problem.code is written once and never read"]);
  });

  it("names an import only the written values use as deleted with the member", () => {
    expect(
      findings({
        "src/seed.ts": 'export const seed = "s";\n',
        "src/main.ts":
          'import { seed } from "./seed.ts";\n\ninterface Row {\n  label: string;\n  note: string;\n}\nconst row: Row = { label: "a", note: seed };\nconsole.log(row.label);\n',
      }),
    ).toEqual([
      "DS1301 Row.note 5: type member Row.note is written once and never read, and deleting it with its writes deletes import seed too",
    ]);
  });
});

describe("a constructor reaching a constructor type", () => {
  it("reaches through its construct signature, so an outside class reads the members of the target's instance type", () => {
    expect(
      findings({
        "node_modules/@example/platform/package.json":
          '{ "name": "@example/platform", "version": "1.0.0", "types": "./index.d.ts" }\n',
        "node_modules/@example/platform/index.d.ts":
          "export declare class Toast {\n  constructor(title: string);\n  onclick: (() => void) | null;\n  close(): void;\n}\n",
        "src/main.ts":
          'import { Toast } from "@example/platform";\n\ninterface ToastLike {\n  onclick: (() => void) | null;\n  close: () => void;\n}\n\nconst ctor: new (title: string) => ToastLike = Toast;\nconst shown = new ctor("hello");\nshown.onclick = (): void => {};\nshown.close();\n',
      }),
    ).toEqual([]);
  });
});

describe("a value reaching a position of another type", () => {
  it("reads each method of an interface the position's interface declares", () => {
    expect(
      findings({
        "src/main.ts":
          "interface Holder {\n  tick(): void;\n}\ninterface View {\n  tick(): void;\n  idle(): void;\n}\nfunction hold(holder: Holder): void {\n  holder.tick();\n}\nexport function mount(view: View): void {\n  hold(view);\n}\n",
      }),
    ).toEqual([
      "DS1203 View.idle 6: no call site invokes or selects the method through the interface",
    ]);
  });

  it("reaches through the type arguments of two instantiations, and from an array to an iterable", () => {
    expect(
      findings({
        "src/main.ts":
          "interface Result {\n  code?: string;\n  extra?: string;\n}\ninterface Reply {\n  code?: string;\n}\ninterface Holder {\n  tick(): void;\n}\ninterface View {\n  tick(): void;\n  idle(): void;\n}\nexport async function send(result: Result, views: readonly View[]): Promise<void> {\n  const answer: () => Promise<Reply | null> = () => Promise.resolve(result);\n  console.log((await answer())?.code);\n  for (const holder of new Set<Holder>(views)) {\n    holder.tick();\n  }\n}\n",
      }),
    ).toEqual([
      "DS1003 Result.extra 3: type member has no reference in the target",
      "DS1203 View.idle 13: no call site invokes or selects the method through the interface",
    ]);
  });
});

describe("an object spread", () => {
  it("reads a member a later property overwrites, since the copy gets it first", () => {
    expect(
      findings({
        "src/main.ts":
          'interface Row {\n  readonly value: string;\n}\nconst row: Row = {\n  get value(): string {\n    return "x";\n  },\n};\nconst copy = { ...row, value: "y" };\nconsole.log(copy.value);\n',
      }),
    ).toEqual([]);
  });

  it("reads a member it copies into the same declaration of the literal's contextual type", () => {
    expect(
      findings({
        "src/main.ts":
          'interface Row {\n  readonly value: string;\n}\nconst row: Row = {\n  get value(): string {\n    return "x";\n  },\n};\nconst copy: Row = { ...row };\nconsole.log(copy === row);\n',
      }),
    ).toEqual([]);
  });

  it("reads a class instance's fields, and neither its methods, its accessors nor its private names", () => {
    expect(
      findings({
        "src/main.ts":
          'class Counter {\n  count = 1;\n  #hidden = 2;\n  get stale(): number {\n    return 3;\n  }\n  reset(): number {\n    return 0;\n  }\n}\nconst copied = { kind: "ok", ...new Counter() };\nconsole.log(copied.kind);\n',
      }),
    ).toEqual([
      "DS1003 Counter.#hidden 3: private class member has no reference in the target",
      "DS1003 Counter.stale 4: class member has no reference in the target",
      "DS1003 Counter.reset 7: method has no reference in the target",
    ]);
  });

  it("reads every member of an interface value it spreads", () => {
    expect(
      findings({
        "src/main.ts":
          'interface Position {\n  readonly epoch: string;\n  readonly head: string;\n}\nfunction position(): Position {\n  return { epoch: "1", head: "2" };\n}\nconst copied = { kind: "ok", ...position() };\nconsole.log(copied.kind);\n',
      }),
    ).toEqual([]);
  });

  it("reads no accessor of a class it spreads through a mapped type over the class", () => {
    expect(
      findings({
        "src/main.ts":
          'class Counter {\n  count = 1;\n  get stale(): number {\n    return 3;\n  }\n}\nconst frozen: Readonly<Counter> = new Counter();\nconst copied = { kind: "ok", ...frozen };\nconsole.log(copied.kind);\n',
      }),
    ).toEqual(["DS1003 Counter.stale 3: class member has no reference in the target"]);
  });

  it("reads an accessor an interface declares, and no method signature a type literal declares", () => {
    expect(
      findings({
        "src/main.ts":
          'interface Sized {\n  get size(): number;\n}\ntype Shaped = {\n  area(): number;\n};\nfunction make(): Sized & Shaped {\n  return { size: 1, area: () => 2 };\n}\nconst copied = { kind: "ok", ...make() };\nconsole.log(copied.kind);\n',
      }),
    ).toEqual(["DS1301 Shaped.area 5: type member Shaped.area is written once and never read"]);
  });
});

describe("the members a literal writes", () => {
  it("are each a member the contextual type declares, at the property naming it", () => {
    expect(
      contextualUsesOf(
        lines(
          "export interface Circle {",
          '  kind: "circle";',
          "  size: number;",
          "}",
          "export interface Dot {",
          '  kind: "dot";',
          "}",
          'export const shape: Circle | Dot = { kind: "circle", size: 1 };',
        ),
      ),
    ).toEqual(["8:38 write Circle.kind", "8:38 write Dot.kind", "8:54 write Circle.size"]);
  });

  it("writes no interface method a literal's method implements, which only a call reads", () => {
    expect(
      findings({
        "src/main.ts": lines(
          "interface View {",
          "  tick(): void;",
          "  idle(): void;",
          "}",
          "function hold(view: View): void {",
          "  view.tick();",
          "}",
          "hold({ tick() {}, idle() {} });",
        ),
      }),
    ).toEqual([
      "DS1203 View.idle 3: no call site invokes or selects the method through the interface",
    ]);
  });
});

describe("the members a value reaching a position reads", () => {
  it("are none for a primitive value, whose members are its own type's", () => {
    expect(
      findings({
        "src/main.ts": lines(
          "interface Sized {",
          "  length: number;",
          "}",
          "function size(_sized: Sized): number {",
          "  return 0;",
          "}",
          'console.log(size("abc"));',
        ),
      }),
    ).toEqual([
      "DS1003 Sized.length 2: type member has no reference in the target",
      "DS1801 _sized 4: parameter _sized is never read in the body; also reported by tsc --noUnusedParameters and @typescript-eslint/no-unused-vars",
    ]);
  });

  it("are a value's type members, though its type inherits a class's too", () => {
    expect(
      findings({
        "src/main.ts": lines(
          "class Base {",
          "  tag = 1;",
          "}",
          "interface Source extends Base {",
          "  id: number;",
          "  extra: number;",
          "}",
          "interface Target {",
          "  id: number;",
          "}",
          "function take(target: Target): number {",
          "  return target.id;",
          "}",
          "const source: Source = { tag: 1, id: 1, extra: 2 };",
          "console.log(take(source));",
        ),
      }),
    ).toEqual([
      "DS1301 Base.tag 2: member Base.tag is written once and never read",
      "DS1301 Source.extra 6: type member Source.extra is written once and never read",
    ]);
  });

  it("are none of the target's for an own class instance, which declares a member in the target", () => {
    expect(
      findings({
        "src/main.ts": lines(
          "interface Problem {",
          "  message: string;",
          "  code?: number;",
          "}",
          "class Failure extends Error {",
          "  code = 1;",
          "}",
          "function report(problem: Problem): void {",
          "  console.log(problem.message);",
          "}",
          'report(new Failure("x"));',
        ),
      }),
    ).toEqual(["DS1003 Problem.code 3: type member has no reference in the target"]);
  });

  it("are read through the result of a function the position calls", () => {
    expect(
      findings({
        "src/main.ts": lines(
          "interface Key {",
          "  order: number;",
          "}",
          "interface Tab {",
          "  order: number;",
          "  title: string;",
          "}",
          "function run(make: () => Key): number {",
          "  return make().order;",
          "}",
          'const tab: Tab = { order: 1, title: "b" };',
          "const make: () => Tab = () => tab;",
          "console.log(run(make));",
        ),
      }),
    ).toEqual(["DS1301 Tab.title 6: type member Tab.title is written once and never read"]);
  });

  it("are read where any constituent of the position declares the member", () => {
    expect(
      contextualUsesOf(
        lines(
          "export interface Source {",
          "  id: number;",
          "  extra: number;",
          "}",
          "export interface Target {",
          "  id: number;",
          "}",
          "export interface Other {",
          "  name?: string;",
          "}",
          "export function take(_target: Target | Other): void {}",
          "declare const source: Source;",
          "take(source);",
        ),
      ),
    ).toEqual(["13:6 read Source.id"]);
  });

  it("are none where the position's member is the value's own declaration", () => {
    expect(
      findings({
        "src/main.ts": lines(
          "interface Wide {",
          "  shared: number;",
          "}",
          "function size(_options: Partial<Wide>): number {",
          "  return 0;",
          "}",
          "const wide: Wide = { shared: 1 };",
          "console.log(size(wide));",
        ),
      }),
    ).toEqual([
      "DS1301 Wide.shared 2: type member Wide.shared is written once and never read",
      "DS1801 _options 4: parameter _options is never read in the body; also reported by tsc --noUnusedParameters and @typescript-eslint/no-unused-vars",
    ]);
  });

  it("are none where one of the position member's declarations is the value's own", () => {
    expect(
      findings({
        "src/main.ts": lines(
          "interface Wide {",
          "  shared: number;",
          "  label?: string;",
          "}",
          "interface Extra {",
          "  label?: string;",
          "}",
          "function size(options: Partial<Wide & Extra>): number {",
          "  return options.shared ?? 0;",
          "}",
          "const wide: Wide = { shared: 1 };",
          "console.log(size(wide));",
        ),
      }),
    ).toEqual([
      "DS1003 Wide.label 3: type member has no reference in the target",
      "DS1003 Extra.label 6: type member has no reference in the target",
    ]);
  });

  it("end the walk over a function type that returns itself", () => {
    expect(
      findings({
        "src/main.ts": lines(
          "interface Item {",
          "  id: number;",
          "}",
          "type F = (item: Item) => F;",
          "type G = (item: Item) => G;",
          "function take(g: G): G {",
          "  return g;",
          "}",
          "const f: F = () => f;",
          "console.log(take(f));",
        ),
      }),
    ).toEqual(["DS1003 Item.id 2: type member has no reference in the target"]);
  });
});

describe("what asking the contextual types costs", () => {
  const ROW = ["export interface Row {", "  label: string;", "  1: string;", "}"];

  it("asks the checker for a computed name's key only where the key is not literal text", () => {
    expect(
      contextualCost(lines(...ROW, 'export const row: Row = { label: "a", 1: "x" };')),
    ).toEqual([2, 1]);
    expect(
      contextualCost(lines(...ROW, 'export const row: Row = { ["label"]: "a", [1]: "x" };')),
      "a literal key costs what the plain name does",
    ).toEqual([2, 1]);
    expect(
      contextualCost(
        lines(
          'const key: unique symbol = Symbol("k");',
          "export interface Keyed {",
          "  [key]: string;",
          "}",
          'export const keyed: Keyed = { [key]: "a" };',
        ),
      ),
      "and a unique symbol one batch more",
    ).toEqual([3, 1]);
  });

  it("asks a union's constituents once, however many literals it types", () => {
    const shapes = [
      "export interface A {",
      '  kind: "a";',
      "}",
      "export interface B {",
      '  kind: "b";',
      "}",
    ];

    expect(contextualCost(lines(...shapes, 'export const a: A | B = { kind: "a" };'))).toEqual([
      2, 3,
    ]);
    expect(
      contextualCost(
        lines(
          ...shapes,
          'export const a: A | B = { kind: "a" };',
          'export const b: A | B = { kind: "b" };',
        ),
      ),
    ).toEqual([2, 3]);
  });

  const TAKE = [
    "export interface Source {",
    "  id: number;",
    "  extra: number;",
    "}",
    "export interface Target {",
    "  id: number;",
    "}",
    "export function take(target: Target): number {",
    "  return target.id;",
    "}",
  ];

  it("asks a value type's members, elements and signatures once, however many values of it reach a position", () => {
    expect(
      contextualCost(lines(...TAKE, "declare const source: Source;", "take(source);")),
    ).toEqual([2, 6]);
    expect(
      contextualCost(
        lines(...TAKE, "declare const source: Source;", "take(source);", "take(source);"),
      ),
    ).toEqual([2, 6]);
  });

  it("asks no position for a value that carries no member a position reads", () => {
    expect(contextualCost(lines(...TAKE)), "the result alone, a number").toEqual([1, 0]);
    expect(
      contextualCost(lines(...TAKE, "take({ id: 1 });")),
      "an object literal, which writes its members instead",
    ).toEqual([2, 1]);
    expect(
      contextualCost(lines(...TAKE, "export class Held {", "  id = 1;", "}", "take(new Held());")),
      "a class instance, which the interface-satisfaction class reads",
    ).toEqual([1, 5]);
    expect(
      contextualCost(
        lines(
          ...TAKE,
          "export interface Empty {}",
          "declare const empty: Empty;",
          "export function hold(_value: object): void {}",
          "hold(empty);",
        ),
      ),
      "a type that declares no member",
    ).toEqual([1, 4]);
  });

  const KEYS = [
    "export interface Key {",
    "  order: number;",
    "}",
    "export interface Tab {",
    "  order: number;",
    "  title: string;",
    "}",
    "declare const tabs: Tab[];",
  ];

  it("asks an array type's element once, and a function type's signature once", () => {
    expect(
      contextualCost(
        lines(
          ...KEYS,
          "export function first(keys: readonly Key[]): number {",
          "  return keys[0]?.order ?? 0;",
          "}",
          "first(tabs);",
          "first(tabs);",
        ),
      ),
    ).toEqual([2, 13]);
    expect(
      contextualCost(
        lines(
          ...KEYS,
          "export function by(key: Key): number {",
          "  return key.order;",
          "}",
          "tabs.map(by);",
          "tabs.map(by);",
        ),
      ),
    ).toEqual([2, 17]);
  });

  it("compares no type argument two instantiations share", () => {
    expect(
      contextualCost(
        lines(
          ...TAKE,
          "export interface A {",
          "  a?: number;",
          "}",
          "export interface B {",
          "  b?: number;",
          "}",
          "export function keyed(map: Map<Target, A | B>): number {",
          "  return map.size;",
          "}",
          "declare const map: Map<Source, A | B>;",
          "keyed(map);",
        ),
      ),
    ).toEqual([2, 14]);
  });

  it("ends the walk over a generic type that is its own type argument", () => {
    expect(
      contextualCost(
        lines(
          "export class Rec<T> {",
          "  v?: T;",
          "}",
          "type R = Rec<R>;",
          "declare const r: R;",
          "export function take(x: unknown): unknown {",
          "  return x;",
          "}",
          "take(r);",
        ),
      ),
    ).toEqual([1, 5]);
  });
});
