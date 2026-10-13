import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isIdentifier, type Node, type SourceFile } from "@typescript/native/ast";
import type { Snapshot, Symbol as TSSymbol, TimingInfo } from "@typescript/native/sync";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import type { Host } from "./host.ts";
import { diagnosticErrors, discoverProjects, DiscoveryError } from "./discover.ts";
import { scopeForDir } from "./scope.ts";
import { isAnswered } from "./query.ts";
import {
  diagnosticsOf,
  openEngine,
  runSession,
  type Engine,
  type Handle,
  type ProjectView,
} from "./session.ts";

/**
 * What one run did with its compiler client, which is the accounting the run
 * lifetime is asserted against.
 *
 * The client's own surface cannot supply it. How many snapshots a client opened is
 * not on that surface at all, and the disposed state a snapshot does report cannot
 * attribute the dispose: releasing the client disposes a snapshot that is still
 * live, so the state reads disposed after a run that never disposed it. The seam
 * that hands the client to the run counts the calls instead.
 */
interface Recorded {
  snapshotsOpened: number;
  disposals: number;
  closes: number;
  readonly opened: string[][];
}

function recordingEngine(real: Engine): { engine: Engine; recorded: Recorded } {
  const recorded: Recorded = { snapshotsOpened: 0, disposals: 0, closes: 0, opened: [] };
  const engine: Engine = {
    parseConfigFile: (file) => real.parseConfigFile(file),
    parseConfigJson: (json, configFile) => real.parseConfigJson(json, configFile),
    createSnapshot: (openProjects, createPrograms, configurations) => {
      recorded.snapshotsOpened += 1;
      recorded.opened.push([...openProjects]);
      const snapshot = real.createSnapshot(openProjects, createPrograms, configurations);
      return Object.create(snapshot, {
        dispose: {
          value: () => {
            recorded.disposals += 1;
            snapshot.dispose();
          },
        },
      }) as Snapshot;
    },
    createModuleResolver: (options, entries) => real.createModuleResolver(options, entries),
    parseSourceFile: (fileName, text) => real.parseSourceFile(fileName, text),
    readsComponents: real.readsComponents,
    batch: (questions) => real.batch(questions),
    ask: (accessor, locations, question) => real.ask(accessor, locations, question),
    getTimingInfo: () => real.getTimingInfo(),
    close: () => {
      recorded.closes += 1;
      real.close();
    },
  };
  return { engine, recorded };
}

const HOST = nodeHost();
const TWO_PROJECTS = fixture("projects", "two-projects");

function identifierIn(file: SourceFile, text: string): Node {
  let found: Node | undefined;
  const visit = (node: Node): void => {
    if (found === undefined && isIdentifier(node) && node.text === text) {
      found = node;
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  if (found === undefined) {
    throw new Error(`no identifier ${text} in ${file.fileName}`);
  }
  return found;
}

function inProject<Result>(
  files: Readonly<Record<string, string>>,
  visit: (project: ProjectView<unknown>, root: string) => Result,
): Result {
  const root = writeProject(files);
  try {
    const { projects } = runSession(
      openEngine({ collectTiming: false }),
      [join(root, "tsconfig.json")],
      (project) => visit(project, root),
    );
    const [answer] = projects;
    if (answer === undefined) {
      throw new Error("the tree opened no project");
    }
    return answer;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function countingHost(overrides: Partial<Host> = {}): { host: Host; removed: string[] } {
  const removed: string[] = [];
  const host: Host = {
    ...HOST,
    temporaryDirectory: () => {
      const path = mkdtempSync(join(tmpdir(), "deadset-ts-mapper-"));
      return {
        path,
        remove: () => {
          removed.push(path);
          rmSync(path, { recursive: true, force: true });
        },
      };
    },
    ...overrides,
  };
  return { host, removed };
}

describe("the compiler client", () => {
  it("removes the mapper's directory and fails where the mapper's manifest cannot be written", () => {
    const { host, removed } = countingHost({
      writeDocument: () => {
        throw new Error("the disk is full");
      },
    });

    expect(() =>
      openEngine({ collectTiming: false, components: { extensions: [".vue"], host } }),
    ).toThrow("the disk is full");
    expect(removed).toHaveLength(1);
  });

  it("reads component files only where an extension is listed", () => {
    const { host } = countingHost();
    const listed = openEngine({ collectTiming: false, components: { extensions: [".vue"], host } });
    const none = openEngine({ collectTiming: false, components: { extensions: [], host } });
    const absent = openEngine({ collectTiming: false });
    try {
      expect([listed.readsComponents, none.readsComponents, absent.readsComponents]).toEqual([
        true,
        false,
        false,
      ]);
    } finally {
      listed.close();
      none.close();
      absent.close();
    }
  });

  it("parses one file outside every program once per text, however often it is asked", () => {
    const engine = openEngine({ collectTiming: true });
    try {
      const requests = (): number => engine.getTimingInfo().totals.requestCount;
      const first = engine.parseSourceFile("/a.ts", "export const a = 1;\n");
      const before = requests();
      const again = engine.parseSourceFile("/a.ts", "export const a = 1;\n");
      const cost = requests() - before;
      const changed = engine.parseSourceFile("/a.ts", "export const b = 1;\n");

      expect(again, "the second answer is the first").toBe(first);
      expect(cost, "and it cost no request").toBe(0);
      expect(changed, "a changed text is parsed again").not.toBe(first);
      expect(changed.text).toBe("export const b = 1;\n");
    } finally {
      engine.close();
    }
  });

  it("releases the client and removes the mapper's directory once, however often it is closed", () => {
    const { host, removed } = countingHost();
    const engine = openEngine({ collectTiming: false, components: { extensions: [".vue"], host } });

    engine.close();
    engine.close();

    expect(removed).toHaveLength(1);
    expect(existsSync(removed[0] ?? "")).toBe(false);
    expect(() => engine.parseSourceFile("/a.ts", "export const a = 1;\n")).toThrow();
  });

  it("opens a project from a configuration text the snapshot alone holds", () => {
    const root = writeProject({ "a.ts": "export const a = 1;\n" });
    const written = join(root, "written.json");
    const engine = openEngine({ collectTiming: false });
    try {
      const snapshot = engine.createSnapshot(
        [written],
        undefined,
        new Map([
          [written, JSON.stringify({ compilerOptions: { noEmit: true }, files: ["a.ts"] })],
        ]),
      );
      try {
        expect(snapshot.getProjects().map((project) => project.configFileName)).toEqual([written]);
      } finally {
        snapshot.dispose();
      }
    } finally {
      engine.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs no content mapper a configuration declares where no component reading is asked for", () => {
    const root = writeProject({
      "tsconfig.json": JSON.stringify({
        contentMappers: [{ package: "own", extensions: [".vue"] }],
        compilerOptions: { module: "NodeNext", moduleResolution: "nodenext", noEmit: true },
        include: ["src"],
      }),
      "src/main.ts": 'import A from "./A.vue";\nexport const all = [A];\n',
      "src/A.vue": "<template><p></p></template>\n",
    });
    const marker = join(root, "ran");
    try {
      mkdirSync(join(root, "node_modules", "own"), { recursive: true });
      writeFileSync(
        join(root, "node_modules", "own", "package.json"),
        JSON.stringify({
          name: "own",
          version: "0.0.0",
          typescript: { contentMapper: { exec: ["/bin/sh", "-c", `touch ${marker}; exit 1`] } },
        }),
      );
      runSession(openEngine({ collectTiming: false }), [join(root, "tsconfig.json")], (project) =>
        project.ownSourceFiles().map((file) => file.fileName),
      );

      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the run lifetime", () => {
  it("opens one snapshot holding every project and disposes it once", () => {
    const { engine, recorded } = recordingEngine(openEngine({ collectTiming: false }));
    const configFiles = discoverProjects(engine, HOST, scopeForDir(HOST, TWO_PROJECTS)).configFiles;

    const { projects } = runSession(engine, configFiles, (project) => project.configFile);

    expect(projects.length, "one answer per project").toBe(2);
    expect(recorded.snapshotsOpened, "one snapshot for the run").toBe(1);
    expect(recorded.opened[0], "the snapshot holds every project").toEqual(configFiles);
    expect(recorded.disposals, "the snapshot is disposed once").toBe(1);
    expect(recorded.closes, "the client is released once").toBe(1);
  });

  it("disposes the snapshot and releases the client when a project's work throws", () => {
    const { engine, recorded } = recordingEngine(openEngine({ collectTiming: false }));
    const configFiles = discoverProjects(engine, HOST, scopeForDir(HOST, TWO_PROJECTS)).configFiles;

    expect(() =>
      runSession(engine, configFiles, () => {
        throw new Error("the work failed");
      }),
    ).toThrow("the work failed");
    expect(recorded.disposals, "the snapshot is disposed once").toBe(1);
    expect(recorded.closes, "the client is released once").toBe(1);
  });

  it("visits the projects in the order the configurations are named, and answers in it", () => {
    const engine = openEngine({ collectTiming: false });
    const [first, second] = discoverProjects(
      engine,
      HOST,
      scopeForDir(HOST, TWO_PROJECTS),
    ).configFiles;
    if (first === undefined || second === undefined) {
      throw new Error("the fixture holds two projects");
    }

    const { projects } = runSession(engine, [second, first], (project) => project.configFile);

    expect(projects).toEqual([second, first]);
  });

  it("ends the run when the snapshot opens no project for a named configuration", () => {
    const real = openEngine({ collectTiming: false });
    const configFiles = discoverProjects(real, HOST, scopeForDir(HOST, TWO_PROJECTS)).configFiles;
    const engine: Engine = {
      ...real,
      createSnapshot: (openProjects) => {
        const snapshot = real.createSnapshot(openProjects);
        const short: Snapshot = Object.create(snapshot) as Snapshot;
        short.getProjects = () => snapshot.getProjects().slice(1);
        return short;
      },
    };

    expect(() => runSession(engine, configFiles, () => 0)).toThrow(DiscoveryError);
  });

  it("names a configuration the snapshot opens no project for, and visits the rest, where told to record it", () => {
    const real = openEngine({ collectTiming: false });
    const configFiles = discoverProjects(real, HOST, scopeForDir(HOST, TWO_PROJECTS)).configFiles;
    const engine: Engine = {
      ...real,
      createSnapshot: (openProjects) => {
        const snapshot = real.createSnapshot(openProjects);
        const short: Snapshot = Object.create(snapshot) as Snapshot;
        short.getProjects = () => snapshot.getProjects().slice(1);
        return short;
      },
    };

    const { projects, unopened } = runSession(
      engine,
      configFiles,
      (project) => project.configFile,
      "record",
    );

    expect(unopened).toEqual(configFiles.slice(0, 1));
    expect(projects).toEqual(configFiles.slice(1));
  });

  it("reports what one snapshot over two projects cost", () => {
    const engine = openEngine({ collectTiming: true });
    const configFiles = discoverProjects(engine, HOST, scopeForDir(HOST, TWO_PROJECTS)).configFiles;

    const { timing } = runSession(engine, configFiles, (project) => {
      diagnosticsOf(project);
      return project.ownSourceFiles().length;
    });

    expect(timing.enabled, "collection is on when the run asks for it").toBe(true);
    expect(timing.totals.requestCount, "a run over two projects costs round trips").toBeGreaterThan(
      0,
    );
  });

  it("reports collection off when the run does not ask for it", () => {
    const engine = openEngine({ collectTiming: false });
    const configFiles = discoverProjects(engine, HOST, scopeForDir(HOST, TWO_PROJECTS)).configFiles;

    const { timing }: { timing: TimingInfo } = runSession(engine, configFiles, () => 0);

    expect(timing.enabled).toBe(false);
  });
});

describe("a project's own files", () => {
  it("holds the sources each project's own configuration names and no library file", () => {
    const engine = openEngine({ collectTiming: false });
    const configFiles = discoverProjects(engine, HOST, scopeForDir(HOST, TWO_PROJECTS)).configFiles;

    const { projects } = runSession(engine, configFiles, (project) => ({
      configFile: project.configFile,
      files: project.ownSourceFiles().map((file) => file.fileName),
      errors: diagnosticErrors(diagnosticsOf(project)).length,
    }));

    // A referenced project's sources are in the referencing project's program as
    // well as its own, so one declaration is seen once per project that builds it.
    // That is what the configuration intersection is over: a symbol is reported
    // only where it is dead in every project.
    expect(
      Object.fromEntries(projects.map(({ configFile, files }) => [configFile, files.sort()])),
    ).toEqual({
      [fixture("projects", "two-projects", "app", "tsconfig.json")]: [
        fixture("projects", "two-projects", "app", "main.ts"),
        fixture("projects", "two-projects", "core", "catalog.ts"),
      ],
      [fixture("projects", "two-projects", "core", "tsconfig.json")]: [
        fixture("projects", "two-projects", "core", "catalog.ts"),
      ],
    });
    expect(projects.map(({ errors }) => errors)).toEqual([0, 0]);
  });

  it("answers the same set every time it is asked, and asks the program once", () => {
    const engine = openEngine({ collectTiming: true });
    const core = fixture("projects", "two-projects", "core", "tsconfig.json");

    const { projects, timing } = runSession(engine, [core], (project) => {
      const first = project.ownSourceFiles().map((file) => file.fileName);
      const before = engine.getTimingInfo().totals.requestCount;
      const again = project.ownSourceFiles().map((file) => file.fileName);
      return { first, again, cost: engine.getTimingInfo().totals.requestCount - before };
    });

    const measured = projects[0];
    expect(measured?.first.length, "the project holds its own sources").toBeGreaterThan(0);
    expect(measured?.again, "the second answer is the first").toEqual(measured?.first);
    expect(measured?.cost, "and it cost nothing, because the snapshot does not change").toBe(0);
    expect(timing.enabled).toBe(true);
  });
});

describe("a project's view", () => {
  it("resolves one identifier asked for alone", () => {
    const named = inProject(
      { "main.ts": "export const total = 1;\nexport const twice = total * 2;\n" },
      (project) => {
        const [file] = project.ownSourceFiles();
        if (file === undefined) {
          throw new Error("the project holds main.ts");
        }
        const symbol = project.resolvedSymbolAt(project.handle(identifierIn(file, "total")));
        return isAnswered(symbol) ? symbol?.name : "unanswered";
      },
    );

    expect(named).toBe("total");
  });

  it("steps an alias one link along, and answers nothing for a symbol that is no alias or an alias of nothing", () => {
    const steps = inProject(
      {
        "lib.ts": "export const value = 1;\n",
        "unknown.d.cts": "export = missing;\n",
        "main.ts":
          'import { value } from "./lib.js";\nimport gone = require("./unknown.cjs");\nexport const all = [value, gone];\n',
      },
      (project) => {
        const main = project.ownSourceFiles().find((file) => file.fileName.endsWith("main.ts"));
        const lib = project.ownSourceFiles().find((file) => file.fileName.endsWith("lib.ts"));
        if (main === undefined || lib === undefined) {
          throw new Error("the project holds main.ts and lib.ts");
        }
        const [imported, required, declared] = project
          .symbolsAt([
            project.handle(identifierIn(main, "value")),
            project.handle(identifierIn(main, "gone")),
            project.handle(identifierIn(lib, "value")),
          ])
          .map((symbol) => (isAnswered(symbol) ? symbol : undefined));
        const step = (symbol: TSSymbol | undefined): TSSymbol | undefined | "unanswered" => {
          const next = symbol === undefined ? undefined : project.aliasStepOf(symbol);
          return isAnswered(next) ? next : "unanswered";
        };
        const named = (symbol: ReturnType<typeof step>): string =>
          typeof symbol === "object"
            ? `${symbol.name} in ${basename(symbol.declarations[0]?.path ?? "")}`
            : String(symbol);
        const assignment = step(required);
        return [
          named(step(imported)),
          named(assignment),
          named(typeof assignment === "object" ? step(assignment) : assignment),
          named(step(declared)),
        ];
      },
    );

    expect(steps).toEqual([
      "value in lib.ts",
      "export= in unknown.d.cts",
      "undefined",
      "undefined",
    ]);
  });

  it("locates an offset of a file by line and column from one, and nothing outside the text", () => {
    const located = inProject({ "main.ts": "ab\ncd" }, (project) => {
      const { locate } = diagnosticsOf(project);
      const [file] = project.ownSourceFiles();
      if (file === undefined) {
        throw new Error("the project holds main.ts");
      }
      return [-1, 0, 4, 5, 6].map((offset) => locate(file.fileName, offset));
    });

    expect(located).toEqual([
      undefined,
      { line: 1, column: 1 },
      { line: 2, column: 2 },
      { line: 2, column: 3 },
      undefined,
    ]);
  });
});

describe("a symbol's declaration", () => {
  it("resolves in this project's program, whichever project first saw the symbol", () => {
    const engine = openEngine({ collectTiming: false });
    const configFiles = discoverProjects(engine, HOST, scopeForDir(HOST, TWO_PROJECTS)).configFiles;

    const { projects } = runSession(engine, configFiles, (project) => {
      const file = project.ownSourceFiles().find((held) => held.fileName.endsWith("catalog.ts"));
      if (file === undefined) {
        return [];
      }
      const [module] = project.symbolsAt([project.handle(file)]);
      if (!isAnswered(module)) {
        throw new Error("the checker did not answer for the module");
      }
      return [...(module?.getExports() ?? [])].flatMap(([, symbol]) =>
        symbol.declarations.map((handle) => {
          const held = project.declarationAt(handle);
          return held === undefined ? "unresolved" : held.node.getSourceFile().fileName;
        }),
      );
    });

    // Every project that builds the shared file resolves the declaration in its own
    // program, so nothing depends on which project reached the symbol first.
    expect(projects.length).toBe(2);
    for (const resolvedIn of projects) {
      expect(resolvedIn.length, "the module exports two declarations").toBe(2);
      expect(new Set(resolvedIn)).toEqual(
        new Set([fixture("projects", "two-projects", "core", "catalog.ts")]),
      );
    }
  });
});

declare const _alpha: unique symbol;
declare const _beta: unique symbol;

/**
 * Two views at two distinct brands stand for two projects of one run: a visitor
 * call introduces its own brand, so this is the shape the session hands out.
 * They are declared, never constructed: the function below is never called.
 */
declare const firstProject: ProjectView<typeof _alpha>;
declare const secondProject: ProjectView<typeof _beta>;
declare const aNode: Parameters<ProjectView<typeof _alpha>["handle"]>[0];

/**
 * The compiler is the assertion here and the type check is where it is made:
 * removing the brand from `Handle` or from `symbolsAt` makes the crossing legal,
 * which turns the expect-error line into an error of its own.
 */
function crossProjectHandle(): unknown {
  const fromFirst: Handle<typeof _alpha> = firstProject.handle(aNode);
  // @ts-expect-error a handle of one project is not a handle of another
  return secondProject.symbolsAt([fromFirst]);
}

describe("a handle never reaches another project's checker", () => {
  it("is refused by the compiler rather than at run time", () => {
    expect(typeof crossProjectHandle).toBe("function");
  });
});
