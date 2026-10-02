import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { emitterInputOf } from "../../__test-helpers__/emitter-input.ts";
import { contractDocument, fixture } from "../../__test-helpers__/fixtures.ts";
import { DiscoveryError } from "../discover.ts";
import type { Finding } from "../finding.ts";
import { isRef } from "../ref.ts";
import { resolve } from "../resolve.ts";
import { run, type Writer } from "../run.ts";
import type { EmitterInput } from "./emitter.ts";
import { EMITTERS } from "./emitters.ts";

/**
 * The fixture with its dependency directory in place. A tree holding one cannot be
 * committed, so the fixture keeps the installed packages under `installed/` and each
 * run moves them where the package manager would have put them.
 */
const TARGET = ((): string => {
  const root = mkdtempSync(join(tmpdir(), "deadset-ts-dependencies-"));
  cpSync(fixture("projects", "dependencies"), root, { recursive: true });
  renameSync(join(root, "installed"), join(root, "node_modules"));
  return root;
})();

afterAll(() => {
  rmSync(TARGET, { recursive: true, force: true });
});

/** The fixture swept for production under its own configuration, or the document given. */
function sweepFixture(
  target: string,
  document?: string,
): { input: EmitterInput; findings: Finding[] } {
  const path = join(target, "deadset.json");
  const { config } = resolve({
    repository: document ?? readFileSync(path, "utf8"),
    repositoryLabel: path,
  });
  const input = emitterInputOf(target, config);
  const emit = EMITTERS.get("dependencies-and-module-machinery");
  return { input, findings: emit === undefined ? [] : [...emit(input)] };
}

const FIXTURE = sweepFixture(TARGET);

function names(findings: readonly Finding[]): string[] {
  return findings.map((finding) => finding.symbol.name);
}

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

describe("the dependencies-and-module-machinery emitter", () => {
  it("reports each declared dependency the target does not need, at its key in the manifest", async () => {
    await expect(`${JSON.stringify(FIXTURE.findings, null, 2)}\n`).toMatchFileSnapshot(
      fixture("golden", "dependencies.findings.json"),
    );
  });

  it("reports one dependency, development dependency and peer dependency, and passes over a used one of each", () => {
    expect(
      FIXTURE.findings.map(
        (finding) =>
          `${finding.symbol.name} ${(finding as { details?: { dependencyClass?: string } }).details?.dependencyClass ?? ""}`,
      ),
    ).toEqual([
      "unused-runtime dependency",
      "@types/bundled dev-dependency",
      "optional-peer dev-dependency",
      "unused-dev dev-dependency",
      "peer-unused peer-dependency",
    ]);
    for (const used of ["used-runtime", "test-helper", "peer-used"]) {
      expect(names(FIXTURE.findings)).not.toContain(used);
    }
  });

  it("counts a type package the compiler resolves an import to, or the configuration names, and not one it never reads", () => {
    expect(names(FIXTURE.findings)).not.toContain("@types/typed-only");
    expect(names(FIXTURE.findings)).not.toContain("@types/globals");
    expect(names(FIXTURE.findings)).toContain("@types/bundled");
  });

  it("holds a dependency shipping a command, and a required peer of a needed one, needed", () => {
    expect(names(FIXTURE.findings)).not.toContain("dev-tool");
    expect(names(FIXTURE.findings)).not.toContain("host-peer");
    expect(names(FIXTURE.findings)).toContain("optional-peer");
  });

  it("never reports the manifest's bin entry, whose target no import reaches, and counts what that target imports", () => {
    for (const finding of FIXTURE.findings) {
      expect(finding.position.path).toBe("package.json");
      expect(finding.symbol.name).not.toBe("dependencies-cli");
    }
    expect(names(FIXTURE.findings)).not.toContain("cli-only");
  });

  it("states each finding in the finding schema's vocabulary", () => {
    const schema = contractDocument("finding.schema.json") as {
      properties: {
        message: { pattern: string };
        details: { properties: { dependency_class: { enum: string[] } } };
      };
    };
    const message = new RegExp(schema.properties.message.pattern, "u");
    const classes = schema.properties.details.properties.dependency_class.enum;
    for (const finding of FIXTURE.findings) {
      expect(finding.code).toBe("DS1601");
      expect(finding.symbol.kind).toBe("dependency");
      expect(isRef(finding.symbol.ref), finding.symbol.ref).toBe(true);
      expect(finding.message).toMatch(message);
      expect(classes).toContain(
        (finding as { details?: { dependencyClass?: string } }).details?.dependencyClass,
      );
    }
  });

  it("names, per deletion candidate, each declared dependency it holds the last use of, and none two declarations share", () => {
    // `start` is a candidate of the production sweep, which counts no test reference.
    expect(FIXTURE.input.dependencies.lastUses).toEqual(
      new Map([
        [
          "src/main.ts:8:17",
          ["@types/typed-only", "bundled", "host-plugin", "peer-used", "typed-only"],
        ],
        ["src/main.ts:12:10", ["left-pad"]],
      ]),
    );
  });

  it("withholds every finding when the severity map sets the kind or its family to allow", () => {
    const allow = (severity: Record<string, string>): Finding[] =>
      sweepFixture(TARGET, JSON.stringify({ target: { kind: "application" }, severity })).findings;

    expect(allow({ DS1601: "allow" })).toEqual([]);
    expect(allow({ DS16: "allow" })).toEqual([]);
    expect(names(allow({ DS16: "allow", DS1601: "warn" }))).toEqual(names(FIXTURE.findings));
  });
});

describe("an import no package resolves", () => {
  const unresolved = fixture("projects", "dependencies-unresolved");

  it("fails the sweep with the project's diagnostic and produces no finding", () => {
    let thrown: unknown;
    try {
      sweepFixture(unresolved);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DiscoveryError);
    expect((thrown as Error).message).toContain("no answer was produced");
  });

  it("exits 3 from the command line, printing the diagnostic and no list", () => {
    const out = new MemoryWriter();
    const err = new MemoryWriter();
    const code = run(["print-retained", `--target=${unresolved}`], out, err, nodeHost());

    expect(code).toBe(3);
    expect(out.text).toBe("");
    expect(err.text).toContain("TS2307");
    expect(err.text).toContain("not-installed");
  });
});
