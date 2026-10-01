import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { runSweeps, type ConfigurationSweep } from "./analysis.ts";
import { graphOf } from "./graph.ts";
import type { InventorySymbol } from "./inventory.ts";
import type { Reference } from "./references.ts";
import { resolve } from "./resolve.ts";
import type { Root } from "./roots.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine } from "./session.ts";
import { sweep, type Mode, type SweepResult } from "./sweep.ts";

const PRODUCTION: Mode = { production: true };
const PLAIN: Mode = { production: false };

/** The one configuration of a fixture, swept under its own configuration document. */
function sweepFixture(name: string, mode: Mode): ConfigurationSweep {
  const target = fixture("projects", name);
  const document = join(target, "deadset.json");
  const { config } = resolve({
    repository: readFileSync(document, "utf8"),
    repositoryLabel: document,
  });
  const host = nodeHost();
  const [only] = runSweeps(
    openEngine({ collectTiming: false }),
    host,
    scopeForDir(host, target),
    config,
    { marked: [], mode },
  );
  if (only === undefined) {
    throw new Error(`${name} discovered no configuration`);
  }
  return only;
}

/**
 * The fixture holding one instance of each shape the two relations separate, swept once
 * for every case below: opening a compiler client is the expensive part of a run.
 */
const RELATIONS = sweepFixture("relations", PRODUCTION);

/** The verdict on the declaration one stable reference names: the relations holding it live, and its candidacy. */
function verdict(ref: string): string {
  const symbol = RELATIONS.symbols.find((held) => held.ref === `ts://@example/relations/${ref}`);
  if (symbol === undefined) {
    return `no declaration ${ref}`;
  }
  return verdictOf(RELATIONS.sweep, symbol);
}

function verdictOf(result: SweepResult, symbol: InventorySymbol): string {
  const live = (result.liveUnder.get(symbol.id) ?? []).join(",") || "-";
  const candidate = result.candidates.find((held) => held.id === symbol.id);
  const dead =
    candidate === undefined
      ? "live"
      : `${candidate.relation}${candidate.testOfDeadCode ? " test-of-dead-code" : ""}`;
  return `${live}\t${dead}`;
}

/** The golden table: one line per declaration the sweep judges, so a diff names the verdict that moved. */
function goldenText(swept: ConfigurationSweep): string {
  return swept.symbols
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

  it("keeps an entry's export reachable and still a candidate when nothing references it", () => {
    expect(
      verdict("src/main.ts#entryExport"),
      "a manifest entry supposes a consumer, so its root feeds reachability alone",
    ).toBe("reachability\treference-counting");
    expect(verdict("src/main.ts#keptByTheEntryExport"), "and what it references is live").toBe(
      "reference-counting,reachability\tlive",
    );
  });

  it("reaches what a barrel stars, through the namespace the entry imports it as", () => {
    expect(verdict("src/starred.ts#starred"), "reached, and named by nothing").toBe(
      "reachability\treference-counting",
    );
    expect(
      verdict("src/starred.ts#reachedThroughTheStar"),
      "so the declaration only it references is live",
    ).toBe("reference-counting,reachability\tlive");
    expect(verdict("src/grouped.ts#member"), "and what a namespace re-export holds").toBe(
      "reachability\treference-counting",
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
function candidates(result: SweepResult, symbols: readonly InventorySymbol[]): string[] {
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
    const graph = graphOf(symbols, chain, [], []);

    expect(candidates(sweep(graph, { marked: [], mode: PLAIN }), symbols), "unmarked").toEqual([
      "head reference-counting",
      "middle reachability",
      "tail reachability",
    ]);
    expect(
      candidates(sweep(graph, { marked: [head.id], mode: PLAIN }), symbols),
      "the mark is live, and seeds what it references",
    ).toEqual([]);
  });

  it("counts no root under reference counting where the root only supposes a caller", () => {
    const rooted: Root[] = [{ id: head.id, kind: "published-api", source: "" }];
    const called: Root[] = [{ id: head.id, kind: "configured", source: "head" }];

    expect(
      candidates(sweep(graphOf(symbols, chain, rooted, []), { marked: [], mode: PLAIN }), symbols),
      "a published root keeps its closure reachable and is a candidate itself",
    ).toEqual(["head reference-counting"]);
    expect(
      candidates(sweep(graphOf(symbols, chain, called, []), { marked: [], mode: PLAIN }), symbols),
      "a configured root names a caller, so it is live under both",
    ).toEqual([]);
  });

  it("reaches a file's exports through a reference to the file, and not through its root", () => {
    const worker = file("src/worker.ts");
    const exported = { ...declared("exported", 2, "src/worker.ts"), exported: true };
    const helper = declared("helper", 3, "src/worker.ts");
    const user = declared("user", 5);
    const own = [worker, exported, helper];
    const all = [source, user, ...own];
    const rooted: Root[] = [{ id: worker.id, kind: "worker", source: "./worker.ts" }];
    const byItself = graphOf(own, [reference(exported, helper)], rooted, []);
    const namespace: Root[] = [{ id: user.id, kind: "configured", source: "user" }];
    const throughNamespace = graphOf(
      all,
      [reference(exported, helper), reference(user, worker)],
      namespace,
      [],
    );

    expect(
      candidates(sweep(byItself, { marked: [], mode: PLAIN }), own),
      "a file a runtime runs without reading its exports roots its top level alone",
    ).toEqual(["exported reference-counting", "helper reachability"]);
    expect(
      candidates(sweep(throughNamespace, { marked: [], mode: PLAIN }), all),
      "a reference to the file names the module's namespace, which holds its exports",
    ).toEqual(["exported reference-counting"]);
  });

  it("follows a marked test declaration's references in a production sweep", () => {
    const testFile = file("src/a.test.ts");
    const check = declared("check", 2, "src/a.test.ts");
    const all = [testFile, check, ...symbols];
    const graph = graphOf(all, [reference(check, head, true), ...chain], [], ["src/a.test.ts"]);

    expect(
      candidates(sweep(graph, { marked: [check.id], mode: PRODUCTION }), all),
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
    const graph = graphOf(all, references, rooted, ["src/a.test.ts"]);

    expect(
      candidates(sweep(graph, { marked: [], mode: PLAIN }), all),
      "the test file's top level reaches the chain, and nothing references the test",
    ).toEqual(["check reference-counting"]);
    expect(
      candidates(sweep(graph, { marked: [], mode: PRODUCTION }), all),
      "a production sweep counts none of the test file's references, under either relation",
    ).toEqual([
      "check reference-counting",
      "head reference-counting",
      "middle reachability",
      "tail reachability",
    ]);
  });
});
