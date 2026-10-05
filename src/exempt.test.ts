import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { contractDocument, fixture } from "../__test-helpers__/fixtures.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { runSweep, type RunSweep } from "./analysis.ts";
import { ConfigError, defaultConfig } from "./config.ts";
import {
  EXEMPTION_CLASSES,
  isExemptionClass,
  TS_EXEMPTION_CLASSES,
  type TSExemptionClass,
} from "./exempt-classes.ts";
import {
  computeExemptions,
  disabledClasses,
  exemptionsOf,
  retainedIn,
  retainedLines,
  type Detector,
  type DetectorInput,
  type Detectors,
  type Evidence,
} from "./exempt.ts";
import { graphOf } from "./graph.ts";
import type { Inventory, InventorySymbol } from "./inventory.ts";
import { matrixOf, sweepMatrix, type Configured } from "./matrix.ts";
import type { Position } from "./position.ts";
import type { Reference } from "./references.ts";
import { Unanswerable } from "./query.ts";
import { resolve } from "./resolve.ts";
import type { Root } from "./roots.ts";
import { run, type Writer } from "./run.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine } from "./session.ts";
import { sweep, type Exemption, type Liveness, type Mode } from "./sweep.ts";

const PRODUCTION: Mode = { production: true };
const PLAIN: Mode = { production: false };

describe("the class registry", () => {
  const contract = contractDocument("exemptions.json")["exemptions"] as {
    class: string;
    languages: string[];
    confidence: string;
    typescript_visibility?: { private: boolean; private_name: boolean };
  }[];

  it("is the Contract's vocabulary, class for class and in its order", () => {
    expect(EXEMPTION_CLASSES).toStrictEqual(
      contract.map((row) => ({
        class: row.class,
        languages: row.languages,
        confidence: row.confidence,
        ...(row.typescript_visibility === undefined
          ? {}
          : {
              typescriptVisibility: {
                private: row.typescript_visibility.private,
                privateName: row.typescript_visibility.private_name,
              },
            }),
      })),
    );
  });

  it("runs on TypeScript exactly the classes the vocabulary lists for it", () => {
    expect(TS_EXEMPTION_CLASSES).toEqual(
      contract.filter((row) => row.languages.includes("ts")).map((row) => row.class),
    );
  });

  it("holds no class it does not list, so a record of one does not compile", () => {
    expectTypeOf<TSExemptionClass>().toEqualTypeOf<
      | "interface-satisfaction"
      | "enum-group"
      | "generated-file"
      | "template-field"
      | "reflective-lookup"
      | "decorator"
      | "injection-container"
      | "framework-lifecycle"
      | "serialization-contract"
    >();
    // @ts-expect-error a class the vocabulary does not hold
    const unknown: TSExemptionClass = "unknown-class";
    // @ts-expect-error a class that runs on Go only
    const goOnly: TSExemptionClass = "encoding-reflection";

    expect(isExemptionClass(unknown), "a name outside the vocabulary").toBe(false);
    expect(isExemptionClass(goOnly), "a class of the vocabulary another language runs").toBe(true);
  });
});

describe("the per-class disable switch", () => {
  const configured = (disabled: readonly string[]) => ({
    ...defaultConfig(),
    exemptionsDisabled: disabled,
  });

  it("switches off the classes it names, a class another language runs included", () => {
    expect([...disabledClasses(configured(["decorator", "encoding-reflection"]))]).toEqual([
      "decorator",
      "encoding-reflection",
    ]);
  });

  it("refuses a name the vocabulary does not hold as a malformed configuration", () => {
    let refused: unknown;
    try {
      disabledClasses(configured(["decorator", "no-such-class"]));
    } catch (error: unknown) {
      refused = error;
    }

    expect(refused).toBeInstanceOf(ConfigError);
    expect((refused as ConfigError).kind).toBe("malformed");
    expect((refused as ConfigError).key).toBe("exemptions.disabled");
    expect((refused as ConfigError).message).toMatch(
      /^exemptions\.disabled: "no-such-class" is not an exemption class: the classes are interface-satisfaction, /u,
    );
  });
});

/** One record of a class at one site of `src/a.ts`. */
function record(
  id: string,
  exemptionClass: TSExemptionClass,
  detail: string,
  line: number,
  path = "src/a.ts",
): Exemption {
  return { id, class: exemptionClass, detail, site: { path, line, column: 1 } };
}

describe("a detector the checker leaves without an answer", () => {
  /** One declaration of the given kind at its own line of `src/a.ts`. */
  const ofKind = (name: string, kind: InventorySymbol["kind"], line: number): InventorySymbol => ({
    id: `src/a.ts:${String(line)}:1`,
    ref: `ts://@example/memory/src/a.ts#${name}`,
    name,
    kind,
    position: { path: "src/a.ts", line, column: 1 },
    endLine: line,
    parent: "src/a.ts:1:1",
    exported: false,
    visibility: "public",
    static: false,
  });

  it("holds back every declaration of the project its class could hold back", () => {
    const symbols = [
      ofKind("run", "function", 2),
      ofKind("Shape.area", "method", 3),
      ofKind("Shape.label", "class-member", 4),
      ofKind("Color.Red", "enum-member", 5),
    ];
    const stopped: Detector = () => {
      throw new Unanswerable();
    };
    // A test fake: the detector stops before it reads the project, so only the
    // declarations are read.
    const input = { held: { symbols } } as unknown as DetectorInput<never>;

    const held = computeExemptions(input, new Map([["interface-satisfaction", stopped]]), {
      disabled: new Set(),
      mode: PLAIN,
      testFiles: new Set(),
    });

    expect(held.map((one) => `${one.id} ${one.class} ${one.detail}`)).toEqual([
      "src/a.ts:3:1 interface-satisfaction kept live by a question the checker did not answer",
      "src/a.ts:4:1 interface-satisfaction kept live by a question the checker did not answer",
    ]);
  });

  it("holds back every declaration but a file where its class names no kinds", () => {
    const symbols = [
      ofKind("src/a.ts", "file", 1),
      ofKind("run", "function", 2),
      ofKind("Shape.area", "method", 3),
    ];
    const stopped: Detector = () => {
      throw new Unanswerable();
    };
    const input = { held: { symbols } } as unknown as DetectorInput<never>;

    const held = computeExemptions(input, new Map([["decorator", stopped]]), {
      disabled: new Set(),
      mode: PLAIN,
      testFiles: new Set(),
    });

    expect(held.map((one) => one.id)).toEqual(["src/a.ts:2:1", "src/a.ts:3:1"]);
  });

  it("lets any other failure end the run", () => {
    const broken: Detector = () => {
      throw new Error("the compiler server closed its channel");
    };
    const input = { held: { symbols: [] } } as unknown as DetectorInput<never>;

    expect(() =>
      computeExemptions(input, new Map([["enum-group", broken]]), {
        disabled: new Set(),
        mode: PLAIN,
        testFiles: new Set(),
      }),
    ).toThrow("closed its channel");
  });
});

describe("the records a run holds", () => {
  it("keeps one record per declaration, class and detail, the one at the first site", () => {
    const later = record("src/a.ts:2:1", "decorator", "named by @register", 9);
    const earlier = record("src/a.ts:2:1", "decorator", "named by @register", 3, "src/0.ts");

    expect(exemptionsOf([later, earlier])).toEqual([earlier]);
  });

  it("keeps a second detail and a second class of one declaration as records of their own", () => {
    const named = record("src/a.ts:2:1", "decorator", "named by @register", 5);
    const passed = record("src/a.ts:2:1", "serialization-contract", "passed to JSON.stringify", 5);
    const other = record("src/a.ts:2:1", "decorator", "named by @inject", 4);

    expect(exemptionsOf([passed, named, other])).toEqual([other, named, passed]);
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
  return { ...declared(path, 1, path), ref: `ts://@example/memory/${path}#`, kind: "file" };
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

/** The record one class keeps of one in-memory declaration, at the declaration. */
function exemptionOf(symbol: InventorySymbol): Exemption {
  return { id: symbol.id, class: "decorator", detail: "named by @register", site: symbol.position };
}

/** The candidates of one sweep, by name, each with the relation that found it. */
function candidates(result: Liveness, symbols: readonly InventorySymbol[]): string[] {
  return result.candidates.map(
    (candidate) =>
      `${symbols.find((symbol) => symbol.id === candidate.id)?.name ?? candidate.id} ${candidate.relation}`,
  );
}

describe("an exemption entering the sweep", () => {
  const source = file();
  const head = declared("head", 2);
  const middle = declared("middle", 3);
  const tail = declared("tail", 4);
  const symbols = [source, head, middle, tail];
  const graph = graphOf(symbols, [reference(head, middle), reference(middle, tail)], [], []);

  it("is never a candidate, and holds live what it references", () => {
    expect(candidates(sweep(graph, { marked: [], mode: PLAIN }), symbols), "no exemption").toEqual([
      "head reference-counting",
      "middle reachability",
      "tail reachability",
    ]);
    const held = sweep(graph, { marked: [], exempt: [exemptionOf(head)], mode: PLAIN });

    expect(candidates(held, symbols), "the head exempt").toEqual([]);
    expect(held.liveUnder.get(head.id), "nothing references the head").toEqual(["reachability"]);
  });

  it("seeds a production sweep from a test declaration, through the references it makes", () => {
    const test = declared("check", 2, "src/a.test.ts");
    const all = [source, middle, tail, file("src/a.test.ts"), test];
    const tested = graphOf(
      all,
      [reference(test, middle, true), reference(middle, tail)],
      [],
      ["src/a.test.ts"],
    );

    expect(
      candidates(sweep(tested, { marked: [], exempt: [exemptionOf(test)], mode: PRODUCTION }), all),
      "the test is held and admitted as nothing; what only it references is counted on " +
        "its production references alone, and what that references is live",
    ).toEqual(["middle reference-counting"]);
  });
});

/** One project of an in-memory matrix. */
function configured(
  configuration: string,
  symbols: readonly InventorySymbol[],
  references: readonly Reference[] = [],
  roots: readonly Root[] = [],
): Configured {
  return { configuration, symbols, references, roots, testFiles: [] };
}

describe("an exemption across the configurations of a run", () => {
  const shared = file("src/shared.ts");
  const held = declared("held", 2, "src/shared.ts");
  const scripts = file("scripts/build.ts");
  const helper = declared("helper", 2, "scripts/build.ts");

  it("holds in every configuration that holds its declaration, wherever it was found", () => {
    const matrix = matrixOf([
      configured("app", [shared, held]),
      configured("scripts", [shared, held, scripts, helper], [reference(held, helper)]),
    ]);
    const input = { marked: [], exempt: [exemptionOf(held)], mode: PLAIN };

    expect(
      candidates(sweepMatrix(matrix, { marked: [], mode: PLAIN }), matrix.union.symbols),
    ).toEqual(["helper reachability", "held reference-counting"]);
    expect(candidates(sweepMatrix(matrix, input), matrix.union.symbols)).toEqual([]);
    expect(retainedIn(matrix, input), "the run reports it without the record").toEqual([
      exemptionOf(held),
    ]);
  });

  it("holds back in the configuration that would report the declaration, whatever another answers", () => {
    const rooted: Root = { id: held.id, kind: "configured", source: "held" };
    const matrix = matrixOf([
      configured("app", [shared, held], [], [rooted]),
      configured("scripts", [shared, held]),
    ]);

    expect(
      candidates(sweepMatrix(matrix, { marked: [], mode: PLAIN }), matrix.union.symbols),
      "the app holds it live, so the run reports nothing without the record",
    ).toEqual([]);
    expect(
      retainedIn(matrix, { marked: [], exempt: [exemptionOf(held)], mode: PLAIN }),
      "the scripts project alone reports it without the record",
    ).toEqual([exemptionOf(held)]);
  });

  it("holds nothing back where every configuration holds the declaration live anyway", () => {
    const rooted: Root = { id: held.id, kind: "configured", source: "held" };
    const matrix = matrixOf([
      configured("app", [shared, held], [], [rooted]),
      configured("scripts", [shared, held], [], [rooted]),
    ]);

    expect(retainedIn(matrix, { marked: [], exempt: [exemptionOf(held)], mode: PLAIN })).toEqual(
      [],
    );
  });

  it("holds nothing back where a mark holds the declaration, or where the run holds no such declaration", () => {
    const matrix = matrixOf([configured("app", [shared, held])]);
    const elsewhere = exemptionOf(declared("gone", 9, "src/gone.ts"));

    expect(
      retainedIn(matrix, { marked: [held.id], exempt: [exemptionOf(held)], mode: PLAIN }),
      "marked",
    ).toEqual([]);
    expect(retainedIn(matrix, { marked: [], exempt: [elsewhere], mode: PLAIN }), "absent").toEqual(
      [],
    );
  });
});

const TARGET = fixture("projects", "exemptions");
const HELD = "src/held.ts";
const TEST = "src/held.test.ts";

/** The fixture's declaration one file and display name spell. */
function at(held: Inventory, path: string, name: string): InventorySymbol {
  const found = held.symbols.find(
    (symbol) => symbol.position.path === path && symbol.name === name,
  );
  if (found === undefined) {
    throw new Error(`the fixture declares no ${name} in ${path}`);
  }
  return found;
}

function evidence(
  held: Inventory,
  path: string,
  name: string,
  detail: string,
  site?: Position,
): Evidence {
  const symbol = at(held, path, name);
  return { id: symbol.id, detail, site: site ?? symbol.position };
}

/**
 * A detector for each of four classes, standing for the real ones: each names the
 * fixture's declarations by name and records the evidence at a declaration's site.
 */
const DETECTORS: Detectors = new Map<TSExemptionClass, Detector>([
  [
    "decorator",
    ({ held }) => [
      evidence(held, HELD, "heldTwice", "named by @register"),
      evidence(held, HELD, "liveAnyway", "named by @register"),
    ],
  ],
  [
    "serialization-contract",
    ({ held }) => [
      evidence(
        held,
        HELD,
        "heldTwice",
        "passed to JSON.stringify",
        at(held, HELD, "keptByHeld").position,
      ),
      evidence(held, HELD, "heldTwice", "passed to JSON.stringify"),
    ],
  ],
  [
    "framework-lifecycle",
    ({ held }) => [evidence(held, TEST, "heldInATest", "named by the runner")],
  ],
  [
    "reflective-lookup",
    ({ held }) => [evidence(held, HELD, "heldByDisabled", "looked up by Reflect.get")],
  ],
]);

/** One fixture, swept under its own configuration with one detector table. */
function sweepFixture(mode: Mode, target = TARGET, detectors = DETECTORS): RunSweep {
  const document = join(target, "deadset.json");
  const { config } = resolve({
    repository: readFileSync(document, "utf8"),
    repositoryLabel: document,
  });
  const host = nodeHost();
  return runSweep(
    openEngine({ collectTiming: false }),
    host,
    scopeForDir(host, target),
    config,
    { marked: [], mode },
    detectors,
  );
}

/** The display names of the candidates of one run's sweep. */
function deadNames(run: RunSweep): string[] {
  return run.sweep.candidates.map(
    (candidate) =>
      run.matrix.union.symbols.find((symbol) => symbol.id === candidate.id)?.name ?? "",
  );
}

/** The display name and class of each retained record of one run. */
function retainedNames(run: RunSweep): string[] {
  return run.retained.map(
    (held) =>
      `${run.matrix.union.symbols.find((symbol) => symbol.id === held.id)?.name ?? ""} ${held.class}`,
  );
}

describe("the framework over a project", () => {
  const production = sweepFixture(PRODUCTION);
  const plain = sweepFixture(PLAIN);

  it("lists every held-back declaration with its classes, and not the declaration a reference holds live", async () => {
    expect(retainedNames(production)).toEqual([
      "heldTwice decorator",
      "heldTwice serialization-contract",
    ]);
    await expect(
      `${retainedLines(production.matrix.union.symbols, production.retained).join("\n")}\n`,
      "regenerate with `npx vitest --run -u src/exempt.test.ts` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "exemptions.retained.txt"));
  });

  it("reports no candidate an exemption holds back, so no finding is built with a retained_by", () => {
    const retainedBy = (id: string): string[] =>
      production.retained.filter((held) => held.id === id).map((held) => held.class);

    expect(production.retained.length, "the run holds something back").toBeGreaterThan(0);
    expect(production.sweep.candidates.flatMap((candidate) => retainedBy(candidate.id))).toEqual(
      [],
    );
  });

  it("holds live what a held-back declaration references, and lists it nowhere", () => {
    expect(deadNames(production)).not.toContain("keptByHeld");
    expect(retainedNames(production).some((name) => name.startsWith("keptByHeld"))).toBe(false);
  });

  it("drops the records of a class the configuration switches off", () => {
    expect(deadNames(production), "production").toContain("heldByDisabled");
    expect(deadNames(plain), "plain").toContain("heldByDisabled");
  });

  it("holds evidence written in a test file under the plain mode alone", () => {
    expect(deadNames(production), "production").toEqual(["heldInATest", "heldByDisabled"]);
    expect(deadNames(plain), "plain").toEqual(["heldByDisabled"]);
    expect(retainedNames(plain), "plain").toEqual([
      "heldInATest framework-lifecycle",
      "heldTwice decorator",
      "heldTwice serialization-contract",
    ]);
  });
});

describe("the private members a class may retain", () => {
  const visibility = fixture("projects", "member-visibility");
  const MEMBERS = "src/held.ts";
  const allThree = (detail: string): Detector => {
    const named = (held: Inventory, name: string): Evidence =>
      evidence(held, MEMBERS, name, detail);
    return ({ held }) => [
      named(held, "Held.visible"),
      named(held, "Held.hidden"),
      named(held, "Held.#named"),
    ];
  };
  const swept = sweepFixture(
    PRODUCTION,
    visibility,
    new Map<TSExemptionClass, Detector>([
      ["interface-satisfaction", allThree("satisfies Shape")],
      ["decorator", allThree("named by @register")],
    ]),
  );

  it("drops evidence on a private member under a class that retains neither kind, and on a private name under every class", () => {
    expect(retainedNames(swept)).toEqual([
      "Held.visible decorator",
      "Held.visible interface-satisfaction",
      "Held.hidden decorator",
    ]);
    expect(deadNames(swept)).toEqual(["Held.#named"]);
  });
});

describe("the framework over the projects of a run", () => {
  it("holds a record one project found in every project, and retains it once", () => {
    const shared = "src/shared.ts";
    const appOnly: Detectors = new Map<TSExemptionClass, Detector>([
      [
        "decorator",
        ({ held }) =>
          held.configFile.endsWith("/tsconfig.json")
            ? [evidence(held, shared, "deadCaller", "named by @register")]
            : [],
      ],
    ]);
    const swept = sweepFixture(PLAIN, fixture("projects", "two-configurations"), appOnly);

    expect(swept.matrix.configurations, "the scripts project is swept first").toEqual([
      "scripts",
      "app",
    ]);
    expect(deadNames(swept)).toEqual(["appOnlyDead", "deadEverywhere"]);
    expect(retainedNames(swept)).toEqual(["deadCaller decorator"]);
  });
});

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

describe("print-retained", () => {
  it("prints nothing and exits 0 where no class this analyzer detects holds a declaration back", () => {
    const out = new MemoryWriter();
    const err = new MemoryWriter();

    expect(run(["print-retained", `--target=${TARGET}`], out, err, nodeHost())).toBe(0);
    expect({ out: out.text, err: err.text }).toEqual({ out: "", err: "" });
  });

  it("refuses a switched-off class the vocabulary does not hold and exits 2", () => {
    const root = writeProject({
      "deadset.json": `${JSON.stringify({
        target: { kind: "application" },
        exemptions: { disabled: ["no-such-class"] },
      })}\n`,
      "src/main.ts": "export const main: number = 1;\n",
    });
    const out = new MemoryWriter();
    const err = new MemoryWriter();
    try {
      expect(run(["print-retained", `--target=${root}`], out, err, nodeHost())).toBe(2);
      expect(out.text).toBe("");
      expect(err.text.split("\n")[0]).toBe(
        'deadset-ts: exemptions.disabled: "no-such-class" is not an exemption class: the classes are ' +
          EXEMPTION_CLASSES.map((row) => row.class).join(", "),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
