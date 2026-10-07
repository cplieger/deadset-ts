import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeHost } from "../../bin/node-host.ts";
import { emitterInputOf } from "../../__test-helpers__/emitter-input.ts";
import { contractDocument, fixture } from "../../__test-helpers__/fixtures.ts";
import type { Finding } from "../finding.ts";
import { isRef } from "../ref.ts";
import { resolve } from "../resolve.ts";
import { run, type Writer } from "../run.ts";
import type { EmitterInput } from "./emitter.ts";
import { EMITTERS, findingsOf } from "./emitters.ts";

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
    const allow = (severity: Record<string, string>): readonly Finding[] =>
      findingsOf(
        sweepFixture(TARGET, JSON.stringify({ target: { kind: "application" }, severity })).input,
      ).filter((finding) => finding.code === "DS1601");

    expect(allow({ DS1601: "allow" })).toEqual([]);
    expect(allow({ DS16: "allow" })).toEqual([]);
    expect(names(allow({ DS16: "allow", DS1601: "warn" }))).toEqual(names(FIXTURE.findings));
  });
});

describe("an import no package resolves and no manifest declares", () => {
  const unresolved = fixture("projects", "dependencies-unresolved");

  it("is a type error the sweep skips, so the emitter runs and reports nothing", () => {
    expect(sweepFixture(unresolved).findings).toEqual([]);
  });

  it("is no setup failure: the command line exits 0", () => {
    const out = new MemoryWriter();
    const err = new MemoryWriter();
    const code = run(["print-retained", `--target=${unresolved}`], out, err, nodeHost());

    expect(code, err.text).toBe(0);
    expect(err.text).not.toContain("setup failure");
  });
});

describe("a workspace whose members declare dependencies", () => {
  const target = mkdtempSync(join(tmpdir(), "deadset-ts-dependencies-workspace-"));
  cpSync(fixture("projects", "dependencies-workspace"), target, { recursive: true });
  renameSync(join(target, "installed"), join(target, "node_modules"));
  afterAll(() => {
    rmSync(target, { recursive: true, force: true });
  });

  it("reports an unneeded dependency of a member's manifest at its key, in the member's scope", () => {
    expect(
      sweepFixture(target).findings.map(
        (finding) =>
          `${finding.symbol.ref} ${finding.position.path}:${String(finding.position.line)}`,
      ),
    ).toEqual([
      "ts://@example/root/package.json#root-unused:dev-dependency package.json:8",
      "ts://@example/app/package.json#member-unused:dev-dependency packages/app/package.json:7",
    ]);
  });

  it("judges no member whose files no built project holds", () => {
    expect(
      sweepFixture(target)
        .findings.map((finding) => finding.symbol.ref)
        .filter((ref) => ref.startsWith("ts://@example/tool/")),
      "packages/tool/scripts/run.mjs imports member-tool, and no configuration holds it",
    ).toEqual([]);
  });

  it("judges no member below which a derived configuration was dropped", () => {
    expect(
      sweepFixture(target)
        .findings.map((finding) => finding.symbol.ref)
        .filter((ref) => ref.startsWith("ts://@example/web/")),
      "packages/web/tsconfig.json matches no input, so files it would hold go unread",
    ).toEqual([]);
  });
});
