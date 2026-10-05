import { cpSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import type { ConventionRow, OptionsCall } from "./convention-rows.ts";
import { readConventions, readProperty, type Conventions } from "./conventions.ts";
import type { DirectoryEntry, Host, PathKind } from "./host.ts";
import { run, type Writer } from "./run.ts";
import { openEngine } from "./session.ts";

const engine = openEngine({ collectTiming: false });
afterAll(() => {
  engine.close();
});
const parse = (fileName: string, text: string) => engine.parseSourceFile(fileName, text);

/** A host over an in-memory tree of absolute paths. */
function hostWith(files: Readonly<Record<string, string>>): Host {
  const kindOf = (path: string): PathKind => {
    if (Object.hasOwn(files, path)) {
      return "file";
    }
    return Object.keys(files).some((one) => one.startsWith(`${path}/`)) ? "directory" : "absent";
  };
  const readDirectory = (dir: string): readonly DirectoryEntry[] => {
    const names = new Map<string, boolean>();
    for (const path of Object.keys(files)) {
      if (path.startsWith(`${dir}/`)) {
        const [name = "", ...rest] = path.slice(dir.length + 1).split("/");
        names.set(name, rest.length > 0);
      }
    }
    return [...names].map(([name, directory]) => ({ name, directory }));
  };
  return {
    workingDirectory: () => "/",
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) {
        throw new Error(`${path}: absent`);
      }
      return text;
    },
    readDirectory,
    kindOf,
    realPath: (path) => path,
    analyzerVersion: () => "0.0.0",
    temporaryDirectory: () => {
      throw new Error("no temporary directory");
    },
    componentMapperCommand: () => [],
    writeDocument: (path) => {
      throw new Error(`${path}: this host writes nothing`);
    },
  };
}

/** A row over `src/`, moved by `layout.dir` in `tool.config.ts`. */
const ROW: ConventionRow = {
  name: "tool",
  package: "tool",
  range: ">=2.0.0 <3.0.0",
  entries: ["<dir>/**/*.ts"],
  moves: [
    {
      id: "dir",
      defaults: ["src"],
      readings: [{ property: "layout.dir", files: ["tool.config.{ts,js}"] }],
    },
  ],
};

const INSTALLED = { "/repo/node_modules/tool/package.json": '{ "version": "2.1.0" }' };

function decide(
  files: Readonly<Record<string, string>>,
  disabled: readonly string[] = [],
  rows: readonly ConventionRow[] = [ROW],
): Conventions {
  return readConventions(
    hostWith(files),
    parse,
    [{ dir: "/repo", path: "package.json" }],
    disabled,
    rows,
  );
}

/** The rows whose globs match one path, once per matching glob. */
function matches(conventions: Conventions, path: string): readonly string[] {
  return conventions.globs.filter((glob) => glob.expression.test(path)).map((glob) => glob.row);
}

describe("readProperty", () => {
  const read = (text: string, call?: OptionsCall) =>
    readProperty(parse("/repo/tool.config.ts", text), "layout.dir", call);
  const TOOL: OptionsCall = { module: "tool", export: "tool" };

  it("reads a string literal and a template literal with no substitution", () => {
    expect(read('export default { layout: { dir: "web" } };').values).toEqual(["web"]);
    expect(read("export default { layout: { dir: `web` } };").values).toEqual(["web"]);
  });

  it("reads the default export through a call, a declaration and a type assertion", () => {
    const text =
      'const config = defineConfig({ layout: { dir: "a" } as const });\nexport default config;\n';

    expect(read(text)).toEqual({ values: ["a"] });
  });

  it("reads a default export written as module.exports or as an export specifier", () => {
    expect(read('module.exports = { layout: { dir: "c" } };').values).toEqual(["c"]);
    expect(read('const c = { layout: { dir: "d" } };\nexport { c as default };').values).toEqual([
      "d",
    ]);
  });

  it("refuses a default export that is not written out as an object literal", () => {
    expect(read("export default function () {}").notLiteral).toBeDefined();
    expect(read("export default merge(base, {});").notLiteral).toBeDefined();
  });

  it("reads the options of every call to the named export, under any local name", () => {
    const text =
      'import { tool as t } from "tool";\nimport * as ns from "tool";\n' +
      'const options = { layout: { dir: "c" } };\n' +
      'export default defineConfig(() => ({ plugins: [t({ layout: { dir: "a" } }), ' +
      'ns.tool({ layout: { dir: "b" } }), t(options), t()] }));\n';

    expect(read(text, TOOL)).toEqual({ values: ["a", "b", "c"] });
  });

  it("reads nothing another call or the default export sets at the same path", () => {
    const text =
      'import { tool, helper } from "tool";\nimport { tool as other } from "other";\n' +
      "export default { plugins: [tool(), other({ layout: { dir: name } }), " +
      'other({ layout: { dir: "x" } }), helper({ layout: { dir: "z" } })], layout: { dir: "y" } };\n';

    expect(read(text, TOOL)).toEqual({ values: [] });
  });

  it("refuses call options that are not written out as an object literal", () => {
    expect(read('import { tool } from "tool";\ntool(make());', TOOL).notLiteral).toBeDefined();
  });

  it("names no value where the file does not set the property", () => {
    expect(read('export default { layout: { other: "x" }, dir: "y" };')).toEqual({ values: [] });
  });

  it("refuses a value that is not a literal, a shorthand, a template with a substitution", () => {
    expect(read("export default { layout: { dir: name } };").notLiteral).toBeDefined();
    expect(read("export default { layout: { dir } };").notLiteral).toBeDefined();
    expect(read("export default { layout: { dir: `${root}/web` } };").notLiteral).toBeDefined();
  });

  it("refuses an object along the path that the file does not write out", () => {
    expect(read("export default { layout: shared };").notLiteral).toBeDefined();
    expect(read("export default { layout: { ...shared } };").notLiteral).toBeDefined();
  });

  it("refuses a read object that spreads another object into itself", () => {
    expect(read("export default { ...shared };").notLiteral).toBeDefined();
    expect(
      read('import { tool } from "tool";\ntool({ ...shared, other: 1 });', TOOL).notLiteral,
    ).toBeDefined();
  });
});

describe("readConventions", () => {
  it("applies a row the manifest declares in any dependency section", () => {
    for (const section of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const decided = decide({
        "/repo/package.json": JSON.stringify({ [section]: { tool: "^2" } }),
        ...INSTALLED,
      });

      expect(decided.applied, section).toEqual([
        { name: "tool", package: "tool", version: "2.1.0", manifest: "package.json" },
      ]);
    }
  });

  it("applies nothing for a manifest that does not declare the enabling package", () => {
    expect(decide({ "/repo/package.json": "{}", ...INSTALLED })).toEqual({
      applied: [],
      globs: [],
      generated: [],
      failures: [],
      uses: [],
    });
  });

  it("reads the installed version from the nearest node_modules at or above the manifest", () => {
    const decided = readConventions(
      hostWith({
        "/repo/apps/web/package.json": '{ "dependencies": { "tool": "2" } }',
        "/repo/node_modules/tool/package.json": '{ "version": "2.0.0" }',
        "/node_modules/tool/package.json": '{ "version": "9.0.0" }',
      }),
      parse,
      [{ dir: "/repo/apps/web", path: "apps/web/package.json" }],
      [],
      [ROW],
    );

    expect(decided.applied.map((one) => one.version)).toEqual(["2.0.0"]);
  });

  it("does not apply a row whose range the installed version is outside", () => {
    const decided = decide({
      "/repo/package.json": '{ "dependencies": { "tool": "3" } }',
      "/repo/node_modules/tool/package.json": '{ "version": "3.0.0" }',
    });

    expect(decided).toEqual({ applied: [], globs: [], generated: [], failures: [], uses: [] });
  });

  it("fails as missing-module where no installed manifest is found", () => {
    const decided = decide({ "/repo/package.json": '{ "dependencies": { "tool": "2" } }' });

    expect(decided.failures.map((one) => one.failure.setupClass)).toEqual(["missing-module"]);
    expect(decided.failures[0]?.failure.detail).toContain("package.json declares tool");
    expect(decided.applied).toEqual([]);
  });

  it("fails as missing-module once for a package two rows read", () => {
    const decided = decide(
      { "/repo/package.json": '{ "dependencies": { "tool": "2" } }' },
      [],
      [ROW, { ...ROW, range: ">=3.0.0 <4.0.0" }],
    );

    expect(decided.failures.map((one) => one.failure.setupClass)).toEqual(["missing-module"]);
  });

  it("fails as missing-module once in each manifest that declares the package", () => {
    const decided = readConventions(
      hostWith({
        "/repo/package.json": '{ "dependencies": { "tool": "2" } }',
        "/repo/apps/web/package.json": '{ "devDependencies": { "tool": "2" } }',
      }),
      parse,
      [
        { dir: "/repo", path: "package.json" },
        { dir: "/repo/apps/web", path: "apps/web/package.json" },
      ],
      [],
      [ROW],
    );

    expect(decided.failures.map((one) => one.failure.detail.split(",")[0])).toEqual([
      "package.json declares tool",
      "apps/web/package.json declares tool",
    ]);
  });

  it("reads nothing for a disabled row, so it neither applies nor fails", () => {
    const decided = decide({ "/repo/package.json": '{ "dependencies": { "tool": "2" } }' }, [
      "tool",
    ]);

    expect(decided).toEqual({ applied: [], globs: [], generated: [], failures: [], uses: [] });
  });

  it("reads the globs against the default directory where no configuration sets it", () => {
    const decided = decide({
      "/repo/package.json": '{ "dependencies": { "tool": "2" } }',
      ...INSTALLED,
    });

    expect(matches(decided, "src/a/b.ts")).toEqual(["tool"]);
    expect(matches(decided, "web/b.ts")).toEqual([]);
  });

  it("reads the globs against the directory a literal moves them to", () => {
    const decided = decide({
      "/repo/package.json": '{ "dependencies": { "tool": "2" } }',
      "/repo/tool.config.ts": 'export default { layout: { dir: "./web/" } };',
      ...INSTALLED,
    });

    expect(matches(decided, "web/b.ts")).toEqual(["tool"]);
    expect(matches(decided, "src/b.ts")).toEqual([]);
  });

  it("fails as convention-not-literal naming the file, the line and the property", () => {
    const decided = decide({
      "/repo/package.json": '{ "dependencies": { "tool": "2" } }',
      "/repo/tool.config.ts": "const dir = 'web';\nexport default { layout: { dir } };\n",
      ...INSTALLED,
    });

    expect(decided.applied).toEqual([]);
    expect(decided.failures.map((one) => one.failure.setupClass)).toEqual([
      "convention-not-literal",
    ]);
    expect(decided.failures[0]?.failure.detail).toMatch(
      /^tool\.config\.ts:2 sets layout\.dir, .*ts\.disabled_conventions.*ts\.entry_files$/u,
    );
  });

  it("reads a move against its base, and a default naming an earlier move", () => {
    const row: ConventionRow = {
      ...ROW,
      entries: ["<inner>/*.ts", "<sibling>/*.ts"],
      moves: [
        ROW.moves[0] ?? { id: "dir", defaults: [], readings: [] },
        { id: "inner", base: "<dir>", defaults: ["pages"], readings: [] },
        { id: "sibling", defaults: ["<dir>/../lib"], readings: [] },
      ],
    };
    const decided = decide(
      {
        "/repo/package.json": '{ "dependencies": { "tool": "2" } }',
        "/repo/tool.config.ts": 'export default { layout: { dir: "app" } };',
        ...INSTALLED,
      },
      [],
      [row],
    );

    expect(matches(decided, "app/pages/x.ts")).toEqual(["tool"]);
    expect(matches(decided, "lib/x.ts")).toEqual(["tool"]);
    expect(matches(decided, "pages/x.ts")).toEqual([]);
  });

  it("reads every default where a move names several, and the manifest's own directory as .", () => {
    const row: ConventionRow = {
      ...ROW,
      moves: [{ id: "dir", defaults: ["app", "."], readings: [] }],
    };
    const decided = decide(
      { "/repo/package.json": '{ "dependencies": { "tool": "2" } }', ...INSTALLED },
      [],
      [row],
    );

    expect(matches(decided, "app/x.ts")).toEqual(["tool", "tool"]);
    expect(matches(decided, "x.ts")).toEqual(["tool"]);
  });
});

describe("a row's short names", () => {
  const row: ConventionRow = {
    ...ROW,
    shortNames: [{ property: "plugin.name", files: ["tool.config.ts"], package: "tool-plugin-{}" }],
  };
  const manifest =
    '{ "dependencies": { "tool": "2" }, "devDependencies": { "tool-plugin-a": "1", "tool-plugin-b": "1", "tool-plugin-c": "1", "other": "1" } }';
  const uses = (config: string): readonly string[] =>
    decide(
      { "/repo/package.json": manifest, "/repo/tool.config.ts": config, ...INSTALLED },
      [],
      [row],
    ).uses;

  it("uses the declared dependency each literal value stands for, an array's elements included", () => {
    expect(uses('export default { plugin: { name: "a" } };')).toEqual(["tool-plugin-a"]);
    expect(uses('export default { plugin: { name: ["c", "a", "missing"] } };')).toEqual([
      "tool-plugin-a",
      "tool-plugin-c",
    ]);
  });

  it("uses every declared dependency the package name can stand for where the value is not a literal, and fails nothing", () => {
    const decided = decide(
      {
        "/repo/package.json": manifest,
        "/repo/tool.config.ts": "export default { plugin: { name: process.env.PLUGIN } };",
        ...INSTALLED,
      },
      [],
      [row],
    );

    expect(decided.uses).toEqual(["tool-plugin-a", "tool-plugin-b", "tool-plugin-c"]);
    expect(decided.failures).toEqual([]);
  });

  it("uses nothing where the row does not apply", () => {
    expect(
      decide(
        {
          "/repo/package.json": manifest,
          "/repo/tool.config.ts": 'export default { plugin: { name: "a" } };',
          ...INSTALLED,
        },
        [],
        [{ ...row, range: ">=3.0.0" }],
      ).uses,
    ).toEqual([]);
  });
});

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

/**
 * One fixture of `fixtures/projects/conventions`, copied to a directory of this test's own
 * with its `installed` tree as `node_modules`, which nothing committed carries.
 */
function copied(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "deadset-ts-conventions-"));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const target = join(root, name);
  cpSync(fixture("projects", "conventions", name), target, { recursive: true });
  if (existsSync(join(target, "installed"))) {
    renameSync(join(target, "installed"), join(target, "node_modules"));
  }
  return target;
}

interface Answer {
  readonly code: number;
  readonly applied: readonly unknown[];
  readonly findings: readonly string[];
  readonly err: string;
}

/** The analysis of one fixture: its exit code, the rows applied, and `code path` per finding. */
function analyzed(name: string): Answer {
  const target = copied(name);
  const report = join(target, "..", "report.json");
  const err = new MemoryWriter();
  const host = { ...nodeHost(), workingDirectory: () => join(target, "..") };
  const code = run(
    ["analyze", `--target=${name}`, "--report=report.json"],
    new MemoryWriter(),
    err,
    host,
  );
  if (!existsSync(report)) {
    return { code, applied: [], findings: [], err: err.text };
  }
  const parsed = JSON.parse(host.readFile(report)) as {
    conventions_applied: unknown[];
    findings: { code: string; position: { path: string } }[];
  };
  return {
    code,
    applied: parsed.conventions_applied,
    findings: parsed.findings.map((one) => `${one.code} ${one.position.path}`).sort(),
    err: err.text,
  };
}

describe("the convention rows over a project", () => {
  it("root the files a row names, and leave every other file to the analysis", () => {
    const answer = analyzed("next");

    expect(answer.applied).toEqual([
      { name: "next", package: "next", version: "16.3.8", manifest: "package.json" },
    ]);
    expect(answer.findings).toEqual(["DS1001 lib/orphan.ts", "DS1502 lib/orphan.ts"]);
  });

  it("name the row as each root's evidence in print-roots", () => {
    const target = copied("next");
    const out = new MemoryWriter();
    const code = run(["print-roots", `--target=${target}`], out, new MemoryWriter(), nodeHost());

    expect(code).toBe(0);
    expect(out.text.split("\n")).toContain(
      "ts://@example/next/app/page.tsx#default\tconvention\tnext",
    );
  });

  it("read the moved directories of a second and a third framework", () => {
    expect(analyzed("nuxt").findings).toEqual([
      "DS1001 app/utils/orphan.ts",
      "DS1502 app/utils/orphan.ts",
    ]);
    expect(analyzed("astro").findings).toEqual([
      "DS1001 site/pages/_lib/helper.ts",
      "DS1001 site/pages/_partial.ts",
      "DS1001 src/pages/moved-away.ts",
      "DS1502 site/pages/_lib/helper.ts",
      "DS1502 site/pages/_partial.ts",
      "DS1502 src/pages/moved-away.ts",
    ]);
    expect(analyzed("moved-literal").findings).toEqual([
      "DS1001 app/root.tsx",
      "DS1502 app/root.tsx",
    ]);
  });

  it("end the run where a moving property is not a literal", () => {
    const answer = analyzed("not-literal");

    expect(answer.code).toBe(3);
    expect(answer.err).toContain(
      "setup failure: convention-not-literal: nuxt.config.ts:3 sets srcDir",
    );
  });

  it("refuse no value that another plugin's options set at a moving property's path", () => {
    const shared = analyzed("other-plugin-not-literal");

    expect(shared.err).toBe("");
    expect(shared.applied).toEqual([
      { name: "sveltekit", package: "@sveltejs/kit", version: "3.0.0", manifest: "package.json" },
    ]);
  });

  it("move no directory to a literal that another plugin's options set", () => {
    expect(analyzed("other-plugin-literal")).toMatchObject({ code: 0, findings: [] });
  });

  it("root SvelteKit 3's parameter file and no parameter directory", () => {
    expect(analyzed("other-plugin-not-literal").findings).toEqual([
      "DS1001 src/params/legacy.ts",
      "DS1502 src/params/legacy.ts",
    ]);
  });

  it("root SvelteKit 2's parameter directory and no parameter file", () => {
    expect(analyzed("params-directory").findings).toEqual([
      "DS1001 src/params.ts",
      "DS1502 src/params.ts",
    ]);
  });

  it("read the directory a framework plugin's options move", () => {
    expect(analyzed("plugin-call-moved").findings).toEqual([
      "DS1001 src/routes/+page.ts",
      "DS1502 src/routes/+page.ts",
    ]);
  });

  it("end the run where the enabling package is declared and not installed", () => {
    const answer = analyzed("not-installed");

    expect(answer.code).toBe(3);
    expect(answer.err).toContain("setup failure: missing-module: package.json declares next");
  });

  it("apply no row whose range the installed version is outside", () => {
    const answer = analyzed("out-of-range");

    expect(answer.applied).toEqual([]);
    expect(answer.findings).toEqual(["DS1001 app/page.tsx", "DS1502 app/page.tsx"]);
  });

  it("apply no disabled row and raise no setup failure for it", () => {
    const answer = analyzed("disabled");

    expect(answer.code).toBe(1);
    expect(answer.findings).toEqual([
      "DS1001 app/layout.tsx",
      "DS1502 app/layout.tsx",
      "DS1601 package.json",
    ]);
  });

  it("root ts.entry_files beside the files an applied row roots", () => {
    const answer = analyzed("entry-files");

    expect(answer.applied).toHaveLength(1);
    expect(answer.findings).toEqual(["DS1001 lib/orphan.ts", "DS1502 lib/orphan.ts"]);
  });

  it("read a member's row against the member's directory alone", () => {
    const answer = analyzed("workspace");

    expect(answer.applied).toEqual([
      { name: "next", package: "next", version: "16.3.8", manifest: "apps/web/package.json" },
    ]);
    expect(answer.findings).toEqual(["DS1001 app/page.tsx", "DS1502 app/page.tsx"]);
  });

  it("root a tool's configuration in a directory that holds no manifest", () => {
    expect(analyzed("tool-configurations")).toMatchObject({ code: 0, findings: [] });
  });
});
