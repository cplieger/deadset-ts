import { rmSync } from "node:fs";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { targetConfigFiles, writeProject } from "../__test-helpers__/projects.ts";
import { aliasChains } from "./alias-chain.ts";
import { calleeName, callsOf, resolvedTargets } from "./calls.ts";
import type { DeclarationEntry } from "./config.ts";
import {
  declarationsNamed,
  entriesAt,
  names,
  namesADeclaration,
  resolveEntries,
  spelledEntry,
} from "./configured-declarations.ts";
import { discoverProjects } from "./load/discover.ts";
import { inventory, type Inventory } from "./inventory.ts";
import { Unanswerable } from "./query.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine, runSession, type Engine, type ProjectView } from "./session.ts";

/** The project every case resolves its entries in, written for that case. */
function written(): string {
  const root = writeProject({
    "package.json": '{ "name": "@example/app", "type": "module" }\n',
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ESNext",
        lib: ["ESNext", "DOM"],
        types: [],
        module: "NodeNext",
        moduleResolution: "nodenext",
        noEmit: true,
      },
      include: ["src/**/*.ts", "src/**/*.cts"],
    }),
    "node_modules/@example/container/package.json": JSON.stringify({
      name: "@example/container",
      type: "module",
      exports: { ".": { types: "./index.d.ts" } },
    }),
    "node_modules/@example/container/index.d.ts": [
      'export { Container, Tokens, register as provide } from "./impl.js";',
      'export { Quoted as "a.b" } from "./impl.js";',
      'export { default } from "./impl.js";',
      "",
    ].join("\n"),
    "node_modules/@example/container/impl.d.ts": [
      "export declare class Container<T> {",
      "  bind(target: unknown): T;",
      "  static create(): void;",
      "}",
      "export declare namespace Tokens {",
      "  function named(name: string): void;",
      "}",
      "export declare class Quoted {",
      `  "it's.x"(): void;`,
      "}",
      "export declare function register(target: unknown): void;",
      "export default function setup(): void;",
      "",
    ].join("\n"),
    "node_modules/@example/lazy/package.json": JSON.stringify({
      name: "@example/lazy",
      type: "module",
      exports: { ".": { types: "./index.d.ts" } },
    }),
    "node_modules/@example/lazy/index.d.ts": "export declare function load(): void;\n",
    "node_modules/later/package.json": JSON.stringify({
      name: "later",
      type: "module",
      exports: { ".": { types: "./index.d.ts" } },
    }),
    "node_modules/later/index.d.ts": "export declare function late(): void;\n",
    "node_modules/@example/legacy/package.json": JSON.stringify({
      name: "@example/legacy",
      types: "./index.d.ts",
    }),
    "node_modules/@example/legacy/index.d.ts": "export declare function old(): void;\n",
    "src/legacy.cts": 'import legacy = require("@example/legacy");\nlegacy.old();\n',
    "src/local.ts": [
      "export function wrap(value: unknown): unknown {",
      "  return value;",
      "}",
      "wrap.helper = (): void => {};",
      "export class Registry {",
      "  static add(value: unknown): void {}",
      "}",
      "export namespace Registry {",
      "  export function lookup(): void {}",
      "}",
      "declare global {",
      "  function provideGlobally(value: unknown): void;",
      "}",
      "export class Bag {",
      "  *[Symbol.iterator](): Iterator<number> {}",
      '  ["c.d"](): void {}',
      "}",
      'export const label = String("@example/lazy");',
      "",
    ].join("\n"),
    "src/main.ts": [
      "declare const later: string;",
      "void import(later);",
      'import { late } from "later";',
      'import setup, { Container, Tokens, provide as give } from "@example/container";',
      'import { Bag, Registry, wrap } from "./local.ts";',
      "new Container<string>().bind(1);",
      "Container.create();",
      "Tokens.named('a');",
      "give(1);",
      "setup();",
      "JSON.stringify(1);",
      "customElements.define('x-a', class extends HTMLElement {});",
      "provideGlobally(1);",
      "wrap(1);",
      "Registry.add(1);",
      "wrap.helper();",
      "Registry.lookup();",
      "late();",
      'declare const routes: Record<"go", () => void>;',
      "routes.go();",
      'void import("@example/lazy");',
      "void [...new Bag()];",
      "",
    ].join("\n"),
  });
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** The entries named, each with the label a case reads it by. */
const ENTRIES: readonly (readonly [string, DeclarationEntry])[] = [
  ["bind", { module: "@example/container", name: "Container.bind" }],
  ["create", { module: "@example/container", name: "Container.create:static" }],
  ["named", { module: "@example/container", name: "Tokens.named" }],
  ["register", { module: "@example/container", name: "provide" }],
  ["default", { module: "@example/container", name: "default" }],
  ["stringify", { global: "JSON.stringify" }],
  ["define", { global: "CustomElementRegistry.define" }],
  ["ambient", { global: "provideGlobally" }],
  ["wrap", { symbol: "ts://@example/app/src/local.ts#wrap" }],
  ["add", { symbol: "ts://@example/app/src/local.ts#Registry.add:static" }],
  ["quoted", { module: "@example/container", name: "'a.b'.'it\\'s.x'" }],
  ["dynamic", { module: "@example/lazy", name: "load" }],
  ["required", { module: "@example/legacy", name: "old" }],
  ["expando", { module: "./local.ts", name: "wrap.helper" }],
  ["merged", { module: "./local.ts", name: "Registry.lookup" }],
  ["late", { module: "later", name: "late" }],
  ["static-as-instance", { module: "@example/container", name: "Container.create" }],
  ["instance-as-static", { module: "@example/container", name: "Container.bind:static" }],
  ["lone-static", { global: "JSON:static" }],
  ["merged-as-static", { module: "./local.ts", name: "Registry.lookup:static" }],
  ["quoted-global", { global: "'JSON'.stringify" }],
  ["unimported", { module: "@example/other", name: "bind" }],
  ["absent-member", { global: "JSON.serialize" }],
  ["absent-symbol", { symbol: "ts://@example/app/src/local.ts#unwrap" }],
  ["iterate", { module: "./local.ts", name: "Bag.[Symbol.iterator]" }],
  ["computed-literal", { module: "./local.ts", name: 'Bag.["c.d"]' }],
  ["quoted-key", { module: "./local.ts", name: "Bag.'c.d'" }],
  ["array-iterate", { global: "Array.[Symbol.iterator]" }],
  ["absent-computed", { module: "./local.ts", name: "Bag.[Symbol.asyncIterator]" }],
];

/** The result of `visit` over the one project of the written project, read through `engine`. */
function inProject<Result>(
  visit: (project: ProjectView<unknown>, held: Inventory) => Result,
  engine: Engine = openEngine({ collectTiming: false }),
): Result {
  const root = written();
  const host = nodeHost();
  const configFiles = targetConfigFiles(discoverProjects(engine, host, scopeForDir(host, root)));
  const { projects } = runSession(engine, configFiles, (project) =>
    visit(project, inventory(project, host, root)),
  );
  const [only] = projects;
  if (only === undefined) {
    throw new Error("the written project opened no project");
  }
  return only;
}

/** Each call of the main file with the labels of the entries its callee is, and each entry's spelling. */
function resolveAll(): {
  readonly calls: readonly string[];
  readonly unmatched: readonly string[];
  readonly spelled: readonly string[];
} {
  return inProject((project, held) => {
    const resolved = resolveEntries(
      project,
      held,
      ENTRIES.map(([, entry]) => entry),
    );
    const chains = aliasChains(project, held);
    const calls = callsOf(project).filter((call) =>
      call.getSourceFile().fileName.endsWith("/main.ts"),
    );
    const targets = resolvedTargets(
      project,
      calls.flatMap((call) => calleeName(call.expression) ?? []),
    );
    return {
      calls: calls.map((call) => {
        const name = calleeName(call.expression);
        const target = name === undefined ? undefined : targets.get(name);
        const labels = ENTRIES.filter((_entry, index) => {
          const one = resolved[index];
          return one !== undefined && target !== undefined && names(one, target, chains);
        }).map(([label]) => label);
        return `${call.expression.getText()}: ${labels.join(" ")}`;
      }),
      unmatched: ENTRIES.filter((_entry, index) => {
        const one = resolved[index];
        return one !== undefined && !namesADeclaration(one);
      }).map(([label]) => label),
      spelled: ENTRIES.map(([, entry]) => spelledEntry(entry, held)),
    };
  });
}

/**
 * A client whose checker, once `failing.on` is set, fails every symbol question: with a
 * server panic, which leaves the question unanswered, or with any other error.
 */
function failingEngine(message: string): {
  readonly engine: Engine;
  readonly failing: { on: boolean };
} {
  const real = openEngine({ collectTiming: false });
  const failing = { on: false };
  return {
    failing,
    engine: {
      ...real,
      ask: (accessor, asked, question) => {
        if (failing.on && accessor === "getSymbolAtLocation") {
          throw new Error(message);
        }
        return real.ask(accessor, asked, question);
      },
    },
  };
}

/** The entries as the configuration lists them, each under the serializers key. */
const CONFIGURED = ENTRIES.map(([, entry]) => ({ key: "ts.serializers", entry }));

describe("the declarations a configuration names", () => {
  it("match the call whose callee resolves to them, through every import, re-export and instantiation", () => {
    expect(resolveAll().calls).toEqual([
      "import: ",
      "new Container<string>().bind: bind",
      "Container.create: create",
      "Tokens.named: named",
      "give: register",
      "setup: default",
      "JSON.stringify: stringify",
      "customElements.define: define",
      "provideGlobally: ambient",
      "wrap: wrap",
      "Registry.add: add",
      "wrap.helper: expando",
      "Registry.lookup: merged",
      "late: late",
      "routes.go: ",
      "import: ",
    ]);
  });

  it("name nothing where the path, the side of the member or the module names nothing", () => {
    expect(resolveAll().unmatched).toEqual([
      "static-as-instance",
      "instance-as-static",
      "lone-static",
      "merged-as-static",
      "quoted-global",
      "unimported",
      "absent-member",
      "absent-symbol",
      "absent-computed",
    ]);
  });

  it("are spelled by their path, and a declaration of the program by its display name", () => {
    expect(resolveAll().spelled.slice(0, 11)).toEqual([
      "Container.bind",
      "Container.create:static",
      "Tokens.named",
      "provide",
      "default",
      "JSON.stringify",
      "CustomElementRegistry.define",
      "provideGlobally",
      "wrap",
      "Registry.add",
      "'a.b'.'it\\'s.x'",
    ]);
  });

  it("each count as naming one where the checker leaves a question of the resolution unanswered", () => {
    const { engine, failing } = failingEngine("panic: runtime error");
    const named = inProject((project, held) => {
      failing.on = true;
      return declarationsNamed(project, held, CONFIGURED);
    }, engine);

    expect(named).toEqual(ENTRIES.map(() => true));
  });

  it("fail the resolution on a checker failure that is no unanswered question", () => {
    const { engine, failing } = failingEngine("the client lost its connection");

    expect(() =>
      inProject((project, held) => {
        failing.on = true;
        return declarationsNamed(project, held, CONFIGURED);
      }, engine),
    ).toThrow("the client lost its connection");
  });

  it("are found at each name node an entry names, and at no other", () => {
    const found = inProject((project, held) => {
      const resolved = resolveEntries(
        project,
        held,
        ENTRIES.map(([, entry]) => entry),
      );
      const nodes = callsOf(project).flatMap((call) => calleeName(call.expression) ?? []);
      const named = entriesAt(project, aliasChains(project, held), nodes, resolved);
      return [...named].map(
        ([node, entries]) =>
          `${node.getText()}: ${entries.map((one) => spelledEntry(one.entry, held)).join(" ")}`,
      );
    });

    expect(found.toSorted()).toEqual([
      "add: Registry.add",
      "bind: Container.bind",
      "create: Container.create:static",
      "define: CustomElementRegistry.define",
      "give: provide",
      "helper: wrap.helper",
      "late: late",
      "lookup: Registry.lookup",
      "named: Tokens.named",
      "old: old",
      "provideGlobally: provideGlobally",
      "setup: default",
      "stringify: JSON.stringify",
      "wrap: wrap",
    ]);
  });

  it("ask the checker nothing at a name node where no entry names a declaration", () => {
    const { engine, failing } = failingEngine("panic: runtime error");
    const found = inProject((project, held) => {
      const resolved = resolveEntries(
        project,
        held,
        ENTRIES.filter(([label]) => label.startsWith("absent-") || label === "unimported").map(
          ([, entry]) => entry,
        ),
      );
      const nodes = callsOf(project).flatMap((call) => calleeName(call.expression) ?? []);
      const chains = aliasChains(project, held);
      failing.on = true;
      try {
        return entriesAt(project, chains, nodes, resolved).size;
      } catch (error: unknown) {
        return error instanceof Unanswerable ? "unanswerable" : "failed";
      }
    }, engine);

    expect(found).toBe(0);
  });
});
