import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { DiagnosticCategory } from "@typescript/native/unstable/sync";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
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

describe("a diagnostic", () => {
  it("renders as its position, its code and its message", () => {
    expect(
      renderDiagnostic({
        fileName: "/src/a.ts",
        pos: 12,
        end: 20,
        code: 2322,
        category: DiagnosticCategory.Error,
        text: "Type 'number' is not assignable to type 'string'.",
      }),
    ).toBe("/src/a.ts:12: TS2322: Type 'number' is not assignable to type 'string'.");
  });
});
