import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { DiagnosticCategory } from "@typescript/native/unstable/sync";
import type { RootedFilePath } from "@typescript/native/unstable/ast";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import type { BuildConfiguration } from "./config.ts";
import { discoverProjects, DiscoveryError, renderDiagnostic } from "./discover.ts";
import { scopeForDir, type Scope } from "./scope.ts";
import { openEngine, type Engine } from "./session.ts";

const HOST = nodeHost();
const opened: Engine[] = [];

/**
 * One compiler client per test, released afterwards. A client is a process, so a
 * test that opens one and leaves it running holds a process for the whole run.
 */
function engine(): Engine {
  const held = openEngine({ collectTiming: false });
  opened.push(held);
  return held;
}

afterEach(() => {
  for (const held of opened.splice(0)) {
    held.close();
  }
});

/**
 * A directory of this test's own, removed afterwards. It is outside the committed
 * fixtures because another test hashes those to pin that a run edits nothing, and
 * the two run at the same time.
 */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "deadset-ts-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A scope naming one path, without reading a document from disk. */
function scopeOf(path: string): Scope {
  return { target: { id: "", path }, consumers: [] };
}

/** Writes each path below `root` with the text given for it, creating its directory. */
function write(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** The error one call threw, or undefined when it returned. */
function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

/** A configuration file that parses and names no input. */
const EMPTY = '{ "include": [] }\n';

/** A platform entry, which names a configuration of another language. */
const PLATFORM: BuildConfiguration = {
  shape: "platform",
  id: "linux-amd64",
  os: "linux",
  arch: "amd64",
  tags: [],
};

describe("project discovery", () => {
  it("reads every configuration under the target root and each one's references", () => {
    const root = fixture("projects", "two-projects");

    const found = discoverProjects(engine(), HOST, scopeForDir(HOST, root));

    expect(found.configFiles).toEqual([
      join(root, "app", "tsconfig.json"),
      join(root, "core", "tsconfig.json"),
    ]);
    expect(found.fromScope, "a scope naming a directory names no configuration").toEqual([]);
  });

  it("reads a configuration the scope names before the walk", () => {
    const core = fixture("projects", "two-projects", "core", "tsconfig.json");

    const found = discoverProjects(engine(), HOST, scopeOf(core));

    expect(found.fromScope).toEqual([core]);
    expect(found.configFiles).toEqual([core]);
  });

  it("names each configuration once however many paths reach it", () => {
    const root = fixture("projects", "two-projects");

    const found = discoverProjects(engine(), HOST, {
      target: { id: "", path: join(root, "app", "tsconfig.json") },
      consumers: [{ id: "", path: join(root, "core", "tsconfig.json") }],
    });

    expect(found.configFiles).toEqual([
      join(root, "app", "tsconfig.json"),
      join(root, "core", "tsconfig.json"),
    ]);
  });

  it("reads no configuration a consumer's path names, which is the consumer's own", () => {
    const root = fixture("projects", "two-projects");

    const found = discoverProjects(engine(), HOST, {
      target: { id: "", path: join(root, "core", "tsconfig.json") },
      consumers: [{ id: "", path: join(root, "app", "tsconfig.json") }],
    });

    expect(found.configFiles).toEqual([join(root, "core", "tsconfig.json")]);
  });

  it("does not descend into an ignored directory", () => {
    const root = scratch();
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(root, "node_modules", "dep", "tsconfig.json"), '{ "include": [] }\n');
    writeFileSync(join(root, "tsconfig.json"), '{ "include": [] }\n');

    const found = discoverProjects(engine(), HOST, scopeForDir(HOST, root));

    expect(found.configFiles).toEqual([join(root, "tsconfig.json")]);
  });

  it("reads every configuration whose name the walk recognises", () => {
    const root = scratch();
    writeFileSync(join(root, "tsconfig.json"), '{ "include": [] }\n');
    writeFileSync(join(root, "tsconfig.build.json"), '{ "include": [] }\n');
    writeFileSync(join(root, "jsconfig.json"), '{ "include": [] }\n');

    const found = discoverProjects(engine(), HOST, scopeForDir(HOST, root));

    expect(found.configFiles).toEqual([
      join(root, "tsconfig.build.json"),
      join(root, "tsconfig.json"),
    ]);
  });

  it("drops a configuration the walk reached and the compiler cannot read, and names it", () => {
    const root = scratch();
    write(root, { "tsconfig.json": '{ "include": [], "references": [{ "path": "./gone" }] }\n' });

    const found = discoverProjects(engine(), HOST, scopeForDir(HOST, root));

    expect(found.configFiles).toEqual([join(root, "tsconfig.json")]);
    expect(found.notBuilt.map((one) => [one.id, one.configFile])).toEqual([
      ["gone/tsconfig.json", join(root, "gone", "tsconfig.json")],
    ]);
    expect(found.notBuilt[0]?.error, "the error names no path above the target").not.toContain(
      root,
    );
  });

  it("ends the run naming a configuration file the compiler cannot read", () => {
    const missing = join(scratch(), "tsconfig.json");

    let thrown: unknown;
    try {
      discoverProjects(engine(), HOST, scopeOf(missing));
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DiscoveryError);
    expect(thrown instanceof DiscoveryError ? thrown.message : "").toContain(missing);
  });
});

describe("a declared matrix", () => {
  it("is exactly the projects its entries name, in their order, by their identifiers", () => {
    const root = scratch();
    write(root, {
      "tsconfig.json": EMPTY,
      "tsconfig.build.json": EMPTY,
      "packages/app/tsconfig.json": EMPTY,
      "fixtures/broken/tsconfig.json": "{ not json",
    });

    const found = discoverProjects(engine(), HOST, scopeOf(root), [
      PLATFORM,
      { shape: "project", id: "app", project: "packages/app/tsconfig.json" },
      { shape: "project", id: "tsconfig.json", project: "tsconfig.json" },
    ]);

    expect(found.projects).toEqual([
      { id: "app", configFile: join(root, "packages", "app", "tsconfig.json") },
      { id: "tsconfig.json", configFile: join(root, "tsconfig.json") },
    ]);
    expect(found.configFiles).toEqual([
      join(root, "packages", "app", "tsconfig.json"),
      join(root, "tsconfig.json"),
    ]);
  });

  it("ends the run naming a configuration a declared project references and the matrix does not name", () => {
    const root = scratch();
    write(root, {
      "a/tsconfig.json": '{ "include": [], "references": [{ "path": "../b" }] }\n',
      "b/tsconfig.json": EMPTY,
    });

    const thrown = thrownBy(() =>
      discoverProjects(engine(), HOST, scopeOf(root), [
        { shape: "project", id: "a", project: "a/tsconfig.json" },
      ]),
    );

    expect(thrown).toBeInstanceOf(DiscoveryError);
    const message = thrown instanceof DiscoveryError ? thrown.message : "";
    expect(message).toContain(`the project "a" (${join(root, "a", "tsconfig.json")}) references`);
    expect(message).toContain(
      `${join(root, "b", "tsconfig.json")}, which the build matrix does not name`,
    );
  });

  it("follows no reference, so a referenced configuration the matrix names keeps its own place and identifier", () => {
    const root = scratch();
    write(root, {
      "a/tsconfig.json": '{ "include": [], "references": [{ "path": "../b" }] }\n',
      "b/tsconfig.json": EMPTY,
    });

    const found = discoverProjects(engine(), HOST, scopeOf(root), [
      { shape: "project", id: "a", project: "a/tsconfig.json" },
      { shape: "project", id: "core", project: "b/tsconfig.json" },
    ]);

    expect(found.projects).toEqual([
      { id: "a", configFile: join(root, "a", "tsconfig.json") },
      { id: "core", configFile: join(root, "b", "tsconfig.json") },
    ]);
  });

  it("reads none of the configuration files the scope names", () => {
    const root = scratch();
    write(root, { "tsconfig.json": EMPTY, "other/tsconfig.json": EMPTY });

    const found = discoverProjects(
      engine(),
      HOST,
      {
        target: { id: "", path: root },
        consumers: [{ id: "", path: join(root, "other", "tsconfig.json") }],
      },
      [{ shape: "project", id: "root", project: "tsconfig.json" }],
    );

    expect(found.configFiles).toEqual([join(root, "tsconfig.json")]);
    expect(found.fromScope).toEqual([]);
  });

  it("keeps the first identifier of a configuration two entries name", () => {
    const root = scratch();
    write(root, { "tsconfig.json": EMPTY });

    const found = discoverProjects(engine(), HOST, scopeOf(root), [
      { shape: "project", id: "first", project: "tsconfig.json" },
      { shape: "project", id: "second", project: "tsconfig.json" },
    ]);

    expect(found.projects).toEqual([{ id: "first", configFile: join(root, "tsconfig.json") }]);
  });

  it.each([
    { name: "does not exist", files: {}, says: "does not exist" },
    {
      name: "is a directory",
      files: { "tsconfig.json/inner.json": EMPTY },
      says: "is a directory",
    },
  ])("ends the run naming an entry whose file $name", ({ files, says }) => {
    const root = scratch();
    write(root, files);

    const thrown = thrownBy(() =>
      discoverProjects(engine(), HOST, scopeOf(root), [
        { shape: "project", id: "named", project: "tsconfig.json" },
      ]),
    );

    expect(thrown).toBeInstanceOf(DiscoveryError);
    const message = thrown instanceof DiscoveryError ? thrown.message : "";
    expect(message).toContain('"named"');
    expect(message).toContain(join(root, "tsconfig.json"));
    expect(message).toContain(says);
  });
});

describe("a derived matrix", () => {
  it("names each project by its configuration file's path below the target root", () => {
    const root = fixture("projects", "two-projects");

    const found = discoverProjects(engine(), HOST, scopeForDir(HOST, root));

    expect(found.projects.map((project) => project.id)).toEqual([
      "app/tsconfig.json",
      "core/tsconfig.json",
    ]);
  });

  it("is what a matrix of platform entries alone leaves discovery to read", () => {
    const root = scratch();
    write(root, { "tsconfig.json": EMPTY, "tools/tsconfig.json": EMPTY });

    const found = discoverProjects(engine(), HOST, scopeForDir(HOST, root), [PLATFORM]);

    expect(found.projects.map((project) => project.id)).toEqual([
      "tools/tsconfig.json",
      "tsconfig.json",
    ]);
  });
});

describe("a diagnostic", () => {
  it("renders as its line and column, its code and its message", () => {
    expect(
      renderDiagnostic({
        diagnostic: {
          fileName: "/src/a.ts" as RootedFilePath,
          pos: 12,
          end: 20,
          code: 2322,
          category: DiagnosticCategory.Error,
          text: "Type 'number' is not assignable to type 'string'.",
        },
        at: { line: 2, column: 5 },
      }),
    ).toBe("/src/a.ts:2:5: TS2322: Type 'number' is not assignable to type 'string'.");
  });

  it("renders the file alone where it names no position", () => {
    expect(
      renderDiagnostic({
        diagnostic: {
          fileName: "/src/tsconfig.json" as RootedFilePath,
          pos: 0,
          end: 0,
          code: 18003,
          category: DiagnosticCategory.Error,
          text: "No inputs were found in config file.",
        },
      }),
    ).toBe("/src/tsconfig.json: TS18003: No inputs were found in config file.");
  });
});
