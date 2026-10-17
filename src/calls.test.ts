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
import { inventory } from "./inventory.ts";
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
