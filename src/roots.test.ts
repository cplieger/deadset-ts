import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture, readFixture } from "../__test-helpers__/fixtures.ts";
import {
  analyzeRoot,
  TSCONFIG,
  writeProject,
  type Analyzed,
} from "../__test-helpers__/projects.ts";
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

  it("reads a target no emit mapping reaches back by name, at a directory boundary, to a file a configuration file roots", () => {
    const root = writeProject({
      "package.json":
        '{ "name": "@example/app", "type": "module", "main": "./dist/index.js", "module": "./dist/main.mjs", "bin": { "tool": "./dist/cli/main.js" } }\n',
      "deadset.json": '{ "target": { "kind": "application" } }\n',
      "build.config.ts":
        'export default { entry: ["./src/index.ts", "./src/cli/main.ts", "./src/domain.ts"] };\n',
      "src/index.ts": "export const index = 1;\n",
      "src/cli/main.ts": "export const cli = 1;\n",
      "src/domain.ts": "export const domain = 1;\n",
    });
    try {
      expect(
        runOver(root)
          .roots.filter((one) => one.kind.startsWith("manifest-"))
          .map((one) => `${one.ref} ${one.kind} ${one.source}`),
      ).toEqual([
        'ts://@example/app/src/cli/main.ts# manifest-binary bin["tool"]',
        "ts://@example/app/src/cli/main.ts# manifest-entry module",
        'ts://@example/app/src/cli/main.ts#cli manifest-binary bin["tool"]',
        "ts://@example/app/src/cli/main.ts#cli manifest-entry module",
        "ts://@example/app/src/index.ts# manifest-entry main",
        "ts://@example/app/src/index.ts#index manifest-entry main",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the roots a manifest's scripts name", () => {
  const SCRIPTS = runOver(fixture("projects", "script-entries")).roots.map(
    (root) => `${root.position.path} ${root.kind} ${root.source}`,
  );

  it("root each file a token names, with what it exports, through the emit mapping too", () => {
    expect(SCRIPTS.filter((line) => line.includes(" script "))).toEqual([
      'built.ts script scripts["built"]',
      'built.ts script scripts["built"]',
      'scripts/chained.ts script scripts["chain"]',
      'scripts/chained.ts script scripts["chain"]',
      'scripts/double.ts script scripts["quoted"]',
      'scripts/double.ts script scripts["quoted"]',
      'scripts/plain.ts script scripts["plain"]',
      'scripts/plain.ts script scripts["plain"]',
      'scripts/semi.ts script scripts["chain"]',
      'scripts/semi.ts script scripts["chain"]',
      'scripts/single.ts script scripts["quoted"]',
      'scripts/single.ts script scripts["quoted"]',
    ]);
  });

  it("root no file a pattern token or no token names", () => {
    expect(SCRIPTS.filter((line) => /pattern-one|unnamed/u.test(line))).toEqual([]);
  });

  it("root the file a workspace member's script names, spelled under the member's manifest", () => {
    const root = writeProject({
      "pnpm-workspace.yaml": 'packages: ["packages/*"]\n',
      "package.json": '{ "name": "@example/root", "private": true }\n',
      "deadset.json": '{ "target": { "kind": "application" } }\n',
      "packages/tool/package.json":
        '{ "name": "@example/tool", "private": true, "type": "module", "scripts": { "gen": "node ./bin/gen.ts" } }\n',
      "packages/tool/bin/gen.ts": "export function gen(): void {}\n",
      "packages/tool/bin/other.ts": "export function other(): void {}\n",
    });
    try {
      expect(
        runOver(root)
          .roots.filter((one) => one.kind === "script")
          .map((one) => `${one.ref} ${one.source}`),
      ).toEqual([
        'ts://@example/tool/bin/gen.ts# packages/tool/package.json scripts["gen"]',
        'ts://@example/tool/bin/gen.ts#gen packages/tool/package.json scripts["gen"]',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the roots the manifest of a package below the target names", () => {
  it("root its entry points, spelled under its manifest, where the target root holds no manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "deadset-ts-"));
    const files = {
      "deadset.json": '{ "target": { "kind": "application" } }\n',
      "web/package.json":
        '{ "name": "@example/web", "private": true, "type": "module", "exports": { ".": "./src/index.ts" } }\n',
      "web/tsconfig.json": TSCONFIG,
      "web/src/index.ts": "export function served(): void {}\n",
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    try {
      expect(
        runOver(root)
          .roots.filter((one) => one.kind === "manifest-entry")
          .map((one) => `${one.ref} ${one.source}`),
      ).toEqual([
        'ts://@example/web/src/index.ts# web/package.json exports["."]',
        'ts://@example/web/src/index.ts#served web/package.json exports["."]',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("publish only what its exports name where it declares them", () => {
    const root = mkdtempSync(join(tmpdir(), "deadset-ts-"));
    const files = {
      "deadset.json": '{ "target": { "kind": "library" } }\n',
      "web/package.json":
        '{ "name": "@example/web", "type": "module", "main": "./src/main.ts", "exports": { ".": "./src/index.ts" } }\n',
      "web/tsconfig.json": TSCONFIG,
      "web/src/index.ts": "export function served(): void {}\n",
      "web/src/main.ts": "export function started(): void {}\n",
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    try {
      expect(
        runOver(root)
          .roots.filter((one) => one.kind === "published-api")
          .map((one) => one.ref),
      ).toEqual(["ts://@example/web/src/index.ts#served"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it("reaches the members of an unexported type a published declaration's type names", () => {
    const root = writeProject({
      "package.json": `${JSON.stringify({
        name: "@example/exposed",
        private: true,
        type: "module",
        exports: { ".": "./src/index.ts" },
      })}\n`,
      "src/index.ts": [
        "export namespace JSX {",
        "  interface Shared {",
        "    title?: string;",
        "  }",
        "  interface Anchor {",
        "    href?: string;",
        "  }",
        "  export interface Elements extends Shared {",
        "    a: Anchor;",
        "  }",
        "}",
        "interface Options {",
        "  retries: number;",
        "}",
        "interface Hidden {",
        "  never: number;",
        "}",
        "export function connect(options: Options): number {",
        "  const hidden: Hidden = { never: options.retries };",
        "  return hidden.never;",
        "}",
        "",
      ].join("\n"),
    });
    try {
      expect(
        rootLines(analyzeRoot(root, { roots: { ...NO_CONFIGURED, publishedAPI: true } }))
          .filter((line) => line.endsWith(" published-api"))
          .map((line) => line.slice("ts://@example/exposed/src/index.ts#".length)),
      ).toEqual([
        "JSX published-api",
        "JSX.Shared published-api",
        "JSX.Shared.title published-api",
        "JSX.Anchor published-api",
        "JSX.Anchor.href published-api",
        "JSX.Elements published-api",
        "JSX.Elements.a published-api",
        "Options published-api",
        "Options.retries published-api",
        "connect published-api",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not reach a type only a member a consumer cannot name writes", () => {
    const root = writeProject({
      "package.json": `${JSON.stringify({
        name: "@example/exposed",
        private: true,
        type: "module",
        exports: { ".": "./src/index.ts" },
      })}\n`,
      "src/index.ts": [
        "interface Hidden {",
        "  secret: number;",
        "}",
        "export class Client {",
        "  private state: Hidden = { secret: 1 };",
        "  read(): number {",
        "    return this.state.secret;",
        "  }",
        "}",
        "",
      ].join("\n"),
    });
    try {
      expect(
        rootLines(analyzeRoot(root, { roots: { ...NO_CONFIGURED, publishedAPI: true } }))
          .filter((line) => line.endsWith(" published-api"))
          .map((line) => line.slice("ts://@example/exposed/src/index.ts#".length)),
      ).toEqual(["Client published-api", "Client.read published-api"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

/** One case of the Contract's pattern corpus. */
interface PatternCase {
  readonly pattern: string;
  readonly reference: string;
  readonly matches: boolean;
  readonly reason: string;
}

const PATTERN_CORPUS = JSON.parse(
  readFixture("contract", "grammar", "pattern-corpus.json"),
) as readonly PatternCase[];

describe("the pattern rule", () => {
  it.each(
    PATTERN_CORPUS.map(
      (entry) => [entry.pattern, entry.reference, entry.matches, entry.reason] as const,
    ),
  )(
    "matchRef(%j, %j) is %j, as the Contract's corpus answers",
    (pattern, reference, matches, reason) => {
      expect(matchRef(pattern, reference), reason).toBe(matches);
    },
  );

  it("knows every member a case of the corpus carries", () => {
    const shapes = new Set(PATTERN_CORPUS.map((entry) => Object.keys(entry).sort().join(" ")));

    expect([...shapes]).toEqual(["matches pattern reason reference"]);
  });

  it("lets a star between two spelled characters stand for no character", () => {
    expect(
      matchRef("ts://@example/app/src/route*.ts#handler", "ts://@example/app/src/route.ts#handler"),
    ).toBe(true);
  });
});
