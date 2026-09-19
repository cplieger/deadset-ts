import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../__test-helpers__/fixtures.ts";

/**
 * The record of which compiler export paths this analyzer consumes, so a rename of
 * an unstable path is an enumerated migration rather than a search.
 */
interface ApiSurface {
  readonly package: string;
  readonly specifier: string;
  readonly version: string;
  readonly consumed: readonly { path: string; names: readonly string[] }[];
  readonly not_consumed: readonly string[];
}

function apiSurface(): ApiSurface {
  return JSON.parse(readFileSync(join(ROOT, "api-surface.json"), "utf8")) as ApiSurface;
}

/** Every `.ts` file the published surface and the command entry are made of. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        found.push(path);
      }
    }
  };
  walk(join(ROOT, "src"));
  walk(join(ROOT, "bin"));
  return found.sort();
}

/**
 * One import statement's specifier and the names it brings in, read from the source
 * text. Every import in this package is a static import statement written at the
 * top of its file with its specifier in double quotes, which is what makes the text
 * the record to read; a dynamic import would be invisible here and there is none.
 */
const IMPORT = /^import\s+(?:type\s+)?(?<clause>[^;]*?)\s*from\s+"(?<path>[^"]+)";$/gmu;

interface Imported {
  readonly path: string;
  readonly names: readonly string[];
}

function importsOf(text: string): Imported[] {
  const found: Imported[] = [];
  for (const match of text.matchAll(IMPORT)) {
    const path = match.groups?.["path"] ?? "";
    const clause = match.groups?.["clause"] ?? "";
    const braced = /\{(?<names>[\s\S]*)\}/u.exec(clause);
    const names =
      braced === null
        ? [clause.trim()].filter((name) => name !== "")
        : (braced.groups?.["names"] ?? "")
            .split(",")
            .map(
              (entry) =>
                entry
                  .trim()
                  .replace(/^type\s+/u, "")
                  .split(/\s+as\s+/u)[0] ?? "",
            )
            .filter((name) => name !== "");
    found.push({ path, names });
  }
  return found;
}

/** The compiler imports of every source file, keyed by specifier. */
function consumedPaths(pkg: string): Map<string, Set<string>> {
  const consumed = new Map<string, Set<string>>();
  for (const file of sourceFiles()) {
    for (const { path, names } of importsOf(readFileSync(file, "utf8"))) {
      if (path !== pkg && !path.startsWith(`${pkg}/`)) {
        continue;
      }
      const held = consumed.get(path) ?? new Set<string>();
      for (const name of names) {
        held.add(name);
      }
      consumed.set(path, held);
    }
  }
  return consumed;
}

describe("the consumed compiler API", () => {
  it("is the set api-surface.json records, path by path and name by name", () => {
    const record = apiSurface();
    const consumed = consumedPaths(record.package);

    expect(
      [...consumed]
        .map(([path, names]) => ({ path, names: [...names].sort() }))
        .sort((a, b) => (a.path < b.path ? -1 : 1)),
    ).toEqual(record.consumed.map(({ path, names }) => ({ path, names: [...names].sort() })));
  });

  it("imports nothing api-surface.json records as not consumed", () => {
    const record = apiSurface();
    const consumed = consumedPaths(record.package);

    expect(record.not_consumed.filter((path) => consumed.has(path))).toEqual([]);
  });

  it("records the compiler specifier the manifest declares and the version it installs", () => {
    const record = apiSurface();
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const installed = JSON.parse(
      readFileSync(join(ROOT, "node_modules", record.package, "package.json"), "utf8"),
    ) as { version: string };

    expect(Object.keys(manifest.dependencies)).toEqual([record.package]);
    expect(manifest.dependencies[record.package]).toBe(record.specifier);
    expect(record.specifier, "the specifier names the recorded version").toContain(
      `@${record.version}`,
    );
    expect(installed.version, "the version the specifier installs").toBe(record.version);
  });

  it("records every path the compiler package exports, as consumed or as not", () => {
    const record = apiSurface();
    const exports = JSON.parse(
      readFileSync(join(ROOT, "node_modules", record.package, "package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };
    const offered = Object.keys(exports.exports)
      .map((entry) => (entry === "." ? record.package : `${record.package}/${entry.slice(2)}`))
      .sort();

    expect([...record.consumed.map(({ path }) => path), ...record.not_consumed].sort()).toEqual(
      offered,
    );
  });
});
