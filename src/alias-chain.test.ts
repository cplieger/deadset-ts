import { rmSync } from "node:fs";
import {
  isExportSpecifier,
  isExpressionStatement,
  isIdentifier,
  type Node,
} from "@typescript/native/ast";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { aliasChains, type ChainTarget } from "./alias-chain.ts";
import { discoverProjects } from "./discover.ts";
import { inventory } from "./inventory.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine, runSession, type Engine } from "./session.ts";

/** What the walks answer for one head, each declaration as `path#name` and its flags. */
interface Walk {
  readonly declarations: readonly string[];
  readonly chain: readonly string[];
  readonly next: readonly string[];
}

/** The walks from every head, and how many steps the compiler was asked for in all. */
interface Walked {
  readonly heads: Readonly<Record<string, Walk>>;
  readonly steps: number;
}

/** One module's text, a line per argument. */
function lines(...text: readonly string[]): string {
  return `${text.join("\n")}\n`;
}

/** The identifier a head is read from: an expression statement's, or an export specifier's name. */
function headsIn(file: Node): Map<string, Node> {
  const found = new Map<string, Node>();
  const visit = (node: Node): void => {
    const parent = node.parent;
    if (
      isIdentifier(node) &&
      !found.has(node.text) &&
      (isExpressionStatement(parent) || (isExportSpecifier(parent) && parent.name === node))
    ) {
      found.set(node.text, node);
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return found;
}

/**
 * The alias chains of one written project, walked from each head `main.ts` names: its
 * declarations, its chain and the first declared link after it, in that order. While the
 * walks run, the compiler fails the step of each alias whose name `unanswered` holds.
 */
function walkedFrom(
  files: Readonly<Record<string, string>>,
  unanswered: readonly string[] = [],
): Walked {
  const root = writeProject(files);
  try {
    const host = nodeHost();
    const opened = openEngine({ collectTiming: false });
    let walking = false;
    const engine: Engine = {
      ...opened,
      ask: (accessor, locations, question) => {
        const name = locations()[0]?.split(" ").at(-1) ?? "";
        if (walking && accessor === "getImmediateAliasedSymbol" && unanswered.includes(name)) {
          throw new Error(`panic: ${accessor}`);
        }
        return opened.ask(accessor, locations, question);
      },
    };
    const configFiles = discoverProjects(engine, host, scopeForDir(host, root)).configFiles;
    const { projects } = runSession(engine, configFiles, (project): Walked => {
      const held = inventory(project, host, root);
      const byId = new Map(held.symbols.map((symbol) => [symbol.id, symbol]));
      const spelled = (id: string): string => {
        const symbol = byId.get(id);
        return symbol === undefined ? id : `${symbol.position.path}#${symbol.name}`;
      };
      const flagged = (target: ChainTarget): string =>
        `${spelled(target.id)}${target.stepped ? " stepped" : ""}${target.guessed ? " guessed" : ""}`;
      const main = project.ownSourceFiles().find((file) => file.fileName.endsWith("/main.ts"));
      if (main === undefined) {
        throw new Error("the written project holds no main.ts");
      }
      const named = [...headsIn(main)];
      const symbols = project.symbolsAt(named.map(([, node]) => project.handle(node)));
      const chains = aliasChains(project, held);
      walking = true;
      try {
        const heads: Record<string, Walk> = {};
        named.forEach(([name], index) => {
          const symbol = symbols[index];
          if (typeof symbol !== "object") {
            throw new Error(`the head ${name} resolves to nothing`);
          }
          heads[name] = {
            declarations: chains.declarationsOf(symbol).map(spelled),
            chain: chains.chainOf(symbol).map(flagged),
            next: chains.nextDeclared(symbol).map(flagged),
          };
        });
        return { heads, steps: chains.steps };
      } finally {
        walking = false;
      }
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

/** A module, its default export and a re-export of its named one, which `main.ts` imports each way. */
const CHAINED = {
  "c.ts": lines("export const a = 1;", "const x = 2;", "export default x;"),
  "b.ts": lines('export { a as e } from "./c";'),
  "main.ts": lines(
    'import { e as m } from "./b";',
    'import d from "./c";',
    'import * as ns from "./c";',
    "const v = 1;",
    "m;",
    "d;",
    "ns;",
    "v;",
  ),
};

describe("the declarations a symbol is", () => {
  it("are its own, unstepped, and no later link is declared after a symbol that is no alias", () => {
    expect(walkedFrom(CHAINED).heads["v"]).toEqual({
      declarations: ["main.ts#v"],
      chain: ["main.ts#v"],
      next: [],
    });
  });
});

describe("the chain an alias heads", () => {
  it("is every declared link to the declaration it ends at, each stepped, and the first declared link is next", () => {
    expect(walkedFrom(CHAINED).heads["m"]).toEqual({
      declarations: [],
      chain: ["b.ts#e stepped", "c.ts#a stepped"],
      next: ["b.ts#e stepped"],
    });
  });

  it("asks the compiler one step per alias, however many walks pass it", () => {
    // m and e, d and the default export, and ns, whose step answers the module.
    expect(walkedFrom(CHAINED).steps).toBe(5);
  });

  it("ends where it comes back to a link it has walked", () => {
    const walked = walkedFrom({
      "main.ts": lines('import { a } from "./main";', "export { a };"),
    }).heads["a"];

    expect(walked).toEqual({ declarations: ["main.ts#a"], chain: ["main.ts#a"], next: [] });
  });

  it("ends, declaring nothing, where it cycles through links no declaration holds", () => {
    const walked = walkedFrom({
      "a.ts": lines('import b = require("./b");', "export = b;"),
      "b.ts": lines('import a = require("./a");', "export = a;"),
      "main.ts": lines('import x = require("./a");', "x;"),
    }).heads["x"];

    expect(walked).toEqual({ declarations: [], chain: [], next: [] });
  });

  it("steps over every link no declaration holds to the next declared one", () => {
    const walked = walkedFrom({
      "a.ts": lines('import f = require("./f");', "export = f;"),
      "f.ts": lines("function g(): void {}", "export = g;"),
      "main.ts": lines('import y = require("./a");', "y;"),
    }).heads["y"];

    expect(walked).toEqual({
      declarations: [],
      chain: ["f.ts#g stepped"],
      next: ["f.ts#g stepped"],
    });
  });
});

describe("a step the compiler does not answer", () => {
  it("guesses the declarations of the name an alias carries forward, and of its own name", () => {
    const walked = walkedFrom(CHAINED, ["m"]).heads["m"];

    expect(walked?.chain).toEqual(["b.ts#e stepped guessed"]);
    expect(walked?.next).toEqual(["b.ts#e stepped guessed"]);
  });

  it("keeps a declared link it reached, and guesses past it by the names the link carries", () => {
    expect(walkedFrom(CHAINED, ["e"]).heads["m"]?.chain).toEqual([
      "b.ts#e stepped",
      "c.ts#a stepped guessed",
    ]);
  });

  it("guesses the default export for a default import", () => {
    expect(walkedFrom(CHAINED, ["d"]).heads["d"]?.chain).toEqual(["c.ts#default stepped guessed"]);
  });

  it("guesses the declaration a default export names, beside the export itself", () => {
    expect(walkedFrom(CHAINED, ["default"]).heads["d"]?.chain).toEqual([
      "c.ts#default stepped",
      "c.ts#x stepped guessed",
    ]);
  });

  it("guesses every file of the project for a namespace import or re-export", () => {
    const files = [
      "b.ts#b.ts stepped guessed",
      "c.ts#c.ts stepped guessed",
      "main.ts#main.ts stepped guessed",
    ];
    const walked = walkedFrom(
      {
        ...CHAINED,
        "b.ts": lines('export { a as e } from "./c";', 'export * as space from "./c";'),
        "main.ts": lines(
          'import * as ns from "./c";',
          'import { space as sp } from "./b";',
          "ns;",
          "sp;",
        ),
      },
      ["ns", "space"],
    );

    expect(walked.heads["ns"]?.chain).toEqual(files);
    expect(walked.heads["ns"]?.next).toEqual(files);
    expect(walked.heads["sp"]?.chain).toEqual(["b.ts#space stepped", ...files]);
  });
});
