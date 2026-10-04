import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture, ROOT } from "../__test-helpers__/fixtures.ts";
import type { Host } from "./host.ts";
import { run, SETTING_OPTIONS, type Writer } from "./run.ts";
import { declaresSetting } from "./schema.ts";
import { openEngine, type Engine } from "./session.ts";
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
    expect(got.err).toContain('"next-app-router" names no convention row');
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

  it("exits 3 naming a scope document it cannot read", () => {
    const got = invoke(["print-projects", `--scope=${fixture("projects", "no-such-scope.json")}`]);

    expect(got.code).toBe(3);
    expect(got.err).toContain("no-such-scope.json");
  });
});

describe("the compiler client a verb opens", () => {
  it("is closed when the verb fails before its session reads a project", () => {
    const target = matrixTree({
      "deadset.json":
        '{"analysis":{"configurations":[{"id":"gone","project":"packages/gone/tsconfig.json"}]}}\n',
    });
    let closes = 0;
    const counted = (collectTiming: boolean): Engine => {
      const engine = openEngine({ collectTiming });
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
      "DS1704: roots.patterns names nothing: ts://@example/configured-roots/a/gone.ts#gone\n" +
        "DS1704: roots.patterns names nothing: ts://@example/configured-roots/*#nothing?\n",
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
