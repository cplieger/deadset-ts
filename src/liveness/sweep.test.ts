import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { matrixFor, policyOf } from "../../__test-helpers__/sweep.ts";
import { nodeHost } from "../../bin/node-host.ts";
import { fixture } from "../../__test-helpers__/fixtures.ts";
import { runSweep, type RunSweep } from "../analysis.ts";
import type { Exemption } from "../exemptions/lifecycle.ts";
import type { InventorySymbol } from "../inventory.ts";
import type { Reference } from "../references.ts";
import { resolve } from "../resolve.ts";
import type { Root } from "../roots/root-set.ts";
import { scopeForDir } from "../scope.ts";
import { openEngine } from "../session.ts";
import { reachedWithTheTests, sweep, type Sweep } from "./sweep.ts";
import type { Mode } from "../tests/file-class.ts";

const PRODUCTION: Mode = { production: true };
const PLAIN: Mode = { production: false };

/** One fixture, swept under its own configuration document. */
function sweepFixture(name: string, mode: Mode): RunSweep {
  const target = fixture("projects", name);
  const document = join(target, "deadset.json");
  const { config } = resolve({
    repository: { text: readFileSync(document, "utf8"), label: document },
  });
  const host = nodeHost();
  return runSweep(openEngine({ collectTiming: false }), host, scopeForDir(host, target), config, {
    marked: [],
    mode,
  });
}

/**
 * The fixture holding one instance of each shape the two relations separate, swept once
 * for every case below: opening a compiler client is the expensive part of a run.
 */
const RELATIONS = sweepFixture("relations", PRODUCTION);

/** The verdict on the declaration one stable reference names: the relations holding it live, and its candidacy. */
function verdict(ref: string): string {
  const symbol = RELATIONS.matrix.union.symbols.find(
    (held) => held.ref === `ts://@example/relations/${ref}`,
  );
  if (symbol === undefined) {
    return `no declaration ${ref}`;
  }
  return verdictOf(RELATIONS.sweep, symbol);
}

function verdictOf(
  result: Pick<Sweep, "liveUnder" | "candidates">,
  symbol: InventorySymbol,
): string {
  const live = (result.liveUnder.get(symbol.id) ?? []).join(",") || "-";
  const candidate = result.candidates.find((held) => held.id === symbol.id);
  const dead =
    candidate === undefined
      ? "live"
      : `${candidate.relation}${candidate.testOfDeadCode ? " test-of-dead-code" : ""}`;
  return `${live}\t${dead}`;
}

/** The golden table: one line per declaration the sweep judges, so a diff names the verdict that moved. */
function goldenText(swept: RunSweep): string {
  return swept.matrix.union.symbols
    .filter((symbol) => symbol.kind !== "file")
    .map((symbol) => `${symbol.ref}\t${verdictOf(swept.sweep, symbol)}\n`)
    .join("");
}

describe("the two relations over one project", () => {
  it("is the committed golden table, verdict for verdict", async () => {
    await expect(
      goldenText(RELATIONS),
      "the table is produced by the production path; to record a reviewed change run " +
        "`npx vitest --run -u src/sweep.test.ts` and read the diff as production code",
    ).toMatchFileSnapshot(fixture("golden", "relations.sweep.txt"));
  });

  it("holds a declaration only a dead one references live under reference counting alone", () => {
    expect(verdict("src/chain.ts#chainHead"), "nothing references the head").toBe(
      "-\treference-counting",
    );
    expect(
      [verdict("src/chain.ts#chainMiddle"), verdict("src/chain.ts#chainTail")],
      "each below it is referenced, and no root reaches it",
    ).toEqual(["reference-counting\treachability", "reference-counting\treachability"]);
    expect(verdict("src/chain.ts#liveHelper"), "while the chain the entry reaches is live").toBe(
      "reference-counting,reachability\tlive",
    );
  });

  it("counts a recursive declaration's call to itself, so reachability is what finds it", () => {
    expect(verdict("src/recursive.ts#recurse")).toBe("reference-counting\treachability");
  });

  it("holds an entry's export live under both relations when nothing references it", () => {
    expect(
      verdict("src/main.ts#entryExport"),
      "a manifest entry names a caller, so its root counts under reference counting too",
    ).toBe("reference-counting,reachability\tlive");
    expect(verdict("src/main.ts#keptByTheEntryExport"), "and what it references is live").toBe(
      "reference-counting,reachability\tlive",
    );
  });

  it("reaches nothing a barrel's star or namespace re-export holds through a member read of the namespace the entry imports it as", () => {
    expect(
      verdict("src/starred.ts#starred"),
      "a member read by name reaches only the export it names, and a re-export nothing " +
        "unseen uses is no use by itself (references-ts.4)",
    ).toBe("-\treference-counting");
    expect(
      verdict("src/starred.ts#reachedThroughTheStar"),
      "so the declaration only it references is referenced and unreached",
    ).toBe("reference-counting\treachability");
    expect(verdict("src/grouped.ts#member"), "and so is what a namespace re-export holds").toBe(
      "-\treference-counting",
    );
  });

  it("follows a chain of re-exports one link at a time from the re-export nothing imports", () => {
    expect(
      [
        verdict("src/front.ts#unrelayed:alias"),
        verdict("src/relay.ts#unrelayed:alias"),
        verdict("src/impl.ts#unrelayed"),
      ],
      "the first link is unreferenced, and each later one is referenced by the link before it",
    ).toEqual([
      "-\treference-counting",
      "reference-counting\treachability",
      "reference-counting\treachability",
    ]);
    expect(
      [verdict("src/impl.ts#listed:alias"), verdict("src/impl.ts#listed")],
      "a local declaration a specifier exports is referenced by the specifier",
    ).toEqual(["-\treference-counting", "reference-counting\treachability"]);
  });
});

/** The fixture whose modules are imported for what their top levels do, swept once. */
const EVALUATION = sweepFixture("evaluation", PRODUCTION);

/** The verdict on one declaration of the evaluation fixture. */
function evaluated(ref: string): string {
  const symbol = EVALUATION.matrix.union.symbols.find(
    (held) => held.ref === `ts://@example/evaluation/${ref}`,
  );
  return symbol === undefined ? `no declaration ${ref}` : verdictOf(EVALUATION.sweep, symbol);
}

describe("a module's evaluation", () => {
  it("runs the top level of a module the entry imports one binding from", () => {
    expect(
      [evaluated("src/b.ts#helper"), evaluated("src/b.ts#registry")],
      "the binding references neither, and the module's top level references both",
    ).toEqual(["reference-counting,reachability\tlive", "reference-counting,reachability\tlive"]);
  });

  it("runs the top level of the dependency of a module imported for its evaluation alone", () => {
    expect(evaluated("src/d.ts#sideEffect")).toBe("reference-counting,reachability\tlive");
  });

  it("runs the top level of a module a literal import() or an import-equals loads", () => {
    expect(
      [evaluated("src/lazy.ts#lazyEffect"), evaluated("src/loaded.cts#loadedEffect")],
      "the function holding the call is reached, and so is the declaration holding the " +
        "import-equals, while the one function reading the import is called by nothing",
    ).toEqual(["reference-counting,reachability\tlive", "reference-counting,reachability\tlive"]);
  });

  it("reaches none of what an evaluated module exports", () => {
    expect(
      evaluated("src/b.ts#unimported"),
      "an evaluation runs the top level and reads no export, so the export nothing " +
        "imports is unreached",
    ).toBe("-\treference-counting");
    expect(
      [evaluated("src/spaced.ts#read"), evaluated("src/spaced.ts#unread")],
      "and a namespace import's member read reaches only the export it names (references-ts.4)",
    ).toEqual(["reference-counting,reachability\tlive", "-\treference-counting"]);
  });
});

/** One declaration of an in-memory graph, a function at its own line of one file. */
function declared(name: string, line: number, path = "src/a.ts"): InventorySymbol {
  return {
    id: `${path}:${String(line)}:1`,
    ref: `ts://@example/memory/${path}#${name}`,
    name,
    kind: "function",
    position: { path, line, column: 1 },
    endLine: line,
    parent: `${path}:1:1`,
    exported: false,
    visibility: "public",
    static: false,
  };
}

/** The file node one in-memory declaration belongs to. */
function file(path = "src/a.ts"): InventorySymbol {
  return {
    id: `${path}:1:1`,
    ref: `ts://@example/memory/${path}#`,
    name: path,
    kind: "file",
    position: { path, line: 1, column: 1 },
    endLine: 100,
    parent: "",
    exported: false,
    visibility: "public",
    static: false,
  };
}

/** One reference between two in-memory declarations. */
function reference(from: InventorySymbol, to: InventorySymbol, test = false): Reference {
  return {
    from: from.id,
    to: to.id,
    position: from.position,
    use: "read",
    resolution: "batch",
    test,
  };
}

/** The candidates of one sweep, by name, each with the relation that found it. */
function candidates(
  result: Pick<Sweep, "candidates">,
  symbols: readonly InventorySymbol[],
): string[] {
  return result.candidates.map(
    (candidate) =>
      `${symbols.find((symbol) => symbol.id === candidate.id)?.name ?? candidate.id} ${candidate.relation}`,
  );
}

describe("the sweep over an in-memory graph", () => {
  const source = file();
  const head = declared("head", 2);
  const middle = declared("middle", 3);
  const tail = declared("tail", 4);
  const symbols = [source, head, middle, tail];
  const chain = [reference(head, middle), reference(middle, tail)];

  it("holds a marked declaration and everything only it references live under both relations", () => {
    const graph = matrixFor(symbols, chain, [], []);

    expect(
      candidates(sweep(graph, policyOf({ marked: [], mode: PLAIN })), symbols),
      "unmarked",
    ).toEqual(["head reference-counting", "middle reachability", "tail reachability"]);
    expect(
      candidates(sweep(graph, policyOf({ marked: [head.id], mode: PLAIN })), symbols),
      "the mark is live, and seeds what it references",
    ).toEqual([]);
  });

  it("counts no root under reference counting where the root only supposes a caller", () => {
    const rooted: Root[] = [{ id: head.id, kind: "published-api", source: "" }];
    const called: Root[] = [{ id: head.id, kind: "configured", source: "head" }];

    expect(
      candidates(
        sweep(matrixFor(symbols, chain, rooted, []), policyOf({ marked: [], mode: PLAIN })),
        symbols,
      ),
      "a published root keeps its closure reachable and is a candidate itself",
    ).toEqual(["head reference-counting"]);
    expect(
      candidates(
        sweep(matrixFor(symbols, chain, called, []), policyOf({ marked: [], mode: PLAIN })),
        symbols,
      ),
      "a configured root names a caller, so it is live under both",
    ).toEqual([]);
  });

  it("seeds from a consumer's test reference where the configuration counts its tests as production, and from no unheld test file's", () => {
    const mode: Mode = { production: true, consumerTestsProduction: true };
    const caller = declared("caller", 9, "test/outside.test.ts");
    const unheld = matrixFor(
      symbols,
      [...chain, { ...reference(caller, head, true), unheld: true }],
      [],
      [],
    );
    const consumer = matrixFor(
      symbols,
      [...chain, { ...reference(caller, head, true), consumer: "@example/consumer" }],
      [],
      [],
    );

    expect(
      candidates(sweep(unheld, policyOf({ marked: [], mode })), symbols),
      "an unheld test file is test code in every production mode",
    ).toEqual(["head reference-counting", "middle reachability", "tail reachability"]);
    expect(candidates(sweep(consumer, policyOf({ marked: [], mode })), symbols)).toEqual([]);
  });

  it("holds a marked file's top level and reaches none of what it exports", () => {
    const worker = file("src/worker.ts");
    const exported = { ...declared("exported", 2, "src/worker.ts"), exported: true };
    const helper = declared("helper", 3, "src/worker.ts");
    const own = [worker, exported, helper];
    const graph = matrixFor(own, [reference(exported, helper)], [], []);

    expect(candidates(sweep(graph, policyOf({ marked: [worker.id], mode: PLAIN })), own)).toEqual([
      "exported reference-counting",
      "helper reachability",
    ]);
  });

  it("reaches a file's exports through a reference to the file, and not through its root", () => {
    const worker = file("src/worker.ts");
    const exported = { ...declared("exported", 2, "src/worker.ts"), exported: true };
    const helper = declared("helper", 3, "src/worker.ts");
    const user = declared("user", 5);
    const own = [worker, exported, helper];
    const all = [source, user, ...own];
    const rooted: Root[] = [{ id: worker.id, kind: "test-runner", source: "**/*.test.ts" }];
    const byItself = matrixFor(own, [reference(exported, helper)], rooted, []);
    const namespace: Root[] = [{ id: user.id, kind: "configured", source: "user" }];
    const throughNamespace = matrixFor(
      all,
      [reference(exported, helper), reference(user, worker)],
      namespace,
      [],
    );

    expect(
      candidates(sweep(byItself, policyOf({ marked: [], mode: PLAIN })), own),
      "a file a runtime runs without reading its exports roots its top level alone",
    ).toEqual(["exported reference-counting", "helper reachability"]);
    expect(
      candidates(sweep(throughNamespace, policyOf({ marked: [], mode: PLAIN })), all),
      "a reference to the file names the module's namespace, which holds its exports",
    ).toEqual(["exported reference-counting"]);
  });

  it("reaches only the export a judged read of a namespace object names, and every export a read no rule judged, a used re-export or a whole read of a namespace passes on", () => {
    const worker = file("src/worker.ts");
    const named = { ...declared("named", 2, "src/worker.ts"), exported: true };
    const other = { ...declared("other", 3, "src/worker.ts"), exported: true };
    const space = {
      ...declared("Space", 4, "src/worker.ts"),
      kind: "namespace" as const,
      exported: true,
    };
    const member = { ...declared("member", 5, "src/worker.ts"), parent: space.id, exported: true };
    const held = { ...declared("held", 6, "src/worker.ts"), parent: space.id, exported: true };
    const barrel = file("src/barrel.ts");
    const holdsFrom = file("src/held.ts");
    const user = declared("user", 5);
    const dead = declared("dead", 6);
    const all = [source, user, dead, worker, named, other, space, member, held, barrel, holdsFrom];
    const ROOT: Root[] = [{ id: user.id, kind: "configured", source: "user" }];
    // What only `dead` references is live under reference counting, so a reachability
    // candidate among them is one no read from the root reaches.
    // `held` passes a namespace object on, as an alias declaration does.
    const fromDead = [
      reference(dead, other),
      reference(dead, member),
      reference(dead, held),
      { ...reference(held, holdsFrom), namespace: true as const, reexport: true as const },
    ];
    const swept = (
      references: readonly Reference[],
      roots: readonly Root[] = ROOT,
      held: { readonly marked?: readonly string[]; readonly exempt?: readonly Exemption[] } = {},
    ): string[] =>
      candidates(
        sweep(
          matrixFor(all, [...fromDead, ...references], roots, []),
          policyOf({ marked: [], mode: PLAIN, ...held }),
        ),
        all,
      ).filter((one) => !one.startsWith("dead ") && !one.startsWith("named "));
    const judged = { ...reference(user, worker), namespace: true as const };
    const passes = {
      ...reference(barrel, worker),
      namespace: true as const,
      reexport: true as const,
    };

    expect(
      swept([judged, reference(user, named)]),
      "a member read by name reaches only that export (references-ts.4)",
    ).toEqual([
      "other reachability",
      "Space reference-counting",
      "member reachability",
      "held reachability",
    ]);
    expect(
      swept([reference(user, worker)]),
      "a use no rule judges reads every export, and a namespace's whole read every member (.5)",
    ).toEqual(["Space reference-counting"]);
    expect(
      swept([{ ...reference(user, barrel), namespace: true as const }, passes]),
      "a re-export nothing unseen uses passes nothing on (.4)",
    ).toEqual([
      "other reachability",
      "Space reference-counting",
      "member reachability",
      "held reachability",
    ]);
    expect(
      swept([passes], [{ id: barrel.id, kind: "configured", source: "barrel" }]),
      "and a root's re-export every export, under both relations, its callers being unseen",
    ).toEqual(["user reference-counting"]);
    const record: Exemption = {
      id: barrel.id,
      class: "decorator",
      detail: "named by @register",
      site: barrel.position,
    };
    for (const [label, held] of [
      ["a suppression mark", { marked: [barrel.id] }],
      ["an exemption record", { exempt: [record] }],
    ] as const) {
      expect(
        swept([passes], ROOT, held),
        `${label} on a re-export reads whole what it passes on, which reference counting leaves to the references (.4)`,
      ).toEqual(["Space reference-counting"]);
    }
    expect(
      swept([judged, reference(user, space)]),
      "a namespace read whole reaches every member it exports",
    ).toEqual(["other reachability"]);
    expect(
      swept([
        judged,
        { ...reference(user, space), namespace: true as const },
        reference(user, member),
      ]),
      "and a member read by name only that member",
    ).toEqual(["other reachability", "held reachability"]);
  });

  it("follows a marked test declaration's references in a production sweep", () => {
    const testFile = file("src/a.test.ts");
    const check = declared("check", 2, "src/a.test.ts");
    const all = [testFile, check, ...symbols];
    const graph = matrixFor(all, [reference(check, head, true), ...chain], [], ["src/a.test.ts"]);

    expect(
      candidates(sweep(graph, policyOf({ marked: [check.id], mode: PRODUCTION })), all),
      "what the mark reaches is live, while a declaration only it references is counted " +
        "on its production references alone",
    ).toEqual(["head reference-counting"]);
  });

  it("drops a test file's references from a production sweep alone", () => {
    const testFile = file("src/a.test.ts");
    const check = declared("check", 2, "src/a.test.ts");
    const all = [testFile, check, ...symbols];
    const references = [reference(testFile, head, true), reference(check, middle, true), ...chain];
    const rooted: Root[] = [{ id: testFile.id, kind: "test-runner", source: "**/*.test.ts" }];
    const graph = matrixFor(all, references, rooted, ["src/a.test.ts"]);

    expect(
      candidates(sweep(graph, policyOf({ marked: [], mode: PLAIN })), all),
      "the test file's top level reaches the chain, and nothing references the test",
    ).toEqual(["check reference-counting"]);
    expect(
      candidates(sweep(graph, policyOf({ marked: [], mode: PRODUCTION })), all),
      "a production sweep counts none of the test file's references, under either relation",
    ).toEqual([
      "check reference-counting",
      "head reference-counting",
      "middle reachability",
      "tail reachability",
    ]);
  });
});

describe("the relations an in-memory graph holds live", () => {
  it("hold no entry for a declaration neither relation holds live", () => {
    const source = file();
    const [head, middle, tail] = [declared("head", 2), declared("middle", 3), declared("tail", 4)];
    const graph = matrixFor(
      [source, head, middle, tail],
      [reference(head, middle), reference(middle, tail)],
      [],
      [],
    );

    expect([...sweep(graph, policyOf({ marked: [], mode: PLAIN })).liveUnder.keys()]).toEqual([
      middle.id,
      tail.id,
    ]);
  });
});

describe("what a run counting test references reaches", () => {
  it("is what a test file's top level and the functions it exports reference, and nothing else", () => {
    const source = file();
    const exportedProduction = { ...declared("exportedProduction", 2), exported: true };
    const usedByTopLevel = declared("usedByTopLevel", 3);
    const usedByCheck = declared("usedByCheck", 4);
    const testFile = file("src/a.test.ts");
    const check = { ...declared("check", 2, "src/a.test.ts"), exported: true };
    const local = declared("local", 3, "src/a.test.ts");
    const suite: InventorySymbol = {
      ...declared("suite", 4, "src/a.test.ts"),
      kind: "namespace",
      exported: true,
    };
    const inner = { ...declared("inner", 5, "src/a.test.ts"), exported: true, parent: suite.id };
    const all = [
      source,
      exportedProduction,
      usedByTopLevel,
      usedByCheck,
      testFile,
      check,
      local,
      suite,
      inner,
    ];
    const graph = matrixFor(
      all,
      [reference(testFile, usedByTopLevel, true), reference(check, usedByCheck, true)],
      [],
      ["src/a.test.ts"],
    );

    const reached = reachedWithTheTests(graph.union, []);

    expect(
      graph.union.symbols.filter((_symbol, at) => reached[at] === true).map((one) => one.name),
    ).toEqual(["src/a.test.ts", "check", "usedByTopLevel", "usedByCheck"]);
  });
});

describe("the tests of dead code", () => {
  it("admit test and test-support code whose production targets are all dead, and no test sharing support with a live one", () => {
    const inTest = (name: string, line: number): InventorySymbol =>
      declared(name, line, "src/a.test.ts");
    const inSupport = (name: string, line: number): InventorySymbol =>
      declared(name, line, "src/support.ts");
    const source = file();
    const dead = declared("dead", 2);
    const live = declared("live", 3);
    const onlyDead = inTest("onlyDead", 2);
    const liveAndDead = inTest("liveAndDead", 3);
    const liveAndShared = inTest("liveAndShared", 4);
    const sharedAndDead = inTest("sharedAndDead", 5);
    const deadAndFile = inTest("deadAndFile", 6);
    const supportOfDead = inSupport("supportOfDead", 2);
    const shared = inSupport("shared", 3);
    const all = [
      source,
      dead,
      live,
      file("src/a.test.ts"),
      onlyDead,
      liveAndDead,
      liveAndShared,
      sharedAndDead,
      deadAndFile,
      file("src/support.ts"),
      supportOfDead,
      shared,
    ];
    const graph = matrixFor(
      all,
      [
        reference(onlyDead, dead, true),
        reference(liveAndDead, live, true),
        reference(liveAndDead, dead, true),
        reference(liveAndShared, live, true),
        reference(liveAndShared, shared, true),
        reference(sharedAndDead, shared, true),
        reference(sharedAndDead, dead, true),
        reference(deadAndFile, dead, true),
        reference(deadAndFile, source, true),
        reference(supportOfDead, dead, true),
      ],
      [{ id: live.id, kind: "configured", source: "live" }],
      ["src/a.test.ts"],
      ["src/support.ts"],
    );

    const admitted = sweep(graph, policyOf({ marked: [], mode: PRODUCTION })).candidates.filter(
      (candidate) => candidate.testOfDeadCode,
    );

    expect(admitted.map((candidate) => all.find((one) => one.id === candidate.id)?.name)).toEqual([
      "onlyDead",
      "deadAndFile",
      "supportOfDead",
    ]);
  });
});
