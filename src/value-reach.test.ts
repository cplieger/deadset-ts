import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isIdentifier, isVariableDeclaration, type Node } from "@typescript/native/ast";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { typesAt } from "./class-members.ts";
import { discoverProjects } from "./discover.ts";
import { inventory } from "./inventory.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine, runSession } from "./session.ts";
import { valueReach } from "./value-reach.ts";

/**
 * What a value of each type carries, read over one written project whose `main.ts` holds
 * `model` and a declaration of each type, as `type: classes … | members …`.
 */
function reachOf(
  model: readonly string[],
  types: readonly string[],
  files: Readonly<Record<string, string>> = {},
): string[] {
  const declarations = types.map((type, index) => `declare const v${String(index)}: ${type};`);
  const root = writeProject({ ...files, "main.ts": `${[...model, ...declarations].join("\n")}\n` });
  try {
    const host = nodeHost();
    const engine = openEngine({ collectTiming: false });
    const configFiles = discoverProjects(engine, host, scopeForDir(host, root)).configFiles;
    const { projects } = runSession(engine, configFiles, (project) => {
      const held = inventory(project, host, root);
      const nameOf = new Map(held.symbols.map((symbol) => [symbol.id, symbol.name]));
      const names: Node[] = [];
      for (const file of project.ownSourceFiles()) {
        const visit = (node: Node): void => {
          if (
            isVariableDeclaration(node) &&
            isIdentifier(node.name) &&
            /^v\d+$/u.test(node.name.text)
          ) {
            names.push(node.name);
          }
          node.forEachChild(visit);
        };
        file.forEachChild(visit);
      }
      const reach = valueReach(project, held);
      return typesAt(project, names).map((type, index) => {
        if (type === undefined) {
          throw new Error(`no type for ${types[index] ?? ""}`);
        }
        const { classes, members } = reach.reachedFrom(type);
        const classNames = [...classes].map((id) => nameOf.get(id) ?? id).sort();
        const memberNames = members.map((member) => member.name).sort();
        return `${types[index] ?? ""}: classes ${classNames.join(" ")} | members ${memberNames.join(" ")}`;
      });
    });
    const [only] = projects;
    if (only === undefined) {
      throw new Error("no project opened");
    }
    return only;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const CLASSES = [
  "export class Order {",
  "  id = 1;",
  "}",
  "export class Item {",
  "  sku = 2;",
  "}",
];

describe("what a value carries", () => {
  it("is the class it is an instance of, a generic class's through its instantiation", () => {
    expect(
      reachOf(
        [...CLASSES, "export class Crate<T> {", "  held!: T;", "}"],
        ["Order", "Crate<Item>", "string"],
      ),
    ).toEqual([
      "Order: classes Order | members ",
      "Crate<Item>: classes Crate Item | members ",
      "string: classes  | members ",
    ]);
  });

  it("is the classes its own interface's data members hold, with those members and its conversion methods", () => {
    expect(
      reachOf(
        [
          ...CLASSES,
          "export interface Holder {",
          "  order: Order;",
          "  run(): void;",
          "  toJSON(): unknown;",
          "  toString(): string;",
          "}",
        ],
        ["Holder"],
      ),
    ).toEqual(["Holder: classes Order | members order toJSON toString"]);
  });

  it("is the classes and members of an object type written as a literal, a mapped type or a record", () => {
    expect(
      reachOf(CLASSES, [
        "{ order: Order }",
        "{ [K in 'first' | 'second']: Order }",
        "Record<string, Item>",
      ]),
    ).toEqual([
      "{ order: Order }: classes Order | members order",
      "{ [K in 'first' | 'second']: Order }: classes Order | members first second",
      "Record<string, Item>: classes Item | members ",
    ]);
  });

  it("is what each constituent of a union or an intersection carries", () => {
    expect(
      reachOf(
        [...CLASSES, "export interface Tagged {", "  tag: Item;", "}"],
        ["Order | undefined", "Order | Item", "Tagged & { order: Order }"],
      ),
    ).toEqual([
      "Order | undefined: classes Order | members ",
      "Order | Item: classes Item Order | members ",
      "Tagged & { order: Order }: classes Item Order | members order tag",
    ]);
  });

  it("is what the elements of an array or a tuple carry, and none of the list's own members", () => {
    expect(reachOf(CLASSES, ["Order[]", "readonly Item[]", "[Order, Item]"])).toEqual([
      "Order[]: classes Order | members ",
      "readonly Item[]: classes Item | members ",
      "[Order, Item]: classes Item Order | members ",
    ]);
  });

  it("is what an own generic interface's members hold, not what its type arguments name", () => {
    expect(
      reachOf(
        [...CLASSES, "export interface Labelled<T> {", "  label: Item;", "}"],
        ["Labelled<Order>"],
      ),
    ).toEqual(["Labelled<Order>: classes Item | members label"]);
  });

  it("is what the elements of an array carry where the project declares Array itself", () => {
    expect(
      reachOf(CLASSES, ["Order[]"], {
        "tsconfig.json": `${JSON.stringify({
          compilerOptions: { noLib: true, strict: true, module: "NodeNext", noEmit: true },
          include: ["**/*.ts"],
        })}\n`,
        "lib.d.ts": [
          "interface Array<T> { length: number; [n: number]: T; }",
          ...["Boolean", "Function", "CallableFunction", "NewableFunction", "IArguments"].map(
            (name) => `interface ${name} {}`,
          ),
          ...["Number", "Object", "RegExp", "String"].map((name) => `interface ${name} {}`),
          "",
        ].join("\n"),
      }),
    ).toEqual(["Order[]: classes Order | members "]);
  });

  it("is nothing of a Map or a Set, which a serializer writes as an empty object", () => {
    expect(reachOf(CLASSES, ["Map<string, Order>", "Set<Item>"])).toEqual([
      "Map<string, Order>: classes  | members ",
      "Set<Item>: classes  | members ",
    ]);
  });

  it("is nothing of a Map whose library interface the project merges a member into", () => {
    expect(
      reachOf(
        [
          ...CLASSES,
          "declare global {",
          "  interface Map<K, V> {",
          "    order: Order;",
          "  }",
          "}",
        ],
        ["Map<string, Item>"],
      ),
    ).toEqual(["Map<string, Item>: classes  | members "]);
  });

  it("is nothing of a class itself, whose statics and prototype a serializer never reads", () => {
    expect(
      reachOf(
        [...CLASSES, "export class Registry {", "  static order = new Order();", "}"],
        ["typeof Registry"],
      ),
    ).toEqual(["typeof Registry: classes  | members "]);
  });

  it("is nothing an accessor of its class answers, which lives on the prototype", () => {
    expect(
      reachOf(
        [
          ...CLASSES,
          "export class Lazy {",
          "  get order(): Order {",
          "    return new Order();",
          "  }",
          "}",
        ],
        ["Lazy"],
      ),
    ).toEqual(["Lazy: classes Lazy | members "]);
  });

  it("reads a type that holds itself once", () => {
    expect(
      reachOf(
        [...CLASSES, "export interface Chain {", "  next: Chain;", "  order: Order;", "}"],
        ["Chain"],
      ),
    ).toEqual(["Chain: classes Order | members next order"]);
  });
});
