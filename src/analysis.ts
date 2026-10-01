/**
 * One run's passes, composed: the projects discovery names, opened in one snapshot
 * of one client, each read through the stages in the order they depend on each
 * other, and the per-project answers merged into the answer for the run.
 *
 * The stages take a project's view, which only this composition makes: a view
 * carries a project's identity in its type so a handle cannot cross to another
 * project's checker, and that holds only for views the session itself hands out.
 */

import type { Diagnostic } from "@typescript/native/unstable/sync";
import type { Config, Provenance } from "./config.ts";
import { diagnosticErrors, discoverProjects, DiscoveryError } from "./discover.ts";
import type { Finding } from "./finding.ts";
import type { Host } from "./host.ts";
import { inventory, type Inventory } from "./inventory.ts";
import { readManifest } from "./manifest.ts";
import { matrixOf, sweepMatrix, type Configured, type Matrix, type SweepResult } from "./matrix.ts";
import { relativePath, resolvePath } from "./paths.ts";
import { byPosition, type Position } from "./position.ts";
import { references } from "./references.ts";
import { roots, unmatchedEverywhere, unmatchedRoots, type RootKind, type Roots } from "./roots.ts";
import type { Scope } from "./scope.ts";
import { diagnosticsOf, runSession, type Engine, type ProjectView } from "./session.ts";
import type { SweepInput } from "./sweep.ts";

/** The setting whose source decides where a finding about a configured root sits. */
const ROOTS_SETTING = "roots.patterns";

/** One root of the run, merged across the projects that hold it. */
export interface RunRoot {
  /** The stable reference of the declaration the root names. */
  readonly ref: string;
  /** Where that declaration is written. */
  readonly position: Position;
  readonly kind: RootKind;
  readonly source: string;
  /** The configurations whose project holds this root, in the run's order. */
  readonly configurations: readonly string[];
}

/** The root set of one run, and the findings about the roots the configuration names. */
export interface RunRoots {
  /**
   * The configurations the run analyzed, each by the name discovery gives its
   * project, in discovery order: the order a declared matrix lists them in.
   */
  readonly configurations: readonly string[];
  /**
   * Every root of the run, ordered by the site of its declaration, then by kind, then
   * by the string that named it. A root several projects hold is one entry naming each.
   */
  readonly roots: readonly RunRoot[];
  /** One finding per configured root or pattern that named nothing in any project. */
  readonly findings: readonly Finding[];
}

/**
 * The document that supplied one setting, below the target root, or the empty
 * string where the setting came from no document of the target. Both paths are
 * resolved against the working directory before one is read below the other, so a
 * relative target and a relative document name the same place.
 */
function documentOf(
  host: Host,
  provenance: Provenance,
  setting: string,
  targetRoot: string,
): string {
  const origin = provenance.get(setting);
  if (origin === undefined || origin.source === "default" || origin.source === "flag") {
    return "";
  }
  const document = resolvePath(host.workingDirectory(), origin.label);
  return relativePath(resolvePath(host.workingDirectory(), targetRoot), document) ?? "";
}

/** Two strings ordered bytewise. */
function compare(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** What every stage after the root set reads of one project. */
interface ProjectRead {
  readonly configuration: string;
  readonly held: Inventory;
  readonly rooted: Roots;
}

/**
 * Reads every project the scope discovers, in one snapshot: each is checked for errors
 * first, then enumerated, then rooted, and `stage` reads the rest of what it needs from
 * the project while its view is open. A project carrying an error fails the run with no
 * answer, as every verb that reads declarations does.
 */
function readProjects<Answer>(
  engine: Engine,
  host: Host,
  scope: Scope,
  config: Config,
  stage: <Brand>(project: ProjectView<Brand>, read: ProjectRead) => Answer,
): readonly Answer[] {
  const targetRoot = scope.target.path;
  const discovered = discoverProjects(engine, host, scope, config.analysis.configurations);
  const ids = new Map(discovered.projects.map((project) => [project.configFile, project.id]));
  const options = {
    manifest: readManifest(host, targetRoot),
    patterns: config.rootPatterns,
    entryFiles: config.ts.entryFiles,
    testFiles: config.ts.testFiles,
    publishedAPI: config.targetKind === "library",
  };
  const failures: Diagnostic[] = [];
  const { projects } = runSession(engine, discovered.configFiles, (project) => {
    const errors = diagnosticErrors(diagnosticsOf(project));
    if (errors.length > 0) {
      failures.push(...errors);
      return undefined;
    }
    const held = inventory(project, host, targetRoot);
    const rooted = roots(project, held, targetRoot, options);
    const configuration = ids.get(project.configFile) ?? project.configFile;
    return stage(project, { configuration, held, rooted });
  });
  if (failures.length > 0) {
    throw new DiscoveryError(
      `${String(failures.length)} error(s); no answer was produced`,
      failures,
    );
  }
  return projects.filter((answer): answer is Answer => answer !== undefined);
}

/**
 * The root set of the run the scope and the configuration describe.
 *
 * A configured string is a finding when it names nothing in every project, and the
 * finding sits in the document that declared the roots.
 */
export function runRoots(
  engine: Engine,
  host: Host,
  scope: Scope,
  config: Config,
  provenance: Provenance,
): RunRoots {
  const targetRoot = scope.target.path;
  const projects = readProjects(engine, host, scope, config, (_project, read) => read);

  const configurations: string[] = [];
  const merged = new Map<string, Omit<RunRoot, "configurations"> & { configurations: string[] }>();
  for (const answer of projects) {
    const configuration = answer.configuration;
    configurations.push(configuration);
    const symbols = new Map(answer.held.symbols.map((symbol) => [symbol.id, symbol]));
    for (const root of answer.rooted.liveUnderReachability) {
      const symbol = symbols.get(root.id);
      if (symbol === undefined) {
        continue;
      }
      const key = [root.id, root.kind, root.source].join("\u0000");
      const held = merged.get(key);
      if (held === undefined) {
        merged.set(key, {
          ref: symbol.ref,
          position: symbol.position,
          kind: root.kind,
          source: root.source,
          configurations: [configuration],
        });
      } else if (!held.configurations.includes(configuration)) {
        held.configurations.push(configuration);
      }
    }
  }

  const ordered = [...merged.values()].sort(
    (a, b) =>
      byPosition(a.position, b.position) || compare(a.kind, b.kind) || compare(a.source, b.source),
  );
  const unmatched = unmatchedEverywhere(
    config.rootPatterns,
    projects.map((answer) => answer.rooted),
  );
  return {
    configurations,
    roots: ordered,
    findings: unmatchedRoots(unmatched, documentOf(host, provenance, ROOTS_SETTING, targetRoot)),
  };
}

/** The run's sweep, beside the matrix it judged. */
export interface RunSweep {
  readonly matrix: Matrix;
  readonly sweep: SweepResult;
}

/**
 * Sweeps the run the scope and the configuration describe. Each project's references
 * are read against its own inventory with the configured test-file patterns while its
 * view is open; the projects then merge into one matrix in discovery order, which is
 * swept under the input the caller decided once for the run. A project that carries
 * an error ends the run before any project is swept.
 */
export function runSweep(
  engine: Engine,
  host: Host,
  scope: Scope,
  config: Config,
  input: SweepInput,
): RunSweep {
  const targetRoot = scope.target.path;
  const configured = readProjects(engine, host, scope, config, (project, read): Configured => {
    const resolved = references(project, read.held, targetRoot, {
      testFiles: config.ts.testFiles,
    });
    return {
      configuration: read.configuration,
      symbols: read.held.symbols,
      references: resolved.references,
      roots: read.rooted.liveUnderReachability,
      testFiles: resolved.testFilePaths,
    };
  });
  const matrix = matrixOf(configured);
  return { matrix, sweep: sweepMatrix(matrix, input) };
}
