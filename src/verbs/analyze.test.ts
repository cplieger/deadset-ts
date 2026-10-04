import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { contractDocument, fixture, readFixture, ROOT } from "../../__test-helpers__/fixtures.ts";
import { schemaValidator } from "../../__test-helpers__/json-schema.ts";
import { TSCONFIG, writeProject } from "../../__test-helpers__/projects.ts";
import type { Host } from "../host.ts";
import { run, type Writer } from "../run.ts";
import { openEngine, type Engine } from "../session.ts";

/** The bound on one case, each of which loads a whole target. */
const LOAD_TIMEOUT = 60_000;

const validate = schemaValidator(
  {
    "report.schema.json": contractDocument("report.schema.json"),
    "finding.schema.json": contractDocument("finding.schema.json"),
  },
  "report.schema.json",
);

/** The text line's defining expression, read from the Contract's page. */
const LINE = new RegExp(
  /## The expression[\s\S]*?```text\n(?<expression>[^\n]+)\n```/u.exec(
    readFixture("contract", "grammar", "text-line.md"),
  )?.groups?.["expression"] ?? "^$",
);

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

/** One finished run: its exit code, its two streams, and the directory it wrote into. */
interface Analyzed {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly dir: string;
}

/**
 * The platform, invoked from `invoked` and reporting a fixed version, so a report names its
 * target and its analyzer the same way on every machine and at every release.
 */
function hostAt(invoked: string): Host {
  return { ...nodeHost(), workingDirectory: () => invoked, analyzerVersion: () => "0.0.0" };
}

/** A directory of this test's own for the documents a run writes, removed afterwards. */
function outputDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "deadset-ts-analyze-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Runs `analyze` from `invoked` over the target, writing into a fresh directory. */
function analyze(target: string, args: readonly string[] = [], invoked: string = ROOT): Analyzed {
  const dir = outputDir();
  const out = new MemoryWriter();
  const err = new MemoryWriter();
  const code = run(
    ["analyze", `--target=${target}`, `--report=${join(dir, "report.json")}`, ...args],
    out,
    err,
    hostAt(invoked),
  );
  return { code, out: out.text, err: err.text, dir };
}

function reportOf(run: Analyzed): Record<string, unknown> {
  return JSON.parse(readFileSync(join(run.dir, "report.json"), "utf8")) as Record<string, unknown>;
}

function textOf(run: Analyzed): string {
  return readFileSync(join(run.dir, "report.json.txt"), "utf8");
}

function totalsOf(run: Analyzed): Record<string, number> {
  return reportOf(run)["totals"] as Record<string, number>;
}

function findingsOf(run: Analyzed): readonly Record<string, unknown>[] {
  return reportOf(run)["findings"] as Record<string, unknown>[];
}

/** A project of this test's own, removed afterwards. */
function project(files: Readonly<Record<string, string>>): string {
  const root = writeProject(files);
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** An application whose one entry file uses the one declaration it imports, so nothing in it is dead. */
const CLEAN_APPLICATION = {
  "deadset.json":
    '{ "target": { "kind": "application" }, "ts": { "entry_files": ["src/main.ts"] } }\n',
  "package.json": '{ "name": "@example/clean", "private": true, "type": "module" }\n',
  "src/main.ts": 'import { helper } from "./internal.js";\n\nconsole.log(helper());\n',
  "src/internal.ts": "export function helper(): number {\n  return 1;\n}\n",
};

describe("analyze over a fixture", () => {
  it.each([
    "unused-declarations",
    "interfaces",
    "reads-and-writes",
    "non-code-artifacts-imports",
    "suppressions",
    "edge-evaluation",
  ])(
    "writes %s's report and its text rendering",
    async (name) => {
      const got = analyze(fixture("projects", name), ["--format=text"]);

      expect(validate(reportOf(got))).toEqual([]);
      await expect(readFileSync(join(got.dir, "report.json"), "utf8")).toMatchFileSnapshot(
        fixture("golden", `${name}.report.json`),
      );
      await expect(textOf(got)).toMatchFileSnapshot(fixture("golden", `${name}.report.txt`));
    },
    LOAD_TIMEOUT,
  );

  it(
    "renders every finding and stale suppression as a line the published expression matches",
    () => {
      const got = analyze(fixture("projects", "suppressions"), ["--format=text"]);
      const totals = totalsOf(got);
      const lines = textOf(got).split("\n");

      expect(lines.filter((line) => LINE.test(line))).toHaveLength(
        (totals["findings"] ?? 0) + (totals["stale_suppressions"] ?? 0),
      );
      expect(lines.filter((line) => line !== "" && !LINE.test(line))).toEqual([
        expect.stringMatching(/^summary: /u),
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "writes nothing to the output stream, and nothing beside the documents it was asked for",
    () => {
      const got = analyze(fixture("projects", "unused-declarations"), [
        "--format=text",
        "--format=json",
      ]);

      expect(got.out).toBe("");
      expect(readdirSync(got.dir).sort()).toEqual([
        "report.json",
        "report.json.json",
        "report.json.txt",
      ]);
      expect(readFileSync(join(got.dir, "report.json.json"), "utf8")).toBe(
        readFileSync(join(got.dir, "report.json"), "utf8"),
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "names its target relative to the directory it was invoked from",
    () => {
      const target = fixture("projects", "unused-declarations");

      expect(reportOf(analyze(target))["target"]).toMatchObject({
        root: "fixtures/projects/unused-declarations",
      });
      expect(reportOf(analyze(target, [], target))["target"]).toMatchObject({ root: "." });
    },
    LOAD_TIMEOUT,
  );
});

describe("the order and the cap", () => {
  it(
    "orders by size when the configuration asks, the largest deletion first",
    () => {
      const sized = findingsOf(
        analyze(fixture("projects", "unused-declarations"), ["--sort=size"]),
      );
      const lines = sized.map(
        (one) => (one["component"] as Record<string, number>)["deletable_lines"] ?? 0,
      );

      expect(lines).toEqual([...lines].sort((a, b) => b - a));
      expect(lines[0]).toBeGreaterThan(lines.at(-1) ?? 0);
    },
    LOAD_TIMEOUT,
  );

  it(
    "keeps the first findings under --max-findings and counts the rest, so printed plus omitted is the total",
    () => {
      const whole = analyze(fixture("projects", "unused-declarations"));
      const capped = analyze(fixture("projects", "unused-declarations"), [
        "--max-findings=3",
        "--format=text",
      ]);

      expect(findingsOf(capped)).toEqual(findingsOf(whole).slice(0, 3));
      expect(totalsOf(capped)).toEqual({
        ...totalsOf(whole),
        omitted: (totalsOf(whole)["findings"] ?? 0) - 3,
      });
      expect(
        textOf(capped)
          .split("\n")
          .filter((line) => LINE.test(line)),
      ).toHaveLength(3);
    },
    LOAD_TIMEOUT,
  );
});

/** The compiler's error for the configuration that names no input, spelled below the target. */
const NO_INPUTS =
  "TS18003: No inputs were found in config file 'tools/tsconfig.json'. Specified 'include' paths were '[\"none/*.ts\"]' and 'exclude' paths were '[]'.";

/** The clean application beside a configuration whose include pattern names no file. */
const WITH_EMPTY_PROJECT = {
  ...CLEAN_APPLICATION,
  "tools/tsconfig.json": '{ "compilerOptions": { "strict": true }, "include": ["none/*.ts"] }\n',
};

/** The setup failure a configuration under `tools/` meets, which imports a file nothing generated. */
const MISSING_MODULE =
  'setup failure: missing-module: tools/gen.ts:1: tools/gen.ts imports "./generated.js", which names no file of the target: run the generator or the build that writes it';

/** The clean application, compiled from `src/` alone, beside a configuration that meets it. */
const WITH_UNGENERATED_PROJECT = {
  ...CLEAN_APPLICATION,
  "tsconfig.json": TSCONFIG.replace('"**/*.ts"', '"src/**/*.ts"'),
  "tools/tsconfig.json": TSCONFIG.replace('"**/*.ts"', '"*.ts"'),
  "tools/gen.ts": 'export { made } from "./generated.js";\n',
};

describe("a configuration that meets a setup failure", () => {
  it(
    "is dropped and named in the report with the failure's line where discovery derived it",
    () => {
      const got = analyze(project(WITH_UNGENERATED_PROJECT), [], tmpdir());
      const report = reportOf(got);

      expect(got.code, got.err).toBe(0);
      expect(validate(report)).toEqual([]);
      expect(report["configurations"]).toEqual([{ id: "tsconfig.json", project: "tsconfig.json" }]);
      expect(report["configurations_not_built"]).toEqual([
        { id: "tools/tsconfig.json", project: "tools/tsconfig.json", error: MISSING_MODULE },
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "ends the run with the failure code and the line where the matrix names it",
    () => {
      const got = analyze(
        project({
          ...WITH_UNGENERATED_PROJECT,
          "deadset.json":
            '{ "target": { "kind": "application" }, "analysis": { "configurations": [{ "id": "app", "project": "tsconfig.json" }, { "id": "tools", "project": "tools/tsconfig.json" }] } }\n',
        }),
        [],
        tmpdir(),
      );

      expect(got.code).toBe(3);
      expect(got.err).toBe(`${MISSING_MODULE}\n`);
      expect(readdirSync(got.dir)).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a configuration that names no input", () => {
  it(
    "is dropped and named in the report where discovery derived it, and the rest is analyzed",
    () => {
      const got = analyze(project(WITH_EMPTY_PROJECT), [], tmpdir());
      const report = reportOf(got);

      expect(got.code, got.err).toBe(0);
      expect(validate(report)).toEqual([]);
      expect(report["configurations"]).toEqual([{ id: "tsconfig.json", project: "tsconfig.json" }]);
      expect(report["configurations_not_built"]).toEqual([
        {
          id: "tools/tsconfig.json",
          project: "tools/tsconfig.json",
          error: NO_INPUTS,
        },
      ]);
      expect(got.err).toBe(
        `deadset-ts: the derived configuration tools/tsconfig.json was not built and is not analyzed: ${NO_INPUTS}\n`,
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "ends the run with the configuration exit code where the matrix names it",
    () => {
      const got = analyze(
        project({
          ...WITH_EMPTY_PROJECT,
          "deadset.json": JSON.stringify({
            target: { kind: "application" },
            ts: { entry_files: ["src/main.ts"] },
            analysis: {
              configurations: [
                { id: "main", project: "tsconfig.json" },
                { id: "tools", project: "tools/tsconfig.json" },
              ],
            },
          }),
        }),
        [],
        tmpdir(),
      );

      expect(got.code).toBe(3);
      expect(got.err).toContain("TS18003");
    },
    LOAD_TIMEOUT,
  );
});

describe("the exit code", () => {
  it(
    "is 0 for a report holding no finding at or above the failing severity",
    () => {
      const got = analyze(project(CLEAN_APPLICATION), [], tmpdir());

      expect(got.code).toBe(0);
      expect(totalsOf(got)["findings"]).toBe(0);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is 1 for a report holding a finding at the failing severity",
    () => {
      const got = analyze(fixture("projects", "unused-declarations"));

      expect(got.code).toBe(1);
      expect(got.err).toBe("");
    },
    LOAD_TIMEOUT,
  );

  it(
    "is 1 for a report holding a stale suppression, and names the count",
    () => {
      const got = analyze(fixture("projects", "suppressions"));

      expect(got.code).toBe(1);
      expect(got.err).toBe(
        `deadset-ts: ${String(totalsOf(got)["stale_suppressions"])} stale suppressions\n`,
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "is 0 when the failing severity is above every finding's",
    () => {
      const warnOnly = project({
        ...CLEAN_APPLICATION,
        "src/main.ts": 'import { run } from "./internal.js";\n\nconsole.log(run());\n',
        "src/internal.ts":
          "export function helper(): number {\n  return 1;\n}\n\nexport function run(): number {\n  return helper() * 2;\n}\n",
      });
      const got = analyze(warnOnly, [], tmpdir());

      expect(findingsOf(got).map((one) => one["severity"])).toEqual(["warn"]);
      expect(got.code).toBe(0);
    },
    LOAD_TIMEOUT,
  );

  it("is 2 when no report path is named", () => {
    const err = new MemoryWriter();

    expect(
      run(
        ["analyze", `--target=${fixture("projects", "unused-declarations")}`],
        new MemoryWriter(),
        err,
        hostAt(ROOT),
      ),
    ).toBe(2);
    expect(err.text).toContain("--report");
  });

  it.each([
    ["a format this analyzer does not render", "--format=html"],
    ["a format named twice", "--format=text --format=text"],
    ["an exit-code value outside on and off", "--exit-code=maybe"],
  ])("is 2 for %s, and writes no report", (_what, options) => {
    const got = analyze(fixture("projects", "unused-declarations"), options.split(" "));

    expect(got.code).toBe(2);
    expect(readdirSync(got.dir)).toEqual([]);
  });

  it.each([
    ["the stale-suppression code", '"DS1703": "warn"'],
    ["the family that holds it", '"DS17": "allow"'],
  ])("is 2 for a severity key naming %s, and writes no report", (_what, key) => {
    const got = analyze(
      project({
        ...CLEAN_APPLICATION,
        "deadset.json": `{ "target": { "kind": "application" }, "severity": { ${key} } }\n`,
      }),
      [],
      tmpdir(),
    );

    expect(got.code).toBe(2);
    expect(got.err).toContain("severity.DS17");
    expect(readdirSync(got.dir)).toEqual([]);
  });

  it(
    "is 3 for a target that imports a file nothing generated, and writes no report",
    () => {
      const got = analyze(failingToLoad(), [], tmpdir());

      expect(got.code).toBe(3);
      expect(got.err).toMatch(
        /^setup failure: missing-module: src\/broken\.ts:1: src\/broken\.ts imports "\.\/generated\.js"/mu,
      );
      expect(readdirSync(got.dir)).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "follows the findings for a target whose own file holds a type error, listing the skip",
    () => {
      const broken = project({
        ...CLEAN_APPLICATION,
        "src/broken.ts": "export const broken: string = 1;\n",
      });
      const got = analyze(broken, [], tmpdir());

      expect(got.code, got.err).toBe(0);
      expect(got.err).toContain("deadset-ts: src/broken.ts:1: ");
      expect(reportOf(got)["type_error_skips"]).toEqual([
        {
          path: "src/broken.ts",
          line: 1,
          message: "Type 'number' is not assignable to type 'string'.",
        },
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "reports nothing inside a function a type error skips, a dead local of it included",
    () => {
      const broken = project({
        ...CLEAN_APPLICATION,
        "src/main.ts":
          'import { helper } from "./internal.js";\nimport { broken } from "./broken.js";\n\nconsole.log(helper(), broken(1));\n',
        "src/broken.ts":
          "export function broken(input: number): number {\n  const unusedLocal = 4;\n  const n: string = input;\n  return n.length;\n}\n",
      });
      const got = analyze(broken, [], tmpdir());

      expect(got.code, got.err).toBe(0);
      expect(reportOf(got)["type_error_skips"]).toEqual([
        {
          path: "src/broken.ts",
          line: 3,
          message: "Type 'number' is not assignable to type 'string'.",
        },
      ]);
      expect(findingsOf(got)).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is 3 for a target outside the directory the run was invoked from, which no report can name",
    () => {
      const got = analyze(project(CLEAN_APPLICATION));

      expect(got.code).toBe(3);
      expect(got.err).toContain("relative to the directory the run was invoked from");
      expect(readdirSync(got.dir)).toEqual([]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is 4 for a report holding a pending finding, which outranks the findings it also holds",
    () => {
      const got = analyze(fixture("projects", "visibility-narrowing"));

      expect(got.code).toBe(4);
      expect(totalsOf(got)["findings"]).toBeGreaterThan(0);
      expect(got.err).toBe(
        "deadset-ts: 2 pending findings: the report names a declared cross-language edge, and no merge has resolved it\n",
      );
    },
    LOAD_TIMEOUT,
  );

  it(
    "is 0 under --exit-code=off, which names the verdict and still writes the report",
    () => {
      const got = analyze(fixture("projects", "unused-declarations"), ["--exit-code=off"]);

      expect(got.code).toBe(0);
      expect(got.err).toBe(
        "deadset-ts: the exit code is configured off: the verdict of this run is 1\n",
      );
      expect(validate(reportOf(got))).toEqual([]);
    },
    LOAD_TIMEOUT,
  );
});

describe("the baseline", () => {
  it(
    "records every finding, the omitted ones included, and each one reading them back exposes, so the next run reports none",
    () => {
      const tree = mkdtempSync(join(tmpdir(), "deadset-ts-baseline-"));
      onTestFinished(() => {
        rmSync(tree, { recursive: true, force: true });
      });
      cpSync(fixture("projects", "unused-declarations"), tree, { recursive: true });
      const baseline = join(tree, "deadset-baseline.json");

      const first = analyze(tree, ["--max-findings=1", `--baseline-write=${baseline}`], tree);
      const rows = (JSON.parse(readFileSync(baseline, "utf8")) as { baseline: unknown[] }).baseline;
      const second = analyze(tree, [], tree);

      expect(findingsOf(first)).toHaveLength(1);
      expect(totalsOf(first)["findings"]).toBe(28);
      expect(rows).toHaveLength(33);
      expect(totalsOf(second)).toMatchObject({
        findings: 0,
        stale_suppressions: 0,
        suppressions_in_effect: 33,
        reasons_recorded: 33,
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "leaves an existing baseline untouched when the run fails",
    () => {
      const tree = failingToLoad();
      const baseline = join(tree, "deadset-baseline.json");
      writeFileSync(baseline, "kept\n");

      expect(analyze(tree, [`--baseline-write=${baseline}`], tmpdir()).code).toBe(3);
      expect(readFileSync(baseline, "utf8")).toBe("kept\n");
    },
    LOAD_TIMEOUT,
  );
});

/** An application whose library holds two dead exports, the first adjudicated by an inline directive. */
function adjudicated(directive: boolean): string {
  return project({
    ...CLEAN_APPLICATION,
    "src/internal.ts": `export function helper(): number {\n  return 1;\n}\n\n${directive ? "// deadset:ignore DS1001 -- kept for a plugin that loads it by name\n" : ""}export function kept(): number {\n  return 2;\n}\n\nexport function dropped(): number {\n  return 3;\n}\n`,
  });
}

/** A target whose analysis fails with 3, so a refusal with 2 is one that came before it. */
function failingToLoad(): string {
  return project({
    ...CLEAN_APPLICATION,
    "src/broken.ts": 'export { made } from "./generated.js";\n',
  });
}

interface SarifRun {
  readonly results: readonly {
    readonly ruleId: string;
    readonly locations: readonly {
      readonly physicalLocation: { readonly region: { readonly startLine: number } };
    }[];
  }[];
  readonly properties: { readonly totals: Record<string, number> };
}

function sarifRunOf(got: Analyzed): SarifRun {
  const log = JSON.parse(readFileSync(join(got.dir, "report.json.sarif"), "utf8")) as {
    runs: SarifRun[];
  };
  const [only] = log.runs;
  if (only === undefined || log.runs.length !== 1) {
    throw new Error(`the SARIF log holds ${String(log.runs.length)} runs`);
  }
  return only;
}

describe("the renderings beside the report", () => {
  it(
    "omits a suppressed finding from the SARIF document while its totals count the suppression",
    () => {
      const open = analyze(adjudicated(false), ["--format=sarif"], tmpdir());
      const kept = analyze(adjudicated(true), ["--format=sarif"], tmpdir());
      const lines = (run: SarifRun): readonly number[] =>
        run.results.map((one) => one.locations[0]?.physicalLocation.region.startLine ?? 0);

      expect(lines(sarifRunOf(open))).toEqual([5, 9]);
      expect(lines(sarifRunOf(kept))).toEqual([10]);
      expect(totalsOf(kept)).toMatchObject({ findings: 1, suppressions_in_effect: 1 });
      expect(sarifRunOf(kept).properties.totals).toEqual(totalsOf(kept));
    },
    LOAD_TIMEOUT,
  );

  it(
    "writes every format beside the report at its suffix, one record per finding and stale suppression in each",
    () => {
      const dir = outputDir();
      const template = join(dir, "codes.tmpl");
      writeFileSync(
        template,
        "{{range .findings}}{{.code}}\n{{end}}{{range .stale_suppressions}}{{.code}}\n{{end}}",
      );
      const got = analyze(fixture("projects", "suppressions"), [
        "--format=text",
        "--format=github",
        "--format=sarif",
        "--format=template",
        `--template=${template}`,
      ]);
      const records = (totalsOf(got)["findings"] ?? 0) + (totalsOf(got)["stale_suppressions"] ?? 0);
      const rendered = (suffix: string): string =>
        readFileSync(join(got.dir, `report.json${suffix}`), "utf8");

      expect(readdirSync(got.dir).sort()).toEqual([
        "report.json",
        "report.json.annotations",
        "report.json.sarif",
        "report.json.tmpl",
        "report.json.txt",
      ]);
      expect(
        rendered(".annotations")
          .split("\n")
          .filter((line) => line.startsWith("::")),
      ).toHaveLength(records);
      expect(sarifRunOf(got).results).toHaveLength(records);
      expect(
        rendered(".tmpl")
          .split("\n")
          .filter((line) => line !== ""),
      ).toEqual(sarifRunOf(got).results.map((one) => one.ruleId));
    },
    LOAD_TIMEOUT,
  );

  it(
    "annotates a finding below the failing severity as a warning, and as an error once the failing severity reaches it",
    () => {
      const warnOnly = project({
        ...CLEAN_APPLICATION,
        "src/main.ts": 'import { run } from "./internal.js";\n\nconsole.log(run());\n',
        "src/internal.ts":
          "export function helper(): number {\n  return 1;\n}\n\nexport function run(): number {\n  return helper() * 2;\n}\n",
      });
      const level = (options: readonly string[]): string =>
        readFileSync(
          join(
            analyze(warnOnly, ["--format=github", ...options], tmpdir()).dir,
            "report.json.annotations",
          ),
          "utf8",
        ).split(" ", 1)[0] ?? "";

      expect(level([])).toBe("::warning");
      expect(level(["--fail-on=warn"])).toBe("::error");
    },
    LOAD_TIMEOUT,
  );

  it.each([
    ["a template that does not parse", "{{if .findings}}never closed"],
    ["a template naming a function it does not define", "{{upper .schema_version}}"],
  ])("is 2 for %s, before any analysis and with no report written", (_what, source) => {
    const dir = outputDir();
    const template = join(dir, "broken.tmpl");
    writeFileSync(template, source);
    const got = analyze(failingToLoad(), ["--format=template", `--template=${template}`], tmpdir());

    expect(got.code).toBe(2);
    expect(got.err).toContain(`--template=${template}: line 1: `);
    expect(readdirSync(got.dir)).toEqual([]);
  });

  it.each([
    ["the template format with no template named", ["--format=template"]],
    ["a template file that cannot be read", ["--template=/nonexistent/x.tmpl"]],
  ])("is 2 for %s, before any analysis and with no report written", (_what, options) => {
    const got = analyze(failingToLoad(), options, tmpdir());

    expect(got.code).toBe(2);
    expect(readdirSync(got.dir)).toEqual([]);
  });

  it(
    "is 3 for a template naming a member the report does not carry, and writes no rendering of it",
    () => {
      const dir = outputDir();
      const template = join(dir, "missing.tmpl");
      writeFileSync(template, "{{.totals.nothing_here}}");
      const got = analyze(fixture("projects", "unused-declarations"), [
        "--format=template",
        `--template=${template}`,
      ]);

      expect(got.code).toBe(3);
      expect(got.err).toBe('deadset-ts: the document has no member "nothing_here" here\n');
      expect(readdirSync(got.dir)).toEqual(["report.json"]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a configured declaration", () => {
  it(
    "that names no declaration in any project is reported once per entry, in each shape and under each key, and one that names a declaration is not",
    () => {
      const root = project({
        "deadset.json": `${JSON.stringify({
          target: { kind: "application" },
          ts: {
            entry_files: ["src/main.ts"],
            injection_registrations: [{ global: "neverDeclared.register" }],
            serializers: [
              { symbol: "ts://@example/configured/src/main.ts#encode" },
              { module: "@example/absent", name: "encode" },
            ],
            lifecycle_contracts: [
              {
                components: [{ symbol: "ts://@example/configured/src/main.ts#missing" }],
                bases: [{ global: "JSON.parse" }],
                members: ["attach"],
              },
            ],
          },
        })}\n`,
        "package.json": '{ "name": "@example/configured", "private": true, "type": "module" }\n',
        "src/main.ts":
          "export function encode(value: unknown): string {\n  return String(value);\n}\n\nconsole.log(encode(1));\n",
      });
      const got = analyze(root, [], root);
      expect(got.err).toBe("");
      const unmatched = findingsOf(got)
        .filter((one) => one["code"] === "DS1706")
        .map((one) => ({
          ref: (one["symbol"] as Record<string, unknown>)["ref"],
          kind: (one["symbol"] as Record<string, unknown>)["kind"],
          path: (one["position"] as Record<string, unknown>)["path"],
          severity: one["severity"],
          relation: one["liveness_relation"],
        }));

      expect(got.code).toBe(1);
      expect(unmatched).toEqual(
        [
          "#neverDeclared.register",
          "@example/absent#encode",
          "ts://@example/configured/src/main.ts#missing",
        ].map((ref) => ({
          ref,
          kind: "configured-declaration",
          path: "deadset.json",
          severity: "deny",
          relation: undefined,
        })),
      );
    },
    LOAD_TIMEOUT,
  );
});

describe("an unused parameter", () => {
  it(
    "is reported in a project whose compiler configuration does not set noUnusedParameters, and the run does not fail",
    () => {
      const root = project({
        "deadset.json":
          '{ "target": { "kind": "application" }, "ts": { "entry_files": ["src/main.ts"] } }\n',
        "package.json": '{ "name": "@example/parameter", "private": true, "type": "module" }\n',
        "src/main.ts":
          "function scaled(value: number, factor: number): number {\n  return value * 2;\n}\n\nconsole.log(scaled(1, 2));\n",
      });
      const got = analyze(root, [], root);

      expect(got.code).toBe(0);
      expect(
        findingsOf(got).map((one) => [
          one["code"],
          (one["symbol"] as Record<string, unknown>)["name"],
          one["severity"],
        ]),
      ).toEqual([["DS1801", "factor", "warn"]]);
    },
    LOAD_TIMEOUT,
  );
});

describe("a question the checker does not answer", () => {
  it(
    "is counted on the error stream under its configuration's path below the target",
    () => {
      const target = fixture("projects", "published-exports");
      const failing = (collectTiming: boolean): Engine => {
        const engine = openEngine({ collectTiming });
        return {
          ...engine,
          ask: (accessor, locations, question) => {
            if (
              accessor === "getExportsOfModule" &&
              locations().some((at) => at.endsWith('/src/index"'))
            ) {
              throw new Error("panic: runtime error: invalid memory address");
            }
            return engine.ask(accessor, locations, question);
          },
        };
      };
      const dir = outputDir();
      const err = new MemoryWriter();

      run(
        ["analyze", `--target=${target}`, `--report=${join(dir, "report.json")}`],
        new MemoryWriter(),
        err,
        hostAt(ROOT),
        failing,
      );

      expect(err.text).toContain(
        "the checker answered 1 question with a failure (tsconfig.json: 1)",
      );
    },
    LOAD_TIMEOUT,
  );
});
