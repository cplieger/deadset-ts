import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Expression, Node } from "@typescript/native/unstable/ast";
import type {
  APIRequestGenerator,
  Checker,
  Symbol as TSSymbol,
  Type,
} from "@typescript/native/unstable/sync";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { discoverProjects } from "./discover.ts";
import { must, queriesOf, Unanswerable, UNANSWERED, UnansweredLog, type Batch } from "./query.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine, runSession } from "./session.ts";

/** The text the compiler server answers a question with when the question panicked. */
const PANIC = "panic: interface conversion: checker.TypeData is *checker.TypeReference";

/** One node of a fake program: a file name and an offset are all the layer reads of it. */
function nodeAt(pos: number): Node {
  // A test fake: the layer reads only the file a node is in and its offset.
  return { pos, getSourceFile: () => ({ fileName: "/src/a.ts" }) } as unknown as Node;
}

/** One symbol of a fake checker, named for the offset it answers for. */
function symbolFor(node: Node): TSSymbol {
  // A test fake: the answer is compared by identity of its name only.
  return { id: node.pos, name: `at${String(node.pos)}` } as unknown as TSSymbol;
}

/** One type of a fake checker, named for the offset it answers for. */
function typeFor(node: Node): Type {
  // A test fake: the answer is compared by its identity number only.
  return { id: node.pos } as unknown as Type;
}

/** A question that answers without a round trip, as a fake server answers it. */
function* answered<T>(answer: () => T): APIRequestGenerator<T> {
  yield* [];
  return answer();
}

/** A batch that runs each question to its end, the way the client's batch hands each its answer. */
const runEach: Batch = <T>(questions: readonly APIRequestGenerator<T>[]): T[] =>
  questions.map((question) => {
    let step = question.next();
    while (step.done !== true) {
      step = question.next();
    }
    return step.value;
  });

/**
 * A checker whose array lookup and contextual lookup panic wherever the run they are
 * asked over holds the node at `poisoned`, as the compiler server does on a type it
 * cannot convert.
 */
function panickingAt(poisoned: number): { checker: Checker; alone: Node[] } {
  const alone: Node[] = [];
  const panicsOn = (nodes: readonly Node[]): void => {
    if (nodes.some((node) => node.pos === poisoned)) {
      throw new Error(PANIC);
    }
  };
  const contextual = (node: Node): Type => {
    panicsOn([node]);
    return typeFor(node);
  };
  // A test fake: only the accessors the cases below ask are present.
  const checker = {
    getSymbolAtLocation: (nodes: readonly Node[]) => {
      panicsOn(nodes);
      return nodes.map(symbolFor);
    },
    getContextualType: Object.assign(
      (node: Node) => {
        alone.push(node);
        return contextual(node);
      },
      { gen: (node: Node) => answered(() => contextual(node)) },
    ),
  } as unknown as Checker;
  return { checker, alone };
}

const NODES = [nodeAt(10), nodeAt(20), nodeAt(30), nodeAt(40), nodeAt(50)];

describe("a guarded question", () => {
  it("answers every location of an array question but the one the server panics on", () => {
    const log = new UnansweredLog();
    const queries = queriesOf(panickingAt(30).checker, "/src/tsconfig.json", runEach, log);

    const answers = queries.symbolsAt(NODES);

    expect(answers.map((answer) => (answer === UNANSWERED ? "unanswered" : answer?.name))).toEqual([
      "at10",
      "at20",
      "unanswered",
      "at40",
      "at50",
    ]);
  });

  it("records each location it could not answer once, by project, accessor and place", () => {
    const log = new UnansweredLog();
    const queries = queriesOf(panickingAt(30).checker, "/src/tsconfig.json", runEach, log);

    queries.symbolsAt(NODES);
    queries.symbolsAt(NODES, 2);

    expect(log.questions).toEqual([
      {
        configFile: "/src/tsconfig.json",
        accessor: "getSymbolAtLocation",
        location: "/src/a.ts:30",
      },
    ]);
  });

  it("answers every single question of one batch but the one that panics, in that batch", () => {
    const log = new UnansweredLog();
    const fake = panickingAt(20);
    const queries = queriesOf(fake.checker, "/src/tsconfig.json", runEach, log);

    const answers = queries.contextualTypes(NODES as unknown as readonly Expression[]);

    expect(answers.map((answer) => (answer === UNANSWERED ? "unanswered" : answer?.id))).toEqual([
      10,
      "unanswered",
      30,
      40,
      50,
    ]);
    expect(fake.alone, "no question is asked again on its own").toEqual([]);
  });

  it("asks a batch the server fails as a whole again one question at a time", () => {
    const log = new UnansweredLog();
    const failing: Batch = () => {
      throw new Error(PANIC);
    };
    const fake = panickingAt(40);
    const queries = queriesOf(fake.checker, "/src/tsconfig.json", failing, log);

    const answers = queries.contextualTypes(NODES as unknown as readonly Expression[]);

    expect(answers.map((answer) => (answer === UNANSWERED ? "unanswered" : answer?.id))).toEqual([
      10,
      20,
      30,
      "unanswered",
      50,
    ]);
    expect(fake.alone.map((node) => node.pos)).toEqual([10, 20, 30, 40, 50]);
  });

  it("lets a failure that is no panic end the run", () => {
    // A test fake: the one accessor asked fails as a closed channel does.
    const closed = {
      getSymbolAtLocation: () => {
        throw new Error("the compiler server closed its channel");
      },
    } as unknown as Checker;
    const queries = queriesOf(closed, "/src/tsconfig.json", runEach, new UnansweredLog());

    expect(() => queries.symbolsAt(NODES)).toThrow("closed its channel");
  });

  it("stops a pass that needs the answer it did not get", () => {
    expect(() => must(UNANSWERED)).toThrow(Unanswerable);
  });
});

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("a question the compiler server panics on", () => {
  it("goes unanswered, and the session answers the next question", () => {
    const root = writeProject({ "src/a.ts": "export const value: string = 'x';\n" });
    roots.push(root);
    const host = nodeHost();
    const engine = openEngine({ collectTiming: false });
    const configFiles = discoverProjects(engine, host, scopeForDir(host, root)).configFiles;

    const { projects, unanswered } = runSession(engine, configFiles, (project) => {
      const file = project.ownSourceFiles().find((one) => one.fileName.endsWith("a.ts"));
      if (file === undefined) {
        throw new Error("the project holds src/a.ts");
      }
      const [module] = project.symbolsAt([project.handle(file)]);
      const table = typeof module === "object" ? project.queries.exportsOf(module) : UNANSWERED;
      const value = table === UNANSWERED ? undefined : table.get("value");
      if (value === undefined) {
        throw new Error("the module exports value");
      }
      // The server asserts that the symbol it is asked to step along is an alias.
      const stepped = project.queries.immediateAliased(value);
      const type = project.queries.typeOfSymbol(value);
      return {
        stepped: stepped === UNANSWERED ? "unanswered" : "answered",
        type:
          type === UNANSWERED || type === undefined ? "none" : project.queries.typeToString(type),
      };
    });

    expect(projects).toEqual([{ stepped: "unanswered", type: "string" }]);
    expect(unanswered.map((one) => [one.configFile, one.accessor])).toEqual([
      [join(root, "tsconfig.json"), "getImmediateAliasedSymbol"],
    ]);
  });
});
