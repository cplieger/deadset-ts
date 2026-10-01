import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { analyzeRoot, type Analyzed } from "../__test-helpers__/projects.ts";
import { runRoots, type RunRoots } from "./analysis.ts";
import { resolve } from "./resolve.ts";
import { matchRef } from "./roots.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine } from "./session.ts";

/** Every root of one analysis as `ref kind source`, in the order the set is returned. */
function rootLines(analyzed: Analyzed): string[] {
  return analyzed.roots.flatMap((rooted, index) => {
    const refs = new Map(
      (analyzed.inventories[index]?.symbols ?? []).map((symbol) => [symbol.id, symbol.ref]),
    );
    return rooted.liveUnderReachability.map((root) =>
      [refs.get(root.id) ?? root.id, root.kind, root.source].join(" ").trimEnd(),
    );
  });
}

/** The root set of a run over one target, its roots read from the document named. */
function runOver(target: string, document = join(target, "deadset.json")): RunRoots {
  const host = nodeHost();
  const { config, provenance } = resolve({
    repository: readFileSync(document, "utf8"),
    repositoryLabel: document,
  });
  return runRoots(
    openEngine({ collectTiming: false }),
    host,
    scopeForDir(host, target),
    config,
    provenance,
  );
}

const NO_CONFIGURED = { patterns: [], entryFiles: [], testFiles: [], publishedAPI: false };

describe("the roots a manifest names", () => {
  const ENTRY_POINTS = analyzeRoot(fixture("projects", "entry-points"), { roots: NO_CONFIGURED });

  it("roots the file each of main, module, types and bin names, with what it exports", () => {
    expect(rootLines(ENTRY_POINTS)).toEqual([
      'ts://@example/entry-points/src/command.ts# manifest-binary bin["entry-points"]',
      'ts://@example/entry-points/src/command.ts#runCommand manifest-binary bin["entry-points"]',
      "ts://@example/entry-points/src/main.ts# manifest-entry main",
      "ts://@example/entry-points/src/main.ts#runMain manifest-entry main",
      "ts://@example/entry-points/src/main.ts#mainCount manifest-entry main",
      "ts://@example/entry-points/src/module.ts# manifest-entry module",
      "ts://@example/entry-points/src/module.ts#moduleEntry manifest-entry module",
      "ts://@example/entry-points/src/types.ts# manifest-entry types",
      "ts://@example/entry-points/src/types.ts#Entry manifest-entry types",
    ]);
  });

  it("reads an emitted target back to the source the project emits it from", () => {
    const lines = rootLines(ENTRY_POINTS);

    expect(lines, "main names ./dist/main.js").toContain(
      "ts://@example/entry-points/src/main.ts# manifest-entry main",
    );
    expect(lines, "types names ./dist/types.d.ts").toContain(
      "ts://@example/entry-points/src/types.ts# manifest-entry types",
    );
  });

  it("roots no declaration a file holds without exporting it, and no file nothing names", () => {
    const lines = rootLines(ENTRY_POINTS).join("\n");

    expect(lines).not.toContain("#unexported");
    expect(lines).not.toContain("unreached.ts");
  });
});

describe("the published API of a library target", () => {
  const PUBLISHED = analyzeRoot(fixture("projects", "published-exports"), {
    roots: { ...NO_CONFIGURED, publishedAPI: true },
  });
  const published = rootLines(PUBLISHED)
    .filter((line) => line.endsWith(" published-api"))
    .map((line) => line.slice(0, -" published-api".length));

  it("is what exports reaches, re-exports and subpath patterns included", () => {
    expect(published).toEqual([
      "ts://@example/published-exports/src/features/one.ts#featureOne",
      "ts://@example/published-exports/src/helper.ts#helper",
      "ts://@example/published-exports/src/index.ts#Published",
      "ts://@example/published-exports/src/index.ts#Published.open",
      "ts://@example/published-exports/src/index.ts#value",
      "ts://@example/published-exports/src/index.ts#built",
      "ts://@example/published-exports/src/index.ts#Reexported:alias",
      "ts://@example/published-exports/src/reexported.ts#Reexported",
      "ts://@example/published-exports/src/reexported.ts#Reexported.open",
      "ts://@example/published-exports/src/reexported.ts#Reexported.guarded",
      "ts://@example/published-exports/src/starred.ts#starred",
      "ts://@example/published-exports/src/starred.ts#alsoStarred",
    ]);
  });

  it("leaves out what main names beside exports, private members and undeclared classes", () => {
    const text = published.join("\n");

    expect(text, "a manifest declaring exports publishes nothing main alone names").not.toContain(
      "legacy",
    );
    expect(text).not.toContain("Published.closed");
    expect(text).not.toContain("Reexported.hidden");
    expect(text, "a class the file does not export is not published").not.toContain("Unexported");
  });

  it("is not rooted for an application target", () => {
    const application = analyzeRoot(fixture("projects", "published-exports"), {
      roots: NO_CONFIGURED,
    });

    expect(rootLines(application).filter((line) => line.endsWith(" published-api"))).toEqual([]);
  });
});

describe("configured roots and patterns", () => {
  const CONFIGURED = runOver(fixture("projects", "configured-roots"));

  it("roots what an exact entry, a star across a solidus and a question mark name", () => {
    expect(
      CONFIGURED.roots.map((root) => `${root.ref} ${root.kind} ${root.configurations.join(",")}`),
    ).toEqual([
      "ts://@example/configured-roots/a/one.ts#one configured a/tsconfig.json",
      "ts://@example/configured-roots/a/one.ts#Keyed.🚀 pattern a/tsconfig.json",
      "ts://@example/configured-roots/b/nested/deep.ts#deep pattern b/tsconfig.json",
    ]);
  });

  it("reports each string that names nothing in any project once, in configuration order", () => {
    expect(CONFIGURED.findings.map((finding) => finding.symbol.ref)).toEqual([
      "ts://@example/configured-roots/a/gone.ts#gone",
      "ts://@example/configured-roots/*#nothing?",
    ]);
  });

  it("states each finding in the finding schema's shape, at the declaring document", () => {
    expect(CONFIGURED.findings[0]).toEqual({
      code: "DS1704",
      position: { path: "deadset.json", line: 1, column: 1, endLine: 1 },
      symbol: {
        ref: "ts://@example/configured-roots/a/gone.ts#gone",
        kind: "root",
        name: "ts://@example/configured-roots/a/gone.ts#gone",
        sizeLines: 1,
      },
      message: "configured root matches no symbol of the inventory",
    });
    expect(CONFIGURED.findings[1]?.message).toBe(
      "configured root pattern matches no symbol of the inventory",
    );
  });

  it("sits at the path of a document below the target that is not the conventional one", () => {
    const run = runOver(
      fixture("projects", "configured-roots"),
      fixture("projects", "configured-roots", "config", "roots.json"),
    );

    expect(run.findings.map((finding) => finding.position)).toEqual([
      { path: "config/roots.json", line: 1, column: 1, endLine: 1 },
    ]);
  });

  it("sits at the conventional document where the document is not below the target", () => {
    const dir = mkdtempSync(join(tmpdir(), "deadset-ts-roots-"));
    try {
      const outside = join(dir, "roots.json");
      writeFileSync(
        outside,
        JSON.stringify({ target: { kind: "application" }, roots: { patterns: ["ts://x#y"] } }),
      );
      const run = runOver(fixture("projects", "configured-roots"), outside);

      expect(run.findings.map((finding) => finding.position.path)).toEqual(["deadset.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the pattern rule", () => {
  it.each([
    ["go://example.com/app#Catalog.*", "go://example.com/app#Catalog.ResolveAlias", true],
    ["go://example.com/app#Catalog.*", "go://example.com/app#Catalog", false],
    ["go://example.com/app/internal/*#*", "go://example.com/app/internal/a/b#Roots", true],
    [
      "ts://@example/app/src/generated/*.ts#*",
      "ts://@example/app/src/generated/deep/wire.ts#Event",
      true,
    ],
    ["ts://@example/app/src/route-v?.ts#*", "ts://@example/app/src/route-v2.ts#handler", true],
    ["ts://@example/app/src/route-v?.ts#*", "ts://@example/app/src/route-v12.ts#handler", false],
    ["ts://./a.ts#?", "ts://./a.ts#🚀", true],
    ["ts://./a.ts#??", "ts://./a.ts#🚀", false],
    ["ts://./a.ts#A", "ts://./a.ts#AB", false],
    ["ts://./a.ts#[Symbol.iterator]", "ts://./a.ts#[Symbol.iterator]", true],
    ["ts://./a.ts#[Symbol.iterator]", "ts://./a.ts#[Symbol.iterator2]", false],
    ["a*b*c", "abbbc", true],
    ["a*b*c", "ac", false],
  ])("matchRef(%j, %j) is %j", (pattern, ref, want) => {
    expect(matchRef(pattern, ref)).toBe(want);
  });
});
