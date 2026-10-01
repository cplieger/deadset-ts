import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { aliasChains } from "./alias-chain.ts";
import { calleeName, callsOf, resolvedTargets } from "./calls.ts";
import type { DeclarationEntry } from "./config.ts";
import {
  names,
  namesADeclaration,
  resolveEntries,
  spelledEntry,
} from "./configured-declarations.ts";
import { discoverProjects } from "./discover.ts";
import { inventory } from "./inventory.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine, runSession } from "./session.ts";

const ROOT = writeProject({
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
    include: ["src/**/*.ts"],
  }),
  "node_modules/@example/container/package.json": JSON.stringify({
    name: "@example/container",
    type: "module",
    exports: { ".": { types: "./index.d.ts" } },
  }),
  "node_modules/@example/container/index.d.ts": [
    'export { Container, Tokens, register as provide } from "./impl.js";',
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
    "export declare function register(target: unknown): void;",
    "export default function setup(): void;",
    "",
  ].join("\n"),
  "src/local.ts": [
    "export function wrap(value: unknown): unknown {",
    "  return value;",
    "}",
    "export class Registry {",
    "  static add(value: unknown): void {}",
    "}",
    "declare global {",
    "  function provideGlobally(value: unknown): void;",
    "}",
    "",
  ].join("\n"),
  "src/main.ts": [
    'import setup, { Container, Tokens, provide as give } from "@example/container";',
    'import { Registry, wrap } from "./local.ts";',
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
    "",
  ].join("\n"),
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** The entries named, each with the label a case reads it by. */
const ENTRIES: readonly (readonly [string, DeclarationEntry])[] = [
  ["bind", { shape: "module", module: "@example/container", name: "Container.bind" }],
  ["create", { shape: "module", module: "@example/container", name: "Container.create:static" }],
  ["named", { shape: "module", module: "@example/container", name: "Tokens.named" }],
  ["register", { shape: "module", module: "@example/container", name: "provide" }],
  ["default", { shape: "module", module: "@example/container", name: "default" }],
  ["stringify", { shape: "global", global: "JSON.stringify" }],
  ["define", { shape: "global", global: "CustomElementRegistry.define" }],
  ["ambient", { shape: "global", global: "provideGlobally" }],
  ["wrap", { shape: "symbol", symbol: "ts://@example/app/src/local.ts#wrap" }],
  ["add", { shape: "symbol", symbol: "ts://@example/app/src/local.ts#Registry.add:static" }],
  [
    "static-as-instance",
    { shape: "module", module: "@example/container", name: "Container.create" },
  ],
  [
    "instance-as-static",
    { shape: "module", module: "@example/container", name: "Container.bind:static" },
  ],
  ["unimported", { shape: "module", module: "@example/other", name: "bind" }],
  ["absent-member", { shape: "global", global: "JSON.serialize" }],
  ["absent-symbol", { shape: "symbol", symbol: "ts://@example/app/src/local.ts#unwrap" }],
];

/** Each call of the main file with the labels of the entries its callee is, and each entry's spelling. */
function resolveAll(): {
  readonly calls: readonly string[];
  readonly unmatched: readonly string[];
  readonly spelled: readonly string[];
} {
  const host = nodeHost();
  const engine = openEngine({ collectTiming: false });
  const { configFiles } = discoverProjects(engine, host, scopeForDir(host, ROOT));
  const { projects } = runSession(engine, configFiles, (project) => {
    const held = inventory(project, host, ROOT);
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
  const [only] = projects;
  if (only === undefined) {
    throw new Error("the written project opened no project");
  }
  return only;
}

describe("the declarations a configuration names", () => {
  const resolved = resolveAll();

  it("match the call whose callee resolves to them, through every import, re-export and instantiation", () => {
    expect(resolved.calls).toEqual([
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
    ]);
  });

  it("name nothing where the path, the side of the member or the module names nothing", () => {
    expect(resolved.unmatched).toEqual([
      "static-as-instance",
      "instance-as-static",
      "unimported",
      "absent-member",
      "absent-symbol",
    ]);
  });

  it("are spelled by their path, and a declaration of the program by its display name", () => {
    expect(resolved.spelled.slice(0, 10)).toEqual([
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
    ]);
  });
});
