import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { DiagnosticCategory, type Diagnostic } from "@typescript/native/sync";
import type { RootedFilePath } from "@typescript/native/ast";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import type { BuildConfiguration } from "./config.ts";
import {
  consumerProjects,
  diagnosticErrors,
  discoverProjects,
  DiscoveryError,
  projectErrors,
  renderDiagnostic,
  targetRelative,
} from "./discover.ts";
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

  it("follows no reference to a configuration outside the target root, which is an outside project", () => {
    const root = scratch();
    write(root, {
      "dom/tsconfig.json":
        '{ "include": [], "references": [{ "path": "../utils/tsconfig.lib.json" }, { "path": "./lib" }] }\n',
      "dom/lib/tsconfig.json": EMPTY,
      "utils/tsconfig.lib.json": EMPTY,
    });

    const found = discoverProjects(engine(), HOST, scopeForDir(HOST, join(root, "dom")));

    expect(found.configFiles).toEqual([
      join(root, "dom", "lib", "tsconfig.json"),
      join(root, "dom", "tsconfig.json"),
    ]);
    expect(found.notBuilt).toEqual([]);
  });

  it("follows the references of a target configuration file only below its directory", () => {
    const root = scratch();
    write(root, {
      "app/tsconfig.json":
        '{ "include": [], "references": [{ "path": "./lib" }, { "path": "../core" }] }\n',
      "app/lib/tsconfig.json": EMPTY,
      "core/tsconfig.json": EMPTY,
    });
    const target = join(root, "app", "tsconfig.json");

    const found = discoverProjects(engine(), HOST, scopeOf(target));

    expect(found.configFiles).toEqual([target, join(root, "app", "lib", "tsconfig.json")]);
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

  it("follows the references of a configuration with a comment and a trailing comma", () => {
    const root = scratch();
    write(root, {
      "app/tsconfig.json":
        '// note\n{ "include": [], "references": [{ "path": "../other.json" },], }\n',
      "other.json": '{ "include": [], "compilerOptions": { "composite": true } }\n',
    });

    const found = discoverProjects(engine(), HOST, scopeForDir(HOST, root));

    expect(found.configFiles).toEqual([
      join(root, "app", "tsconfig.json"),
      join(root, "other.json"),
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

  it("drops a configuration whose extends chain is circular and keeps one referencing it", () => {
    const root = scratch();
    write(root, {
      "tsconfig.json": '{ "include": ["*.ts"] }\n',
      "main.ts": "export const one = 1;\n",
      "cycle/tsconfig.json": '{ "extends": "./a.json", "include": ["*.ts"] }\n',
      "cycle/a.json": '{ "extends": "./tsconfig.json" }\n',
      "cycle/main.ts": "export const two = 2;\n",
      "outer/tsconfig.json": '{ "extends": "../cycle/a.json", "include": ["*.ts"] }\n',
      "outer/main.ts": "export const three = 3;\n",
      "user/tsconfig.json": '{ "include": ["*.ts"], "references": [{ "path": "../cycle" }] }\n',
      "user/main.ts": "export const four = 4;\n",
    });

    const found = discoverProjects(engine(), HOST, scopeForDir(HOST, root));

    expect(found.configFiles).toEqual([
      join(root, "tsconfig.json"),
      join(root, "user", "tsconfig.json"),
    ]);
    expect(found.notBuilt.map((one) => [one.id, one.error])).toEqual([
      [
        "cycle/tsconfig.json",
        "TS18000: Circularity detected while resolving configuration: cycle/tsconfig.json",
      ],
      [
        "outer/tsconfig.json",
        "TS18000: Circularity detected while resolving configuration: outer/tsconfig.json",
      ],
    ]);
  });

  it("ends the run naming a declared configuration whose extends chain is circular", () => {
    const root = scratch();
    write(root, {
      "tsconfig.json": '{ "extends": "./tsconfig.json", "include": ["*.ts"] }\n',
      "main.ts": "export const one = 1;\n",
    });

    const thrown = thrownBy(() =>
      discoverProjects(engine(), HOST, scopeOf(root), [{ id: "named", project: "tsconfig.json" }]),
    );

    expect(thrown).toBeInstanceOf(DiscoveryError);
    expect(thrown instanceof DiscoveryError ? thrown.message : "").toContain(
      `the project "named" (${join(root, "tsconfig.json")}) cannot be read as a compiler configuration: TS18000: Circularity detected while resolving configuration: ${join(root, "tsconfig.json")}`,
    );
  });

  it("names a circular configuration's path as written, replacement patterns included", () => {
    const root = join(scratch(), "pro$&ject");
    write(root, {
      "tsconfig.json": '{ "extends": "./tsconfig.json", "include": ["*.ts"] }\n',
      "main.ts": "export const one = 1;\n",
    });

    const thrown = thrownBy(() =>
      discoverProjects(engine(), HOST, scopeOf(root), [{ id: "named", project: "tsconfig.json" }]),
    );

    expect(thrown instanceof DiscoveryError ? thrown.message : "").toContain(
      `resolving configuration: ${join(root, "tsconfig.json")}`,
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

  it("follows a reference that names a configuration file rather than a directory", () => {
    const root = scratch();
    write(root, {
      "tsconfig.json": '{ "include": [], "references": [{ "path": "./other.json" }] }\n',
      "other.json": EMPTY,
    });

    const found = discoverProjects(engine(), HOST, scopeForDir(HOST, root));

    expect(found.configFiles).toEqual([join(root, "tsconfig.json"), join(root, "other.json")]);
    expect(found.notBuilt).toEqual([]);
  });

  it.each([
    { name: "is null", text: "null\n" },
    {
      name: "lists references that are no object",
      text: '{ "include": [], "references": [null, "b", 1] }\n',
    },
    { name: "carries a comment", text: '// the root\n{ "include": [] }\n' },
  ])("follows nothing from a configuration that $name", ({ text }) => {
    const root = scratch();
    write(root, { "tsconfig.json": text });

    const found = discoverProjects(engine(), HOST, scopeForDir(HOST, root));

    expect(found.configFiles).toEqual([join(root, "tsconfig.json")]);
    expect(found.notBuilt).toEqual([]);
  });
});

describe("a consumer's projects", () => {
  it("end the run naming a consumer path that is a file", () => {
    const root = scratch();
    write(root, { "tsconfig.json": EMPTY });
    const file = join(root, "tsconfig.json");

    const thrown = thrownBy(() => consumerProjects(engine(), HOST, file));

    expect(thrown).toBeInstanceOf(DiscoveryError);
    expect(thrown instanceof DiscoveryError ? thrown.message : "").toBe(
      `the consumer ${file} is not a directory`,
    );
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
      { id: "app", project: "packages/app/tsconfig.json" },
      { id: "tsconfig.json", project: "tsconfig.json" },
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
      discoverProjects(engine(), HOST, scopeOf(root), [{ id: "a", project: "a/tsconfig.json" }]),
    );

    expect(thrown).toBeInstanceOf(DiscoveryError);
    const message = thrown instanceof DiscoveryError ? thrown.message : "";
    expect(message).toContain(`the project "a" (${join(root, "a", "tsconfig.json")}) references`);
    expect(message).toContain(
      `${join(root, "b", "tsconfig.json")}, which the build matrix does not name`,
    );
  });

  it("names no configuration a declared project references outside the target root", () => {
    const root = scratch();
    write(root, {
      "dom/tsconfig.json": '{ "include": [], "references": [{ "path": "../utils" }] }\n',
      "utils/tsconfig.json": EMPTY,
    });

    const found = discoverProjects(engine(), HOST, scopeOf(join(root, "dom")), [
      { id: "dom", project: "tsconfig.json" },
    ]);

    expect(found.configFiles).toEqual([join(root, "dom", "tsconfig.json")]);
  });

  it("reads the references of a commented declared configuration", () => {
    const root = scratch();
    write(root, {
      "a/tsconfig.json":
        '{\n  // note\n  "include": [],\n  "references": [{ "path": "../b" }],\n}\n',
      "b/tsconfig.json": EMPTY,
    });

    const thrown = thrownBy(() =>
      discoverProjects(engine(), HOST, scopeOf(root), [{ id: "a", project: "a/tsconfig.json" }]),
    );

    expect(thrown).toBeInstanceOf(DiscoveryError);
    expect(thrown instanceof DiscoveryError ? thrown.message : "").toContain(
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
      { id: "a", project: "a/tsconfig.json" },
      { id: "core", project: "b/tsconfig.json" },
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
      [{ id: "root", project: "tsconfig.json" }],
    );

    expect(found.configFiles).toEqual([join(root, "tsconfig.json")]);
    expect(found.fromScope).toEqual([]);
  });

  it("keeps the first identifier of a configuration two entries name", () => {
    const root = scratch();
    write(root, { "tsconfig.json": EMPTY });

    const found = discoverProjects(engine(), HOST, scopeOf(root), [
      { id: "first", project: "tsconfig.json" },
      { id: "second", project: "tsconfig.json" },
    ]);

    expect(found.projects).toEqual([{ id: "first", configFile: join(root, "tsconfig.json") }]);
  });

  it("leaves an empty reference path to the compiler, which refuses it in the project's own diagnostics", () => {
    const root = scratch();
    write(root, { "tsconfig.build.json": '{ "include": [], "references": [{ "path": "" }] }\n' });

    const found = discoverProjects(engine(), HOST, scopeOf(root), [
      { id: "build", project: "tsconfig.build.json" },
    ]);

    expect(found.configFiles).toEqual([join(root, "tsconfig.build.json")]);
  });

  it("ends the run naming an entry whose file the compiler cannot read", () => {
    const root = scratch();
    write(root, { "tsconfig.json": EMPTY });
    const configFile = join(root, "tsconfig.json");
    // The client's answer for a file it cannot open, which a test running as root
    // cannot produce through permissions.
    const unreadable: Engine = {
      ...engine(),
      parseConfigFile: () => {
        throw new Error(`api: client error: could not read file "${configFile}"`);
      },
    };

    const thrown = thrownBy(() =>
      discoverProjects(unreadable, HOST, scopeOf(root), [
        { id: "named", project: "tsconfig.json" },
      ]),
    );

    expect(thrown).toBeInstanceOf(DiscoveryError);
    expect(thrown instanceof DiscoveryError ? thrown.message : "").toBe(
      `the project "named" (${configFile}) cannot be read as a compiler configuration: ` +
        `api: client error: could not read file "${configFile}"`,
    );
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
      discoverProjects(engine(), HOST, scopeOf(root), [{ id: "named", project: "tsconfig.json" }]),
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

/** One diagnostic of `category` with code `code`, naming no file. */
function diagnostic(code: number, category: DiagnosticCategory): Diagnostic {
  return { pos: 0, end: 0, code, category, text: `diagnostic ${String(code)}` };
}

describe("a project's errors", () => {
  const warning = diagnostic(6385, DiagnosticCategory.Warning);
  const suggestion = diagnostic(80001, DiagnosticCategory.Suggestion);

  it("are its error diagnostics alone, configuration first, then syntax, then types", () => {
    const errors = diagnosticErrors({
      configParsing: [warning, diagnostic(5023, DiagnosticCategory.Error)],
      syntactic: [diagnostic(1005, DiagnosticCategory.Error), suggestion],
      semantic: [warning, diagnostic(2322, DiagnosticCategory.Error)],
    });

    expect(errors.map((one) => one.code)).toEqual([5023, 1005, 2322]);
  });

  it("leave a project whose configuration carries only a warning loaded, and check its files", () => {
    const errors = projectErrors({
      configParsing: [warning],
      syntactic: [],
      semantic: [diagnostic(2322, DiagnosticCategory.Error)],
      unplaced: [],
      locate: () => undefined,
    });

    expect(errors.load).toEqual([]);
    expect(errors.check.map((one) => one.diagnostic.code)).toEqual([2322]);
  });

  it("are the configuration's alone where it did not load, whatever its files carry", () => {
    const errors = projectErrors({
      configParsing: [diagnostic(18003, DiagnosticCategory.Error)],
      syntactic: [],
      semantic: [diagnostic(2322, DiagnosticCategory.Error)],
      unplaced: [],
      locate: () => undefined,
    });

    expect(errors.load.map((one) => one.diagnostic.code)).toEqual([18003]);
    expect(errors.check).toEqual([]);
  });
});

describe("an error about the target", () => {
  it.each([
    {
      name: "a path below the root, the root spelled with a trailing slash",
      text: "cannot read /work/app/a/tsconfig.json",
      root: "/work/app/",
      says: "cannot read a/tsconfig.json",
    },
    {
      name: "the root itself",
      text: "cannot read /work/app",
      root: "/work/app",
      says: "cannot read .",
    },
    {
      name: "its first line alone",
      text: "first line /work/app/a.json\nsecond line",
      root: "/work/app",
      says: "first line a.json",
    },
    {
      name: "a first line ended by a carriage return too",
      text: "first line\r\nsecond line",
      root: "/work/app",
      says: "first line",
    },
    { name: "no surrounding space", text: "  padded  \n", root: "/work/app", says: "padded" },
    {
      name: "a stand-in where the first line is blank",
      text: "\nsecond line",
      root: "/work/app",
      says: "the configuration could not be built",
    },
  ])("spells $name", ({ text, root, says }) => {
    expect(targetRelative(text, root)).toBe(says);
  });
});
