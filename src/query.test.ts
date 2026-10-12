import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SyntaxKind, type Expression, type Node } from "@typescript/native/ast";
import type {
  APIRequestGenerator,
  Checker,
  Signature,
  Symbol as TSSymbol,
  Type,
} from "@typescript/native/sync";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { discoverProjects } from "./discover.ts";
import {
  isAnswered,
  must,
  propertyTables,
  queriesOf,
  Unanswerable,
  UNANSWERED,
  UnansweredLog,
  type Batch,
} from "./query.ts";
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
    expect(log.questions).toEqual([
      {
        configFile: "/src/tsconfig.json",
        accessor: "getContextualType",
        location: "/src/a.ts:20",
      },
    ]);
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

  it("tells an answer, an absent one among them, from a question the checker did not answer", () => {
    expect([isAnswered(UNANSWERED), isAnswered(undefined), isAnswered(0)]).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("lets a failure that is no panic end the run from a single question", () => {
    // A test fake: the one accessor asked fails as a closed channel does.
    const closed = {
      getTypeAtLocation: () => {
        throw new Error("the compiler server closed its channel");
      },
    } as unknown as Checker;
    const log = new UnansweredLog();
    const queries = queriesOf(closed, "/src/tsconfig.json", runEach, log);

    expect(() => queries.typeAt(nodeAt(10))).toThrow("closed its channel");
    expect(log.questions).toEqual([]);
  });

  it("lets a failure that is no panic end the run from one question of a batch", () => {
    // A test fake: the contextual lookup fails as a closed channel does.
    const closed = {
      getContextualType: {
        gen: function* (): APIRequestGenerator<Type> {
          yield* [];
          throw new Error("the compiler server closed its channel");
        },
      },
    } as unknown as Checker;
    const log = new UnansweredLog();
    const queries = queriesOf(closed, "/src/tsconfig.json", runEach, log);

    expect(() => queries.contextualTypes(NODES as unknown as readonly Expression[])).toThrow(
      "closed its channel",
    );
    expect(log.questions).toEqual([]);
  });

  it("lets a batch the server fails with no panic end the run", () => {
    const closed: Batch = () => {
      throw new Error("the compiler server closed its channel");
    };
    const fake = panickingAt(-1);
    const queries = queriesOf(fake.checker, "/src/tsconfig.json", closed, new UnansweredLog());

    expect(() => queries.contextualTypes(NODES as unknown as readonly Expression[])).toThrow(
      "closed its channel",
    );
    expect(fake.alone, "no question is asked again on its own").toEqual([]);
  });
});

describe("questions over many locations", () => {
  it("go out as one round trip per capped run of a batch, each answered once and in order", () => {
    const runs: number[] = [];
    const counting: Batch = (questions) => {
      runs.push(questions.length);
      return runEach(questions);
    };
    const queries = queriesOf(
      panickingAt(-1).checker,
      "/src/tsconfig.json",
      counting,
      new UnansweredLog(),
    );
    const ids = (nodes: readonly Node[], cap: number): unknown[] =>
      queries
        .contextualTypes(nodes as unknown as readonly Expression[], cap)
        .map((answer) => (answer === UNANSWERED ? "unanswered" : answer?.id));

    expect(ids(NODES, 2)).toEqual([10, 20, 30, 40, 50]);
    expect(ids(NODES.slice(0, 4), 2)).toEqual([10, 20, 30, 40]);
    expect(ids([], 2)).toEqual([]);
    expect(runs).toEqual([2, 2, 1, 2, 2]);
  });

  it("go out as one array question per capped run, each answered once and in order", () => {
    const runs: number[][] = [];
    // A test fake: only the array lookup is asked.
    const checker = {
      getSymbolAtLocation: (nodes: readonly Node[]) => {
        runs.push(nodes.map((node) => node.pos));
        return nodes.map(symbolFor);
      },
    } as unknown as Checker;
    const queries = queriesOf(checker, "/src/tsconfig.json", runEach, new UnansweredLog());

    const answers = queries.symbolsAt(NODES, 2);

    expect(answers.map((answer) => (answer === UNANSWERED ? "unanswered" : answer?.name))).toEqual([
      "at10",
      "at20",
      "at30",
      "at40",
      "at50",
    ]);
    expect(runs).toEqual([[10, 20], [30, 40], [50]]);
  });

  it("put each question of a batch through the run's ask, naming its own location", () => {
    const asked: string[] = [];
    const queries = queriesOf(
      panickingAt(-1).checker,
      "/src/tsconfig.json",
      runEach,
      new UnansweredLog(),
      (accessor, locations, question) => {
        asked.push(`${accessor} ${locations().join(" ")}`);
        return question();
      },
    );

    queries.contextualTypes(NODES.slice(0, 2) as unknown as readonly Expression[]);

    expect(asked).toEqual(["getContextualType /src/a.ts:10", "getContextualType /src/a.ts:20"]);
  });
});

describe("the questions a fake checker answers", () => {
  it("resolve an identifier by name, and ask nothing of another node", () => {
    const resolved: number[] = [];
    // A test fake: only the name lookup is asked.
    const checker = {
      getResolvedSymbol: (node: Node) => {
        resolved.push(node.pos);
        return symbolFor(node);
      },
    } as unknown as Checker;
    const queries = queriesOf(checker, "/src/tsconfig.json", runEach, new UnansweredLog());
    // A test fake: the layer reads a node's kind, file and offset.
    const identifier = { ...nodeAt(10), kind: SyntaxKind.Identifier } as unknown as Node;
    const call = { ...nodeAt(20), kind: SyntaxKind.CallExpression } as unknown as Node;

    const answers = [queries.resolvedSymbol(identifier), queries.resolvedSymbol(call)];

    expect(answers.map((answer) => (typeof answer === "object" ? answer.name : answer))).toEqual([
      "at10",
      undefined,
    ]);
    expect(resolved).toEqual([10]);
  });

  it("answer a type that is no union or intersection as its own one constituent", () => {
    const queries = queriesOf({} as Checker, "/src/tsconfig.json", runEach, new UnansweredLog());
    // A test fake: the layer reads only what kind of type it is and its constituents.
    const plain = { id: 1, isUnionType: () => false, isIntersectionType: () => false };
    const parts = [{ id: 2 }, { id: 3 }];
    const union = { id: 4, isUnionType: () => true, getTypes: () => parts };

    expect(queries.constituents(plain as unknown as Type)).toEqual([plain]);
    expect(queries.constituents(union as unknown as Type)).toEqual(parts);
  });

  it("answer no generic signature for a signature that instantiates none, asking nothing", () => {
    const queries = queriesOf({} as Checker, "/src/tsconfig.json", runEach, new UnansweredLog());
    const generic = { id: 1 };
    // A test fake: the layer reads a signature's target and asks for it.
    const instantiated = { id: 2, target: generic, getTarget: () => generic };
    const plain = {
      id: 3,
      target: undefined,
      getTarget: () => {
        throw new Error("asked for the target of a signature without one");
      },
    };

    expect(queries.genericOf(instantiated as unknown as Signature)).toBe(generic);
    expect(queries.genericOf(plain as unknown as Signature)).toBeUndefined();
  });
});

describe("the run's record of unanswered questions", () => {
  it("keeps questions apart that differ in project, accessor or place", () => {
    const log = new UnansweredLog();
    const first = { configFile: "/a/tsconfig.json", accessor: "getSymbol", location: "type 1" };
    const others = [
      { ...first, configFile: "/b/tsconfig.json" },
      { ...first, accessor: "getTypes" },
      { ...first, location: "type 2" },
    ];

    for (const question of [first, ...others, first]) {
      log.note(question);
    }

    expect(log.questions).toEqual([first, ...others]);
  });
});

describe("the property tables", () => {
  it("ask for one type's properties once, an unanswered answer included", () => {
    const asked: number[] = [];
    // A test fake: a type is read by its identity number only.
    const type = (id: number): Type => ({ id }) as unknown as Type;
    const property = { name: "p" } as unknown as TSSymbol;
    const tables = propertyTables({
      propertiesOf: (one) => {
        asked.push(one.id);
        return one.id === 2 ? UNANSWERED : [property];
      },
    });

    const reads = [1, 1, 2, 2].map((id) => tables.of(type(id)));

    expect(reads).toEqual([
      { properties: [property], asked: true },
      { properties: [property], asked: false },
      { properties: UNANSWERED, asked: true },
      { properties: UNANSWERED, asked: false },
    ]);
    expect(asked).toEqual([1, 2]);
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
