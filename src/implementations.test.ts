import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { targetConfigFiles, writeProject } from "../__test-helpers__/projects.ts";
import { discoverProjects } from "./load/discover.ts";
import { implementations, mergeImplementations, type Implementations } from "./implementations.ts";
import { inventory } from "./inventory.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine, runSession, type Engine } from "./session.ts";

/** One run's answers, by display name: who implements what, how each method is written, what is unknown. */
interface Read {
  readonly classes: readonly string[];
  readonly bodies: readonly string[];
  readonly unknown: readonly string[];
}

/** One module's text, a line per argument. */
function lines(...text: readonly string[]): string {
  return `${text.join("\n")}\n`;
}

/**
 * How the interfaces of one written project are implemented. While the answers are read,
 * the client fails each question whose accessor `fails` answers an error for.
 */
function implementationsIn(
  files: Readonly<Record<string, string>>,
  fails: (accessor: string) => Error | undefined = () => undefined,
): Read {
  const root = writeProject(files);
  try {
    const host = nodeHost();
    const opened = openEngine({ collectTiming: false });
    let reading = false;
    const engine: Engine = {
      ...opened,
      ask: (accessor, locations, question) => {
        const failure = reading ? fails(accessor) : undefined;
        if (failure !== undefined) {
          throw failure;
        }
        return opened.ask(accessor, locations, question);
      },
    };
    const configFiles = targetConfigFiles(discoverProjects(engine, host, scopeForDir(host, root)));
    const read: Read[] = [];
    runSession(engine, configFiles, (project) => {
      const held = inventory(project, host, root);
      const name = (id: string): string =>
        held.symbols.find((symbol) => symbol.id === id)?.name ?? id;
      reading = true;
      let found: Implementations;
      try {
        found = implementations(project, held);
      } finally {
        reading = false;
      }
      read.push({
        classes: [...found.classes].flatMap(([id, owners]) =>
          [...owners].map((owner) => `${name(id)}: ${name(owner)}`),
        ),
        bodies: [...found.bodies].flatMap(([id, byClass]) =>
          [...byClass].map(
            ([owner, empty]) => `${name(id)}: ${name(owner)} ${empty ? "empty" : "written"}`,
          ),
        ),
        unknown: [...found.unknown].map(name),
      });
    });
    const [first] = read;
    if (first === undefined) {
      throw new Error("no project opened");
    }
    return {
      classes: [...first.classes].sort(),
      bodies: [...first.bodies].sort(),
      unknown: [...first.unknown].sort(),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A client failure the server reports as a panic on one question. */
function panicOn(wanted: string): (accessor: string) => Error | undefined {
  return (accessor) => (accessor === wanted ? new Error(`panic: ${accessor}`) : undefined);
}

describe("the interfaces a class implements", () => {
  it("are the ones its implements clause names, a namespace's included", () => {
    expect(
      implementationsIn({
        "src/main.ts": lines(
          "export interface Shape { area(): number }",
          "export class Square implements Shape { area(): number { return 1; } }",
          "export namespace Inner {",
          "  export interface Named { label(): string }",
          '  export class Tag implements Named { label(): string { return "t"; } }',
          "}",
        ),
      }).classes,
    ).toEqual(["Inner.Named: Inner.Tag", "Shape: Square"]);
  });

  it("are the ones it is assignable to by name and type, its optional members aside", () => {
    expect(
      implementationsIn({
        "src/main.ts": lines(
          "export interface Options { start(): void; stop?(): void }",
          "export class Starter { start(): void {} }",
          "export interface Count { count(): number }",
          'export class Wrong { count(): string { return ""; } }',
          "export interface Weak { a?(): void }",
          "export class HasA { a(): void {} }",
          "export class Empty {}",
        ),
      }).classes,
    ).toEqual(["Options: Starter", "Weak: HasA"]);
  });

  it("are never matched by shape for a generic interface or a generic class", () => {
    expect(
      implementationsIn({
        "src/main.ts": lines(
          "export interface Runner { run(): void }",
          "export class Plain { run(): void {} }",
          "export class Generic<T> { run(): void {} hold?: T }",
          "export interface Sized<T> { size(): number; extra?: T }",
          "export class Box { size(): number { return 1; } }",
        ),
      }).classes,
    ).toEqual(["Runner: Plain"]);
  });

  it("are read as generic where any declaration of a merged interface is", () => {
    expect(
      implementationsIn({
        "src/main.ts": lines(
          "export interface Mixed { a(): void }",
          "export interface Mixed<T> { b?: T }",
          "export class Fits { a(): void {} }",
        ),
      }).classes,
    ).toEqual([]);
  });

  it("are named by every declaration of a merged interface", () => {
    expect(
      implementationsIn({
        "src/main.ts": lines(
          "export interface Merged { a(): void }",
          "export interface Merged { b(): void }",
          "export class Both implements Merged { a(): void {} b(): void {} }",
        ),
      }).classes,
    ).toEqual(["Merged: Both", "Merged: Both"]);
  });

  it("are not those of an extends clause", () => {
    expect(
      implementationsIn({
        "src/main.ts": lines(
          "export class Base<T> { held?: T }",
          "export interface Base<T> { m(): T }",
          "export class Child extends Base<number> {}",
        ),
      }).classes,
    ).toEqual([]);
  });
});

describe("how a class writes each method an interface declares", () => {
  it("is empty only where every body it writes holds no statement, and an abstract method is not", () => {
    expect(
      implementationsIn({
        "src/main.ts": lines(
          "export interface Hook { run(): void }",
          "export class NoOp implements Hook { run(): void {} }",
          "export class Busy implements Hook { run(): void { void 0; } }",
          "export abstract class Later implements Hook { abstract run(): void }",
        ),
      }).bodies,
    ).toEqual(["Hook.run: Busy written", "Hook.run: Later written", "Hook.run: NoOp empty"]);
  });

  it("is read for the methods of the interface, not for those of a type it extends", () => {
    expect(
      implementationsIn({
        "src/main.ts": lines(
          "type Base = { m(): void };",
          "export interface Ext extends Base { n(): void }",
          "export class Impl implements Ext { m(): void {} n(): void {} }",
        ),
      }).bodies,
    ).toEqual(["Ext.n: Impl empty"]);
  });

  it("is written where a declaration of it lies outside the target", () => {
    expect(
      implementationsIn({
        "node_modules/dep/package.json":
          '{ "name": "dep", "version": "1.0.0", "type": "module", "exports": "./index.ts" }\n',
        "node_modules/dep/index.ts": "export class Quiet { run(): void {} }\n",
        "node_modules/typed/package.json":
          '{ "name": "typed", "version": "1.0.0", "types": "./index.d.ts" }\n',
        "node_modules/typed/index.d.ts": "export declare class Loud { run(): void; }\n",
        "src/main.ts": lines(
          'import { Quiet } from "dep";',
          'import { Loud } from "typed";',
          "export interface Hook { run(): void }",
          "export class FromSource extends Quiet implements Hook {}",
          "export class FromDeclaration extends Loud implements Hook {}",
        ),
      }).bodies,
    ).toEqual(["Hook.run: FromDeclaration written", "Hook.run: FromSource written"]);
  });
});

describe("a question the checker leaves unanswered", () => {
  it("makes every interface method of the project unknown, and nothing else", () => {
    expect(
      implementationsIn(
        {
          "src/main.ts": lines(
            "export interface Hook { run(): void; stop(): void }",
            "export class NoOp implements Hook { run(): void {} stop(): void {} }",
            "export type Shape = { area(): number };",
            "export function helper(): void {}",
          ),
        },
        panicOn("getTypeAtLocation"),
      ),
    ).toEqual({ classes: [], bodies: [], unknown: ["Hook.run", "Hook.stop"] });
  });

  it("is never asked where the project holds no class to implement its interfaces", () => {
    expect(
      implementationsIn(
        { "src/main.ts": lines("export interface Hook { run(): void }") },
        panicOn("getTypeAtLocation"),
      ),
    ).toEqual({ classes: [], bodies: [], unknown: [] });
  });

  it("is not how any other failure of the client is read", () => {
    expect(() =>
      implementationsIn(
        {
          "src/main.ts": lines(
            "export interface Hook { run(): void }",
            "export class NoOp implements Hook { run(): void {} }",
          ),
        },
        (accessor) => (accessor === "getTypeAtLocation" ? new Error("channel closed") : undefined),
      ),
    ).toThrow("channel closed");
  });
});

describe("the answers of every project of a run", () => {
  it("hold each project's unknown methods", () => {
    const empty = { classes: new Map(), bodies: new Map() };

    expect([
      ...mergeImplementations([
        { ...empty, unknown: new Set(["a"]) },
        { ...empty, unknown: new Set(["b", "a"]) },
      ]).unknown,
    ]).toEqual(["a", "b"]);
  });
});
