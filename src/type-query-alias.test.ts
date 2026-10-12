import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isIdentifier, isVariableDeclaration } from "@typescript/native/ast";
import { afterAll, describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { emitterInputOf, findingsOf } from "../__test-helpers__/emitter-input.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { runRoots } from "./analysis.ts";
import { resolve } from "./resolve.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine } from "./session.ts";
import { typeQueryAliases } from "./type-query-alias.ts";

const TARGET = fixture("projects", "type-query-alias");

const CONFIG = ((): ReturnType<typeof resolve> => {
  const document = join(TARGET, "deadset.json");
  return resolve({ repository: readFileSync(document, "utf8"), repositoryLabel: document });
})();

/** Every finding of the fixture's production sweep, as `code path:line name`. */
const FINDINGS = findingsOf(emitterInputOf(TARGET, CONFIG.config)).map(
  (finding) =>
    `${finding.code} ${finding.position.path}:${String(finding.position.line)} ${finding.symbol.name}`,
);

/** Every root of the fixture, as `ref kind`. */
const ROOTS = ((): string[] => {
  const host = nodeHost();
  return runRoots(
    openEngine({ collectTiming: false }),
    host,
    scopeForDir(host, TARGET),
    CONFIG.config,
    CONFIG.provenance,
  ).roots.map((root) => `${root.ref.replace(/^.*\//u, "")} ${root.kind}`);
})();

describe("a global a declaration file declares as an alias of a module's export", () => {
  it("is used where the global is, through the indexed and the qualified form alike", () => {
    expect(
      FINDINGS.filter((line) => / (useIndexed|useQualified|useScript|useAugmented)$/u.test(line)),
    ).toEqual([]);
  });

  it("is used through every link of a re-export chain the alias names", () => {
    expect(FINDINGS.filter((line) => / (viaReexport|inner)$/u.test(line))).toEqual([]);
  });

  it("is not used by the alias's own type query, in either form", () => {
    expect(FINDINGS.filter((line) => line.startsWith("DS1001 counter.ts"))).toEqual([
      "DS1001 counter.ts:13 unusedIndexed",
      "DS1001 counter.ts:17 unusedQualified",
    ]);
  });

  it("is reported by nothing, nor is a module declaration around it", () => {
    expect(FINDINGS.filter((line) => / ([a-z-]*globals|augment)\.d\.ts:/u.test(line))).toEqual([]);
  });

  it("is a root with every module declaration around it, at a script's top level too", () => {
    expect([...new Set(ROOTS.filter((line) => line.endsWith(" type-query-alias")))]).toEqual([
      "augment.d.ts#'example-ambient' type-query-alias",
      "augment.d.ts#'example-ambient'.global type-query-alias",
      "augment.d.ts#'example-ambient'.global.useAugmented type-query-alias",
      "globals.d.ts#global type-query-alias",
      "globals.d.ts#global.useIndexed type-query-alias",
      "globals.d.ts#global.useQualified type-query-alias",
      "globals.d.ts#global.viaReexport type-query-alias",
      "globals.d.ts#global.unusedIndexed type-query-alias",
      "globals.d.ts#global.unusedQualified type-query-alias",
      "script-globals.d.ts#useScript type-query-alias",
    ]);
  });

  it("is no alias when a source file that is no declaration file declares it", () => {
    expect(ROOTS.filter((line) => line.startsWith("source-globals.ts"))).toEqual([]);
    expect(
      FINDINGS.filter((line) => line.endsWith(" useInSource")),
      "the global's literal indexed-access type references the export as any such type does",
    ).toEqual([]);
  });
});

const engine = openEngine({ collectTiming: false });
afterAll(() => {
  engine.close();
});

function aliasesOf(fileName: string, lines: readonly string[]): string[] {
  return typeQueryAliases(engine.parseSourceFile(fileName, lines.join("\n"))).map((alias) => {
    const name =
      isVariableDeclaration(alias.declaration) && isIdentifier(alias.declaration.name)
        ? alias.declaration.name.text
        : "?";
    return `${name} -> ${alias.name}, ${String(alias.containers.length)}`;
  });
}

describe("the aliases one file declares", () => {
  it("are the variables of a script declaration file typed as a module's export, in either form", () => {
    expect(
      aliasesOf("/target/globals.d.ts", [
        'declare var indexed: typeof import("m")["x"];',
        'declare var qualified: typeof import("m").y;',
        'declare var typeOnly: import("m").Z;',
        'declare var instantiated: typeof import("m").f<number>;',
        'declare var notAModule: typeof import(m)["x"];',
        'declare var notAnImport: Box["k"];',
        'declare var qualifiedIndex: typeof import("m").ns["k"];',
        "declare var plain: number;",
      ]),
    ).toEqual(["indexed -> x, 0", "qualified -> y, 0"]);
  });

  it("are, in a module declaration file, only those its declare global block holds", () => {
    expect(
      aliasesOf("/target/augment.d.ts", [
        'declare var scoped: typeof import("m")["x"];',
        "declare global {",
        '  var inGlobal: typeof import("m")["y"];',
        "}",
        "export {};",
      ]),
    ).toEqual(["inGlobal -> y, 1"]);
  });

  it("are read in a declare global block an ambient module holds, with both around it", () => {
    expect(
      aliasesOf("/target/ambient.d.ts", [
        'declare module "pkg" {',
        "  global {",
        '    var ambient: typeof import("m")["x"];',
        "  }",
        "}",
      ]),
    ).toEqual(["ambient -> x, 2"]);
  });

  it("are not read in a namespace or a module named by an identifier", () => {
    expect(
      aliasesOf("/target/named.d.ts", [
        "declare namespace global {",
        '  var namespaced: typeof import("m")["x"];',
        "}",
        "declare module Named {",
        '  var moduled: typeof import("m")["x"];',
        "}",
        "declare namespace Outer {",
        "  global {",
        '    var nested: typeof import("m")["x"];',
        "  }",
        "}",
        "export {};",
      ]),
    ).toEqual([]);
  });

  it("are none in a source file that is no declaration file", () => {
    expect(
      aliasesOf("/target/source.ts", [
        'declare var top: typeof import("m")["x"];',
        "declare global {",
        '  var inBlock: typeof import("m")["y"];',
        "}",
      ]),
    ).toEqual([]);
  });
});
