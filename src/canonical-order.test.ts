import { rmSync } from "node:fs";
import type { NodeHandle, Symbol as TSSymbol } from "@typescript/native/sync";
import { describe, expect, it } from "vitest";
import { emitterInputOf, findingsOf } from "../__test-helpers__/emitter-input.ts";
import { LOAD_TIMEOUT } from "../__test-helpers__/intra-function-parts.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import {
  canonicalDeclarations,
  canonicalSymbols,
  canonicalTable,
  canonicalTypes,
  compareHandles,
} from "./canonical-order.ts";
import { resolve } from "./resolve.ts";
import { openEngine, type Engine } from "./session.ts";

/** A declaration handle at one place, as the checker gives it. */
function handle(path: string, index: number): NodeHandle {
  return { path, index } as unknown as NodeHandle;
}

/** A symbol named `name` whose declarations are at `at`, in the order given. */
function symbol(name: string, ...at: readonly NodeHandle[]): TSSymbol {
  return { escapedName: name, name, declarations: at } as unknown as TSSymbol;
}

describe("the canonical order", () => {
  it("puts declarations by their file's path, bytewise, then in source order", () => {
    const declared = symbol("x", handle("/b.ts", 1), handle("/a.ts", 9), handle("/a.ts", 2));

    expect(
      canonicalDeclarations(declared).map((one) => `${one.path}#${String(one.index)}`),
    ).toEqual(["/a.ts#2", "/a.ts#9", "/b.ts#1"]);
    expect(canonicalDeclarations(undefined)).toEqual([]);
    expect(compareHandles(handle("/\u{1F600}.ts", 0), handle("/\uFFFD.ts", 0))).toBe(1);
  });

  it("puts symbols by their first declaration, then those no file declares by name", () => {
    const later = symbol("later", handle("/a.ts", 5));
    const earlier = symbol("earlier", handle("/b.ts", 1), handle("/a.ts", 3));
    const zeta = symbol("zeta");
    const alpha = symbol("alpha");
    const names = (list: readonly TSSymbol[]): string[] => list.map((one) => one.name);

    expect(names(canonicalSymbols([zeta, later, alpha, earlier]))).toEqual([
      "earlier",
      "later",
      "alpha",
      "zeta",
    ]);
    expect([
      ...canonicalTable(
        new Map([
          ["z", zeta],
          ["l", later],
          ["e", earlier],
        ]),
      ).keys(),
    ]).toEqual(["e", "l", "z"]);
    expect(
      canonicalTypes(["none", "later", "earlier"], (type) =>
        type === "later" ? later : type === "earlier" ? earlier : undefined,
      ),
    ).toEqual(["earlier", "later", "none"]);
  });
});

/** The accessors whose answer is a list or a table, whose order the checker chooses. */
const LISTED = new Set([
  "getPropertiesOfType",
  "getMembers",
  "getExports",
  "getExportsOfModule",
  "getSymbolsInScope",
  "getBaseTypes",
  "getTypes",
  "getIndexInfosOfType",
  "getSignaturesOfType",
]);

/** An answer with its list or table reversed. */
function reversed(answer: unknown): unknown {
  if (Array.isArray(answer)) {
    return [...(answer as unknown[])].reverse();
  }
  return answer instanceof Map ? new Map([...(answer as Map<unknown, unknown>)].reverse()) : answer;
}

/** Each finding of one application tree, entered at `main.ts`, as its whole record. */
function findings(files: Readonly<Record<string, string>>, engine?: Engine): string[] {
  const root = writeProject({
    "package.json": JSON.stringify({ name: "@example/order", private: true, type: "module" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, module: "NodeNext", target: "ESNext" },
      include: ["**/*.ts"],
    }),
    ...files,
  });
  try {
    const { config } = resolve({
      repository: {
        text: JSON.stringify({
          target: { kind: "application" },
          analysis: { min_confidence: "possible" },
          ts: { entry_files: ["main.ts"] },
        }),
        label: "deadset.json",
      },
    });
    return findingsOf(emitterInputOf(root, config, engine === undefined ? {} : { engine })).map(
      (one) => JSON.stringify(one),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A tree whose answers hold lists in an order of the checker's choosing. */
const ORDERED = {
  "shapes.ts": [
    "export interface Shape { area(): number; label: string }",
    "export interface Shape { spare: string }",
    "export class Base { static make(): Base { return new Base(); } shared = 1; unread = 2 }",
    "",
  ].join("\n"),
  "more.ts": [
    'import type { Shape } from "./shapes.js";',
    'declare module "./shapes.js" { interface Shape { merged: number } }',
    "export const unit: Shape = { area: () => 1, label: 'u', spare: 's', merged: 0 };",
    "",
  ].join("\n"),
  "main.ts": [
    'import { Base } from "./shapes.js";',
    'import { unit } from "./more.js";',
    "class Derived extends Base { static build(): void {} run(): number { return this.shared; } idle(): void {} }",
    "type Either = { kind: 'a'; a: number; gone: string } | { kind: 'b'; b: string; lost: number };",
    "function pick(value: Either): number | string { return value.kind === 'a' ? value.a : value.b; }",
    "console.log(JSON.stringify(unit), unit.area(), new Derived().run(), Derived.make(), pick);",
    "",
  ].join("\n"),
};

describe("the findings of a tree whose checker answers its lists in another order", () => {
  it(
    "are the findings it answers them in, record for record",
    () => {
      const opened = openEngine({ collectTiming: false });
      const reversing: Engine = {
        ...opened,
        ask: (accessor, locations, question) => {
          const answer = opened.ask(accessor, locations, question);
          return (LISTED.has(accessor) ? reversed(answer) : answer) as typeof answer;
        },
      };
      const asked = findings(ORDERED);

      expect(asked.length).toBeGreaterThan(0);
      expect(findings(ORDERED, reversing)).toEqual(asked);
    },
    LOAD_TIMEOUT,
  );
});
