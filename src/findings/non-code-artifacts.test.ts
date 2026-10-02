import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitterInputOf } from "../../__test-helpers__/emitter-input.ts";
import { contractDocument, fixture, readFixture } from "../../__test-helpers__/fixtures.ts";
import { writeProject } from "../../__test-helpers__/projects.ts";
import type { Config } from "../config.ts";
import type { Finding } from "../finding.ts";
import { resolve } from "../resolve.ts";
import type { EmitterInput } from "./emitter.ts";
import { EMITTERS } from "./emitters.ts";

const MATRIX = fixture("projects", "non-code-artifacts-matrix");
const IMPORTS = fixture("projects", "non-code-artifacts-imports");
const CORPUS = fixture("corpus", "entry-file-declaring-nothing");

/** The configuration a target's own document resolves to, or the one given. */
function configOf(target: string, document?: string): Config {
  const path = join(target, "deadset.json");
  return resolve({
    repository: document ?? readFileSync(path, "utf8"),
    repositoryLabel: path,
  }).config;
}

/**
 * What the family reads of one target swept for production under one configuration,
 * with each declared edge side named naming one symbol.
 */
function inputFor(
  target: string,
  config: Config,
  extra: { readonly marked?: readonly string[]; readonly edgeSides?: readonly string[] } = {},
): EmitterInput {
  const input = emitterInputOf(target, config, { marked: extra.marked ?? [] });
  const edges = (extra.edgeSides ?? []).map((symbol) => ({
    edge: "fixture/edge",
    side: "used_by" as const,
    symbol,
  }));
  return { ...input, boundary: { ...input.boundary, edges } };
}

/** The family's findings, through the emitter table. */
function emit(input: EmitterInput): readonly Finding[] {
  const emitter = EMITTERS.get("non-code-artifacts");
  if (emitter === undefined) {
    throw new Error("the emitter table holds no non-code-artifacts family");
  }
  return emitter(input);
}

/** The golden table: one line per finding, so a diff names the finding that moved. */
function goldenText(findings: readonly Finding[]): string {
  return findings
    .map(({ code, position, symbol, message }) =>
      [
        `${position.path}:${String(position.line)}:${String(position.column)}-${String(position.endLine)}`,
        code,
        symbol.kind,
        symbol.name,
        String(symbol.sizeLines),
        symbol.ref,
        message,
      ].join("\t"),
    )
    .map((line) => `${line}\n`)
    .join("");
}

/** Each finding as its code and its path. */
function reported(findings: readonly Finding[]): string[] {
  return findings.map((finding) => `${finding.code} ${finding.position.path}`);
}

describe("DS1501 under the build matrix", () => {
  it("reports each source file no project of a complete matrix includes, at the scope of its own package", async () => {
    const findings = emit(inputFor(MATRIX, configOf(MATRIX)));

    expect(reported(findings)).toEqual(["DS1501 src/legacy/old.ts", "DS1501 tools/build.ts"]);
    await expect(
      goldenText(findings),
      "regenerate with `npx vitest --run -u src/findings/non-code-artifacts.test.ts` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "non-code-artifacts-matrix.findings.txt"));
  });

  it("reads no file below a directory discovery skips, and ends a file at the line of its last character", () => {
    const root = writeProject({
      "package.json": '{ "name": "@example/written", "type": "module", "main": "./src/main.ts" }\n',
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, module: "NodeNext", noEmit: true },
        include: ["src/**/*.ts"],
      }),
      "src/main.ts": "export const main = 1;\n",
      "unbuilt.ts": "export const first = 1;\r\nexport const second = 2;\r\n",
      "node_modules/dependency/index.ts": "export const dependency = 1;\n",
      ".git/hooks/hook.ts": "export const hook = 1;\n",
    });
    try {
      const config = configOf(
        root,
        JSON.stringify({
          target: { kind: "application" },
          analysis: {
            configurations: [{ id: "only", project: "tsconfig.json" }],
            matrix: { complete: true },
          },
        }),
      );
      const findings = emit(inputFor(root, config));

      expect(goldenText(findings)).toBe(
        "unbuilt.ts:1:1-2\tDS1501\tfile\tunbuilt.ts\t2\tts://@example/written/unbuilt.ts#\t" +
          "no project of the build matrix includes this file (only)\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports nothing where the configuration lists the projects and does not declare them complete", () => {
    const config = configOf(
      MATRIX,
      JSON.stringify({
        target: { kind: "application" },
        analysis: {
          configurations: [
            { id: "app", project: "tsconfig.json" },
            { id: "scripts", project: "tsconfig.scripts.json" },
          ],
        },
        ts: { entry_files: ["scripts/check.ts"] },
      }),
    );

    expect(reported(emit(inputFor(MATRIX, config)))).toEqual([]);
  });

  it("reports nothing where the configuration declares completeness of a matrix it lists no project of", () => {
    const config = configOf(
      MATRIX,
      JSON.stringify({
        target: { kind: "application" },
        analysis: { matrix: { complete: true } },
        ts: { entry_files: ["scripts/check.ts"] },
      }),
    );

    expect(reported(emit(inputFor(MATRIX, config)))).toEqual([]);
  });
});

describe("DS1502 over the import graph", () => {
  it("reports each file no import reaches and no root names, and keeps every file a program holds by inclusion", async () => {
    const findings = emit(inputFor(IMPORTS, configOf(IMPORTS)));

    expect(reported(findings)).toEqual([
      "DS1502 src/dead-importer.ts",
      "DS1502 src/lone.ts",
      "DS1502 src/orphan.ts",
    ]);
    await expect(
      goldenText(findings),
      "regenerate with `npx vitest --run -u src/findings/non-code-artifacts.test.ts` and review the diff",
    ).toMatchFileSnapshot(fixture("golden", "non-code-artifacts-imports.findings.txt"));
  });

  it("keeps a file whose declaration a suppression holds live", () => {
    const findings = emit(inputFor(IMPORTS, configOf(IMPORTS), { marked: ["src/orphan.ts:1:17"] }));

    expect(reported(findings)).toEqual(["DS1502 src/dead-importer.ts", "DS1502 src/lone.ts"]);
  });

  it("keeps a file in which a declared cross-language edge names a declaration", () => {
    const findings = emit(
      inputFor(IMPORTS, configOf(IMPORTS), {
        edgeSides: ["ts://@example/non-code-artifacts-imports/src/orphan.ts#orphan"],
      }),
    );

    expect(reported(findings)).toEqual(["DS1502 src/dead-importer.ts", "DS1502 src/lone.ts"]);
  });

  it("keeps a file a configured root names a declaration in", () => {
    const config = configOf(
      IMPORTS,
      JSON.stringify({
        target: { kind: "application" },
        roots: { patterns: ["ts://@example/non-code-artifacts-imports/src/dead-importer.ts#*"] },
      }),
    );

    expect(reported(emit(inputFor(IMPORTS, config)))).toEqual([
      "DS1502 src/lone.ts",
      "DS1502 src/orphan.ts",
    ]);
  });
});

/** The subject kind of every finding this family reports. */
const FILE_KIND = "file";

/** The members of a finding-schema branch these tests read, each optional as the schema's shapes vary. */
interface Branch {
  readonly if?: {
    readonly properties?: {
      readonly code?: { readonly const?: string };
      readonly language?: { readonly const?: string };
    };
    readonly anyOf?: readonly {
      readonly properties?: {
        readonly symbol?: {
          readonly properties?: { readonly kind?: { readonly enum?: string[] } };
        };
      };
    }[];
  };
  readonly then?: { readonly allOf?: readonly Branch[] };
  readonly else?: {
    readonly properties?: {
      readonly details?: { readonly not?: { readonly required?: string[] } };
    };
  };
}

/** One row of a corpus fixture's expectation file, as far as this family reads it. */
interface ExpectRow {
  readonly symbol: string;
  readonly report: string;
  readonly symbol_kind?: string;
}

describe("the corpus fixture entry-file-declaring-nothing", () => {
  const expectation = JSON.parse(
    readFixture("corpus", "entry-file-declaring-nothing", "expect.json"),
  ) as { readonly target_kind: string; readonly expect: readonly ExpectRow[] };
  const manifest = JSON.parse(
    readFixture("corpus", "entry-file-declaring-nothing", "ts", "fixture.json"),
  ) as { readonly symbols: Readonly<Record<string, { file: string; line: number }>> };
  const target = join(CORPUS, "ts", "target");
  const findings = emit(
    inputFor(
      target,
      configOf(target, JSON.stringify({ target: { kind: expectation.target_kind } })),
    ),
  );

  it.each(expectation.expect)("answers the row naming $symbol with $report", (row) => {
    const bound = manifest.symbols[row.symbol];
    expect(bound).toBeDefined();
    const at = findings.filter(
      (finding) =>
        `target/${finding.position.path}` === bound?.file && finding.position.line === bound.line,
    );

    if (row.report === "none") {
      expect(reported(at)).toEqual([]);
    } else {
      expect(at.map((finding) => [finding.code, finding.symbol.kind])).toEqual([
        [row.report, row.symbol_kind ?? FILE_KIND],
      ]);
    }
  });
});

describe("what the Contract leaves a TypeScript file finding to carry", () => {
  const branches = contractDocument("finding.schema.json")["allOf"] as readonly Branch[];

  it("forbids excluded_by on a TypeScript DS1501, so the finding names its projects in its message", () => {
    const branch = branches.find((one) => one.if?.properties?.code?.const === "DS1501");
    const arm = branch?.then?.allOf?.[0];

    expect(arm?.if?.properties?.language?.const).toBe("go");
    expect(arm?.else?.properties?.details?.not?.required).toEqual(["excluded_by"]);
  });

  it("names a file among the subjects that carry no liveness relation", () => {
    const absent = branches.flatMap((one) =>
      (one.if?.anyOf ?? []).flatMap((arm) => arm.properties?.symbol?.properties?.kind?.enum ?? []),
    );

    expect(absent).toContain(FILE_KIND);
  });
});
