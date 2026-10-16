import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { emitterInputOf, findingsOf } from "../../__test-helpers__/emitter-input.ts";
import { fixture } from "../../__test-helpers__/fixtures.ts";
import { writeProject } from "../../__test-helpers__/projects.ts";
import type { ResolvedConfig } from "../config.ts";
import type { CompletedFinding } from "../finding.ts";
import { resolve } from "../resolve.ts";

/** The configuration one target's own document resolves to. */
function configOf(target: string): ResolvedConfig {
  const path = join(target, "deadset.json");
  return resolve({ repository: { text: readFileSync(path, "utf8"), label: path } }).config;
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
      "DS1503 Flag deadset-ts/c-0008 root 1 0",
      "DS1301 written deadset-ts/c-0009 root 1 0",
      "DS1301 shared deadset-ts/c-0010 root 1 0",
      "DS1301 Gauge.#samples deadset-ts/c-0011 root 1 0",
      "DS1301 slots deadset-ts/c-0012 root 1 0",
      "DS1005 Mode.Write deadset-ts/c-0006 root 1 1",
      "DS1006 first<T> deadset-ts/c-0001 root 1 1",
      "DS1006 Box.open<V> deadset-ts/c-0003 root 1 1",
      "DS1006 ID<Phantom> deadset-ts/c-0004 root 1 1",
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

    it("gives each unused dependency a component of its own that deletes no declaration line, and one only dead code uses that code's", () => {
      const input = emitterInputOf(root, configOf(root));
      const rows = findingsOf(input).filter((finding) => finding.code === "DS1701");

      expect(input.swept.sweep.components).toHaveLength(1);
      expect(placements(rows)).toEqual([
        "DS1701 left-pad deadset-ts/c-0001 1 3",
        "DS1701 unused-runtime deadset-ts/c-0002 root 1 0",
        "DS1701 @types/bundled deadset-ts/c-0003 root 1 0",
        "DS1701 unused-dev deadset-ts/c-0004 root 1 0",
        "DS1701 peer-unused deadset-ts/c-0005 root 1 0",
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
    repository: { text: JSON.stringify({ ...own, ...extra }), label: path },
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
      "DS1202 uncalled-interface-method manual warn",
    ]);
  });

  it("gives a dead subject its candidate's relation and a live one none, each in the configurations holding it", () => {
    const rows = claims(reportedUnder("reads-and-writes")).filter((row) =>
      /^(DS1301 written|DS1005 Mode\.Write) /u.test(row),
    );

    expect(rows).toEqual([
      "DS1301 written certain/certain - - [tsconfig.json]",
      "DS1005 Mode.Write certain/certain reference-counting - [tsconfig.json]",
    ]);
  });

  it("reads each subject's facts from its own file where two packages of one name spell one reference", () => {
    expect(
      claims(
        reportedUnder("shared-package-name").filter(
          (finding) => finding.symbol.name === "onlyTested",
        ),
      ),
    ).toEqual(["DS1102 onlyTested certain/certain reference-counting test-only [a/tsconfig.json]"]);
  });

  it("reads each subject's facts from its own position where two declarations of one file spell one reference", () => {
    expect(
      claims(
        reportedUnder("global-blocks-of-one-file").filter(
          (finding) => finding.symbol.name === "global",
        ),
      ),
    ).toEqual(["DS1002 global certain/certain reference-counting - [tsconfig.json]"]);
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

  it("withhold, with a root one family reports at allow, what another family reports in its component", () => {
    const everything = named(reportedUnder("interfaces"));
    const allowed = named(reportedUnder("interfaces", { severity: { DS1002: "allow" } }));

    expect(everything).toContain("DS1201 OnlyDead");
    expect(allowed).not.toContain("DS1201 OnlyDead");
    expect(allowed).toEqual(
      everything.filter((one) => !one.startsWith("DS1002") && one !== "DS1201 OnlyDead"),
    );
  });

  it("withhold a finding that falls with a root alone, leaving the root another family reports", () => {
    const everything = named(reportedUnder("interfaces"));
    const allowed = named(reportedUnder("interfaces", { severity: { DS1201: "allow" } }));

    expect(allowed).toContain("DS1002 orphan");
    expect(allowed).toEqual(
      everything.filter((one) => !one.startsWith("DS1201") && one !== "DS1103 testProbe"),
    );
  });

  it("withhold every root of a component with one of them, whichever family reports each", () => {
    const everything = named(reportedUnder("interfaces"));
    const allowed = named(reportedUnder("interfaces", { severity: { DS1103: "allow" } }));

    expect(everything).toEqual(expect.arrayContaining(["DS1103 testProbe", "DS1201 Probe"]));
    expect(allowed).not.toContain("DS1201 Probe");
    expect(allowed).not.toContain("DS1103 testProbe");
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
          repository: {
            text: JSON.stringify({ target: { kind: "library" }, ...document }),
            label: "deadset.json",
          },
        }).config,
      ),
    ).map((finding) => `${finding.code} ${finding.symbol.name} ${finding.confidence}`);

  it("withholds the published API and narrows only where no manifest export reaches, with no consumer information", () => {
    expect(reported({})).toEqual(["DS1503 helperLocal certain"]);
  });

  it("reports the published API at possible where the configuration lowers the minimum confidence", () => {
    expect(reported({ analysis: { min_confidence: "possible" } })).toEqual([
      "DS1001 unusedPublished possible",
      "DS1001 viaLocal possible",
      "DS1001 viaInternal possible",
      "DS1503 helperLocal certain",
    ]);
  });

  it("reports every kind over the published API once the configuration declares the consumer set complete", () => {
    expect(
      reported({ consumers: { complete: true }, analysis: { min_confidence: "possible" } }),
    ).toEqual([
      "DS1001 unusedPublished possible",
      "DS1001 viaLocal possible",
      "DS1001 viaInternal possible",
      "DS1503 localPublished possible",
      "DS1503 helperLocal certain",
    ]);
  });
});

describe("the confidence of a dead component", () => {
  // A published export only a test calls, and the test.
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
          repository: {
            text: JSON.stringify({ target: { kind: "library" }, ...document }),
            label: "deadset.json",
          },
        }).config,
      ),
    ).map((finding) => `${finding.code} ${finding.symbol.name} ${finding.confidence}`);

  it("withholds the export under the default minimum, and reports no test of it where no consumer judges it", () => {
    expect(reported({})).toEqual([]);
    expect(reported({ analysis: { min_confidence: "possible" } })).toEqual([
      "DS1102 testedOnly possible",
    ]);
  });
});

describe("a test of dead code in a library", () => {
  it("is no test of dead code where a target beside an internal one is published API no consumer judges", () => {
    const root = writeProject({
      "package.json":
        '{ "name": "@example/lib", "type": "module", "exports": { ".": "./src/index.ts" } }\n',
      "tsconfig.json":
        '{ "compilerOptions": { "strict": true, "module": "NodeNext", "moduleResolution": "nodenext", "noEmit": true, "allowImportingTsExtensions": true }, "include": ["src/**/*.ts"] }\n',
      "src/index.ts":
        "export interface Handle {\n  destroy(): void;\n}\n\nexport function make(): Handle {\n  return { destroy() {} };\n}\n",
      "src/index.test.ts":
        'import type { Handle } from "./index.ts";\nimport { reset } from "./internal.ts";\n\nconst held: Handle[] = [];\n\nexport function clean(): void {\n  reset();\n  for (const one of held) {\n    one.destroy();\n  }\n}\n',
      "src/internal.ts": "export function reset(): void {}\n",
    });
    try {
      const { config } = resolve({
        repository: {
          text: '{ "target": { "kind": "library" }, "analysis": { "min_confidence": "possible" } }',
          label: "deadset.json",
        },
      });
      const found = findingsOf(emitterInputOf(root, config)).filter(
        (finding) => finding.code === "DS1103" || finding.symbol.name === "reset",
      );

      expect(
        found.map((finding) => `${finding.code} ${finding.symbol.name} ${finding.confidence}`),
      ).toEqual(["DS1102 reset possible"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function reportedOver(
  files: Readonly<Record<string, string>>,
  document: Record<string, unknown>,
): readonly CompletedFinding[] {
  const root = writeProject(files);
  try {
    const { config } = resolve({
      repository: { text: JSON.stringify(document), label: "deadset.json" },
    });
    return findingsOf(emitterInputOf(root, config));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the configurations a finding holds in", () => {
  it("are the matrix for a file, and the declaring file's for a live declaration and for a part", () => {
    const options = { strict: true, module: "NodeNext", noEmit: true };
    const found = reportedOver(
      {
        "package.json": '{ "name": "@example/split", "type": "module", "main": "./src/main.ts" }\n',
        "tsconfig.json": `${JSON.stringify({ compilerOptions: options, include: ["src/**/*.ts"] })}\n`,
        "tsconfig.tools.json": `${JSON.stringify({ compilerOptions: options, include: ["tools/**/*.ts"] })}\n`,
        "src/main.ts": [
          "let written = 0;",
          "written = 1;",
          "",
          "function scale(value: number, unused: number): number {",
          "  return value * 2;",
          "}",
          "",
          "console.log(scale(1, 2));",
          "",
        ].join("\n"),
        "src/orphan.ts": 'console.log("orphan");\n',
        "tools/run.ts": 'console.log("tool");\n',
      },
      { target: { kind: "application" }, ts: { entry_files: ["src/main.ts", "tools/run.ts"] } },
    );

    expect(
      found.map(
        (finding) =>
          `${finding.code} ${finding.symbol.name} [${finding.configurations.join(",")}] ${finding.testOnly ? "test-only" : "-"}`,
      ),
    ).toEqual([
      "DS1301 written [tsconfig.json] -",
      "DS1602 src/orphan.ts [tsconfig.json,tsconfig.tools.json] -",
      "DS1401 unused [tsconfig.json] -",
    ]);
  });
});

describe("a part of test-support code only test code calls", () => {
  it("is no test-only finding, which only a dead declaration's is", () => {
    const found = reportedOver(
      {
        "package.json": '{ "name": "@example/parts", "type": "module", "main": "./src/main.ts" }\n',
        "node_modules/vitest/package.json":
          '{ "name": "vitest", "version": "1.0.0", "types": "./index.d.ts" }\n',
        "node_modules/vitest/index.d.ts": "export {};\n",
        "src/main.ts": "console.log(1);\n",
        "src/fakes/fake.ts":
          'import "vitest";\n\nexport function fake(value: number, ignored: number): number {\n  return value;\n}\n',
        "src/main.test.ts": 'import { fake } from "./fakes/fake.js";\n\nconsole.log(fake(1, 2));\n',
      },
      { target: { kind: "application" } },
    );

    expect(
      found.map((finding) => `${finding.code} ${finding.symbol.name} ${String(finding.testOnly)}`),
    ).toEqual(["DS1401 ignored false"]);
  });
});

describe("a dead component whose root is certain and a member falling with it is not", () => {
  // `in` tests the member by name, so only `area` of the two is possible.
  const SHAPES = {
    "package.json": '{ "name": "@example/shapes", "type": "module", "main": "./src/main.ts" }\n',
    "src/main.ts": [
      "class Shape {",
      "  area(): number {",
      "    return 1;",
      "  }",
      "  name(): string {",
      '    return "shape";',
      "  }",
      "}",
      "",
      "function deadCaller(shape: Shape): number {",
      "  return shape.area();",
      "}",
      "",
      "const shape = new Shape();",
      'console.log(shape.name(), "area" in shape);',
      "",
    ].join("\n"),
  };
  const claimed = (document: Record<string, unknown>): string[] =>
    reportedOver(SHAPES, { target: { kind: "application" }, ...document }).map(
      (finding) => `${finding.code} ${finding.symbol.name} ${finding.confidence}`,
    );

  it("keeps the root at its own class, and the member at its", () => {
    expect(claimed({ analysis: { min_confidence: "possible" } })).toEqual([
      "DS1003 Shape.area possible",
      "DS1002 deadCaller certain",
    ]);
  });

  it("reports the root alone under the default minimum confidence", () => {
    expect(claimed({})).toEqual(["DS1002 deadCaller certain"]);
  });
});

describe("a component listed in full", () => {
  it("names every member in position order, each to the last line it spans", () => {
    const found = reportedOver(
      {
        "package.json":
          '{ "name": "@example/cascade", "type": "module", "main": "./src/main.ts" }\n',
        "src/later.ts": "export function later(): number {\n  return 3;\n}\n",
        "src/main.ts": [
          'import { later } from "./later.js";',
          "",
          "function late(): number {",
          "  return 1;",
          "}",
          "",
          "function deadCaller(): number {",
          "  return (",
          "    late() +",
          "    early() +",
          "    later()",
          "  );",
          "}",
          "",
          "function early(): number {",
          "  return 2;",
          "}",
          "",
          "console.log(1);",
          "",
        ].join("\n"),
      },
      { target: { kind: "application" }, reporters: { cascade: "full" } },
    );
    const root = found.find((finding) => finding.symbol.name === "deadCaller");

    expect(
      root?.component.members?.map(
        (member) =>
          `${member.name} ${member.position.path}:${String(member.position.line)}-${String(member.position.endLine)}`,
      ),
    ).toEqual([
      "later src/later.ts:1-3",
      "late src/main.ts:3-5",
      "deadCaller src/main.ts:7-13",
      "early src/main.ts:15-17",
    ]);
  });

  it("names the subject alone for a component minted for a subject in no dead component", () => {
    const found = reportedOver(
      {
        "package.json":
          '{ "name": "@example/minted", "type": "module", "main": "./src/main.ts" }\n',
        "src/main.ts":
          "export function used(kept: number, spare: number): number {\n  return kept;\n}\n",
      },
      { target: { kind: "application" }, reporters: { cascade: "full" } },
    );
    const part = found.find((finding) => finding.code === "DS1401");

    expect(part?.component.members).toEqual([
      { ref: part?.symbol.ref, name: part?.symbol.name, position: part?.position },
    ]);
  });

  it("names an interface and the members that fall with it for a component minted for an interface tests hold", () => {
    const found = reportedOver(
      {
        "package.json": '{ "name": "@example/probe", "type": "module", "main": "./src/main.ts" }\n',
        "tsconfig.json": `${JSON.stringify({
          compilerOptions: { strict: true, module: "NodeNext", noEmit: true, types: [] },
          include: ["src", "tests"],
        })}\n`,
        "src/main.ts": "export const run = 1;\n",
        "tests/support.ts": [
          'import test from "node:test";',
          "export interface Probe {",
          "  check(): void;",
          "  other(): void;",
          "}",
          "export class Impl implements Probe {",
          "  check(): void {}",
          "  other(): void {}",
          "}",
          "export const runner = test;",
          "",
        ].join("\n"),
        "tests/a.test.ts": [
          'import { Impl } from "./support.js";',
          "const probe = new Impl();",
          "probe.check();",
          "probe.other();",
          "",
        ].join("\n"),
      },
      {
        target: { kind: "application" },
        reporters: { cascade: "full" },
        ts: { test_files: ["tests/**/*.test.ts"] },
      },
    );
    const probe = found.find((finding) => finding.symbol.name === "Probe");

    expect(probe?.component.symbolCount).toBe(3);
    expect(probe?.component.members?.map((member) => member.name)).toEqual([
      "Probe",
      "Probe.check",
      "Probe.other",
    ]);
  });
});
