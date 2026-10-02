import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { contractDocument, fixture, readFixture, ROOT } from "../../__test-helpers__/fixtures.ts";
import { schemaValidator } from "../../__test-helpers__/json-schema.ts";
import { writeProject } from "../../__test-helpers__/projects.ts";
import type { Host } from "../host.ts";
import { run, type Writer } from "../run.ts";

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
    ["a format this analyzer does not render", "--format=sarif"],
    ["a format named twice", "--format=text --format=text"],
    ["an exit-code value outside on and off", "--exit-code=maybe"],
  ])("is 2 for %s, and writes no report", (_what, options) => {
    const got = analyze(fixture("projects", "unused-declarations"), options.split(" "));

    expect(got.code).toBe(2);
    expect(readdirSync(got.dir)).toEqual([]);
  });

  it(
    "is 3 for a target that does not type-check, and writes no report",
    () => {
      const broken = project({
        ...CLEAN_APPLICATION,
        "src/broken.ts": "export const broken: string = 1;\n",
      });
      const got = analyze(broken, [], tmpdir());

      expect(got.code).toBe(3);
      expect(got.err).toContain("TS2322");
      expect(readdirSync(got.dir)).toEqual([]);
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
    "records every finding, the omitted ones included, and the next run holds each of them in effect",
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
      expect(rows).toHaveLength(totalsOf(first)["findings"] ?? 0);
      expect(totalsOf(second)).toMatchObject({
        stale_suppressions: 0,
        suppressions_in_effect: rows.length,
        reasons_recorded: rows.length,
      });
    },
    LOAD_TIMEOUT,
  );

  it(
    "leaves an existing baseline untouched when the run fails",
    () => {
      const tree = project({
        ...CLEAN_APPLICATION,
        "src/broken.ts": "export const broken: string = 1;\n",
      });
      const baseline = join(tree, "deadset-baseline.json");
      writeFileSync(baseline, "kept\n");

      expect(analyze(tree, [`--baseline-write=${baseline}`], tmpdir()).code).toBe(3);
      expect(readFileSync(baseline, "utf8")).toBe("kept\n");
    },
    LOAD_TIMEOUT,
  );
});
