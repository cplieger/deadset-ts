import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { emitterInputOf, findingsOf as reportedOf } from "../../__test-helpers__/emitter-input.ts";
import { fixture } from "../../__test-helpers__/fixtures.ts";
import { writeProject } from "../../__test-helpers__/projects.ts";
import type { Config } from "../config.ts";
import type { CompletedFinding } from "../finding.ts";
import { resolve } from "../resolve.ts";
import { run, type Writer } from "../run.ts";
import type { Mode } from "../sweep.ts";
import type { EmitterInput } from "./emitter.ts";

const TARGET = fixture("projects", "reads-and-writes");
const PRODUCTION: Mode = { production: true };

/** The configuration a document resolves to. */
function configOf(document: string): Config {
  return resolve({ repository: document, repositoryLabel: "deadset.json" }).config;
}

/** The run's reported findings of the reads-and-writes family, completed and dialed. */
function emitted(input: EmitterInput): readonly CompletedFinding[] {
  return reportedOf(input).filter((finding) => finding.code.startsWith("DS13"));
}

/** One target's findings, swept and emitted under one configuration document. */
function findingsOf(
  target: string,
  document: string,
  mode = PRODUCTION,
): readonly CompletedFinding[] {
  const config = configOf(document);
  return emitted(emitterInputOf(target, config, { mode }));
}

/** The fixture's own configuration document, with `extra` merged over its top level. */
function fixtureDocument(extra: Record<string, unknown> = {}): string {
  const own = JSON.parse(readFileSync(join(TARGET, "deadset.json"), "utf8")) as Record<
    string,
    unknown
  >;
  return JSON.stringify({ ...own, ...extra });
}

/** One finding as a line: where, what, the claim, the component, the dials and the writes. */
function line(finding: CompletedFinding): string {
  const { path, line: at, column, endLine } = finding.position;
  const component = `${finding.component.id} root=${String(finding.component.root)} symbols=${String(finding.component.symbolCount)} lines=${String(finding.component.deletableLines)}`;
  const writes = (finding.details.writePositions ?? [])
    .map((write) => `${write.path}:${String(write.line)}:${String(write.column)}`)
    .join(" ");
  return [
    `${path}:${String(at)}:${String(column)}-${String(endLine)}`,
    finding.code,
    finding.symbol.kind,
    finding.symbol.name,
    finding.symbol.ref,
    `${finding.reachabilityClass}/${finding.confidence}`,
    finding.livenessRelation ?? "-",
    `test_only=${String(finding.testOnly)}`,
    component,
    finding.configurations.join(","),
    finding.severity,
    writes === "" ? "-" : writes,
    finding.message,
  ].join("\t");
}

/** Each finding's code and display name. */
function named(findings: readonly CompletedFinding[]): string[] {
  return findings.map((finding) => `${finding.code} ${finding.symbol.name}`);
}

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

describe("the reads-and-writes emitter", () => {
  const fixtureFindings = (): readonly CompletedFinding[] => findingsOf(TARGET, fixtureDocument());

  it("reports each write-only symbol, enum member and type parameter of the fixture, as the golden records", async () => {
    await expect(
      `${fixtureFindings().map(line).join("\n")}\n`,
      "regenerate with `npx vitest --run -u src/findings/reads-and-writes.test.ts` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "reads-and-writes.findings.txt"));
  });

  it("names every position a write-only symbol is written at, and reports no relation for it", () => {
    const writeOnly = fixtureFindings().filter((finding) => finding.code === "DS1301");

    expect(
      writeOnly.map((finding) => [
        finding.symbol.name,
        (finding.details.writePositions ?? []).map(
          (write) => `${String(write.line)}:${String(write.column)}`,
        ),
        finding.livenessRelation,
      ]),
    ).toEqual([
      ["written", ["15:3", "16:3"], undefined],
      ["shared", ["11:3"], undefined],
      ["Gauge.#samples", ["30:10", "38:10", "43:10"], undefined],
      ["slots", ["55:3"], undefined],
    ]);
  });

  it("reports a module-level collection an element access stores into and nothing reads", () => {
    expect(named(fixtureFindings())).toContain("DS1301 slots");
  });

  it("reports no state something reads, no setter and no member an exemption record names", () => {
    const reported = named(fixtureFindings());

    expect(reported).not.toContain("DS1301 counted");
    expect(reported).not.toContain("DS1301 Gauge.label");
    expect(reported).not.toContain("DS1301 Gauge.level");
    expect(reported).not.toContain("DS1301 Gauge.hidden");
  });

  it("reports the enum member nothing names and none of an enum a conversion produces or a dead enum holds", () => {
    expect(named(fixtureFindings().filter((finding) => finding.code === "DS1302"))).toEqual([
      "DS1302 Mode.Write",
    ]);
  });

  it("reports the type parameters of functions and methods nothing names, and none of a type declaration", () => {
    const unused = fixtureFindings().filter((finding) => finding.code === "DS1303");

    expect(named(unused)).toEqual(["DS1303 first<T>", "DS1303 Box.open<V>"]);
    expect(unused.map((finding) => finding.confidence)).toEqual(["certain", "certain"]);
  });

  it("counts a read from a test file as a read outside production mode", () => {
    const counted = findingsOf(TARGET, fixtureDocument(), { production: false });

    expect(named(counted.filter((finding) => finding.code === "DS1301"))).toEqual([
      "DS1301 written",
      "DS1301 Gauge.#samples",
      "DS1301 slots",
    ]);
  });

  it("reports every member of each enum a conversion produces once the enum-group class is off", () => {
    const unexempt = findingsOf(
      TARGET,
      fixtureDocument({ exemptions: { disabled: ["enum-group"] } }),
    );

    expect(named(unexempt.filter((finding) => finding.code === "DS1302"))).toEqual([
      "DS1302 Tier.Mid",
      "DS1302 Tier.High",
      "DS1302 Flag.On",
      "DS1302 Flag.Off",
      "DS1302 Wire.Binary",
      "DS1302 Mode.Write",
    ]);
  });

  it("reports nothing of a code the severity map allows, by its own key or its family's", () => {
    const own = findingsOf(TARGET, fixtureDocument({ severity: { DS1302: "allow" } }));
    const family = findingsOf(
      TARGET,
      fixtureDocument({ severity: { DS13: "allow", DS1303: "warn" } }),
    );

    expect(own.some((finding) => finding.code === "DS1302")).toBe(false);
    expect(own.some((finding) => finding.code === "DS1301")).toBe(true);
    expect(named(family)).toEqual(["DS1303 first<T>", "DS1303 Box.open<V>"]);
    expect(family.map((finding) => finding.severity)).toEqual(["warn", "warn"]);
  });
});

describe("a write-only member of a library's published API", () => {
  const library = (extra: Record<string, unknown> = {}): readonly CompletedFinding[] => {
    const root = writeProject({
      "package.json": `${JSON.stringify({ name: "@example/meter", version: "1.0.0", type: "module", main: "./src/index.ts" })}\n`,
      "src/index.ts": [
        "export class Meter {",
        "  public count = 0;",
        "  tick(): void {",
        "    this.count = 1;",
        "  }",
        "}",
        "",
      ].join("\n"),
    });
    try {
      return findingsOf(root, JSON.stringify({ target: { kind: "library" }, ...extra }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("is reported at the possible class, because a consumer the run did not load may read it", () => {
    const open = library({ analysis: { min_confidence: "possible" } });

    expect(open.map((finding) => [finding.symbol.name, finding.reachabilityClass])).toEqual([
      ["Meter.count", "possible"],
    ]);
  });

  it("is withheld under a minimum confidence above its class", () => {
    expect(library({ analysis: { min_confidence: "certain" } })).toEqual([]);
  });

  it("is withheld under the default minimum confidence, which is probable", () => {
    expect(library()).toEqual([]);
  });
});

/** One row of a corpus fixture's expectation file. */
interface Row {
  readonly symbol: string;
  readonly report: string;
  readonly confidence?: string;
  readonly reachability_class?: string;
  readonly liveness_relation?: string;
  readonly symbol_kind?: string;
  readonly retained_by?: readonly string[];
}

/** One corpus fixture's TypeScript rendering, its rows, and where each logical name is. */
function corpusFixture(name: string): {
  readonly target: string;
  readonly rows: readonly Row[];
  readonly at: ReadonlyMap<string, string>;
} {
  const dir = fixture("corpus", name);
  const expected = JSON.parse(readFileSync(join(dir, "expect.json"), "utf8")) as {
    readonly expect: readonly Row[];
  };
  const manifest = JSON.parse(readFileSync(join(dir, "ts", "fixture.json"), "utf8")) as {
    readonly symbols: Readonly<Record<string, { readonly file: string; readonly line: number }>>;
  };
  const at = new Map(
    Object.entries(manifest.symbols).map(([symbol, place]) => [
      symbol,
      `${place.file.replace(/^target\//u, "")}:${String(place.line)}`,
    ]),
  );
  return { target: join(dir, "ts", "target"), rows: expected.expect, at };
}

function corpusRun(name: string): {
  readonly input: EmitterInput;
  readonly findingAt: (symbol: string) => CompletedFinding | undefined;
  readonly idAt: (symbol: string) => string | undefined;
  readonly placed: readonly string[];
} {
  const { target, at } = corpusFixture(name);
  const input = emitterInputOf(
    target,
    configOf(JSON.stringify({ target: { kind: "application" } })),
  );
  const findings = emitted(input);
  const placeOf = (position: { readonly path: string; readonly line: number }): string =>
    `${position.path}:${String(position.line)}`;
  return {
    input,
    findingAt: (symbol) => findings.find((finding) => placeOf(finding.position) === at.get(symbol)),
    idAt: (symbol) =>
      input.swept.matrix.union.symbols.find((held) => placeOf(held.position) === at.get(symbol))
        ?.id,
    placed: findings.map((finding) => placeOf(finding.position)),
  };
}

describe.each(["enum-group-conversion", "private-member-unread"])(
  "the corpus fixture %s",
  (name) => {
    const { rows, at } = corpusFixture(name);

    it.each(rows.filter((row) => row.report.startsWith("DS13")))(
      "reports $symbol under $report as the row states",
      (row) => {
        const found = corpusRun(name).findingAt(row.symbol);

        expect(found?.code).toBe(row.report);
        expect(found?.confidence).toBe(row.confidence);
        expect(found?.reachabilityClass).toBe(row.reachability_class);
        expect(found?.livenessRelation).toBe(row.liveness_relation);
        if (row.symbol_kind !== undefined) {
          expect(found?.symbol.kind).toBe(row.symbol_kind);
        }
      },
    );

    it.each(rows.filter((row) => row.report === "none"))(
      "reports nothing about $symbol, held back by what the row names",
      (row) => {
        const { input, findingAt, idAt } = corpusRun(name);
        const id = idAt(row.symbol);
        const classes = input.swept.retained
          .filter((record) => record.id === id)
          .map((record) => record.class);

        expect(findingAt(row.symbol)).toBeUndefined();
        for (const named of row.retained_by ?? []) {
          // A record on a declaration a store holds live held nothing dead back, so the
          // retained set does not list it; the store pass reads it as a read.
          expect(
            classes.includes(named as (typeof classes)[number]) ||
              (id !== undefined && input.stores.exempt.has(id)),
          ).toBe(true);
        }
      },
    );

    it("reports no finding of this family the rows do not name", () => {
      const rowed = new Set(
        rows.filter((row) => row.report.startsWith("DS13")).map((row) => at.get(row.symbol)),
      );

      expect(corpusRun(name).placed.filter((place) => !rowed.has(place))).toEqual([]);
    });
  },
);

describe("print-retained over a project whose enums a conversion produces", () => {
  it("prints each member of such an enum with the conversion that holds it back, and exits 0", async () => {
    const out = new MemoryWriter();
    const err = new MemoryWriter();

    expect(run(["print-retained", `--target=${TARGET}`], out, err, nodeHost())).toBe(0);
    expect(err.text).toBe("");
    await expect(
      out.text,
      "regenerate with `npx vitest --run -u src/findings/reads-and-writes.test.ts` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "reads-and-writes.retained.txt"));
  });
});

function applicationFindings(files: Readonly<Record<string, string>>): readonly CompletedFinding[] {
  const root = writeProject(files);
  try {
    return findingsOf(root, JSON.stringify({ target: { kind: "application" } }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("a store that reads its target", () => {
  it("is a read where its value is used, or where it reads to decide whether to store", () => {
    const found = applicationFindings({
      "package.json": `${JSON.stringify({ name: "@example/counters", private: true, type: "module", bin: "./src/main.ts" })}\n`,
      "src/main.ts": [
        "class Counters {",
        "  private postfix = 0;",
        "  private prefix = 0;",
        "  private cached: string | undefined;",
        "  private flag = false;",
        "  private added = 0;",
        "  private discarded = 0;",
        "  next(): number {",
        "    this.discarded++;",
        "    return this.postfix++;",
        "  }",
        "  first(): number {",
        "    return ++this.prefix;",
        "  }",
        "  load(): void {",
        '    this.cached ??= "value";',
        "    this.flag ||= true;",
        "  }",
        "  add(): number {",
        "    return (this.added += 1);",
        "  }",
        "}",
        "",
        "const counters = new Counters();",
        "counters.next();",
        "counters.first();",
        "counters.load();",
        "counters.add();",
        "",
      ].join("\n"),
    });

    expect(found.map((finding) => `${finding.code} ${finding.symbol.name}`)).toEqual([
      "DS1301 Counters.discarded",
    ]);
  });
});

describe("a parameter property", () => {
  const root = writeProject({
    "package.json": `${JSON.stringify({ name: "@example/box", private: true, type: "module", bin: "./src/main.ts" })}\n`,
    "src/main.ts": [
      "class Box<T> {",
      "  constructor(",
      "    private readonly label: string,",
      "    private readonly kept: number,",
      "    private readonly spare: T,",
      "  ) {",
      "    console.log(label);",
      "  }",
      "  show(): number {",
      "    return this.kept;",
      "  }",
      "}",
      "",
      'console.log(new Box("a", 1, true).show());',
      "",
    ].join("\n"),
  });
  const found = findingsOf(root, JSON.stringify({ target: { kind: "application" } }));
  rmSync(root, { recursive: true, force: true });

  it("is written by its constructor at its name, and read by no read of the parameter its body makes", () => {
    expect(
      found.map((finding) => [
        finding.code,
        finding.symbol.kind,
        finding.message,
        (finding.details.writePositions ?? []).map(
          (at) => `${String(at.line)}:${String(at.column)}`,
        ),
      ]),
    ).toEqual([
      ["DS1301", "class-member", "member Box.label is written once and never read", ["3:22"]],
      ["DS1301", "class-member", "member Box.spare is written once and never read", ["5:22"]],
    ]);
  });
});

describe("a store a for loop's incrementor makes", () => {
  it("is a write only, so a member only it increments is written and never read", () => {
    const found = applicationFindings({
      "package.json": `${JSON.stringify({ name: "@example/loop", private: true, type: "module", bin: "./src/main.ts" })}\n`,
      "src/main.ts": [
        "class Loop {",
        "  private steps = 0;",
        "  run(limit: number): number {",
        "    let done = 0;",
        "    for (let i = 0; i < limit; this.steps++) {",
        "      done += 1;",
        "      i = done;",
        "    }",
        "    return done;",
        "  }",
        "}",
        "",
        "new Loop().run(2);",
        "",
      ].join("\n"),
    });

    expect(found.map((finding) => `${finding.code} ${finding.symbol.name}`)).toEqual([
      "DS1301 Loop.steps",
    ]);
  });
});

const COMMAND = `${JSON.stringify({ name: "@example/stores", private: true, type: "module", bin: "./src/main.ts" })}\n`;

describe("what deleting a write-only declaration with its writes takes with it", () => {
  it("names each type parameter of its type only it names, and none another member reads", () => {
    const found = applicationFindings({
      "package.json": COMMAND,
      "src/main.ts": [
        "class Box<T, V> {",
        "  private held: T | undefined;",
        "  private kept: V | undefined;",
        "  put(): void {",
        "    this.held = undefined;",
        "    this.kept = undefined;",
        "  }",
        "  get(): V | undefined {",
        "    return this.kept;",
        "  }",
        "}",
        "",
        "new Box<number, string>().put();",
        "new Box<number, string>().get();",
        "",
      ].join("\n"),
    });

    expect(found.map((finding) => `${finding.code} ${finding.message}`)).toEqual([
      "DS1301 member Box.held is written once and never read, and deleting it with its writes deletes type parameter Box<T> too",
    ]);
  });

  it("names each import only its writes use, in name order", () => {
    const found = applicationFindings({
      "package.json": COMMAND,
      "src/values.ts": "export const zeta = 1;\nexport const alpha = 2;\n",
      "src/main.ts":
        'import { alpha, zeta } from "./values.js";\n\nlet held = 0;\nheld = zeta;\nheld = alpha;\n',
    });

    expect(found.map((finding) => `${finding.code} ${finding.message}`)).toEqual([
      "DS1301 variable held is written at 2 positions and never read, and deleting it with its writes deletes import alpha and import zeta too",
    ]);
  });
});

describe("a write-only declaration written over several lines", () => {
  it("is reported from its first line to its last", () => {
    const found = applicationFindings({
      "package.json": COMMAND,
      "src/main.ts": [
        "let written:",
        "  | number",
        "  | undefined = 0;",
        "written = 1;",
        "",
        "class Holder {",
        "  private held:",
        "    | number",
        "    | undefined;",
        "  put(): void {",
        "    this.held = 1;",
        "  }",
        "}",
        "",
        "new Holder().put();",
        "",
      ].join("\n"),
    });

    expect(
      found.map(
        (finding) =>
          `${finding.symbol.name} ${String(finding.position.line)}-${String(finding.position.endLine)} ${String(finding.symbol.sizeLines)}`,
      ),
    ).toEqual(["written 1-3 3", "Holder.held 7-9 3"]);
  });
});

describe("a write-only declaration two configurations compile", () => {
  it("names each position written once", () => {
    const options = { strict: true, module: "NodeNext", noEmit: true };
    const found = applicationFindings({
      "package.json": COMMAND,
      "tsconfig.json": `${JSON.stringify({ compilerOptions: options, include: ["src/**/*.ts"] })}\n`,
      "tsconfig.other.json": `${JSON.stringify({ compilerOptions: { ...options, noUnusedLocals: false }, include: ["src/**/*.ts"] })}\n`,
      "src/main.ts": "let written = 0;\nwritten = 1;\n",
    });

    expect(
      found.map((finding) => [
        finding.symbol.name,
        finding.configurations,
        (finding.details.writePositions ?? []).map(
          (at) => `${String(at.line)}:${String(at.column)}`,
        ),
      ]),
    ).toEqual([["written", ["tsconfig.json", "tsconfig.other.json"], ["2:1"]]]);
  });
});

describe("a store that replaces a method", () => {
  it("leaves the method to the kinds of code, which a store runs no part of", () => {
    expect(
      applicationFindings({
        "package.json": COMMAND,
        "src/main.ts":
          "class Plugin {\n  start(): void {}\n}\n\nconst plugin = new Plugin();\nplugin.start = () => undefined;\n",
      }),
    ).toEqual([]);
  });
});

describe("an enum member only a test file names", () => {
  it("is no unnamed member, which only a member nothing names is", () => {
    expect(
      named(
        applicationFindings({
          "package.json": COMMAND,
          "src/main.ts":
            "export enum Mode {\n  Read,\n  Write,\n  Gone,\n}\n\nconsole.log(Mode.Read);\n",
          "src/main.test.ts": 'import { Mode } from "./main.js";\n\nconsole.log(Mode.Write);\n',
        }),
      ),
    ).toEqual(["DS1302 Mode.Gone"]);
  });
});
