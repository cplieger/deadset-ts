import { cpSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { CONVENTION_ROWS, type ConventionRow, type OptionsCall } from "./convention-rows.ts";
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
      selected: new Map(),
      testFiles: new Set(),
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

    expect(decided).toEqual({
      applied: [],
      globs: [],
      generated: [],
      failures: [],
      uses: [],
      selected: new Map(),
      testFiles: new Set(),
    });
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

    expect(decided).toEqual({
      applied: [],
      globs: [],
      generated: [],
      failures: [],
      uses: [],
      selected: new Map(),
      testFiles: new Set(),
    });
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

  it("reads a JSON configuration file's document as its default export", () => {
    const json: ConventionRow = {
      ...ROW,
      shortNames: [
        { property: "plugin.name", files: ["tool.config.json"], package: "tool-plugin-{}" },
      ],
    };

    expect(
      decide(
        {
          "/repo/package.json": manifest,
          "/repo/tool.config.json": '{ "plugin": { "name": ["b", "missing"] } }',
          ...INSTALLED,
        },
        [],
        [json],
      ).uses,
    ).toEqual(["tool-plugin-b"]);
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

describe("a row's package keys", () => {
  const row: ConventionRow = {
    ...ROW,
    packageKeys: [{ key: "builder", files: ["tool.json", "tool.config.ts"] }],
  };
  const manifest = JSON.stringify({
    dependencies: { tool: "2" },
    devDependencies: { exact: "1", "@scope/sub": "1", "@scope/run": "1", named: "1", bare: "1" },
    peerDependencies: { elsewhere: "1", "member-name": "1" },
  });
  const uses = (files: Readonly<Record<string, string>>): readonly string[] =>
    decide({ "/repo/package.json": manifest, ...files, ...INSTALLED }, [], [row]).uses;

  it("uses each dependency a string under the key names exactly, by a subpath or before a colon, at any depth", () => {
    expect(
      uses({
        "/repo/tool.json": JSON.stringify({
          projects: {
            app: {
              targets: {
                build: { builder: "@scope/run:application" },
                test: { builder: { main: "exact", extra: ["@scope/sub/theme.css"] } },
              },
            },
          },
        }),
      }),
    ).toEqual(["@scope/run", "@scope/sub", "exact"]);
  });

  it("uses no dependency a member's name, another member's string or a bare colon spells", () => {
    expect(
      uses({
        "/repo/tool.json": JSON.stringify({
          builder: { "member-name": "bare:", elsewhere: "named:build" },
          other: "exact",
        }),
      }),
    ).toEqual(["named"]);
  });

  it("reads a module's default export as it reads a JSON document", () => {
    expect(
      uses({
        "/repo/tool.config.ts": 'export default defineConfig({ builder: ["named:build"] });',
      }),
    ).toEqual(["named"]);
  });
});

describe("a row's helper settings", () => {
  /** The dependencies one row's helper settings use over a manifest declaring the tool and the package. */
  const uses = (
    name: string,
    tool: string,
    helpers: string,
    config: Readonly<Record<string, string>>,
  ): readonly string[] => {
    const row = CONVENTION_ROWS.find((one) => one.name === name);
    if (row === undefined) {
      throw new Error(`no row ${name}`);
    }
    const manifest = JSON.stringify({
      dependencies: { [helpers]: "1" },
      devDependencies: { [tool]: "1" },
    });
    const version = /\d+\.\d+\.\d+/u.exec(row.range)?.[0] ?? "";
    const files = Object.fromEntries(
      Object.entries(config).map(([file, text]) => [`/repo/${file}`, text]),
    );
    return decide(
      {
        "/repo/package.json": manifest,
        [`/repo/node_modules/${tool}/package.json`]: JSON.stringify({ version }),
        ...files,
      },
      [],
      [row],
    ).uses;
  };

  it("uses @babel/runtime where a Babel configuration lists the transform-runtime plugin, by either name", () => {
    const babel = (config: Readonly<Record<string, string>>) =>
      uses("babel", "@babel/core", "@babel/runtime", config);

    expect(
      babel({ "babel.config.json": '{ "plugins": ["@babel/plugin-transform-runtime"] }' }),
    ).toEqual(["@babel/runtime"]);
    expect(
      babel({
        ".babelrc": '{ "plugins": [["@babel/transform-runtime", { "version": "^8.0.0" }]] }',
      }),
    ).toEqual(["@babel/runtime"]);
    expect(
      babel({
        "babel.config.js": 'module.exports = { plugins: ["@babel/plugin-transform-runtime"] };',
      }),
    ).toEqual(["@babel/runtime"]);
    expect(babel({ "babel.config.json": '{ "presets": ["@babel/preset-env"] }' })).toEqual([]);
  });

  it("uses @swc/helpers where .swcrc sets jsc.externalHelpers, and not where it leaves it false", () => {
    expect(
      uses("swc", "@swc/core", "@swc/helpers", {
        ".swcrc": '{ "jsc": { "externalHelpers": true } }',
      }),
    ).toEqual(["@swc/helpers"]);
    expect(
      uses("swc", "@swc/core", "@swc/helpers", {
        ".swcrc": '{ "jsc": { "externalHelpers": false } }',
      }),
    ).toEqual([]);
    expect(
      uses("swc", "@swc/core", "@swc/helpers", { ".swcrc": '{ "jsc": { "target": "es5" } }' }),
    ).toEqual([]);
  });

  it("uses @oxc-project/runtime where a Vite or Rolldown configuration sets the runtime helper mode", () => {
    expect(
      uses("vite", "vite", "@oxc-project/runtime", {
        "vite.config.ts":
          'import { defineConfig } from "vite";\nexport default defineConfig({ oxc: { helpers: { mode: "Runtime" } } });',
      }),
    ).toEqual(["@oxc-project/runtime"]);
    expect(
      uses("rolldown", "rolldown", "@oxc-project/runtime", {
        "rolldown.config.mjs": 'export default { transform: { helpers: { mode: "Runtime" } } };',
      }),
    ).toEqual(["@oxc-project/runtime"]);
    expect(
      uses("vite", "vite", "@oxc-project/runtime", {
        "vite.config.ts": 'export default { oxc: { helpers: { mode: "External" } } };',
      }),
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
  /** The name of each dependency a finding reports, sorted. */
  readonly dependencies: readonly string[];
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
    return { code, applied: [], findings: [], dependencies: [], err: err.text };
  }
  const parsed = JSON.parse(host.readFile(report)) as {
    conventions_applied: unknown[];
    findings: {
      code: string;
      position: { path: string };
      symbol: { kind: string; name: string };
    }[];
  };
  return {
    code,
    applied: parsed.conventions_applied,
    findings: parsed.findings.map((one) => `${one.code} ${one.position.path}`).sort(),
    dependencies: parsed.findings
      .filter((one) => one.symbol.kind === "dependency")
      .map((one) => one.symbol.name)
      .sort(),
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

  it("use the runner and checker packages a JSON configuration names by their short names", () => {
    const answer = analyzed("stryker");

    expect(answer.applied).toEqual([
      {
        name: "stryker",
        package: "@stryker-mutator/core",
        version: "10.0.0",
        manifest: "package.json",
      },
    ]);
    expect(answer.findings).toEqual(["DS1601 package.json"]);
  });

  it.each([
    ["helpers-babel", "babel", "@babel/core"],
    ["helpers-rolldown", "rolldown", "rolldown"],
    ["helpers-swc", "swc", "@swc/core"],
    ["helpers-vite", "vite", "vite"],
  ])(
    "use the runtime helper package the %s configuration's setting imports, and report the tool nothing runs",
    (name, row, tool) => {
      const answer = analyzed(name);

      expect(answer.applied.map((one) => (one as { name: string }).name)).toEqual([row]);
      expect(answer.dependencies).toEqual([tool]);
    },
  );

  it("root a stryker.conf module and read the runner its default export names", () => {
    const answer = analyzed("stryker-conf");

    expect(answer.findings).toEqual(["DS1601 package.json"]);
  });
});

describe("the rows of a documentation site and an Angular CLI project", () => {
  /** The rows of `name` applied over a manifest declaring `tool` at `version`, and whether each path is rooted. */
  const rooted = (
    name: string,
    tool: string,
    version: string,
    paths: readonly string[],
  ): { applied: readonly string[]; rooted: readonly string[] } => {
    const rows = CONVENTION_ROWS.filter((one) => one.name === name);
    const decided = decide(
      {
        "/repo/package.json": JSON.stringify({ devDependencies: { [tool]: version } }),
        [`/repo/node_modules/${tool}/package.json`]: JSON.stringify({ version }),
      },
      [],
      rows,
    );
    return {
      applied: decided.applied.map((one) => `${one.name} ${one.version}`),
      rooted: paths.filter((path) => matches(decided, path).length > 0),
    };
  };

  it("applies the VitePress row to a prerelease of its next major and roots its configuration, theme, loaders and components", () => {
    expect(
      rooted("vitepress", "vitepress", "2.0.0-alpha.20", [
        ".vitepress/config.ts",
        ".vitepress/theme/index.ts",
        ".vitepress/theme/Hero.vue",
        "blog.data.ts",
        ".vitepress/meta.ts",
      ]),
    ).toEqual({
      applied: ["vitepress 2.0.0-alpha.20"],
      rooted: [
        ".vitepress/config.ts",
        ".vitepress/theme/index.ts",
        ".vitepress/theme/Hero.vue",
        "blog.data.ts",
      ],
    });
  });

  it("uses the builders, polyfills, styles and scripts angular.json names, and no required peer of them", () => {
    const decided = decide(
      {
        "/repo/package.json": JSON.stringify({
          dependencies: {
            "@angular/compiler": "20.0.0",
            "@angular/material": "20.0.0",
            "zone.js": "0.15.0",
            "chart-lib": "1.0.0",
          },
          devDependencies: { "@angular/build": "20.0.0", "@angular/compiler-cli": "20.0.0" },
        }),
        "/repo/node_modules/@angular/build/package.json": JSON.stringify({ version: "20.0.0" }),
        "/repo/angular.json": JSON.stringify({
          projects: {
            app: {
              prefix: "app",
              architect: {
                build: {
                  builder: "@angular/build:application",
                  options: {
                    polyfills: ["zone.js"],
                    styles: ["@angular/material/prebuilt-themes/azure-blue.css", "src/styles.css"],
                    scripts: ["chart-lib/dist/chart.js"],
                  },
                },
              },
            },
          },
        }),
      },
      [],
      CONVENTION_ROWS.filter((one) => one.name === "angular"),
    );

    expect(decided.uses).toEqual(["@angular/build", "@angular/material", "chart-lib", "zone.js"]);
  });

  it("roots an Angular CLI project's browser, server and test entries at the root and below projects", () => {
    expect(
      rooted("angular", "@angular/build", "20.0.0", [
        "src/main.ts",
        "src/main.server.ts",
        "server.ts",
        "projects/admin/src/main.ts",
        "projects/kit/src/public-api.ts",
        "src/app/app.ts",
      ]),
    ).toEqual({
      applied: ["angular 20.0.0"],
      rooted: [
        "src/main.ts",
        "src/main.server.ts",
        "server.ts",
        "projects/admin/src/main.ts",
        "projects/kit/src/public-api.ts",
      ],
    });
  });
});
