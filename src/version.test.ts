import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { corpusLock, ROOT } from "../__test-helpers__/fixtures.ts";
import * as library from "./index.ts";
import { CONTRACT_VERSION } from "./version.ts";

const SEMANTIC_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;

function manifestVersion(): string {
  return (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string })
    .version;
}

/** Every file below one directory, as paths relative to it, in ascending order. */
function filesUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      found.push(relative(dir, path));
    }
  };
  walk(dir);
  return found.sort();
}

/**
 * The build's own emit, into a temporary directory laid out the way an install is:
 * the emitted tree below `dist/` and the manifest at the root above it, which is
 * what the Node host's walk climbs. The compiler emits in about a tenth of a
 * second, which is what makes the emit itself the thing these tests read rather
 * than a claim about it.
 */
function emitInto(root: string): void {
  const built = spawnSync(join(ROOT, "node_modules", ".bin", "tsc"), [
    "-p",
    join(ROOT, "tsconfig.build.json"),
    "--outDir",
    join(root, "dist"),
  ]);

  expect(
    { status: built.status, output: built.stdout?.toString() ?? "" },
    "the build project emits",
  ).toEqual({ status: 0, output: "" });
}

/** A program printing what the emitted Node host answers for the analyzer's version. */
function writeProbe(root: string): string {
  const probe = join(root, "probe.mjs");
  writeFileSync(
    probe,
    'import { nodeHost } from "./dist/bin/node-host.js";\n' +
      "process.stdout.write(nodeHost().analyzerVersion());\n",
  );
  return probe;
}

describe("the analyzer's version", () => {
  it("is the one the manifest of the package it was installed from carries", () => {
    expect(nodeHost().analyzerVersion()).toBe(manifestVersion());
  });

  it("is a semantic version, which is the only shape a report accepts", () => {
    expect(nodeHost().analyzerVersion()).toMatch(SEMANTIC_VERSION);
  });

  it("is the version the published manifests agree on", () => {
    const jsr = JSON.parse(readFileSync(join(ROOT, "jsr.json"), "utf8")) as { version: string };

    expect(jsr.version).toBe(manifestVersion());
  });

  it("reaches a caller through the host it supplied, so the library exports no name for it", () => {
    expect(Object.keys(library).filter((name) => /version/iu.test(name))).toEqual([
      "CONTRACT_VERSION",
    ]);
  });
});

describe("the emitted tree", () => {
  it("carries no manifest, so nothing reads a copy of one", () => {
    const root = mkdtempSync(join(tmpdir(), "deadset-ts-emit-"));
    try {
      emitInto(root);

      expect(
        filesUnder(join(root, "dist")).filter((path) => path.endsWith("package.json")),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads the version from the package root above the emitted file's own location", () => {
    const root = mkdtempSync(join(tmpdir(), "deadset-ts-walk-"));
    try {
      emitInto(root);
      copyFileSync(join(ROOT, "package.json"), join(root, "package.json"));
      const probe = writeProbe(root);

      // From a working directory with no manifest above it, so the manifest the walk
      // finds is the one above the emitted file and not the one the caller stood in.
      const ran = spawnSync(process.execPath, [probe], { cwd: tmpdir() });

      expect(ran.stdout.toString(), ran.stderr.toString()).toBe(manifestVersion());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names the search when no manifest above its own location declares this package", () => {
    const root = mkdtempSync(join(tmpdir(), "deadset-ts-nomanifest-"));
    try {
      emitInto(root);
      const probe = writeProbe(root);

      // From this repository, whose own manifest does declare this package: the walk
      // climbs from the emitted file, so standing somewhere that has one is no answer.
      const ran = spawnSync(process.execPath, [probe], { cwd: ROOT });

      expect(ran.status, ran.stdout.toString()).not.toBe(0);
      expect(ran.stderr.toString()).toContain("no package.json declaring @cplieger/deadset-ts");
      expect(ran.stderr.toString()).toContain(join(root, "dist", "bin"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the published sources", () => {
  it("import no module of the platform, so a consumer compiles them with the compiler alone", () => {
    const offenders: string[] = [];
    for (const path of filesUnder(join(ROOT, "src"))) {
      if (!path.endsWith(".ts") || path.endsWith(".test.ts")) {
        continue;
      }
      const text = readFileSync(join(ROOT, "src", path), "utf8");
      // The tail after the specifier admits an import attribute, which is how a
      // manifest is imported and is the one form a specifier-only expression misses.
      for (const match of text.matchAll(/^import\s[^;]*?from\s+"(?<path>[^"]+)"[^;]*;$/gmu)) {
        const specifier = match.groups?.["path"] ?? "";
        if (specifier.startsWith("node:") || specifier.endsWith(".json")) {
          offenders.push(`src/${path}: ${specifier}`);
        }
      }
    }

    expect(
      offenders,
      "the platform reaches the analysis through the host, and the manifest through it",
    ).toEqual([]);
  });
});

describe("the Contract version", () => {
  it("is a semantic version", () => {
    expect(CONTRACT_VERSION).toMatch(SEMANTIC_VERSION);
  });

  it("is the one the pinned Contract release carries", () => {
    expect(corpusLock().contract_version).toBe(CONTRACT_VERSION);
  });
});
