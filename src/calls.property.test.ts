import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isStringLiteral,
  isVariableDeclaration,
  type CallExpression,
  type Node,
} from "@typescript/native/ast";
import type { Checker, Project } from "@typescript/native/sync";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { runSweep } from "./analysis.ts";
import { resolve } from "./resolve.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine, type Engine } from "./session.ts";

/**
 * One iteration writes an application that hands one custom element per drawn row to a
 * callee holding the registering wrapper or a decoy, and sweeps it; then it asks the same
 * client's checker which callees hold the wrapper. An iteration costs a sweep, about a
 * second, so the property carries its own time bound and the case's timeout is raised.
 */
const RUNS = 20;

/** How a row's call reaches the function it calls. */
const CALLEES = [
  "direct",
  "copy",
  "property",
  "shorthand",
  "object destructuring",
  "array destructuring",
  "parameter",
  "call result",
  "assignment",
  "conditional",
  "nullish",
  "spread",
  "erasing annotation",
] as const;
type Callee = (typeof CALLEES)[number];

/** How a row's call writes the class it passes. */
const ARGUMENTS = [
  "name",
  "conditional",
  "nullish",
  "array",
  "array branch",
  "object",
  "object branch",
  "call result",
  "erased",
  "spread",
] as const;
type Argument = (typeof ARGUMENTS)[number];

/** One drawn row: a class, the call that passes it and whether that call reaches the wrapper. */
interface Row {
  readonly callee: Callee;
  readonly argument: Argument;
  /** Whether the function the callee holds is the wrapper, or a decoy that registers nothing. */
  readonly wrapper: boolean;
}

const row: fc.Arbitrary<Row> = fc.record({
  callee: fc.constantFrom(...CALLEES),
  argument: fc.constantFrom(...ARGUMENTS),
  wrapper: fc.boolean(),
});

/** The argument text one row passes, after the declarations it needs. */
function argumentOf(one: Row, at: number): { readonly text: string; readonly setup: string[] } {
  const element = `C${String(at)}`;
  switch (one.argument) {
    case "name":
      return { text: element, setup: [] };
    case "conditional":
      return { text: `flag ? ${element} : ${element}`, setup: [] };
    case "nullish":
      return {
        text: `maybe${element} ?? ${element}`,
        setup: [`const maybe${element}: CustomElementConstructor | undefined = undefined;`],
      };
    case "array":
      return { text: `[${element}]`, setup: [] };
    case "array branch":
      return { text: `[flag ? ${element} : ${element}]`, setup: [] };
    case "object":
      return { text: `{ element: ${element} }`, setup: [] };
    case "object branch":
      return { text: `{ element: flag ? ${element} : ${element} }`, setup: [] };
    case "call result":
      return {
        text: `made${element}()`,
        setup: [`function made${element}(): typeof ${element} {`, `  return ${element};`, "}"],
      };
    case "erased":
      return { text: `held${element}`, setup: [`const held${element}: unknown = ${element};`] };
    case "spread":
      return { text: `...([${element}] as const)`, setup: [] };
  }
}

/** The statements one row writes: what its callee needs, and the call. */
function callOf(one: Row, at: number): readonly string[] {
  const fn = one.wrapper ? "register" : "decoy";
  const n = String(at);
  const passed = argumentOf(one, at);
  const args = `"x-${n}", ${passed.text}`;
  const called = (callee: string, setup: readonly string[] = []): readonly string[] => [
    ...passed.setup,
    ...setup,
    `${callee}(${args});`,
  ];
  switch (one.callee) {
    case "direct":
      return called(fn);
    case "copy":
      return called(`copy${n}`, [`const copy${n} = ${fn};`]);
    case "property":
      return called(`prop${n}.f`, [`const prop${n} = { f: ${fn} };`]);
    case "shorthand":
      return called(`short${n}.${fn}`, [`const short${n} = { ${fn} };`]);
    case "object destructuring":
      return called(`obj${n}`, [`const { f: obj${n} } = { f: ${fn} };`]);
    case "array destructuring":
      return called(`arr${n}`, [`const [arr${n}] = [${fn}];`]);
    case "parameter":
      return [
        ...passed.setup,
        `function use${n}(r: typeof ${fn}): void {`,
        `  r(${args});`,
        "}",
        `use${n}(${fn});`,
      ];
    case "call result":
      return called(`get${n}()`, [`function get${n}(): typeof ${fn} {`, `  return ${fn};`, "}"]);
    case "assignment":
      return called(`later${n}`, [
        `let later${n}: typeof ${fn} | undefined;`,
        `later${n} = ${fn};`,
      ]);
    case "conditional":
      return called(`(flag ? ${fn} : ${fn})`);
    case "nullish":
      return called(`(maybe${n} ?? ${fn})`, [
        `const maybe${n}: typeof ${fn} | undefined = flag ? ${fn} : undefined;`,
      ]);
    case "spread":
      return called(`spread${n}`, [`const [spread${n}] = [...[${fn}]];`]);
    case "erasing annotation":
      return called(`erased${n}`, [
        `const erased${n}: (name: string, element: unknown) => void = ${fn};`,
      ]);
  }
}

/** The application a draw becomes. */
function mainOf(rows: readonly Row[]): string {
  return [
    "declare const flag: boolean;",
    "function register(name: string, element: unknown): void {",
    "  customElements.define(name, element as CustomElementConstructor);",
    "}",
    "function decoy(_name: string, _element: unknown): void {}",
    ...rows.flatMap((_one, at) => [
      `class C${String(at)} extends HTMLElement {`,
      "  connectedCallback(): void {}",
      "}",
    ]),
    ...rows.flatMap(callOf),
    "",
  ].join("\n");
}

/** Whether the checker's type at one expression holds the function `wrapper` declares. */
function holds(checker: Checker, at: Node, wrapper: number): boolean {
  const type = checker.getTypeAtLocation(at);
  const parts = type === undefined ? [] : type.isUnionType() ? (type.getTypes() ?? []) : [type];
  return parts.some((part) => part.getSymbol()?.id === wrapper);
}

/**
 * The rows whose call reaches the wrapper, read by the checker: the callee's type holds
 * the wrapper's function, or the callee names a variable whose initializer's type does.
 */
function reachingRows(project: Project, file: Node, wrapperName: Node): ReadonlySet<number> {
  const { checker } = project;
  const wrapper = checker.getSymbolAtLocation(wrapperName)?.id;
  const reaching = new Set<number>();
  if (wrapper === undefined) {
    return reaching;
  }
  const calls: CallExpression[] = [];
  const visit = (node: Node): void => {
    if (isCallExpression(node)) {
      calls.push(node);
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  for (const call of calls) {
    const [first] = call.arguments;
    const at = first !== undefined && isStringLiteral(first) ? /^x-(\d+)$/u.exec(first.text) : null;
    if (at?.[1] === undefined) {
      continue;
    }
    const callee = call.expression;
    const declared = isIdentifier(callee)
      ? checker.getSymbolAtLocation(callee)?.valueDeclaration
      : undefined;
    const node = declared?.resolve(project);
    const initializer =
      node !== undefined && isVariableDeclaration(node) ? node.initializer : undefined;
    if (
      holds(checker, callee, wrapper) ||
      (initializer !== undefined && holds(checker, initializer, wrapper))
    ) {
      reaching.add(Number(at[1]));
    }
  }
  return reaching;
}

/**
 * Property: a class handed to the registering wrapper is registered whatever value the
 * callee is and however the argument writes the class. For every drawn callee form and
 * argument shape, a row's `connectedCallback` is reported dead exactly where the checker
 * says the row's callee does not hold the wrapper, read independently of the product.
 */
describe("a class passed to a wrapper of the custom-element registry", () => {
  it("is registered exactly where the checker says the callee holds the wrapper", () => {
    const { config } = resolve({
      repository: { text: '{ "target": { "kind": "application" } }', label: "deadset.json" },
    });
    // One client serves every draw, each in its own snapshot: a run closes the client it
    // is handed, so the run is handed one whose close is left to this test.
    const client = openEngine({ collectTiming: false });
    const shared: Engine = { ...client, close: () => undefined };
    const host = nodeHost();
    try {
      fc.assert(
        fc.property(fc.array(row, { minLength: 1, maxLength: 4 }), (rows) => {
          const root = writeProject({
            "package.json":
              '{ "name": "app", "private": true, "type": "module", "main": "./main.ts" }\n',
            "main.ts": mainOf(rows),
          });
          try {
            const snapshot = shared.createSnapshot([join(root, "tsconfig.json")]);
            let reaching: ReadonlySet<number>;
            try {
              const project = snapshot.getConfiguredProject(join(root, "tsconfig.json"));
              const file = project?.program.getSourceFile(join(root, "main.ts"));
              const wrapper = file?.statements.find(
                (statement) =>
                  isFunctionDeclaration(statement) && statement.name?.text === "register",
              );
              const name =
                wrapper !== undefined && isFunctionDeclaration(wrapper) ? wrapper.name : undefined;
              if (project === undefined || file === undefined || name === undefined) {
                throw new Error("the drawn project did not open");
              }
              reaching = reachingRows(project, file, name);
            } finally {
              snapshot.dispose();
            }
            expect([...reaching].sort()).toEqual(
              rows.flatMap((one, at) => (one.wrapper ? [at] : [])),
            );
            const swept = runSweep(shared, host, scopeForDir(host, root), config, {
              marked: [],
              mode: { production: true },
            });
            const names = new Map(swept.matrix.union.symbols.map((one) => [one.id, one.name]));
            const dead = swept.sweep.candidates
              .map((candidate) => names.get(candidate.id) ?? candidate.id)
              .filter((name) => /^C\d+\.connectedCallback$/u.test(name));
            expect([...dead].sort()).toEqual(
              rows
                .flatMap((_one, at) =>
                  reaching.has(at) ? [] : [`C${String(at)}.connectedCallback`],
                )
                .sort(),
            );
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        }),
        {
          numRuns: RUNS,
          plugins: [fc.interruptAfterTimeLimit(120_000, { failOnInterrupt: true })],
        },
      );
    } finally {
      client.close();
    }
  }, 150_000);
});
