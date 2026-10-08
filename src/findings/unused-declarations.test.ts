import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { emitterInputOf } from "../../__test-helpers__/emitter-input.ts";
import { fixture } from "../../__test-helpers__/fixtures.ts";
import { writeProject } from "../../__test-helpers__/projects.ts";
import type { Config } from "../config.ts";
import type { CompletedFinding } from "../finding.ts";
import { resolve } from "../resolve.ts";
import type { EmitterInput } from "./emitter.ts";
import { EMITTERS, findingsOf } from "./emitters.ts";

/** The codes of this family. */
const FAMILY = /^DS10[0-9]{2}$/u;

/** One configuration document, resolved. */
function configOf(document: string): Config {
  return resolve({ repository: document, repositoryLabel: "deadset.json" }).config;
}

/** What the emitters read of one fixture project under its own configuration document. */
function sweepProject(name: string): EmitterInput {
  const target = fixture("projects", name);
  return emitterInputOf(target, configOf(readFileSync(join(target, "deadset.json"), "utf8")));
}

/** The run's reported findings of this family, completed and dialed with every other family's. */
function family(input: EmitterInput): readonly CompletedFinding[] {
  return findingsOf(input).filter((finding) => FAMILY.test(finding.code));
}

/** One finding as one line: every member the family decides or completes. */
function line(finding: CompletedFinding): string {
  const { position, symbol, component } = finding;
  return [
    finding.code,
    `${position.path}:${String(position.line)}:${String(position.column)}-${String(position.endLine)}`,
    `${symbol.kind} ${symbol.name} ${String(symbol.sizeLines)}`,
    `${finding.reachabilityClass}/${finding.confidence}`,
    finding.livenessRelation ?? "-",
    finding.testOnly ? "test-only" : "-",
    `${component.id}${component.root ? " root" : ""} ${String(component.symbolCount)} ${String(component.deletableLines)}`,
    finding.severity,
    finding.configurations.join(","),
    JSON.stringify(finding.details),
    finding.message,
  ].join("\t");
}

/** Each finding as its code and its subject's display name. */
function named(findings: readonly CompletedFinding[]): string[] {
  return findings.map((finding) => `${finding.code} ${finding.symbol.name}`);
}

describe("the unused-declarations emitter over an application", () => {
  const input = sweepProject("unused-declarations");
  const findings = family(input);

  it("is the committed golden table, finding for finding", async () => {
    await expect(
      `${findings.map(line).join("\n")}\n`,
      "regenerate with `npx vitest --run src/findings/unused-declarations.test.ts -u` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "unused-declarations.findings.txt"));
  });

  it("reports an exported and an unexported declaration nothing references, and neither when referenced", () => {
    const reported = named(findings);

    expect(reported).toContain("DS1001 unusedExported");
    expect(reported).toContain("DS1002 unusedUnexported");
    expect(reported).toContain("DS1001 Shapes.unusedArea");
    expect(reported).toContain("DS1002 Shapes.hidden");
    expect(reported).toContain("DS1001 alias");
    expect(reported.filter((one) => /\b(used|usedHelper|Shapes\.area)$/u.test(one))).toEqual([]);
  });

  it("reports a declaration only dead code references by reachability, in its root's component", () => {
    const caller = findings.find((finding) => finding.symbol.name === "deadCaller");
    const callee = findings.find((finding) => finding.symbol.name === "calledOnlyByDead");

    expect(caller?.livenessRelation).toBe("reference-counting");
    expect(callee?.code).toBe("DS1002");
    expect(callee?.livenessRelation).toBe("reachability");
    expect(callee?.component).toEqual({ ...caller?.component, root: false });
    expect(caller?.component.root).toBe(true);
  });

  it("reports a member of a live container, a private name at certain, and no member of a dead one", () => {
    const reported = named(findings);

    expect(reported).toEqual(
      expect.arrayContaining([
        "DS1003 Counter.stale",
        "DS1003 Counter.#origin",
        "DS1003 Counter.guarded",
        "DS1003 Counter.created",
        "DS1003 Counter.unusedMethod",
        "DS1003 Labelled.note",
        "DS1003 Color.Green",
        "DS1001 Obsolete",
      ]),
    );
    expect(reported.filter((one) => one.includes("Obsolete."))).toEqual([]);
    expect(reported.filter((one) => /Counter\.(live|total)$|Labelled\.label$/u.test(one))).toEqual(
      [],
    );
    const origin = findings.find((finding) => finding.symbol.name === "Counter.#origin");
    expect([origin?.reachabilityClass, origin?.confidence]).toEqual(["certain", "certain"]);
  });

  it("leaves an enumerated member nothing names to its own kind", () => {
    expect(named(findings).filter((one) => one.includes("Color.Blue"))).toEqual([]);
  });

  it("reports a declaration only test files reference under the test-only code", () => {
    const tested = findings.find((finding) => finding.symbol.name === "onlyTested");

    expect(tested?.code).toBe("DS1004");
    expect(tested?.testOnly).toBe(true);
    expect(named(findings).filter((one) => one.endsWith(" used"))).toEqual([]);
  });

  it("reports a test whose every target is dead, and not a test that references a live one", () => {
    const reported = named(findings);

    expect(reported).toContain("DS1005 testOfDeadCode");
    expect(reported.filter((one) => one.includes("testOfLiveCode"))).toEqual([]);
    expect(reported.filter((one) => one.endsWith(" check"))).toEqual([]);
  });

  it("reports a deprecated declaration with no production reference under the deprecated code alone", () => {
    const reported = named(findings);

    expect(reported).toEqual(
      expect.arrayContaining([
        "DS1006 deprecatedUnused",
        "DS1006 deprecatedTestedOnly",
        "DS1006 Counter.legacy",
        "DS1006 staleFirst",
        "DS1006 staleSecond",
      ]),
    );
    expect(reported.filter((one) => one.includes("deprecatedButUsed"))).toEqual([]);
    expect(reported.filter((one) => one.endsWith(" deprecatedUnused"))).toEqual([
      "DS1006 deprecatedUnused",
    ]);
  });

  it("reports each declaration once", () => {
    const subjects = findings.map((finding) => finding.symbol.ref);

    expect(new Set(subjects).size).toBe(subjects.length);
  });
});

describe("the dials over the unused-declarations family", () => {
  const input = sweepProject("unused-declarations");
  const under = (document: string): string[] =>
    named(family({ ...input, config: configOf(document) }));
  const application = (extra: string): string => `{ "target": { "kind": "application" }${extra} }`;
  const everything = under(application(""));

  it("withholds a root at allow and every finding that falls with it", () => {
    const allowed = under(application(`, "severity": { "DS1001": "allow" }`));

    expect(allowed.filter((one) => one.startsWith("DS1001"))).toEqual([]);
    expect(allowed).not.toContain("DS1002 calledOnlyByDead");
    expect(allowed).not.toContain("DS1003 Color.Green");
    expect(allowed).toContain("DS1002 unusedUnexported");
  });

  it("withholds a finding that falls with a root alone", () => {
    const allowed = under(application(`, "severity": { "DS1002": "allow" }`));

    expect(allowed).not.toContain("DS1002 calledOnlyByDead");
    expect(allowed).toContain("DS1001 deadCaller");
    expect(allowed).toEqual(everything.filter((one) => !one.startsWith("DS1002")));
  });

  it("reads a code's key before its family's", () => {
    const findings = family({
      ...input,
      config: configOf(application(`, "severity": { "DS10": "warn", "DS1003": "allow" }`)),
    });

    expect(new Set(findings.map((finding) => finding.severity))).toEqual(new Set(["warn"]));
    expect(findings.filter((finding) => finding.code === "DS1003")).toEqual([]);
  });

  it("gives every code its default severity where nothing names it", () => {
    const findings = family({ ...input, config: configOf(application("")) });

    expect(new Set(findings.map((finding) => finding.severity))).toEqual(new Set(["deny"]));
  });
});

describe("the unused-declarations emitter over a library", () => {
  const input = sweepProject("unused-declarations-library");
  const findings = family(input);

  it("is the committed golden table, finding for finding", async () => {
    await expect(
      `${findings.map(line).join("\n")}\n`,
      "regenerate with `npx vitest --run src/findings/unused-declarations.test.ts -u` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "unused-declarations-library.findings.txt"));
  });

  it("classes the published API possible and a private member certain, with no consumer information", () => {
    const every = family({
      ...input,
      config: configOf(
        `{ "target": { "kind": "library" }, "analysis": { "min_confidence": "possible" } }`,
      ),
    });
    const classes = every.map((finding) => `${finding.symbol.name} ${finding.confidence}`);

    expect(classes).toEqual([
      "Published.visible possible",
      "Published.#secret certain",
      "Published.hidden certain",
      "makePublished possible",
      "internalRetired certain",
    ]);
  });

  it("leaves an unused export no code outside the target can import to the unreachable-export kind", () => {
    const unreachable = EMITTERS.get("visibility-narrowing")?.(input) ?? [];

    expect(named(findings).filter((one) => one.endsWith(" internalUnused"))).toEqual([]);
    expect(unreachable.map((one) => `${one.code} ${one.symbol.name}`)).toContain(
      "DS1103 internalUnused",
    );
  });

  it("keeps a deprecated one, which the deprecated code names alone", () => {
    const unreachable = EMITTERS.get("visibility-narrowing")?.(input) ?? [];

    expect(named(findings)).toContain("DS1006 internalRetired");
    expect(unreachable.map((one) => one.symbol.name)).not.toContain("internalRetired");
  });

  it("withholds below the minimum confidence", () => {
    const certain = family({
      ...input,
      config: configOf(
        `{ "target": { "kind": "library" }, "analysis": { "min_confidence": "certain" } }`,
      ),
    });

    expect(named(certain)).toEqual([
      "DS1003 Published.#secret",
      "DS1003 Published.hidden",
      "DS1006 internalRetired",
    ]);
  });
});

describe("an export a root names that nothing references", () => {
  const target = fixture("projects", "caller-roots");

  it("is never reported where a manifest entry, a command or an entry file roots it", () => {
    const input = emitterInputOf(
      target,
      configOf(readFileSync(join(target, "deadset.json"), "utf8")),
    );

    expect(
      named(findingsOf(input)),
      "the member of a rooted interface and the export no root names are still reported",
    ).toEqual(["DS1003 MainShape.name", "DS1103 unused"]);
  });

  it("stays a candidate in a library where the published API roots it, and nowhere else", () => {
    const input = emitterInputOf(
      target,
      configOf(
        `{ "target": { "kind": "library" }, "analysis": { "min_confidence": "possible" }, "ts": { "entry_files": ["src/route.ts"] } }`,
      ),
    );

    expect(named(findingsOf(input))).toEqual([
      "DS1001 fromMain",
      "DS1103 unused",
      "DS1201 MainShape",
    ]);
  });
});

/** One row of a corpus fixture's expectation file, as far as this family reads it. */
interface ExpectRow {
  readonly symbol: string;
  readonly report: string;
  readonly confidence?: string;
  readonly reachability_class?: string;
  readonly liveness_relation?: string;
  readonly symbol_kind?: string;
  readonly retained_by?: readonly string[];
}

/** One corpus fixture's TypeScript rendering, answered for this family. */
interface Answered {
  /** Per row, in the file's order: the row's name and code, then what failed, or `pass`. */
  readonly rows: readonly string[];
  /** The findings no row names. */
  readonly unnamed: readonly string[];
}

/**
 * Answers one corpus fixture's TypeScript rendering for this family: each row naming a
 * code of the family is matched against the finding at the row's line, each row naming
 * `none` against the absence of one and the exemption records the row names, and each
 * finding the family reports is named by some row.
 */
function answer(name: string): Answered {
  const dir = fixture("corpus", name);
  const expected = JSON.parse(readFileSync(join(dir, "expect.json"), "utf8")) as {
    readonly target_kind: string;
    readonly consumers?: readonly string[];
    readonly expect: readonly ExpectRow[];
  };
  const manifest = JSON.parse(readFileSync(join(dir, "ts", "fixture.json"), "utf8")) as {
    readonly symbols: Readonly<Record<string, { readonly file: string; readonly line: number }>>;
  };
  const config = configOf(`{ "target": { "kind": "${expected.target_kind}" } }`);
  const input = emitterInputOf(join(dir, "ts", "target"), config, {
    consumers: (expected.consumers ?? []).map((consumer) => join(dir, "ts", consumer)),
  });
  const { swept } = input;
  const findings = family(input);
  const at = (row: ExpectRow): { readonly path: string; readonly line: number } => {
    const bound = manifest.symbols[row.symbol];
    return { path: (bound?.file ?? "").replace(/^target\//u, ""), line: bound?.line ?? 0 };
  };
  const findingAt = (row: ExpectRow): CompletedFinding | undefined => {
    const { path, line: atLine } = at(row);
    return findings.find(
      (finding) => finding.position.path === path && finding.position.line === atLine,
    );
  };

  const rows = expected.expect.map((row) => {
    const label = `${row.symbol} ${row.report}`;
    const found = findingAt(row);
    if (row.report === "none") {
      if (found !== undefined) {
        return `${label}: reported ${found.code}`;
      }
      const { path, line: atLine } = at(row);
      const held = swept.retained
        .filter((record) => {
          const symbol = swept.matrix.union.symbols[swept.matrix.union.at(record.id)];
          return symbol?.position.path === path && symbol.position.line === atLine;
        })
        .map((record): string => record.class);
      const missing = (row.retained_by ?? []).filter((one) => !held.includes(one));
      return missing.length === 0
        ? `${label}: pass`
        : `${label}: not retained by ${missing.join(",")}`;
    }
    if (!FAMILY.test(row.report)) {
      return `${label}: another family`;
    }
    const wanted: [string, string | undefined, string | undefined][] = [
      ["code", row.report, found?.code],
      ["confidence", row.confidence, found?.confidence],
      ["reachability_class", row.reachability_class, found?.reachabilityClass],
      ["liveness_relation", row.liveness_relation, found?.livenessRelation],
      ["symbol_kind", row.symbol_kind, found?.symbol.kind],
    ];
    const wrong = wanted
      .filter(([, want, got]) => want !== undefined && want !== got)
      .map(([member, , got]) => `${member} ${got ?? "absent"}`);
    return wrong.length === 0 ? `${label}: pass` : `${label}: ${wrong.join(", ")}`;
  });
  const unnamed = findings
    .filter((finding) => expected.expect.every((row) => findingAt(row) !== finding))
    .map((finding) => `${finding.code} ${finding.symbol.name}`);
  return { rows, unnamed };
}

describe("the corpus fixtures naming a code of the family", () => {
  it.each([
    [
      "deprecated-and-unused",
      [
        "Old DS1006: pass",
        "Stale DS1006: pass",
        "StaleToo DS1006: pass",
        "Counter.Old DS1006: pass",
        "Kept none: pass",
        "Fresh none: pass",
        "Counter.Live none: pass",
      ],
    ],
    ["test-only-reference", ["OnlyTested DS1004: pass", "Production none: pass"]],
    ["unused-exported-consumer", ["DeadExport DS1001: pass", "UsedByConsumer none: pass"]],
    [
      "test-of-dead-code",
      [
        "DeadOne DS1004: pass",
        "DeadTwo DS1004: pass",
        "TestDeadOnly DS1005: pass",
        "Live none: pass",
        "TestMixed none: pass",
        "assertSum none: pass",
      ],
    ],
    [
      "unused-declaration-visibility",
      [
        "Resolve DS1001: pass",
        "Recurse DS1001: pass",
        "helper DS1002: pass",
        "Counter.stale DS1003: pass",
        "Used none: pass",
        "usedHelper none: pass",
        "Counter.Live none: pass",
        "Counter.Total none: pass",
      ],
    ],
    [
      "private-member-unread",
      [
        "UnreadPrivate DS1301: another family",
        "UnreferencedPrivate DS1003: pass",
        "ReachedByStringIndex none: pass",
      ],
    ],
  ])("answers %s row for row", (name, rows) => {
    expect(answer(name)).toEqual({ rows, unnamed: [] });
  });
});

describe("a member that is the only part of its type naming a type parameter", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** This family's findings over one `src/main.ts` the manifest names as the entry. */
  function findings(main: string): string[] {
    const root = writeProject({
      "package.json": '{ "name": "@example/app", "type": "module", "main": "./src/main.ts" }\n',
      "src/main.ts": main,
    });
    roots.push(root);
    return family(emitterInputOf(root, configOf('{ "target": { "kind": "application" } }'))).map(
      (finding) => `${finding.code} ${finding.symbol.name}`,
    );
  }

  const PAIR =
    "export interface Pair<P> {\n  readonly id: number;\n  readonly first?: P;\n  readonly second?: P;\n}\nconst pair: Pair<string> = { id: 1 };\n";

  it("is not reported while every part naming the parameter is a member no value writes and nothing reads", () => {
    expect(findings(`${PAIR}console.log(pair.id);\n`)).toEqual([]);
  });

  it("is reported once another part naming the parameter is read", () => {
    expect(findings(`${PAIR}console.log(pair.id, pair.second);\n`)).toEqual(["DS1003 Pair.first"]);
  });
});

describe("a file whose only statement is its default export", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** Every finding, as code, name and place, over `src/main.ts` importing `src/side.ts` for its effect. */
  function findings(side: string): string[] {
    const root = writeProject({
      "package.json": '{ "name": "@example/app", "type": "module", "main": "./src/main.ts" }\n',
      "src/main.ts": 'import "./side.js";\n',
      "src/side.ts": side,
    });
    roots.push(root);
    return findingsOf(
      emitterInputOf(root, configOf('{ "target": { "kind": "application" } }')),
    ).map(
      (finding) =>
        `${finding.code} ${finding.symbol.name} ${String(finding.position.line)}:${String(finding.position.column)}`,
    );
  }

  it("reports the unused default export apart from the file the import evaluates", () => {
    expect(findings("export default function () {}")).toEqual(["DS1001 default 1:8"]);
    expect(findings("export default 1;")).toEqual(["DS1001 default 1:8"]);
  });
});

describe("test-support code a configuration holding no test file compiles too", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is judged with the tests in every configuration of the run", () => {
    const root = writeProject({
      "package.json": '{ "name": "@example/app", "type": "module", "main": "./src/main.ts" }\n',
      "tsconfig.json": `${JSON.stringify({
        compilerOptions: { strict: true, module: "NodeNext", noEmit: true },
        include: ["src/**/*.ts"],
        exclude: ["src/**/*.test.ts"],
      })}\n`,
      "tsconfig.test.json": `${JSON.stringify({ extends: "./tsconfig.json", exclude: [] })}\n`,
      "src/main.ts": "console.log(1);\n",
      "src/fakes/outer.ts":
        'import { inner } from "./inner.js";\n\nexport function outer(): number {\n  return inner();\n}\n',
      "src/fakes/inner.ts": "export function inner(): number {\n  return 2;\n}\n",
      "src/main.test.ts": 'import { outer } from "./fakes/outer.js";\n\nconsole.log(outer());\n',
    });
    roots.push(root);
    expect(
      family(emitterInputOf(root, configOf('{ "target": { "kind": "application" } }'))).map(
        (finding) => `${finding.code} ${finding.symbol.name}`,
      ),
    ).toEqual([]);
  });
});

describe("a file only a test reaches through a module specifier with a query", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is test-support code, and so is what it imports", () => {
    const root = writeProject({
      "package.json": '{ "name": "@example/app", "type": "module", "main": "./src/main.ts" }\n',
      "src/main.ts": "console.log(1);\n",
      "src/env.d.ts":
        'declare module "*?worker&url" {\n  const url: string;\n  export default url;\n}\n',
      "src/fakes/worker.ts": 'import { inner } from "./inner.js";\n\nconsole.log(inner());\n',
      "src/fakes/inner.ts": "export function inner(): number {\n  return 2;\n}\n",
      "src/main.test.ts":
        'import workerUrl from "./fakes/worker.ts?worker&url";\n\nconsole.log(workerUrl);\n',
    });
    roots.push(root);
    expect(
      findingsOf(emitterInputOf(root, configOf('{ "target": { "kind": "application" } }')))
        .filter((finding) => finding.position.path.startsWith("src/fakes/"))
        .map((finding) => `${finding.code} ${finding.symbol.name}`),
    ).toEqual([]);
  });

  it("is not test-support code when the query reads the file as text", () => {
    const root = writeProject({
      "package.json": '{ "name": "@example/app", "type": "module", "main": "./src/main.ts" }\n',
      "src/main.ts": "console.log(1);\n",
      "src/env.d.ts":
        'declare module "*?raw" {\n  const text: string;\n  export default text;\n}\n',
      "src/page.ts": 'import { inner } from "./inner.js";\n\nexport const page = inner();\n',
      "src/inner.ts": "export function inner(): number {\n  return 2;\n}\n",
      "src/main.test.ts": 'import source from "./page.ts?raw";\n\nconsole.log(source);\n',
    });
    roots.push(root);
    expect(
      findingsOf(emitterInputOf(root, configOf('{ "target": { "kind": "application" } }')))
        .filter((finding) => ["src/page.ts", "src/inner.ts"].includes(finding.position.path))
        .map((finding) => `${finding.code} ${finding.symbol.name}`),
    ).toEqual(["DS1001 inner", "DS1001 page", "DS1502 src/page.ts"]);
  });
});

describe("a test file no configuration of the run holds", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("references what its imports name, so what only it imports is test-support code", () => {
    const root = writeProject({
      "package.json": '{ "name": "@example/app", "type": "module", "main": "./src/main.ts" }\n',
      "tsconfig.json": `${JSON.stringify({
        compilerOptions: { strict: true, module: "NodeNext", noEmit: true },
        include: ["src/**/*.ts"],
        exclude: ["src/**/*.test.ts"],
      })}\n`,
      "src/main.ts": "console.log(1);\n",
      "src/hooks.ts": "export function forTests(): number {\n  return 1;\n}\n",
      "src/fakes/fake.ts":
        "function inner(): number {\n  return 2;\n}\n\nexport function fake(): number {\n  return inner();\n}\n\nexport function unusedFake(): number {\n  return 3;\n}\n",
      "src/main.test.ts":
        'import { fake } from "./fakes/fake.js";\nimport { forTests } from "./hooks.js";\n\nconsole.log(fake(), forTests());\n',
    });
    roots.push(root);
    expect(
      findingsOf(emitterInputOf(root, configOf('{ "target": { "kind": "application" } }'))).map(
        (finding) => `${finding.code} ${finding.symbol.name}`,
      ),
    ).toEqual(["DS1001 unusedFake"]);
  });

  it("references nothing through a specifier whose query reads the file as text", () => {
    const root = writeProject({
      "package.json": '{ "name": "@example/app", "type": "module", "main": "./src/main.ts" }\n',
      "tsconfig.json": `${JSON.stringify({
        compilerOptions: { strict: true, module: "NodeNext", noEmit: true },
        include: ["src/**/*.ts"],
        exclude: ["src/**/*.test.ts"],
      })}\n`,
      "src/main.ts": "console.log(1);\n",
      "src/page.ts": "export default function page(): number {\n  return 1;\n}\n",
      "src/main.test.ts": 'import source from "./page.ts?raw";\n\nconsole.log(source);\n',
    });
    roots.push(root);
    expect(
      findingsOf(emitterInputOf(root, configOf('{ "target": { "kind": "application" } }'))).map(
        (finding) => `${finding.code} ${finding.symbol.name}`,
      ),
    ).toEqual(["DS1001 page", "DS1502 src/page.ts"]);
  });

  it("references a named default export through a default import", () => {
    const root = writeProject({
      "package.json": '{ "name": "@example/app", "type": "module", "main": "./src/main.ts" }\n',
      "tsconfig.json": `${JSON.stringify({
        compilerOptions: { strict: true, module: "NodeNext", noEmit: true },
        include: ["src/**/*.ts"],
        exclude: ["src/**/*.test.ts"],
      })}\n`,
      "src/main.ts": "console.log(1);\n",
      "src/page.ts": "export default function page(): number {\n  return 1;\n}\n",
      "src/main.test.ts": 'import page from "./page.js";\n\nconsole.log(page());\n',
    });
    roots.push(root);
    expect(
      findingsOf(emitterInputOf(root, configOf('{ "target": { "kind": "application" } }'))).map(
        (finding) => `${finding.code} ${finding.symbol.name}`,
      ),
    ).toEqual([]);
  });

  /** Every finding of an application whose one compiler configuration excludes `src/main.test.ts`. */
  function findingsBeside(files: Readonly<Record<string, string>>): string[] {
    const root = writeProject({
      "package.json": '{ "name": "@example/app", "type": "module", "main": "./src/main.ts" }\n',
      "tsconfig.json": `${JSON.stringify({
        compilerOptions: { strict: true, module: "NodeNext", noEmit: true, allowJs: true },
        include: ["src/**/*.ts", "src/**/*.mts", "src/**/*.js"],
        exclude: ["src/**/*.test.ts"],
      })}\n`,
      "src/main.ts": "console.log(1);\n",
      ...files,
    });
    roots.push(root);
    return findingsOf(
      emitterInputOf(root, configOf('{ "target": { "kind": "application" } }')),
    ).map((finding) => `${finding.code} ${finding.symbol.name}`);
  }

  it("evaluates the file a bare or a namespace import names, and reads no export of it", () => {
    expect(
      findingsBeside({
        "src/setup.ts": "console.log(0);\n",
        "src/hooks.ts": "export function forTests(): number {\n  return 1;\n}\n",
        "src/main.test.ts":
          'import "./setup.js";\nimport * as hooks from "./hooks.js";\n\nconsole.log(hooks);\n',
      }),
    ).toEqual(["DS1001 forTests"]);
  });

  it("references what its re-exports name", () => {
    expect(
      findingsBeside({
        "src/hooks.ts": "export function forTests(): number {\n  return 1;\n}\n",
        "src/main.test.ts": 'export { forTests } from "./hooks.js";\n',
      }),
    ).toEqual([]);
  });

  it("evaluates the file an import() call of literal text names", () => {
    expect(
      findingsBeside({
        "src/fakes/setup.ts": 'import { inner } from "./inner.js";\n\nconsole.log(inner());\n',
        "src/fakes/inner.ts": "export function inner(): number {\n  return 2;\n}\n",
        "src/main.test.ts": 'it("boots", async () => {\n  await import("./fakes/setup.js");\n});\n',
      }),
    ).toEqual([]);
  });

  it("names a JavaScript source and a directory's index the way the module resolution does", () => {
    expect(
      findingsBeside({
        "src/legacy.js": "export function legacy() {\n  return 1;\n}\n",
        "src/lib/index.mts": "export function fromIndex(): number {\n  return 2;\n}\n",
        "src/main.test.ts":
          'import { legacy } from "./legacy";\nimport { fromIndex } from "./lib";\n\nconsole.log(legacy(), fromIndex());\n',
      }),
    ).toEqual([]);
  });
});

describe("an override of a method its base class calls", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** This family's findings over one `src/main.ts` the manifest names as the entry. */
  function findings(main: string): string[] {
    const root = writeProject({
      "package.json": '{ "name": "@example/app", "type": "module", "main": "./src/main.ts" }\n',
      "src/main.ts": main,
    });
    roots.push(root);
    return family(emitterInputOf(root, configOf('{ "target": { "kind": "application" } }'))).map(
      (finding) => `${finding.code} ${finding.symbol.name}`,
    );
  }

  const SHAPES = [
    "abstract class Shape {",
    "  describe(): string {",
    "    return `${this.name()} ${String(area(this))}`;",
    "  }",
    "  protected abstract name(): string;",
    "  abstract area(): number;",
    "  abstract perimeter(): number;",
    "}",
    "function area(shape: Shape): number {",
    "  return shape.area();",
    "}",
    "class Square extends Shape {",
    "  protected name(): string {",
    '    return "square";',
    "  }",
    "  area(): number {",
    "    return 4;",
    "  }",
    "  perimeter(): number {",
    "    return 8;",
    "  }",
    "}",
    "",
  ].join("\n");

  it("is live while the base calls it through this or a value of the base type, and no other is", () => {
    expect(findings(`${SHAPES}console.log(new Square().describe());\n`)).toEqual([
      "DS1003 Shape.perimeter",
      "DS1003 Square.perimeter",
    ]);
  });

  it("falls with the base method that calls it", () => {
    expect(findings(`${SHAPES}console.log(new Square());\n`)).toContain("DS1003 Square.name");
  });

  it("is no override where the members are private names, which each class declares alone", () => {
    expect(
      findings(
        [
          "class Base {",
          "  run(): number {",
          "    return this.#step();",
          "  }",
          "  #step(): number {",
          "    return 1;",
          "  }",
          "}",
          "class Child extends Base {",
          "  #step(): number {",
          "    return 2;",
          "  }",
          "}",
          "console.log(new Child().run());",
          "",
        ].join("\n"),
      ),
    ).toEqual(["DS1003 Child.#step"]);
  });
});

describe("an override of a member of a class a dependency declares", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is live where the member's name is quoted or starts with two underscores", () => {
    const root = writeProject({
      "package.json":
        '{ "name": "@example/app", "type": "module", "main": "./src/main.ts", "dependencies": { "@example/elements": "1.0.0" } }\n',
      "node_modules/@example/elements/package.json":
        '{ "name": "@example/elements", "version": "1.0.0", "type": "module", "types": "./index.d.ts" }\n',
      "node_modules/@example/elements/index.d.ts": [
        "export declare class Element {",
        '  "data-x": string;',
        "  __state(): number;",
        "}",
        "",
      ].join("\n"),
      "src/main.ts": [
        'import { Element } from "@example/elements";',
        "class Card extends Element {",
        '  override "data-x" = "card";',
        "  override __state(): number {",
        "    return 1;",
        "  }",
        '  palette = "blue";',
        "}",
        "new Card();",
        "",
      ].join("\n"),
    });
    roots.push(root);

    expect(
      family(emitterInputOf(root, configOf('{ "target": { "kind": "application" } }'))).map(
        (finding) => `${finding.code} ${finding.symbol.name}`,
      ),
    ).toEqual(["DS1003 Card.palette"]);
  });
});
