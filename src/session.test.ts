import { describe, expect, it } from "vitest";
import type { Snapshot, TimingInfo } from "@typescript/native/unstable/sync";
import { nodeHost } from "../bin/node-host.ts";
import { fixture } from "../__test-helpers__/fixtures.ts";
import { diagnosticErrors, discoverProjects } from "./discover.ts";
import { scopeForDir } from "./scope.ts";
import {
  diagnosticsOf,
  identifiersOf,
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
    updateSnapshot: (openProjects) => {
      recorded.snapshotsOpened += 1;
      recorded.opened.push([...openProjects]);
      const snapshot = real.updateSnapshot(openProjects);
      const recording: Snapshot = Object.create(snapshot) as Snapshot;
      recording.dispose = () => {
        recorded.disposals += 1;
        snapshot.dispose();
      };
      return recording;
    },
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

  it("resolves a file's identifiers in one batch, one answer per identifier", () => {
    const engine = openEngine({ collectTiming: false });
    const core = fixture("projects", "two-projects", "core", "tsconfig.json");

    const { projects } = runSession(engine, [core], (project) => {
      const file = project.ownSourceFiles()[0];
      if (file === undefined) {
        return { identifiers: 0, resolved: 0 };
      }
      const identifiers = identifiersOf(file);
      const symbols = project.symbolsAt(identifiers.map((node) => project.handle(node)));
      return {
        identifiers: identifiers.length,
        resolved: symbols.filter((symbol) => symbol !== undefined).length,
        answers: symbols.length,
      };
    });

    const measured = projects[0];
    expect(measured?.identifiers, "the file carries identifiers").toBeGreaterThan(0);
    expect(measured?.answers, "the batch answers once per node").toBe(measured?.identifiers);
    expect(measured?.resolved, "the batch resolves the declarations it names").toBeGreaterThan(0);
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
