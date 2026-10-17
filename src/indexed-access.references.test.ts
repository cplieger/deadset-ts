import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { targetConfigFiles, writeProject } from "../__test-helpers__/projects.ts";
import { aliasChains } from "./alias-chain.ts";
import { discoverProjects } from "./load/discover.ts";
import { indexedAccessReferences } from "./indexed-access.ts";
import { inventory } from "./inventory.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine, runSession, type Engine } from "./session.ts";

const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, target: "ESNext", module: "NodeNext", noEmit: true },
  include: ["main.ts"],
});

/**
 * The indexed-access references of the project `main` is the one file of, each as
 * `<from> -> <to>` by declaration name, while the checker panics on every question
 * through the accessor `unanswered`.
 */
function referencesOf(main: string, unanswered?: string): readonly string[] {
  const root = writeProject({ "tsconfig.json": TSCONFIG, "main.ts": main });
  try {
    const host = nodeHost();
    const opened = openEngine({ collectTiming: false });
    let reading = false;
    const engine: Engine = {
      ...opened,
      ask: (accessor, locations, question) => {
        if (reading && accessor === unanswered) {
          throw new Error(`panic: ${accessor}`);
        }
        return opened.ask(accessor, locations, question);
      },
    };
    const configFiles = targetConfigFiles(discoverProjects(engine, host, scopeForDir(host, root)));
    const found = new Set<string>();
    runSession(engine, configFiles, (project) => {
      const held = inventory(project, host, root);
      const names = new Map(held.symbols.map((symbol) => [symbol.id, symbol.name]));
      const chains = aliasChains(project, held);
      reading = true;
      try {
        for (const one of indexedAccessReferences(project, held, chains, root, new Set())) {
          found.add(`${names.get(one.from) ?? one.from} -> ${names.get(one.to) ?? one.to}`);
        }
      } finally {
        reading = false;
      }
      return held;
    });
    return [...found].sort();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the references an indexed access makes", () => {
  // Each case asserts the key its calls fix, not what else the type parameters' constraints admit.
  it("are made where a type reference passes a type parameter on to the generic indexing by it", () => {
    expect(
      referencesOf(
        [
          "interface Payload { a: string; b: number }",
          "type Boxed<K extends keyof Payload> = { value: Payload[K] };",
          'function box<K extends "a" | "b">(): Boxed<K> { return undefined as never; }',
          'export const boxed = box<"a">();',
          "",
        ].join("\n"),
      ),
    ).toEqual(expect.arrayContaining(["boxed -> Payload.a"]));
  });

  it("are made through a function type and a call signature the generic indexing by its type parameter returns", () => {
    expect(
      referencesOf(
        [
          "interface Payload { a: string; b: number; c: boolean }",
          'function viaFunctionType<K extends "a" | "c">(): () => Payload[K] {',
          "  return () => undefined as never;",
          "}",
          'function viaCallSignature<K extends "b" | "c">(): { <T>(seed: T): Payload[K] } {',
          "  return () => undefined as never;",
          "}",
          'export const read = [viaFunctionType<"a">(), viaCallSignature<"b">()];',
          "",
        ].join("\n"),
      ),
    ).toEqual(expect.arrayContaining(["read -> Payload.a", "read -> Payload.b"]));
  });

  it("read a union the checker cannot split as one type", () => {
    expect(
      referencesOf(
        [
          "interface Left { shared: string; left: string }",
          "interface Right { shared: string; right: string }",
          'export const read: (Left | Right)["shared"] = "";',
          "",
        ].join("\n"),
        "getTypes",
      ),
    ).toEqual(["read -> Left.shared", "read -> Right.shared"]);
  });
});
