import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture, ROOT } from "../__test-helpers__/fixtures.ts";
import type { Host } from "./host.ts";
import { run, SETTING_OPTIONS, type Writer } from "./run.ts";
import { declaresSetting } from "./schema.ts";
import { CONTRACT_VERSION } from "./version.ts";

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

interface Invocation {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

function invoke(args: readonly string[], host: Host = nodeHost()): Invocation {
  const out = new MemoryWriter();
  const err = new MemoryWriter();
  const code = run(args, out, err, host);
  return { code, out: out.text, err: err.text };
}

const USAGE =
  "usage: deadset-ts <verb> [options]\n" +
  "verbs: analyze, explain, print-config, print-projects, print-roots, print-retained, " +
  "describe, version\n";

/** The sha256 of every file below one directory, keyed by its relative path. */
function hashTree(dir: string): Map<string, string> {
  const hashes = new Map<string, string>();
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      hashes.set(
        relative(dir, path),
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      );
    }
  };
  walk(dir);
  return hashes;
}

describe("the command line", () => {
  it("prints the version its host reports and the Contract version, and exits 0", () => {
    const host: Host = { ...nodeHost(), analyzerVersion: () => "9.9.9-probe" };

    expect(invoke(["version"], host)).toEqual({
      code: 0,
      out: `deadset-ts 9.9.9-probe\ncontract ${CONTRACT_VERSION}\n`,
      err: "",
    });
  });

  it("prints the usage naming every verb and exits 2 when no verb is given", () => {
    expect(invoke([])).toEqual({ code: 2, out: "", err: USAGE });
  });

  it("names an unknown verb and exits 2", () => {
    const got = invoke(["analyse"]);

    expect(got.code).toBe(2);
    expect(got.err).toBe(`deadset-ts: unknown verb "analyse"\n${USAGE}`);
  });

  it("names a verb it does not implement and exits 2", () => {
    const got = invoke(["analyze"]);

    expect(got.code).toBe(2);
    expect(got.err).toBe("deadset-ts: analyze is not implemented\n");
  });
});

describe("the report-only guard", () => {
  it.each([
    { name: "--fix", args: ["analyze", "--fix"], spelled: "--fix" },
    { name: "--fix with a value", args: ["analyze", "--fix=all"], spelled: "--fix" },
    { name: "--edit", args: ["analyze", "--edit"], spelled: "--edit" },
    { name: "--delete-dead", args: ["analyze", "--delete-dead"], spelled: "--delete-dead" },
    { name: "--rewrite", args: ["analyze", "--rewrite=src"], spelled: "--rewrite" },
    { name: "a short form", args: ["analyze", "-fix"], spelled: "-fix" },
  ])("refuses $name by name before the verb is read and exits 2", ({ args, spelled }) => {
    const got = invoke(args);

    expect(got.code).toBe(2);
    expect(got.out).toBe("");
    expect(got.err).toBe(
      `deadset-ts: ${spelled} is not supported: ` +
        `deadset-ts reports and never edits a source file\n${USAGE}`,
    );
  });

  it("does not refuse an option whose value carries a token", () => {
    const got = invoke(["print-config", "--target=/nowhere/fix"]);

    expect(got.err).not.toContain("is not supported");
  });
});

describe("the setting options", () => {
  it("names a setting the Contract's key list declares for every option", () => {
    const undeclared = [...SETTING_OPTIONS].filter(([, path]) => !declaresSetting(path));

    expect(undeclared).toEqual([]);
  });
});

describe("print-config", () => {
  it("names the target kind field and exits 2 when no source supplies one", () => {
    const got = invoke(["print-config", `--target=${fixture("projects", "sources-only")}`]);

    expect(got.code, got.err).toBe(2);
    expect(got.err).toContain("target.kind is not set");
  });

  it("resolves the target kind an option's document supplies", () => {
    const got = invoke([
      "print-config",
      `--config=${fixture("vectors", "config", "provenance-on-input", "repository.json")}`,
    ]);

    expect(got.code, got.err).toBe(0);
    expect(JSON.parse(got.out)).toMatchObject({
      contract_version: CONTRACT_VERSION,
      target: { kind: "library" },
    });
  });

  it("names an unknown option and exits 2", () => {
    const got = invoke(["print-config", "--nope=1"]);

    expect(got.code).toBe(2);
    expect(got.err).toContain('unknown option "--nope"');
  });
});

describe("print-projects", () => {
  it("discovers every project of a project-references graph", () => {
    const got = invoke(["print-projects", `--target=${fixture("projects", "two-projects")}`]);

    expect(got.code, got.err).toBe(0);
    expect(got.out.trim().split("\n").sort()).toEqual([
      fixture("projects", "two-projects", "app", "tsconfig.json"),
      fixture("projects", "two-projects", "core", "tsconfig.json"),
    ]);
  });

  it("analyzes a package whose sources ship as TypeScript with no build step", () => {
    const target = fixture("projects", "sources-only");
    const got = invoke(["print-projects", `--target=${target}`]);

    expect(got.code, got.err).toBe(0);
    expect(got.out).toBe(`${join(target, "tsconfig.json")}\n`);
  });

  it("exits 3 printing the diagnostics and no project list for a project that fails to check", () => {
    const got = invoke(["print-projects", `--target=${fixture("projects", "semantic-error")}`]);

    expect(got.code).toBe(3);
    expect(got.out).toBe("");
    expect(got.err).toContain("broken.ts");
    expect(got.err).toContain("TS2322");
    expect(got.err).toContain("no answer was produced");
  });

  it("exits 3 naming a scope document it cannot read", () => {
    const got = invoke(["print-projects", `--scope=${fixture("projects", "no-such-scope.json")}`]);

    expect(got.code).toBe(3);
    expect(got.err).toContain("no-such-scope.json");
  });
});

describe("a run over a fixture", () => {
  it("leaves every file of the fixture byte-identical", () => {
    const tree = fixture("projects");
    const before = hashTree(tree);

    const projects = invoke(["print-projects", `--target=${fixture("projects", "two-projects")}`]);
    const config = invoke([
      "print-config",
      `--config=${fixture("vectors", "config", "provenance-on-input", "repository.json")}`,
    ]);

    expect(projects.code, projects.err).toBe(0);
    expect(config.code, config.err).toBe(0);
    expect([...hashTree(tree)]).toEqual([...before]);
  });

  it("leaves the repository's own tree byte-identical", () => {
    const before = hashTree(join(ROOT, "src"));

    expect(invoke(["version"]).code).toBe(0);
    expect([...hashTree(join(ROOT, "src"))]).toEqual([...before]);
  });
});
