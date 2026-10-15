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
  ...module("spelled"),
  ...module("letted"),
  ...module("scoped"),
  ...module("reassigned"),
  ...module("hoisted"),
  ...module("looped"),
  ...module("exported"),
  ...module("paramed"),
  "main.ts": [
    'import * as named from "./named.js";',
    'import * as indexed from "./indexed.js";',
    'import * as computed from "./computed.js";',
    'import * as passed from "./passed.js";',
    'import * as idle from "./idle.js";',
    'import * as queried from "./queried.js";',
    'import * as spelled from "./spelled.js";',
    'import * as lettedOriginal from "./letted.js";',
    'import * as scopedOriginal from "./scoped.js";',
    'import * as reassignedOriginal from "./reassigned.js";',
    'import * as hoistedOriginal from "./hoisted.js";',
    'import * as loopedOriginal from "./looped.js";',
    'import * as exported from "./exported.js";',
    'import * as paramed from "./paramed.js";',
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
    "hold(spelled.spelledUsed);",
    "hold({ spelled: 1 });",
    "spelled: for (;;) {",
    "  break spelled;",
    "}",
    "class Spelling {",
    "  spelled = 1;",
    "}",
    "hold(new Spelling().spelled);",
    "let letted = lettedOriginal;",
    "hold(letted.lettedUsed);",
    "{",
    "  var scoped = scopedOriginal;",
    "}",
    "hold(scoped.scopedUsed);",
    "let reassigned = reassignedOriginal;",
    "hold(reassigned.reassignedUsed);",
    "reassigned = reassignedOriginal;",
    "{",
    "  var hoisted = hoistedOriginal;",
    "}",
    "hold(hoisted);",
    "for (let looped = loopedOriginal, once = true; once; once = false) {",
    "  hold(looped.loopedUsed);",
    "}",
    "const looped = 1;",
    "hold(looped);",
    "hold(exported.exportedUsed);",
    "export { hold as exported };",
    "hold(paramed.paramedUsed);",
    "function shadow(paramed?: number): number {",
    "  return 0;",
    "}",
    "hold(shadow());",
    "",
  ].join("\n"),
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function reported(project: Readonly<Record<string, string>> = PROJECT): string[] {
  const root = writeProject(project);
  roots.push(root);
  const repository = JSON.stringify({ target: { kind: "application" } });
  const { config } = resolve({ repository, repositoryLabel: "deadset.json" });
  return findingsOf(emitterInputOf(root, config))
    .map((finding) => `${finding.code} ${finding.symbol.name}`)
    .sort();
}

describe("a module namespace object", () => {
  it.each([
    ["named", "a property read by name"],
    ["indexed", "an index that is a string literal"],
    ["awaited", "the value an await of a dynamic import produces"],
    ["aliased", "a const binding of a namespace object"],
    ["then", "the first parameter of a then callback"],
    ["destructured", "a property an object binding pattern destructures"],
    [
      "spelled",
      "a property read by name, beside a property, a member and a label spelled as the binding",
    ],
    ["letted", "a let binding of a namespace object"],
    ["scoped", "a var binding of a namespace object, read outside the block that declares it"],
    ["looped", "a let binding a loop head declares, beside a later binding of its name"],
    ["exported", "a property read by name, beside an export renamed to the binding's name"],
  ])("references only the export %s reads, through %s", (name) => {
    expect(
      reported().filter((line) => line.startsWith("DS1001 ") && line.includes(` ${name}`)),
    ).toEqual([`DS1001 ${name}Spare`]);
  });

  it.each([
    ["computed", "an index that is no literal"],
    ["passed", "the object passed as an argument"],
    ["handed", "a const binding of the object passed as an argument"],
    ["rested", "a rest element of a binding pattern"],
    ["reassigned", "a let binding of a namespace object that is reassigned"],
    [
      "hoisted",
      "a var binding of the object passed as an argument outside the block that declares it",
    ],
    ["queried", "a typeof query of the object"],
  ])("references every export of %s, through %s", (name) => {
    expect(
      reported().filter((line) => line.startsWith("DS1001 ") && line.includes(` ${name}`)),
    ).toEqual([]);
  });

  it("references only the export paramed reads, beside a parameter of its name", () => {
    expect(reported().filter((line) => line.includes(" paramed"))).toEqual([
      "DS1001 paramedSpare",
      "DS1401 paramed",
    ]);
  });

  it.each([
    ["idle", "a namespace import nothing uses"],
    ["loaded", "a dynamic import whose value is not used"],
  ])("references no export of %s, through %s", (name) => {
    expect(
      reported().filter((line) => line.startsWith("DS1001 ") && line.includes(` ${name}`)),
    ).toEqual([`DS1001 ${name}Spare`, `DS1001 ${name}Used`]);
  });
});

function beside(name: string, lines: readonly string[]): Readonly<Record<string, string>> {
  return {
    "package.json": '{ "name": "@example/app", "type": "module", "main": "./main.ts" }\n',
    ...module(name),
    "main.ts": [
      "function hold(value: unknown): void {",
      "  console.log(value);",
      "}",
      "",
      ...lines,
      "",
    ].join("\n"),
  };
}

describe("a module namespace object in a project of its own", () => {
  it.each([
    [
      "parenthesized",
      "a property read through parentheses",
      [
        'import * as parenthesized from "./parenthesized.js";',
        "hold((parenthesized).parenthesizedUsed);",
      ],
    ],
    [
      "templated",
      "an index that is a template literal",
      ['import * as templated from "./templated.js";', "hold(templated[`templatedUsed`]);"],
    ],
    [
      "qualified",
      "a qualified name a type query writes",
      [
        'import * as qualified from "./qualified.js";',
        "type Shape = typeof qualified.qualifiedUsed;",
        "const shape: Shape | undefined = undefined;",
        "hold(shape);",
      ],
    ],
  ])("references only the export %s reads, through %s", (name, _, lines) => {
    expect(
      reported(beside(name, lines)).filter(
        (line) => line.startsWith("DS1001 ") && line.includes(` ${name}`),
      ),
    ).toEqual([`DS1001 ${name}Spare`]);
  });

  it.each([
    [
      "lettered",
      "a let binding of the object",
      [
        'import * as lettered from "./lettered.js";',
        "let alias = lettered;",
        "alias = lettered;",
        "hold(alias.letteredUsed);",
      ],
    ],
    [
      "widened",
      "an index typed as any string",
      [
        'import * as widened from "./widened.js";',
        "const key: string = String(Date.now());",
        "hold(widened[key]);",
      ],
    ],
    [
      "caught",
      "a catch callback of a dynamic import",
      ['void import("./caught.js").catch((error: Error) => hold(error.message));'],
    ],
    [
      "pending",
      "the promise of a dynamic import a binding holds",
      ['const pending = import("./pending.js");', "hold(pending);"],
    ],
    [
      "cyclic",
      "consts of a block that read its name through each other",
      [
        'import * as cyclic from "./cyclic.js";',
        "{",
        "  const alias = cyclic;",
        "  const cyclic = alias;",
        "  hold(cyclic);",
        "}",
      ],
    ],
  ])("references every export of %s, through %s", (name, _, lines) => {
    expect(
      reported(beside(name, lines)).filter(
        (line) => line.startsWith("DS1001 ") && line.includes(` ${name}`),
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "voided",
      "a statement and a void of the binding",
      ['import * as voided from "./voided.js";', "voided;", "void voided;"],
    ],
    [
      "spelled",
      "a member's name spelled as the binding",
      [
        'import * as spelled from "./spelled.js";',
        'declare const shapes: Record<"spelled", number>;',
        "hold(shapes.spelled);",
        "type Spelled = typeof shapes.spelled;",
        "const { spelled: renamed } = shapes;",
        "const shape: Spelled = renamed;",
        "hold(shape);",
      ],
    ],
    [
      "shadowed",
      "a declaration of its name in a nested scope",
      [
        'import * as shadowed from "./shadowed.js";',
        "function shadow(): void {",
        "  const shadowed = { other: 1 };",
        "  hold(shadowed.other);",
        "}",
        "shadow();",
      ],
    ],
    [
      "ignored",
      "a dynamic import as a statement and as a void",
      ['import("./ignored.js");', 'void import("./ignored.js");'],
    ],
    ["side", "a bare import", ['import "./side.js";']],
    [
      "typed",
      "a type query of a type-only namespace import",
      [
        'import type * as typed from "./typed.js";',
        "type Typed = typeof typed;",
        "const shape: Typed | undefined = undefined;",
        "hold(shape);",
      ],
    ],
  ])("references no export of %s, through %s", (name, _, lines) => {
    expect(
      reported(beside(name, lines)).filter(
        (line) => line.startsWith("DS1001 ") && line.includes(` ${name}`),
      ),
    ).toEqual([`DS1001 ${name}Spare`, `DS1001 ${name}Used`]);
  });

  it("references no export of a module, nor the file, through another call of its specifier", () => {
    expect(
      reported(beside("called", ['hold("./called.js");'])).filter((line) =>
        line.includes(" called"),
      ),
    ).toEqual(["DS1001 calledSpare", "DS1001 calledUsed", "DS1602 called.ts"]);
  });
});
