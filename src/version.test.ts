import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { corpusLock, ROOT } from "../__test-helpers__/fixtures.ts";
import { CONTRACT_VERSION, version } from "./version.ts";

const SEMANTIC_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;

describe("the analyzer's version", () => {
  it("is the one its own manifest carries", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      version: string;
    };

    expect(version()).toBe(manifest.version);
  });

  it("is a semantic version, which is the only shape a report accepts", () => {
    expect(version()).toMatch(SEMANTIC_VERSION);
  });

  it("is the version the published manifests agree on", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    const jsr = JSON.parse(readFileSync(join(ROOT, "jsr.json"), "utf8")) as { version: string };

    expect(jsr.version).toBe(manifest.version);
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
