import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { targetConfigFiles, writeProject } from "../__test-helpers__/projects.ts";
import { aliasChains } from "./alias-chain.ts";
import {
  calleeName,
  callsOf,
  classesPassed,
  decoratedClasses,
  resolvedTargets,
  spelledDecorator,
} from "./calls.ts";
import { discoverProjects } from "./load/discover.ts";
import { inventory } from "./inventory/enumerate.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine, runSession, type Engine } from "./session.ts";

/** What the call readings answer over one project's `main.ts`, each call spelled by its text. */
interface Read {
  /** Each call as `call: callee name`, `-` where it has none. */
  readonly callees: readonly string[];
  /** Each call as `call: declaration` for a callee that resolves, `call: -` for one that does not. */
  readonly targets: readonly string[];
  /** How many times the alias resolution was asked while the callees resolved. */
  readonly aliasQuestions: number;
  /** Each call as `call: class@site …`. */
  readonly passed: readonly string[];
  /** Each decorated class as its name and its decorators' spellings. */
  readonly decorated: readonly string[];
}

/** One module's text, a line per argument. */
function lines(...text: readonly string[]): string {
  return `${text.join("\n")}\n`;
}

/** The call readings of one written project. */
function readCalls(files: Readonly<Record<string, string>>): Read {
  const root = writeProject(files);
  try {
    const host = nodeHost();
    const opened = openEngine({ collectTiming: false });
    let aliasQuestions = 0;
    const engine: Engine = {
      ...opened,
      ask: (accessor, locations, question) => {
        if (accessor === "getAliasedSymbol") {
          aliasQuestions += 1;
        }
        return opened.ask(accessor, locations, question);
      },
    };
    const configFiles = targetConfigFiles(discoverProjects(engine, host, scopeForDir(host, root)));
    const { projects } = runSession(engine, configFiles, (project): Read => {
      const held = inventory(project, host, root);
      const byId = new Map(held.symbols.map((symbol) => [symbol.id, symbol.name]));
      const calls = callsOf(project).filter((call) =>
        call.getSourceFile().fileName.endsWith("/main.ts"),
      );
      const names = calls.map((call) => calleeName(call.expression));
      aliasQuestions = 0;
      const targets = resolvedTargets(
        project,
        names.flatMap((name) => name ?? []),
      );
      const asked = aliasQuestions;
      const passed = classesPassed(project, held, aliasChains(project, held), calls);
      return {
        callees: calls.map((call, index) => `${call.getText()}: ${names[index]?.getText() ?? "-"}`),
        targets: calls.map((call, index) => {
          const name = names[index];
          const target = name === undefined ? undefined : targets.get(name);
          const file = target?.declarations[0]?.path.split("/").at(-1);
          return `${call.getText()}: ${target === undefined ? "-" : `${file ?? "?"}#${target.name}`}`;
        }),
        aliasQuestions: asked,
        passed: calls.map(
          (call) =>
            `${call.getText()}:${(passed.get(call) ?? [])
              .map((use) => ` ${byId.get(use.id) ?? use.id}@${use.site.getText()}`)
              .join("")}`,
        ),
        decorated: decoratedClasses(project, held).map(
          (one) =>
            `${byId.get(one.id) ?? one.id} ${one.decorators.map(spelledDecorator).join(" ")}`,
        ),
      };
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

describe("the name a callee resolves through", () => {
  it("is the identifier or the accessed name, inside any parentheses, and none for another expression", () => {
    expect(
      readCalls({
        "main.ts": lines(
          "const box = { open(): void {} };",
          "function run(): void {}",
          "(box.open)();",
          "((run))();",
          "run();",
          "(() => 1)();",
        ),
      }).callees,
    ).toEqual(["(box.open)(): open", "((run))(): run", "run(): run", "(() => 1)(): -"]);
  });
});

describe("the declaration a callee resolves to", () => {
  it("is the one every alias stands for, each alias resolved once, and none for an import that names nothing", () => {
    const read = readCalls({
      "lib.ts": lines("export function start(): void {}"),
      "main.ts": lines(
        'import { start, missing } from "./lib";',
        "function local(): void {}",
        "start();",
        "start();",
        "missing();",
        "local();",
      ),
    });

    expect(read.targets).toEqual([
      "start(): lib.ts#start",
      "start(): lib.ts#start",
      "missing(): -",
      "local(): main.ts#local",
    ]);
    expect(read.aliasQuestions).toBe(2);
  });
});

describe("the classes a call passes", () => {
  it("are the classes it passes as arguments, array elements, spread elements and object values, at their sites", () => {
    expect(
      readCalls({
        "main.ts": lines(
          "class Alpha {}",
          "class Beta {}",
          "function helper(): void {}",
          "declare function register(...values: unknown[]): void;",
          "register(Alpha);",
          "register([Alpha, ...[Beta]]);",
          "register({ key: Alpha, Beta });",
          "register((Alpha));",
          "register(...[Beta]);",
          "register(helper, unknownName);",
        ),
      }).passed,
    ).toEqual([
      "register(Alpha): Alpha@Alpha",
      "register([Alpha, ...[Beta]]): Alpha@Alpha Beta@Beta",
      "register({ key: Alpha, Beta }): Alpha@Alpha Beta@Beta",
      "register((Alpha)): Alpha@Alpha",
      "register(...[Beta]): Beta@Beta",
      "register(helper, unknownName):",
    ]);
  });

  it("are the classes it names through variables, a variable named by another's initializer included", () => {
    expect(
      readCalls({
        "main.ts": lines(
          "class Alpha {}",
          "declare function register(...values: unknown[]): void;",
          "declare function make(): unknown;",
          "const First = Alpha;",
          "const Second = (First);",
          "const Made = make();",
          "var looped = again, again = looped;",
          "register(Second);",
          "register(Made, looped);",
        ),
      }).passed,
    ).toEqual(["make():", "register(Second): Alpha@Second", "register(Made, looped):"]);
  });

  it("are the classes each call of a wrapper passes at the place of the parameter it forwards, a spread at every place it can reach", () => {
    expect(
      readCalls({
        "main.ts": lines(
          "declare function define(name: string, element: unknown): void;",
          "class ByCopy {}",
          "class ByProperty {}",
          "class ByExpression {}",
          "class ByThis {}",
          "class ByPair {}",
          "class ByTable {}",
          "class ByAssert {}",
          "export function register(name: string, element: unknown): void {",
          "  define(name, element);",
          "}",
          "const copy = register;",
          'copy("x-copy", ByCopy);',
          "const registry = {",
          "  add: (name: string, element: unknown): void => define(name, element),",
          "};",
          'registry.add("x-property", ByProperty);',
          "const viaExpression = function (name: string, element: unknown): void {",
          "  define(name, element);",
          "};",
          'viaExpression("x-expression", ByExpression);',
          "class Hosted {",
          "  add(this: Hosted, name: string, element: unknown): void {",
          "    define(name, element);",
          "  }",
          "}",
          'new Hosted().add("x-this", ByThis);',
          "function pairs(name: string, element: unknown): void {",
          "  define(name, element);",
          "}",
          'const pair = ["x-pair", ByPair] as const;',
          "pairs(...pair);",
          "function viaTable(name: string, element: unknown): void {",
          "  define(name, element);",
          "}",
          "const table = { element: ByTable };",
          'viaTable("x-table", table.element);',
          'define("x-assert", ByAssert as unknown);',
        ),
        "lib.ts": lines(
          'import { register as reg } from "./main.js";',
          "export class ByAlias {}",
          'reg("x-alias", ByAlias);',
        ),
      }).passed,
    ).toEqual([
      "define(name, element): ByCopy@element ByAlias@element",
      'copy("x-copy", ByCopy): ByCopy@ByCopy',
      "define(name, element): ByProperty@element",
      'registry.add("x-property", ByProperty): ByProperty@ByProperty',
      "define(name, element): ByExpression@element",
      'viaExpression("x-expression", ByExpression): ByExpression@ByExpression',
      "define(name, element): ByThis@element",
      'new Hosted().add("x-this", ByThis): ByThis@ByThis',
      "define(name, element): ByPair@name ByPair@element",
      "pairs(...pair): ByPair@pair",
      "define(name, element): ByTable@element",
      'viaTable("x-table", table.element): ByTable@table.element',
      'define("x-assert", ByAssert as unknown): ByAssert@ByAssert',
    ]);
  });

  it("are the classes each value an argument can be holds as the checker types it, and a wrapper is called through any binding that holds it", () => {
    const read = readCalls({
      "main.ts": lines(
        "declare function define(name: string, element: unknown): void;",
        "declare const flag: boolean;",
        "declare const maybe: (new () => object) | undefined;",
        "class ByCondA {}",
        "class ByCondB {}",
        "class ByNullish {}",
        "class ByPropCopy {}",
        "class ByDirectCond {}",
        "class ByField {}",
        "class ByBag {}",
        "class ByDestructure {}",
        "class ByTyped {}",
        "class ByErased {}",
        "class ByInstance {}",
        "export function register(name: string, element: unknown): void {",
        "  define(name, element);",
        "}",
        'register("x-cond", flag ? ByCondA : ByCondB);',
        'register("x-nullish", maybe ?? ByNullish);',
        "const regs = { reg: register };",
        'regs.reg("x-prop-copy", ByPropCopy);',
        'define("x-direct", flag ? ByDirectCond : ByDirectCond);',
        "class Box {",
        "  reg = register;",
        "}",
        'new Box().reg("x-field", ByField);',
        "const bag = { register };",
        'bag.register("x-bag", ByBag);',
        "const wrapped = { register };",
        "const { register: renamed } = wrapped;",
        'renamed("x-destructure", ByDestructure);',
        "const typed: (name: string, element: unknown) => void = register;",
        'typed("x-typed", ByTyped);',
        "const erased: unknown = flag ? ByErased : undefined;",
        'define("x-erased", erased);',
        'define("x-instance", new ByInstance());',
        'import { ByShorthand } from "./lib.js";',
        "declare function each(value: unknown): void;",
        "each({ ByShorthand });",
      ),
      "lib.ts": lines(
        'import { register } from "./main.js";',
        "export class ByShorthand {}",
        "export class ByImportBag {}",
        "export class ByImportDestructure {}",
        "const held = { register };",
        'held.register("x-import-bag", ByImportBag);',
        "const { register: again } = held;",
        'again("x-import-destructure", ByImportDestructure);',
      ),
    }).passed;

    const forwarded = read.find((one) => one.startsWith("define(name, element):"));
    expect(forwarded?.split(" ").slice(2).sort()).toEqual([
      "ByBag@element",
      "ByCondA@element",
      "ByCondB@element",
      "ByDestructure@element",
      "ByField@element",
      "ByImportBag@element",
      "ByImportDestructure@element",
      "ByNullish@element",
      "ByPropCopy@element",
      "ByTyped@element",
    ]);
    expect(read.filter((one) => !one.startsWith("define(name, element):"))).toEqual([
      'register("x-cond", flag ? ByCondA : ByCondB): ByCondA@ByCondA ByCondB@ByCondB',
      'register("x-nullish", maybe ?? ByNullish): ByNullish@ByNullish',
      'regs.reg("x-prop-copy", ByPropCopy): ByPropCopy@ByPropCopy',
      'define("x-direct", flag ? ByDirectCond : ByDirectCond): ByDirectCond@ByDirectCond ByDirectCond@ByDirectCond',
      'new Box().reg("x-field", ByField): ByField@ByField',
      'bag.register("x-bag", ByBag): ByBag@ByBag',
      'renamed("x-destructure", ByDestructure): ByDestructure@ByDestructure',
      'typed("x-typed", ByTyped): ByTyped@ByTyped',
      'define("x-erased", erased): ByErased@erased',
      'define("x-instance", new ByInstance()):',
      "each({ ByShorthand }): ByShorthand@ByShorthand",
    ]);
  });

  it("are passed to a wrapper wherever the checker's type at the callee holds it, and by each branch inside an array or object literal", () => {
    const read = readCalls({
      "main.ts": lines(
        "declare function define(name: string, element: unknown): void;",
        "declare const flag: boolean;",
        "class ByParam {}",
        "class ByArray {}",
        "class ByReturned {}",
        "class ByLater {}",
        "class ByAnonymous {}",
        "class ByErasedCopy {}",
        "class ByArrayBranch {}",
        "class ByObjectBranch {}",
        "class ByDecoy {}",
        "export function register(name: string, element: unknown): void {",
        "  define(name, element);",
        "}",
        "function decoy(_name: string, _element: unknown): void {}",
        "function use(r: typeof register): void {",
        '  r("x-param", ByParam);',
        "}",
        "use(register);",
        "const [arr] = [register];",
        'arr("x-array", ByArray);',
        "function getReg(): typeof register {",
        "  return register;",
        "}",
        'getReg()("x-returned", ByReturned);',
        "let later: typeof register | undefined;",
        "later = register;",
        'later("x-later", ByLater);',
        "const anonymous = [(name: string, element: unknown): void => define(name, element)];",
        'anonymous[0]?.("x-anonymous", ByAnonymous);',
        "const erasedCopy: (name: string, element: unknown) => void = flag ? register : decoy;",
        'erasedCopy("x-erased-copy", ByErasedCopy);',
        'register("x-array-branch", [flag ? ByArrayBranch : ByArrayBranch]);',
        'register("x-object-branch", { element: flag ? ByObjectBranch : ByObjectBranch });',
        'decoy("x-decoy", ByDecoy);',
      ),
    }).passed;

    const forwarded = read.filter((one) => one.startsWith("define(name, element):"));
    expect(forwarded.map((one) => one.split(" ").slice(2).sort())).toEqual([
      [
        "ByArray@element",
        "ByArrayBranch@element",
        "ByErasedCopy@element",
        "ByLater@element",
        "ByObjectBranch@element",
        "ByParam@element",
        "ByReturned@element",
      ],
      ["ByAnonymous@element"],
    ]);
    expect(read.filter((one) => one.includes("-branch"))).toEqual([
      'register("x-array-branch", [flag ? ByArrayBranch : ByArrayBranch]): ByArrayBranch@ByArrayBranch ByArrayBranch@ByArrayBranch',
      'register("x-object-branch", { element: flag ? ByObjectBranch : ByObjectBranch }): ByObjectBranch@ByObjectBranch ByObjectBranch@ByObjectBranch',
    ]);
  });
});

describe("the decorated classes", () => {
  it("are the class declarations at any depth that carry a decorator, with how each is spelled", () => {
    expect(
      readCalls({
        "main.ts": lines(
          "function mark(..._args: unknown[]): void {}",
          "function tag(_name: string): (..._args: unknown[]) => void {",
          "  return mark;",
          "}",
          "@mark",
          "export class Marked {}",
          '@tag( "x" )',
          "export class Tagged {}",
          "export class Plain {",
          "  @mark",
          "  method(): void {}",
          "}",
          "export namespace Inner {",
          "  @mark",
          "  export class Nested {}",
          "}",
        ),
      }).decorated,
    ).toEqual(["Marked @mark", "Tagged @tag", "Inner.Nested @mark"]);
  });
});
