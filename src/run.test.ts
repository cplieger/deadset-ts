import { CONTRACT_VERSION } from "./contract/contract.generated.ts";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture, ROOT } from "../__test-helpers__/fixtures.ts";
import type { Host } from "./host.ts";
import { run, SETTING_OPTIONS, type Writer } from "./run.ts";
import { openEngine, type Engine, type EngineOptions } from "./session.ts";

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

/**
 * A tree of this test's own, removed afterwards: the matrix vector's two projects,
 * each naming its own source, beside a project that does not type-check.
 */
function matrixTree(extra: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "deadset-ts-matrix-"));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const project = (include: string): string =>
    `${JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: [include] })}\n`;
  const files: Record<string, string> = {
    "tsconfig.json": project("src/*.ts"),
    "src/main.ts": "export const main: number = 1;\n",
    "packages/app/tsconfig.json": project("*.ts"),
    "packages/app/app.ts": 'export const app: string = "app";\n',
    "fixtures/broken/tsconfig.json": project("*.ts"),
    "fixtures/broken/broken.ts": "export const broken: string = 1;\n",
    ...extra,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

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

  it("refuses an explanation request that names no symbol and exits 2", () => {
    const got = invoke(["explain"]);

    expect(got.code).toBe(2);
    expect(got.err).toBe(
      `deadset-ts: explain explains the symbol --why, --why-live or --why-not names, and none was named\n${USAGE}`,
    );
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
  it("are the options the Contract's command line gives this analyzer for a setting", () => {
    expect([...SETTING_OPTIONS].sort()).toEqual([
      ["cascade", "reporters.cascade"],
      ["fail-on", "reporters.fail_on"],
      ["max-findings", "reporters.max_findings"],
      ["min-confidence", "analysis.min_confidence"],
      ["sort", "reporters.sort"],
    ]);
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

  it("reads a count option written as digits as the integer it spells", () => {
    const got = invoke([
      "print-config",
      `--config=${fixture("vectors", "config", "provenance-on-input", "repository.json")}`,
      "--max-findings=7",
    ]);

    expect(got.code, got.err).toBe(0);
    expect(JSON.parse(got.out)).toMatchObject({ reporters: { max_findings: 7 } });
  });

  it.each(["1e2", "100.0"])(
    "refuses a count option written %j, naming the setting, and exits 2",
    (value) => {
      const got = invoke([
        "print-config",
        `--config=${fixture("vectors", "config", "provenance-on-input", "repository.json")}`,
        `--max-findings=${value}`,
      ]);

      expect(got.code).toBe(2);
      expect(got.err).toContain("reporters.max_findings");
    },
  );

  it("refuses a disabled convention row this analyzer does not carry, naming the setting, and exits 2", () => {
    const scratch = mkdtempSync(join(tmpdir(), "deadset-ts-conventions-"));
    onTestFinished(() => {
      rmSync(scratch, { recursive: true, force: true });
    });
    const document = join(scratch, "deadset.json");
    writeFileSync(
      document,
      '{"target":{"kind":"application"},"ts":{"disabled_conventions":["next-app-router"]}}\n',
    );

    const got = invoke(["print-config", `--config=${document}`]);

    expect(got.code, got.err).toBe(2);
    expect(got.out).toBe("");
    expect(got.err).toContain("ts.disabled_conventions");
    expect(got.err).toContain('"next-app-router" names no row this analyzer carries');
  });

  it("names an unknown option and exits 2", () => {
    const got = invoke(["print-config", "--nope=1"]);

    expect(got.code).toBe(2);
    expect(got.err).toContain('unknown option "--nope"');
  });

  it("refuses an argument that is no option, even one spelling a source-edit token, and exits 2", () => {
    expect(invoke(["print-config", "delete"])).toEqual({
      code: 2,
      out: "",
      err: `deadset-ts: unexpected argument "delete"\n${USAGE}`,
    });
  });

  it("refuses an option written without its value and exits 2", () => {
    expect(invoke(["print-config", "--target"])).toEqual({
      code: 2,
      out: "",
      err: `deadset-ts: option "--target" takes a value\n${USAGE}`,
    });
  });

  it.each(["config", "central"])(
    "refuses a configuration document --%s names that cannot be read, naming it, and exits 2",
    (option) => {
      const missing = join(tmpdir(), "deadset-ts-absent", "deadset.json");

      const got = invoke(["print-config", `--target=${tmpdir()}`, `--${option}=${missing}`]);

      expect(got.code).toBe(2);
      expect(got.err).toContain(`deadset-ts: ${missing}: `);
    },
  );

  it("resolves the target kind the central configuration an option names supplies", () => {
    const scratch = mkdtempSync(join(tmpdir(), "deadset-ts-central-"));
    onTestFinished(() => {
      rmSync(scratch, { recursive: true, force: true });
    });
    const central = join(scratch, "central.json");
    writeFileSync(central, '{"target":{"kind":"application"}}\n');

    const got = invoke(["print-config", `--target=${scratch}`, `--central=${central}`]);

    expect(got.code, got.err).toBe(0);
    expect(JSON.parse(got.out)).toMatchObject({ target: { kind: "application" } });
  });
});

/** A one-project tree of this test's own whose repository configuration is `document`. */
function configuredTree(document: Readonly<Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), "deadset-ts-configured-"));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "deadset.json"), `${JSON.stringify(document)}\n`);
  writeFileSync(join(root, "tsconfig.json"), '{"include":["main.ts"]}\n');
  writeFileSync(join(root, "main.ts"), "export const main: number = 1;\n");
  return root;
}

describe("a key only another product reads", () => {
  const OTHERS = {
    target: { kind: { go: "service", ts: "application" } },
    analysis: { languages: ["py"] },
    providers: {
      analyzers: [
        { name: "deadset-ts", languages: ["ts"], command: "a" },
        { name: "deadset-ts", languages: ["ts"], command: "b" },
      ],
    },
    go: { planted: null, build_tags: "not-a-list" },
  };

  it.each(["print-config", "print-projects", "print-roots"])("is accepted unread by %s", (verb) => {
    const got = invoke([verb, `--target=${configuredTree(OTHERS)}`]);

    expect(got.code, got.err).toBe(0);
  });

  it("is left out of the printed configuration, a per-language kind printed as its own member", () => {
    const got = invoke(["print-config", `--target=${configuredTree(OTHERS)}`]);
    const printed = JSON.parse(got.out) as {
      target: unknown;
      analysis: Record<string, unknown>;
      provenance: Record<string, string>;
    };

    expect(printed.target).toEqual({ kind: { ts: "application" } });
    expect(Object.keys(printed)).not.toContain("providers");
    expect(Object.keys(printed)).not.toContain("go");
    expect(Object.keys(printed.analysis)).not.toContain("languages");
    expect(Object.keys(printed.provenance).filter((key) => key.startsWith("providers"))).toEqual(
      [],
    );
  });
});

describe("a configuration document above the Contract's bound", () => {
  it("is refused with the usage code before it is decoded", () => {
    const got = invoke([
      "print-config",
      `--target=${configuredTree({ target: { kind: "library" }, roots: { patterns: ["a".repeat(1 << 20)] } })}`,
    ]);

    expect(got.code).toBe(2);
    expect(got.err).toContain("holds more than 1048576 bytes");
  });

  it("is read no further than one byte past the bound, from every source", () => {
    const root = configuredTree({ target: { kind: "library" } });
    const document = join(root, "deadset.json");
    const limits: (number | undefined)[] = [];
    const host: Host = {
      ...nodeHost(),
      readFile: (path, limit) => {
        if (path === document) {
          limits.push(limit);
        }
        return nodeHost().readFile(path, limit);
      },
    };

    expect(invoke(["print-config", `--target=${root}`], host).code).toBe(0);
    expect(invoke(["print-config", `--config=${document}`], host).code).toBe(0);
    expect(invoke(["print-config", `--target=${root}`, `--central=${document}`], host).code).toBe(
      0,
    );
    expect(limits).toEqual([1048577, 1048577, 1048577, 1048577]);
  });

  /** A document of exactly `bytes` bytes, its padding two-byte characters. */
  function sized(bytes: number): string {
    const [head, tail] = ['{"target":{"kind":"library"},"roots":{"patterns":["', '"]}}'];
    const fill = bytes - Buffer.byteLength(head + tail);
    return head + "é".repeat(Math.floor(fill / 2)) + "a".repeat(fill % 2) + tail;
  }

  it.each([
    [1048576, 0],
    [1048577, 2],
    [1048578, 2],
  ])("of %i bytes of two-byte characters exits %i", (bytes, code) => {
    const root = configuredTree({});
    writeFileSync(join(root, "deadset.json"), sized(bytes));
    const got = invoke(["print-config", `--target=${root}`]);

    expect(Buffer.byteLength(sized(bytes))).toBe(bytes);
    expect(got.code, got.err).toBe(code);
    expect(got.err.split("\n")[0]).toBe(
      code === 0 ? "" : `deadset-ts: ${join(root, "deadset.json")}: holds more than 1048576 bytes`,
    );
  });
});

describe("print-projects", () => {
  it("discovers every project of a project-references graph", () => {
    const got = invoke(["print-projects", `--target=${fixture("projects", "two-projects")}`]);

    expect(got.code, got.err).toBe(0);
    expect(got.out.trim().split("\n").sort()).toEqual(["app/tsconfig.json", "core/tsconfig.json"]);
  });

  it("analyzes a package whose sources ship as TypeScript with no build step", () => {
    const got = invoke(["print-projects", `--target=${fixture("projects", "sources-only")}`]);

    expect(got.code, got.err).toBe(0);
    expect(got.out).toBe("tsconfig.json\n");
  });

  it("lists a project whose own file holds a type error, which the run analyzes", () => {
    const got = invoke(["print-projects", `--target=${fixture("projects", "semantic-error")}`]);

    expect(got.code, got.err).toBe(0);
    expect(got.out).toBe("tsconfig.json\n");
  });

  it("ends a run whose target holds no compiler configuration with the failure code", () => {
    const root = mkdtempSync(join(tmpdir(), "deadset-ts-no-program-"));
    onTestFinished(() => {
      rmSync(root, { recursive: true, force: true });
    });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "@example/none", devDependencies: { "left-pad": "1.0.0" } }),
    );
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "deadset.json"), JSON.stringify({ target: { kind: "application" } }));
    const got = invoke(["analyze", "--target=.", `--report=${join(root, "report.json")}`], {
      ...nodeHost(),
      workingDirectory: () => root,
    });

    expect(got.code, got.err).toBe(3);
    expect(got.err).toMatch(/holds no compiler configuration, so the run holds no program/u);
  });

  it("analyzes a nested package whose enabling package nothing installs, applying no row", () => {
    const root = mkdtempSync(join(tmpdir(), "deadset-ts-nested-uninstalled-"));
    onTestFinished(() => {
      rmSync(root, { recursive: true, force: true });
    });
    mkdirSync(join(root, "tools"));
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["**/*.ts"] }),
    );
    writeFileSync(join(root, "main.ts"), "export const a = 1;\n");
    writeFileSync(
      join(root, "tools", "package.json"),
      JSON.stringify({ name: "@example/tools", devDependencies: { vitest: "5.0.0" } }),
    );
    writeFileSync(join(root, "tools", "pinned.ts"), "export const b = 2;\n");
    const got = invoke(["print-projects", "--target=."], {
      ...nodeHost(),
      workingDirectory: () => root,
    });

    expect(got.err).toBe("");
    expect(got.code).toBe(0);
  });

  it("analyzes exactly the projects a declared matrix names, by their identifiers", () => {
    const got = invoke([
      "print-projects",
      `--target=${matrixTree()}`,
      `--config=${fixture("vectors", "config", "typescript-matrix-declared", "repository.json")}`,
    ]);

    expect(got.code, got.err).toBe(0);
    expect(got.out.trim().split("\n").sort()).toEqual([
      "packages/app/tsconfig.json",
      "tsconfig.json",
    ]);
  });

  it("reads the declared matrix from the target's own configuration document", () => {
    const target = matrixTree({
      "deadset.json": '{"analysis":{"configurations":[{"id":"main","project":"tsconfig.json"}]}}\n',
    });

    const got = invoke(["print-projects", `--target=${target}`]);

    expect(got.code, got.err).toBe(0);
    expect(got.out).toBe("main\n");
  });

  it("prints the projects in the order the matrix lists them, whatever their paths", () => {
    const project = '{"compilerOptions":{"strict":true,"noEmit":true},"include":["src/*.ts"]}\n';
    const target = matrixTree({
      "tsconfig.a.json": project,
      "tsconfig.b.json": project,
      "deadset.json": JSON.stringify({
        analysis: {
          configurations: [
            { id: "a1", project: "tsconfig.json" },
            { id: "c3", project: "tsconfig.b.json" },
            { id: "b2", project: "tsconfig.a.json" },
          ],
        },
      }),
    });

    const got = invoke(["print-projects", `--target=${target}`]);

    expect(got.code, got.err).toBe(0);
    expect(got.out, "neither the configuration files' path order nor the identifiers'").toBe(
      "a1\nc3\nb2\n",
    );
  });

  it("derives every project of the tree with no declared matrix, one holding a type error among them", () => {
    const got = invoke(["print-projects", `--target=${matrixTree()}`]);

    expect(got.code, got.err).toBe(0);
    expect(got.out).toBe(
      "fixtures/broken/tsconfig.json\npackages/app/tsconfig.json\ntsconfig.json\n",
    );
  });

  it("drops a derived project that imports a file nothing generated, naming the setup failure", () => {
    const got = invoke([
      "print-projects",
      `--target=${matrixTree({ "fixtures/broken/broken.ts": 'export { made } from "./generated.js";\n' })}`,
    ]);

    expect(got.code, got.err).toBe(0);
    expect(got.out).toBe("packages/app/tsconfig.json\ntsconfig.json\n");
    expect(got.err).toContain(
      'the derived configuration fixtures/broken/tsconfig.json was not built and is not analyzed: setup failure: missing-module: fixtures/broken/broken.ts:1: fixtures/broken/broken.ts imports "./generated.js", which names no file of the target: run the generator or the build that writes it',
    );
  });

  it("prints the projects that load and names on the error stream a derived one that names no input", () => {
    const target = matrixTree({
      "fixtures/broken/tsconfig.json": '{ "include": ["none/*.ts"] }\n',
      "tools/tsconfig.json": '{ "include": ["none/*.ts"] }\n',
    });

    const got = invoke(["print-projects", `--target=${target}`]);

    expect(got.code, got.err).toBe(0);
    expect(got.out).toBe("packages/app/tsconfig.json\ntsconfig.json\n");
    expect(got.err.split("\n").filter((line) => line !== "")).toEqual([
      "deadset-ts: the derived configuration fixtures/broken/tsconfig.json was not built and is not analyzed: TS18003: No inputs were found in config file 'fixtures/broken/tsconfig.json'. Specified 'include' paths were '[\"none/*.ts\"]' and 'exclude' paths were '[]'.",
      "deadset-ts: the derived configuration tools/tsconfig.json was not built and is not analyzed: TS18003: No inputs were found in config file 'tools/tsconfig.json'. Specified 'include' paths were '[\"none/*.ts\"]' and 'exclude' paths were '[]'.",
    ]);
  });

  it("builds a derived project missing a global type, skipping each of its files whole", () => {
    const target = matrixTree({
      "fixtures/broken/tsconfig.json":
        '{ "compilerOptions": { "noLib": true, "noEmit": true }, "include": ["*.ts"] }\n',
      "fixtures/broken/broken.ts": "export const broken = [1];\nfunction unread(): void {}\n",
      "deadset.json": '{"target":{"kind":"application"}}\n',
    });

    const got = invoke(["analyze", "--target=.", `--report=${join(target, "report.json")}`], {
      ...nodeHost(),
      workingDirectory: () => target,
    });
    const report = JSON.parse(readFileSync(join(target, "report.json"), "utf8")) as {
      configurations_not_built: unknown[];
      findings: { position: { path: string } }[];
    };

    expect(got.err).toContain(
      "deadset-ts: fixtures/broken/tsconfig.json: TS2318: Cannot find global type 'Array'.: the configuration is analyzed without that library",
    );
    expect(got.err).toContain(
      "deadset-ts: fixtures/broken/broken.ts:1: Cannot find global type 'Array'.: the function or statement holding this type error is not evaluated",
    );
    expect(report.configurations_not_built).toEqual([]);
    expect(report.findings.map((one) => one.position.path)).not.toContain(
      "fixtures/broken/broken.ts",
    );
  });

  it.each([
    [
      "a removed option of the configuration its test files join",
      {
        "package.json":
          '{ "name": "app", "private": true, "devDependencies": { "jest": "29.0.0" } }\n',
        "tsconfig.json":
          '{ "compilerOptions": { "strict": true, "noEmit": true, "esModuleInterop": false }, "include": ["src/*.ts"], "exclude": ["**/*.test.ts"] }\n',
        "src/main.test.ts": 'import { main } from "./main";\nconsole.log(main);\n',
      },
      "tsconfig.json",
    ],
    [
      "the output layout of the configuration the run writes for a workspace member",
      {
        "package.json": '{ "private": true, "workspaces": ["web"] }\n',
        "web/package.json":
          '{ "name": "web", "private": true, "devDependencies": { "jest": "29.0.0" } }\n',
        "web/tsconfig.json":
          '{ "compilerOptions": { "strict": true, "outDir": "./dist/" }, "include": ["./src/**/*"], "exclude": ["**/*.test.ts"] }\n',
        "web/src/a.ts": "export const a = 1;\n",
        "web/src/a.test.ts": 'import { a } from "./a";\nconsole.log(a);\n',
      },
      "web/tsconfig.json",
    ],
  ])("builds a derived project whose only error in no file is about %s", (_form, extra, built) => {
    const target = matrixTree(extra);

    const got = invoke(["print-projects", `--target=${target}`]);

    expect(got.code, got.err).toBe(0);
    expect(got.out.split("\n")).toContain(built);
    expect(got.err).not.toMatch(/TS5\d{3}/u);
  });

  it("builds a declared project missing a global type", () => {
    const target = matrixTree({
      "deadset.json":
        '{"analysis":{"configurations":[{"id":"app","project":"packages/app/tsconfig.json"}]}}\n',
      "packages/app/tsconfig.json":
        '{ "compilerOptions": { "noLib": true, "noEmit": true }, "include": ["*.ts"] }\n',
      "packages/app/app.ts": "export const app = [1];\n",
    });

    const got = invoke(["print-projects", `--target=${target}`]);

    expect(got.code, got.err).toBe(0);
    expect(got.out).toBe("app\n");
  });

  it("analyzes a project naming a type library the compiler cannot find, noting it once", () => {
    const target = matrixTree({
      "deadset.json":
        '{"target":{"kind":"application"},"analysis":{"configurations":[{"id":"app","project":"packages/app/tsconfig.json"}]}}\n',
      "packages/app/tsconfig.json":
        '{ "compilerOptions": { "strict": true, "types": ["no-such"], "noEmit": true }, "include": ["*.ts"] }\n',
    });

    const got = invoke(["analyze", "--target=.", `--report=${join(target, "report.json")}`], {
      ...nodeHost(),
      workingDirectory: () => target,
    });

    expect(got.code, got.err).toBe(1);
    expect(
      got.err.split("\n").filter((line) => line.includes("TS2688")),
      "one note, though two diagnostic sets carry the error",
    ).toEqual([
      "deadset-ts: packages/app/tsconfig.json: TS2688: Cannot find type definition file for 'no-such'.: the configuration is analyzed without that library",
    ]);
  });

  it("names on the error stream the derived project print-roots dropped", () => {
    const target = matrixTree({
      "deadset.json": '{ "target": { "kind": "application" } }\n',
      "fixtures/broken/tsconfig.json": '{ "include": ["none/*.ts"] }\n',
    });

    const got = invoke(["print-roots", `--target=${target}`]);

    expect(got.code, got.err).toBe(0);
    expect(got.err).toContain(
      "deadset-ts: the derived configuration fixtures/broken/tsconfig.json was not built and is not analyzed",
    );
  });

  it("exits 3 naming a declared project whose configuration does not exist", () => {
    const target = matrixTree({
      "deadset.json":
        '{"analysis":{"configurations":[{"id":"gone","project":"packages/gone/tsconfig.json"}]}}\n',
    });

    const got = invoke(["print-projects", `--target=${target}`]);

    expect(got.code).toBe(3);
    expect(got.out).toBe("");
    expect(got.err).toContain('the project "gone"');
    expect(got.err).toContain(join(target, "packages", "gone", "tsconfig.json"));
  });

  it("exits 3 with the setup failure when it drops every project discovery derived", () => {
    const ungenerated = 'export { made } from "./generated.js";\n';
    const target = matrixTree({
      "src/main.ts": ungenerated,
      "packages/app/app.ts": ungenerated,
      "fixtures/broken/broken.ts": ungenerated,
    });

    const got = invoke(["print-projects", `--target=${target}`]);

    expect(got.code).toBe(3);
    expect(got.out).toBe("");
    expect(got.err).toMatch(/^setup failure: missing-module: src\/main\.ts:1: /mu);
  });

  it.each([
    ["an import type", '/** @type {import("./missing.js").T} */\nexport let v;\n'],
    [
      "an @import tag",
      '/** @import { T } from "./missing.js" */\n/** @type {T} */\nexport let v;\n',
    ],
  ])(
    "exits 3 with the setup failure for a checked JavaScript file whose doc comment holds %s of a file nothing generated",
    (_form, text) => {
      const target = matrixTree({
        "deadset.json":
          '{"analysis":{"configurations":[{"id":"js","project":"fixtures/broken/tsconfig.json"}]}}\n',
        "fixtures/broken/tsconfig.json":
          '{ "compilerOptions": { "strict": true, "noEmit": true, "allowJs": true, "checkJs": true }, "include": ["*.js"] }\n',
        "fixtures/broken/main.js": text,
      });

      const got = invoke(["print-projects", `--target=${target}`]);

      expect(got.code, got.err).toBe(3);
      expect(got.err).toMatch(
        /^setup failure: missing-module: fixtures\/broken\/main\.js:1: fixtures\/broken\/main\.js imports "\.\/missing\.js", which names no file of the target/mu,
      );
    },
  );

  it("reads an import a paths alias maps to an existing asset as a type error, and one it maps to no file as a setup failure", () => {
    const tree = (asset: string): string =>
      matrixTree({
        "app/tsconfig.json":
          '{ "compilerOptions": { "strict": true, "noEmit": true, "module": "esnext", "moduleResolution": "bundler", "paths": { "@/*": ["./*"] } }, "include": ["*.ts"] }\n',
        "app/public/logo.png": "",
        "app/main.ts": `import logo from "@/public/${asset}";\nexport const shown = logo;\n`,
      });

    const present = invoke(["print-projects", `--target=${join(tree("logo.png"), "app")}`]);
    const absent = invoke(["print-projects", `--target=${join(tree("gone.png"), "app")}`]);

    expect(present.code, present.err).toBe(0);
    expect(present.out).toBe("tsconfig.json\n");
    expect(absent.code).toBe(3);
    expect(absent.err).toContain(
      `imports "@/public/gone.png", which the compiler configuration's paths map to no file`,
    );
  });

  it("substitutes what a paths alias's star matches as written, a dollar sign included", () => {
    const target = matrixTree({
      "app/tsconfig.json":
        '{ "compilerOptions": { "strict": true, "noEmit": true, "module": "esnext", "moduleResolution": "bundler", "paths": { "@/*": ["./*"] } }, "include": ["*.ts"] }\n',
      "app/public/$&.png": "",
      "app/main.ts": 'import logo from "@/public/$&.png";\nexport const shown = logo;\n',
    });

    const got = invoke(["print-projects", `--target=${join(target, "app")}`]);

    expect(got.code, got.err).toBe(0);
    expect(got.out).toBe("tsconfig.json\n");
  });

  it("reads an import a paths alias maps to a directory, rather than a file, as a setup failure", () => {
    const target = matrixTree({
      "app/tsconfig.json":
        '{ "compilerOptions": { "strict": true, "noEmit": true, "module": "esnext", "moduleResolution": "bundler", "paths": { "@/*": ["./*"] } }, "include": ["*.ts"] }\n',
      "app/assets/readme.txt": "",
      "app/main.ts": 'import assets from "@/assets";\nexport const shown = assets;\n',
    });

    const got = invoke(["print-projects", `--target=${join(target, "app")}`]);

    expect(got.code).toBe(3);
    expect(got.err).toContain(
      `imports "@/assets", which the compiler configuration's paths map to no file`,
    );
  });

  it("reads the targets of a paths alias an extended configuration writes against that configuration's directory", () => {
    const target = matrixTree({
      "paths.json": '{ "compilerOptions": { "paths": { "@/*": ["./app/*"] } } }\n',
      "app/tsconfig.json":
        '{ "extends": "../paths.json", "compilerOptions": { "strict": true, "noEmit": true, "module": "esnext", "moduleResolution": "bundler" }, "include": ["*.ts"] }\n',
      "app/public/logo.png": "",
      "app/main.ts": 'import logo from "@/public/logo.png";\nexport const shown = logo;\n',
    });

    const got = invoke(["print-projects", `--target=${join(target, "app")}`]);

    expect(got.code, got.err).toBe(0);
    expect(got.out).toBe("tsconfig.json\n");
  });

  it("reads an import of an installed package that a paths alias maps to no file as a type error", () => {
    const target = matrixTree({
      "app/tsconfig.json":
        '{ "compilerOptions": { "strict": true, "noEmit": true, "module": "nodenext", "moduleResolution": "nodenext", "paths": { "@scope/*": ["./packages/*/src/index.ts"] } }, "include": ["*.ts"] }\n',
      "app/node_modules/@scope/pm/package.json":
        '{ "name": "@scope/pm", "exports": { "./other": "./other.js" } }\n',
      "app/main.ts": 'export type { View } from "@scope/pm/view";\n',
    });

    const got = invoke(["print-projects", `--target=${join(target, "app")}`]);

    expect(got.code, got.err).toBe(0);
    expect(got.out).toBe("tsconfig.json\n");
  });

  it("reads an import of a package installed above the target that the compiler cannot resolve as a type error", () => {
    const tree = (installed: "package" | "file" | "absent"): string =>
      matrixTree({
        "package.json": '{ "name": "root", "private": true }\n',
        ...(installed === "package"
          ? {
              "node_modules/pkg/package.json":
                '{ "name": "pkg", "exports": { "./providers/*": "./providers/*.js" } }\n',
            }
          : {}),
        ...(installed === "file" ? { "node_modules/pkg": "" } : {}),
        "apps/web/package.json": '{ "name": "web", "dependencies": { "pkg": "1.0.0" } }\n',
        "apps/web/tsconfig.json":
          '{ "compilerOptions": { "strict": true, "noEmit": true, "module": "nodenext", "moduleResolution": "nodenext" }, "include": ["*.ts"] }\n',
        "apps/web/main.ts": 'export type { Provider } from "pkg/providers";\n',
      });

    const hoisted = invoke(["print-projects", `--target=${join(tree("package"), "apps", "web")}`]);
    const missing = invoke(["print-projects", `--target=${join(tree("absent"), "apps", "web")}`]);
    const file = invoke(["print-projects", `--target=${join(tree("file"), "apps", "web")}`]);

    expect(hoisted.code, hoisted.err).toBe(0);
    expect(hoisted.out).toBe("tsconfig.json\n");
    expect(missing.code).toBe(3);
    expect(missing.err).toContain("a dependency package.json declares that is not installed");
    expect(file.code, "a file where the package's directory would be").toBe(3);
    expect(file.err).toContain("a dependency package.json declares that is not installed");
  });

  it("exits 3 with the setup failure for a declared project that imports a file nothing generated", () => {
    const target = matrixTree({
      "deadset.json":
        '{"analysis":{"configurations":[{"id":"app","project":"tsconfig.json"},{"id":"broken","project":"fixtures/broken/tsconfig.json"}]}}\n',
      "fixtures/broken/broken.ts": 'export { made } from "./generated.js";\n',
    });

    const got = invoke(["print-projects", `--target=${target}`]);

    expect(got.code).toBe(3);
    expect(got.out).toBe("");
    expect(got.err).toMatch(/^setup failure: missing-module: /mu);
  });

  it("names the setup failure analyze names for a workspace member with no source", () => {
    const target = fixture("corpus", "workspace-member-without-source", "ts", "target");
    const scratch = mkdtempSync(join(tmpdir(), "deadset-ts-member-"));
    onTestFinished(() => {
      rmSync(scratch, { recursive: true, force: true });
    });
    writeFileSync(join(scratch, "deadset.json"), '{"target":{"kind":"application"}}\n');
    const line =
      "setup failure: workspace-member-without-source: packages/app/src/main.ts imports @example/lib, a package of the workspace with no source to read: the package has no tsconfig*.json and its manifest names ./dist/bundle.js, which does not exist; build the package\n";

    const projects = invoke(["print-projects", `--target=${target}`]);
    const analyzed = invoke([
      "analyze",
      `--target=${target}`,
      `--config=${join(scratch, "deadset.json")}`,
      `--report=${join(scratch, "report.json")}`,
    ]);

    expect(projects.code).toBe(3);
    expect(projects.err).toBe(line);
    expect(analyzed.code).toBe(3);
    expect(analyzed.err).toBe(line);
  });

  it("exits 3 for a declared project referencing one the matrix leaves out, whose errors the run would not read", () => {
    const target = matrixTree({
      "deadset.json": '{"analysis":{"configurations":[{"id":"a","project":"a/tsconfig.json"}]}}\n',
      "a/tsconfig.json":
        '{"compilerOptions":{"strict":true,"module":"NodeNext","noEmit":true},' +
        '"include":["*.ts"],"references":[{"path":"../b"}]}\n',
      "a/a.ts": 'import { fromB } from "../b/b.js";\nexport const fromA: number = fromB;\n',
      "b/tsconfig.json":
        '{"compilerOptions":{"composite":true,"strict":true,"module":"NodeNext","outDir":"out"},' +
        '"include":["*.ts"]}\n',
      "b/b.ts": "export const fromB: number = 1;\nexport const broken: string = 2;\n",
    });

    const got = invoke(["print-projects", `--target=${target}`]);

    expect(got.code, got.out).toBe(3);
    expect(got.err).toContain("which the build matrix does not name");
  });

  it("exits 2 naming a build configuration of both shapes", () => {
    const target = matrixTree({
      "deadset.json":
        '{"analysis":{"configurations":[{"id":"x","os":"linux","arch":"amd64","project":"tsconfig.json"}]}}\n',
    });

    const got = invoke(["print-projects", `--target=${target}`]);

    expect(got.code).toBe(2);
    expect(got.err).toContain("analysis.configurations[0]");
  });

  it("analyzes this repository under the matrix its own configuration declares", () => {
    const got = invoke(["print-projects", `--target=${ROOT}`]);

    expect(got.code, got.err).toBe(0);
    expect(got.out).toBe("tsconfig.test.json\n");
  });

  it("exits 2 naming a scope document the invocation names and it cannot read", () => {
    const got = invoke(["print-projects", `--scope=${fixture("projects", "no-such-scope.json")}`]);

    expect(got.code).toBe(2);
    expect(got.err).toContain("no-such-scope.json");
    expect(got.err).toContain(USAGE);
  });
});

describe("the compiler client a verb opens", () => {
  it("is closed when the verb fails before its session reads a project", () => {
    const target = matrixTree({
      "deadset.json":
        '{"analysis":{"configurations":[{"id":"gone","project":"packages/gone/tsconfig.json"}]}}\n',
    });
    let closes = 0;
    const counted = (options: EngineOptions): Engine => {
      const engine = openEngine(options);
      return {
        ...engine,
        close: () => {
          closes += 1;
          engine.close();
        },
      };
    };

    const code = run(
      ["print-projects", `--target=${target}`],
      new MemoryWriter(),
      new MemoryWriter(),
      nodeHost(),
      counted,
    );

    expect(code).toBe(3);
    expect(closes).toBe(1);
  });
});

describe("print-roots", () => {
  it.each(["entry-points", "published-exports", "configured-roots", "entry-rules"])(
    "prints the root set of %s as the committed golden",
    async (name) => {
      const got = invoke(["print-roots", `--target=${fixture("projects", name)}`]);

      await expect(
        got.out,
        "the lines are produced by the production path; to record a reviewed change run " +
          "`npx vitest --run -u src/run.test.ts` and read the diff as production code",
      ).toMatchFileSnapshot(fixture("golden", `${name}.roots.txt`));
    },
  );

  it("exits 0 with nothing on the error stream when every configured root names something", () => {
    const got = invoke(["print-roots", `--target=${fixture("projects", "entry-rules")}`]);

    expect(got.code, got.err).toBe(0);
    expect(got.err).toBe("");
  });

  it("names each configured root that names nothing by its issue kind and exits 1", () => {
    const got = invoke(["print-roots", `--target=${fixture("projects", "configured-roots")}`]);

    expect(got.code).toBe(1);
    expect(got.err).toBe(
      "DS9004: roots.patterns names nothing: ts://@example/configured-roots/a/gone.ts#gone\n" +
        "DS9004: roots.patterns names nothing: ts://@example/configured-roots/*#nothing?\n",
    );
  });

  it("roots what a statement holding a type error declares, and exits 0", () => {
    const got = invoke([
      "print-roots",
      `--target=${fixture("projects", "semantic-error")}`,
      `--config=${fixture("projects", "entry-points", "deadset.json")}`,
    ]);

    expect(got.code, got.err).toBe(0);
    expect(got.out).toBe("ts://./broken.ts#answer\ttype-error\n");
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
