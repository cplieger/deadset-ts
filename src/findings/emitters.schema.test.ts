import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { emitterInputOf, findingsOf } from "../../__test-helpers__/emitter-input.ts";
import { contractDocument, fixture, ROOT } from "../../__test-helpers__/fixtures.ts";
import { schemaValidator } from "../../__test-helpers__/json-schema.ts";
import type { CompletedFinding } from "../finding.ts";
import { wireFinding } from "../report.ts";
import { resolve } from "../resolve.ts";

const validate = schemaValidator(
  { "finding.schema.json": contractDocument("finding.schema.json") },
  "finding.schema.json",
);

/** A finding of the minimal shape the finding schema admits, for the validator's own cases. */
const ADMITTED = {
  code: "DS1002",
  kind: "unused-unexported",
  language: "ts",
  position: { path: "src/a.ts", line: 1, column: 1, end_line: 1 },
  symbol: { ref: "ts://@example/app/src/a.ts#a", kind: "function", name: "a", size_lines: 1 },
  reachability_class: "certain",
  confidence: "certain",
  liveness_relation: "reference-counting",
  test_only: false,
  generated: false,
  component: { id: "deadset-ts/c-1", root: true, symbol_count: 1, deletable_lines: 1 },
  retained_by: [],
  configurations: ["tsconfig.json"],
  consumers_loaded: [],
  fixability: "deletable",
  severity: "deny",
  message: "unexported function has no reference in the target",
  details: {},
};

describe("the finding schema's validator", () => {
  it("admits a finding the schema admits", () => {
    expect(validate(ADMITTED)).toEqual([]);
  });

  it.each([
    ["a required member is missing", { ...ADMITTED, severity: undefined }],
    ["a live subject's code carries a relation", { ...ADMITTED, code: "DS1104" }],
    [
      "a code carries a details member another code owns",
      { ...ADMITTED, details: { write_positions: [ADMITTED.position] } },
    ],
    [
      "a member the schema does not declare is present",
      { ...ADMITTED, component: { ...ADMITTED.component, size: 1 } },
    ],
  ])("refuses a finding in which %s", (_what, finding) => {
    expect(validate(JSON.parse(JSON.stringify(finding)))).not.toEqual([]);
  });
});

/** The bound on one case, which loads one whole target, the repository among them. */
const LOAD_TIMEOUT = 60_000;

/** Whether a corpus fixture's run ends with a setup failure, which leaves no finding to check. */
function endsInSetupFailure(name: string): boolean {
  const expectation = JSON.parse(
    readFileSync(fixture("corpus", name, "expect.json"), "utf8"),
  ) as Record<string, unknown>;
  return expectation["setup_failure"] !== undefined;
}

/**
 * Every target the suite analyzes: the repository, every project fixture, and every corpus
 * fixture with a TypeScript rendering that a run analyzes to the end.
 */
function targets(): [string, string][] {
  const projects = readdirSync(fixture("projects")).map((name): [string, string] => [
    `projects/${name}`,
    fixture("projects", name),
  ]);
  const corpus = readdirSync(fixture("corpus"))
    .filter((name) => !endsInSetupFailure(name))
    .map((name): [string, string] => [`corpus/${name}`, fixture("corpus", name, "ts", "target")]);
  return [["the repository", ROOT], ...projects, ...corpus];
}

describe("every finding the table reports", () => {
  const copies: string[] = [];
  afterAll(() => {
    for (const copy of copies) {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  /**
   * The target as the analysis reads it. A fixture keeping its dependency directory under
   * `installed/`, inside the target or beside it at the rendering root, is copied with that
   * directory moved where the package manager puts it.
   */
  const readable = (target: string): string => {
    const holder = [target, dirname(target)].find((dir) => existsSync(join(dir, "installed")));
    if (holder === undefined) {
      return target;
    }
    const copy = mkdtempSync(join(tmpdir(), "deadset-ts-schema-"));
    copies.push(copy);
    cpSync(holder, copy, { recursive: true });
    renameSync(join(copy, "installed"), join(copy, "node_modules"));
    return holder === target ? copy : join(copy, basename(target));
  };

  it.each(targets())(
    "over %s meets the finding schema",
    { timeout: LOAD_TIMEOUT },
    (_label, target) => {
      const root = readable(target);
      const path = join(root, "deadset.json");
      const document = existsSync(path)
        ? readFileSync(path, "utf8")
        : JSON.stringify({ target: { kind: "application" } });
      const findings: readonly CompletedFinding[] = findingsOf(
        emitterInputOf(root, resolve({ repository: document, repositoryLabel: path }).config),
      );

      expect(
        findings.flatMap((finding) =>
          validate(wireFinding(finding)).map(
            (error) => `${finding.code} ${finding.symbol.name} ${error}`,
          ),
        ),
      ).toEqual([]);
    },
  );
});
