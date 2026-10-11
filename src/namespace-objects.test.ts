import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { emitterInputOf, findingsOf } from "../__test-helpers__/emitter-input.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { resolve } from "./resolve.ts";

/** A module exporting `used` and `spare`, under one file name. */
function module(name: string): Readonly<Record<string, string>> {
  return {
    [`${name}.ts`]: `export const ${name}Used = 1;\n\nexport const ${name}Spare = 2;\n`,
  };
}

/** An application whose entry reads the namespace object of one module per form. */
const PROJECT: Readonly<Record<string, string>> = {
  "package.json": '{ "name": "@example/app", "type": "module", "main": "./main.ts" }\n',
  ...module("named"),
  ...module("indexed"),
  ...module("computed"),
  ...module("passed"),
  ...module("awaited"),
  ...module("aliased"),
  ...module("handed"),
  ...module("then"),
  ...module("destructured"),
  ...module("rested"),
  ...module("queried"),
  ...module("idle"),
  ...module("loaded"),
  "main.ts": [
    'import * as named from "./named.js";',
    'import * as indexed from "./indexed.js";',
    'import * as computed from "./computed.js";',
    'import * as passed from "./passed.js";',
    'import * as idle from "./idle.js";',
    'import * as queried from "./queried.js";',
    "",
    "function hold(value: unknown): void {",
    "  console.log(value);",
    "}",
    "",
    'const key = Date.now() > 0 ? "computedUsed" : "computedSpare";',
    "hold(named.namedUsed);",
    'hold(indexed["indexedUsed"]);',
    "hold(computed[key]);",
    "hold(passed);",
    'const awaited = await import("./awaited.js");',
    "hold(awaited.awaitedUsed);",
    'const original = await import("./aliased.js");',
    "const aliased = original;",
    "hold(aliased.aliasedUsed);",
    'const handedOriginal = await import("./handed.js");',
    "const handed = handedOriginal;",
    "hold(handed);",
    'void import("./then.js").then((loaded) => hold(loaded.thenUsed));',
    'const { destructuredUsed } = await import("./destructured.js");',
    "hold(destructuredUsed);",
    'const { ...rested } = await import("./rested.js");',
    "hold(rested);",
    "type Queried = typeof queried;",
    "const shape: Queried | undefined = undefined;",
    "hold(shape);",
    'await import("./loaded.js");',
    "",
  ].join("\n"),
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Every finding of the project, as `code name`. */
function reported(): string[] {
  const root = writeProject(PROJECT);
  roots.push(root);
  const repository = JSON.stringify({ target: { kind: "application" } });
  const { config } = resolve({ repository, repositoryLabel: "deadset.json" });
  return findingsOf(emitterInputOf(root, config))
    .map((finding) => `${finding.code} ${finding.symbol.name}`)
    .sort();
}

describe("a module namespace object", () => {
  const found = reported();

  it.each([
    ["named", "a property read by name"],
    ["indexed", "an index that is a string literal"],
    ["awaited", "the value an await of a dynamic import produces"],
    ["aliased", "a const binding of a namespace object"],
    ["then", "the first parameter of a then callback"],
    ["destructured", "a property an object binding pattern destructures"],
  ])("references only the export %s reads, through %s", (name) => {
    expect(found.filter((line) => line.includes(` ${name}`))).toEqual([`DS1001 ${name}Spare`]);
  });

  it.each([
    ["computed", "an index that is no literal"],
    ["passed", "the object passed as an argument"],
    ["handed", "a const binding of the object passed as an argument"],
    ["rested", "a rest element of a binding pattern"],
    ["queried", "a typeof query of the object"],
  ])("references every export of %s, through %s", (name) => {
    expect(found.filter((line) => line.includes(` ${name}`))).toEqual([]);
  });

  it.each([
    ["idle", "a namespace import nothing uses"],
    ["loaded", "a dynamic import whose value is not used"],
  ])("references no export of %s, through %s", (name) => {
    expect(found.filter((line) => line.includes(` ${name}`))).toEqual([
      `DS1001 ${name}Spare`,
      `DS1001 ${name}Used`,
    ]);
  });
});
