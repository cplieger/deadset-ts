import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { emitterInputOf } from "../../__test-helpers__/emitter-input.ts";
import { fixture } from "../../__test-helpers__/fixtures.ts";
import { writeProject } from "../../__test-helpers__/projects.ts";
import type { Config } from "../config.ts";
import type { CompletedFinding } from "../finding.ts";
import { resolve } from "../resolve.ts";
import { findingsOf } from "./emitters.ts";

/** The configuration one target's own document resolves to. */
function configOf(target: string): Config {
  const path = join(target, "deadset.json");
  return resolve({ repository: readFileSync(path, "utf8"), repositoryLabel: path }).config;
}

/** Each finding as its code, its subject and the component it is placed in. */
function placements(findings: readonly CompletedFinding[]): string[] {
  return findings.map(
    ({ code, symbol, component }) =>
      `${code} ${symbol.name} ${component.id}${component.root ? " root" : ""} ${String(component.symbolCount)} ${String(component.deletableLines)}`,
  );
}

describe("the placement of every family's findings in their components", () => {
  it("keeps a dead subject's computed component and numbers a live subject's own past them, deleting no line, across families", () => {
    const target = fixture("projects", "reads-and-writes");
    const input = emitterInputOf(target, configOf(target));

    expect(input.swept.sweep.components).toHaveLength(7);
    expect(placements(findingsOf(input))).toEqual([
      "DS1002 Unused deadset-ts/c-0007 root 3 4",
      "DS1104 Flag deadset-ts/c-0008 root 1 0",
      "DS1301 written deadset-ts/c-0009 root 1 0",
      "DS1301 shared deadset-ts/c-0010 root 1 0",
      "DS1301 Gauge.#samples deadset-ts/c-0011 root 1 0",
      "DS1301 slots deadset-ts/c-0012 root 1 0",
      "DS1302 Mode.Write deadset-ts/c-0006 root 1 1",
      "DS1303 first<T> deadset-ts/c-0001 root 1 1",
      "DS1303 Box.open<V> deadset-ts/c-0003 root 1 1",
    ]);
  });

  it("places a dead subject its emitter names no component for in the component it falls in", () => {
    const target = fixture("projects", "interfaces");
    const placed = placements(findingsOf(emitterInputOf(target, configOf(target))));

    expect(placed).toContain("DS1201 Unused deadset-ts/c-0003 root 3 4");
    expect(placed).toContain("DS1201 OnlyDead deadset-ts/c-0004 3 6");
  });

  describe("over a manifest row", () => {
    const root = mkdtempSync(join(tmpdir(), "deadset-ts-completion-"));
    cpSync(fixture("projects", "dependencies"), root, { recursive: true });
    renameSync(join(root, "installed"), join(root, "node_modules"));
    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it("gives each unused dependency a component of its own that deletes no declaration line", () => {
      const input = emitterInputOf(root, configOf(root));
      const rows = findingsOf(input).filter((finding) => finding.code === "DS1601");

      expect(input.swept.sweep.components).toHaveLength(1);
      expect(placements(rows)).toEqual([
        "DS1601 unused-runtime deadset-ts/c-0003 root 1 0",
        "DS1601 @types/bundled deadset-ts/c-0004 root 1 0",
        "DS1601 optional-peer deadset-ts/c-0005 root 1 0",
        "DS1601 unused-dev deadset-ts/c-0006 root 1 0",
        "DS1601 peer-unused deadset-ts/c-0007 root 1 0",
      ]);
    });
  });
});

/** Each finding as its code, its subject and the members the completion step reads from the run. */
function claims(findings: readonly CompletedFinding[]): string[] {
  return findings.map(
    (finding) =>
      `${finding.code} ${finding.symbol.name} ${finding.reachabilityClass}/${finding.confidence} ${finding.livenessRelation ?? "-"} ${finding.testOnly ? "test-only" : "-"} [${finding.configurations.join(",")}]`,
  );
}

/** The fixture's findings under its own document with `extra` merged over its top level. */
function reportedUnder(
  name: string,
  extra: Record<string, unknown> = {},
): readonly CompletedFinding[] {
  const target = fixture("projects", name);
  const path = join(target, "deadset.json");
  const own = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const { config } = resolve({
    repository: JSON.stringify({ ...own, ...extra }),
    repositoryLabel: path,
  });
  return findingsOf(emitterInputOf(target, config));
}

describe("the completion of every family's findings", () => {
  it("names each code's kind, fixability and severity as its row of the issue-kind vocabulary states them", () => {
    const rows = reportedUnder("interfaces")
      .filter(
        (finding) => finding.symbol.name === "Unused" || finding.symbol.name === "Channel.close",
      )
      .map(
        (finding) => `${finding.code} ${finding.kind} ${finding.fixability} ${finding.severity}`,
      );

    expect(rows).toEqual([
      "DS1201 unused-interface deletable deny",
      "DS1203 uncalled-interface-method manual warn",
    ]);
  });

  it("gives a dead subject its candidate's relation and a live one none, each in the configurations holding it", () => {
    const rows = claims(reportedUnder("reads-and-writes")).filter((row) =>
      /^DS130[12] (written|Mode\.Write) /u.test(row),
    );

    expect(rows).toEqual([
      "DS1301 written certain/certain - - [tsconfig.json]",
      "DS1302 Mode.Write certain/certain reference-counting - [tsconfig.json]",
    ]);
  });

  it("reads each subject's facts from its own file where two packages of one name spell one reference", () => {
    expect(
      claims(
        reportedUnder("shared-package-name").filter(
          (finding) => finding.symbol.name === "onlyTested",
        ),
      ),
    ).toEqual(["DS1004 onlyTested certain/certain reference-counting test-only [a/tsconfig.json]"]);
  });

  it("reads each subject's facts from its own position where two declarations of one file spell one reference", () => {
    expect(
      claims(
        reportedUnder("ambient-default-aliases").filter(
          (finding) => finding.symbol.kind === "export-alias",
        ),
      ),
    ).toEqual(["DS1001 '*.partly'.default certain/certain reference-counting - [tsconfig.json]"]);
  });

  it("marks a subject only test files name test-only", () => {
    expect(claims(reportedUnder("interfaces"))).toContain(
      "DS1201 Probe certain/certain reference-counting test-only [tsconfig.json]",
    );
  });

  it("holds a finding about a file in every configuration of the matrix, at certain with no relation", () => {
    const target = fixture("projects", "non-code-artifacts-matrix");
    const input = emitterInputOf(target, configOf(target));
    const files = findingsOf(input).filter((finding) => finding.symbol.kind === "file");

    expect(input.swept.matrix.configurations.length).toBeGreaterThan(1);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect([file.reachabilityClass, file.livenessRelation, file.configurations]).toEqual([
        "certain",
        undefined,
        input.swept.matrix.configurations,
      ]);
    }
  });

  it("names the consumers the run loaded and no exemption class", () => {
    const target = fixture("projects", "reads-and-writes");
    const input = emitterInputOf(target, configOf(target));
    const loaded = {
      ...input,
      boundary: {
        ...input.boundary,
        consumers: { declared: ["@example/c"], loaded: ["@example/c"] },
      },
    };

    expect(
      new Set(
        findingsOf(loaded).map((finding) =>
          JSON.stringify([finding.consumersLoaded, finding.retainedBy]),
        ),
      ),
    ).toEqual(new Set([JSON.stringify([["@example/c"], []])]));
  });
});

describe("the dials over every family's findings", () => {
  const named = (findings: readonly CompletedFinding[]): string[] =>
    findings.map((finding) => `${finding.code} ${finding.symbol.name}`);
  const everything = named(reportedUnder("interfaces"));

  it("withhold, with a root one family reports at allow, what another family reports in its component", () => {
    const allowed = named(reportedUnder("interfaces", { severity: { DS1002: "allow" } }));

    expect(everything).toContain("DS1201 OnlyDead");
    expect(allowed).not.toContain("DS1201 OnlyDead");
    expect(allowed).toEqual(
      everything.filter((one) => !one.startsWith("DS1002") && one !== "DS1201 OnlyDead"),
    );
  });

  it("withhold a finding that falls with a root alone, leaving the root another family reports", () => {
    const allowed = named(reportedUnder("interfaces", { severity: { DS1201: "allow" } }));

    expect(allowed).toContain("DS1002 orphan");
    expect(allowed).toEqual(
      everything.filter((one) => !one.startsWith("DS1201") && one !== "DS1005 testProbe"),
    );
  });

  it("withhold every root of a component with one of them, whichever family reports each", () => {
    const allowed = named(reportedUnder("interfaces", { severity: { DS1005: "allow" } }));

    expect(everything).toEqual(expect.arrayContaining(["DS1005 testProbe", "DS1201 Probe"]));
    expect(allowed).not.toContain("DS1201 Probe");
    expect(allowed).not.toContain("DS1005 testProbe");
  });
});

describe("the defaults of a library", () => {
  // A published module and one no manifest export reaches. Each module holds an export
  // only its own file references; the published one also holds exports nothing names.
  const root = writeProject({
    "package.json": `${JSON.stringify({
      name: "@example/defaults",
      private: true,
      type: "module",
      exports: { ".": "./src/index.ts" },
    })}\n`,
    "src/index.ts": [
      'import { callsHelper } from "./internal.js";',
      "",
      "export function unusedPublished(): number {",
      "  return 1;",
      "}",
      "",
      "export function localPublished(): number {",
      "  return 2;",
      "}",
      "",
      "export const viaLocal = localPublished();",
      "export const viaInternal = callsHelper();",
      "",
    ].join("\n"),
    "src/internal.ts": [
      "export function helperLocal(): number {",
      "  return 3;",
      "}",
      "",
      "export function callsHelper(): number {",
      "  return helperLocal();",
      "}",
      "",
    ].join("\n"),
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const reported = (document: Record<string, unknown>): string[] =>
    findingsOf(
      emitterInputOf(
        root,
        resolve({
          repository: JSON.stringify({ target: { kind: "library" }, ...document }),
          repositoryLabel: "deadset.json",
        }).config,
      ),
    ).map((finding) => `${finding.code} ${finding.symbol.name} ${finding.confidence}`);

  it("withholds the published API and narrows only where no manifest export reaches, with no consumer information", () => {
    expect(reported({})).toEqual(["DS1104 helperLocal certain"]);
  });

  it("reports the published API at possible where the configuration lowers the minimum confidence", () => {
    expect(reported({ analysis: { min_confidence: "possible" } })).toEqual([
      "DS1001 unusedPublished possible",
      "DS1001 viaLocal possible",
      "DS1001 viaInternal possible",
      "DS1104 helperLocal certain",
    ]);
  });

  it("reports every kind over the published API once the configuration declares the consumer set complete", () => {
    expect(
      reported({ consumers: { complete: true }, analysis: { min_confidence: "possible" } }),
    ).toEqual([
      "DS1001 unusedPublished possible",
      "DS1001 viaLocal possible",
      "DS1001 viaInternal possible",
      "DS1104 localPublished possible",
      "DS1104 helperLocal certain",
    ]);
  });
});

describe("the confidence of a dead component", () => {
  // A published export only a test calls, and the test, which falls with it.
  const root = writeProject({
    "package.json": `${JSON.stringify({
      name: "@example/capped",
      private: true,
      type: "module",
      exports: { ".": "./src/index.ts" },
    })}\n`,
    "src/index.ts": "export function testedOnly(): number {\n  return 1;\n}\n",
    "src/index.test.ts": [
      'import { testedOnly } from "./index.js";',
      "",
      "export function probe(): number {",
      "  return testedOnly();",
      "}",
      "",
    ].join("\n"),
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const reported = (document: Record<string, unknown>): string[] =>
    findingsOf(
      emitterInputOf(
        root,
        resolve({
          repository: JSON.stringify({ target: { kind: "library" }, ...document }),
          repositoryLabel: "deadset.json",
        }).config,
      ),
    ).map((finding) => `${finding.code} ${finding.symbol.name} ${finding.confidence}`);

  it("caps every finding of a component at its weakest root, so the minimum confidence withholds it whole", () => {
    expect(reported({})).toEqual([]);
    expect(reported({ analysis: { min_confidence: "possible" } })).toEqual([
      "DS1005 probe possible",
      "DS1004 testedOnly possible",
    ]);
  });
});
