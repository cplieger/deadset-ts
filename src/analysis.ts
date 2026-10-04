/**
 * One run's passes, composed: the projects discovery names, opened in one snapshot
 * of one client, each read through the stages in the order they depend on each
 * other, and the per-project answers merged into the answer for the run.
 *
 * The stages take a project's view, which only this composition makes: a view
 * carries a project's identity in its type so a handle cannot cross to another
 * project's checker, and that holds only for views the session itself hands out.
 */

import { lineOf, readComponent } from "./component-files.ts";
import type { Config, Provenance } from "./config.ts";
import {
  consumerLoads,
  consumerReferences,
  moduleIdentity,
  type LoadedConsumer,
} from "./consumers.ts";
import {
  configuredDeclarations,
  configuredRef,
  declarationsNamed,
} from "./configured-declarations.ts";
import { decorator } from "./decorator.ts";
import { dependenciesOf, projectNeeds } from "./dependencies.ts";
import { deprecatedDeclarations, type Deprecation } from "./deprecation.ts";
import {
  discoverProjects,
  DiscoveryError,
  isGuess,
  projectErrors,
  renderDiagnostic,
  targetRelative,
  type LocatedDiagnostic,
  type NotBuilt,
} from "./discover.ts";
import { readEdgeSides } from "./edges.ts";
import { enumGroup } from "./enum-group.ts";
import {
  computeExemptions,
  disabledClasses,
  exemptionsOf,
  holdingWhile,
  isUnansweredRecord,
  retainedIn,
  type Detector,
  type Detectors,
} from "./exempt.ts";
import type { TSExemptionClass } from "./exempt-classes.ts";
import { heldByInclusion, sourceTree } from "./file-facts.ts";
import type { Finding } from "./finding.ts";
import { findingsPass, recordedFindings, rowKey, type PassResult } from "./findings-pass.ts";
import type { EmitterInput } from "./findings/emitter.ts";
import {
  NO_SELF_CHECK,
  unmatchedRootFindings,
  type SelfCheckFacts,
} from "./findings/self-check.ts";
import { frameworkLifecycle } from "./framework-lifecycle.ts";
import type { Host } from "./host.ts";
import { implementations, mergeImplementations } from "./implementations.ts";
import { injectionContainer } from "./injection-container.ts";
import { interfaceSatisfaction } from "./interface-satisfaction.ts";
import { intraFunctionFacts, projectParts, type ProjectParts } from "./intra-function-parts.ts";
import { inventory, type Inventory, type InventorySymbol } from "./inventory.ts";
import { readManifest } from "./manifest.ts";
import {
  liveFilesAt,
  matrixOf,
  referenceKey,
  sweepMatrix,
  type Configured,
  type Matrix,
  type SweepResult,
} from "./matrix.ts";
import { relativePath, resolvePath } from "./paths.ts";
import type { UnansweredQuestion } from "./query.ts";
import { byPosition, isComponentFile, type Position } from "./position.ts";
import type { TypeErrorSkip, UnansweredCount } from "./report.ts";
import { SetupError, setupLine, type SetupFailure } from "./setup-failure.ts";
import {
  pathsOf,
  readErrors,
  skippedRoots,
  skippedUnits,
  type SkippedUnit,
} from "./type-errors.ts";
import { reflectiveLookup } from "./reflective-lookup.ts";
import { references, testFileRulesOf, type Reference, type TestFileRule } from "./references.ts";
import { roots, unmatchedEverywhere, type RootKind, type Roots } from "./roots.ts";
import type { Scope } from "./scope.ts";
import { serializationContract } from "./serialization-contract.ts";
import { supportReferences, testSupportFiles } from "./test-support.ts";
import { diagnosticsOf, ownedAs, runSession, type Engine, type ProjectView } from "./session.ts";
import { accessorsOf, storesOf } from "./stores.ts";
import { isPartKind, type SuppressionRecord, type Suppressions, type Verdict } from "./suppress.ts";
import { bindRows, readBaseline, readIgnoreFile, type Recorded } from "./suppress-file.ts";
import { inlineDirectives, inlineSuppressions, type InlineDirective } from "./suppress-inline.ts";
import type { Exemption, Mode, SweepInput } from "./sweep.ts";
import { readTemplates, templateField } from "./template-field.ts";
import { ownErrors, workspaceRun } from "./workspace-run.ts";

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
  /** The derived configurations the run dropped. */
  readonly notBuilt: readonly NotBuilt[];
  /** Every question the checker could not answer, each once. */
  readonly unanswered: readonly UnansweredQuestion[];
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
  /** The compiler configuration file the project was opened from, absolute. */
  readonly configFile: string;
  readonly held: Inventory;
  readonly rooted: Roots;
  /**
   * The paths below the target root of the workspace-package files the project holds
   * only for the references they make.
   */
  readonly referenceOnly: readonly string[];
  /** Every type error of the project's own files that skipped a unit. */
  readonly typeErrorSkips: readonly TypeErrorSkip[];
  /** The lines each of those skips withholds every finding on. */
  readonly skipped: readonly SkippedUnit[];
}

/** One target project the run analyzes, as its stage is handed it. */
interface OpenedProject {
  readonly configuration: string;
  /** Enumerates and roots the project; called only inside the stage it was handed to. */
  readonly read: () => ProjectRead;
}

/** What a run read of the consumers its scope declares. */
interface ConsumerReads {
  /** Every declared consumer, each loaded, in the scope's order. */
  readonly loaded: readonly LoadedConsumer[];
  /** Every reference a consumer makes to a declaration of the target, each once. */
  readonly references: readonly Reference[];
}

/** What a run read of its projects: each target project's answer, and its consumers. */
interface ReadProjects<Answer> {
  readonly answers: readonly Answer[];
  readonly consumers: ConsumerReads;
  /** The derived configurations the run dropped, in the order it met them. */
  readonly notBuilt: readonly NotBuilt[];
  /** Every question the checker could not answer, each once. */
  readonly unanswered: readonly UnansweredQuestion[];
  /** Per configuration whose component files the run cannot read, the reason. */
  readonly componentsUnread: readonly ComponentsUnread[];
}

/**
 * Reads every project the scope discovers, and each declared consumer's, in one snapshot,
 * each checked for errors first. `stage` is handed a target project and enumerates and roots
 * it if it reads it; a consumer project is read for its references to the target. A type error
 * in an own file skips the unit holding it. A guess that does not load or meets a setup failure
 * is dropped into `notBuilt` (see {@link isGuess}); any other such project fails the run, as
 * does a run whose every guess was dropped.
 */
function readProjects<Answer>(
  engine: Engine,
  host: Host,
  scope: Scope,
  config: Config,
  stage: <Brand>(project: ProjectView<Brand>, opened: OpenedProject) => Answer,
): ReadProjects<Answer> {
  const targetRoot = scope.target.path;
  const discovered = discoverProjects(engine, host, scope, config.analysis.configurations);
  const ids = new Map(discovered.projects.map((project) => [project.configFile, project.id]));
  const loads = consumerLoads(engine, host, scope, discovered.configFiles);
  const consumerOf = new Map(
    loads.flatMap((load) =>
      load.configFiles.map((configFile) => [configFile, load.consumer] as const),
    ),
  );
  const absoluteRoot = resolvePath(host.workingDirectory(), targetRoot);
  const workspace = workspaceRun(
    engine,
    host,
    absoluteRoot,
    discovered.configFiles,
    readManifest(host, targetRoot),
  );
  const options = {
    manifest: workspace?.manifest ?? readManifest(host, targetRoot),
    workspaceEntries: workspace?.entries,
    patterns: config.rootPatterns,
    entryFiles: config.ts.entryFiles,
    testFiles: config.ts.testFiles,
    publishedAPI: config.targetKind === "library",
  };
  const notBuilt: NotBuilt[] = [...discovered.notBuilt];
  const dropped = (configFile: string, error: string): void => {
    notBuilt.push({
      id: ids.get(configFile) ?? configFile,
      configFile,
      error: targetRelative(error, absoluteRoot),
    });
  };
  const failures: LocatedDiagnostic[] = [];
  const unbuildable: SetupFailure[] = [];
  const setupDropped: SetupFailure[] = [];
  const consumed = new Map<string, Reference>();
  const setupMet = (configFile: string, met: readonly SetupFailure[]): void => {
    const [first] = met;
    if (first !== undefined && isGuess(discovered, configFile)) {
      dropped(configFile, setupLine(first));
      setupDropped.push(...met);
    } else {
      unbuildable.push(...met);
    }
  };
  const session = runSession(
    engine,
    [...discovered.configFiles, ...consumerOf.keys()],
    (opened) => {
      const consumer = consumerOf.get(opened.configFile);
      const setup = consumer === undefined ? workspace?.unbuildable(opened.configFile) : undefined;
      if (setup !== undefined) {
        setupMet(opened.configFile, [
          { setupClass: "workspace-member-without-source", detail: setup },
        ]);
        return undefined;
      }
      const referenceOnly =
        workspace === undefined || consumer !== undefined
          ? () => false
          : workspace.referenceOnly(opened.configFile, opened.rootFiles);
      const project =
        workspace === undefined || consumer !== undefined
          ? opened
          : ownedAs(opened, (file, fromExternalLibrary) =>
              workspace.ownFile(file, fromExternalLibrary),
            );
      const raw = projectErrors(diagnosticsOf(project));
      const errors = { load: raw.load, check: ownErrors(raw.check, referenceOnly) };
      const [unloaded] = errors.load;
      if (
        unloaded !== undefined &&
        consumer === undefined &&
        isGuess(discovered, project.configFile)
      ) {
        dropped(
          project.configFile,
          renderDiagnostic(unloaded, (path) => relativePath(absoluteRoot, path) ?? path),
        );
        return undefined;
      }
      if (errors.load.length > 0) {
        failures.push(...errors.load);
        return undefined;
      }
      const reading = readErrors(project, errors.check, {
        host,
        targetRoot:
          consumer === undefined
            ? absoluteRoot
            : resolvePath(host.workingDirectory(), consumer.path),
        paths: pathsOf(engine, project.configFile),
      });
      if (reading.failing.length > 0) {
        failures.push(...reading.failing);
        return undefined;
      }
      if (consumer !== undefined && reading.missing.length > 0) {
        unbuildable.push(
          ...reading.missing.map((one) => ({
            setupClass: "missing-consumer" as const,
            detail: `the consumer ${consumer.path} does not build, its dependencies not installed: ${one.detail}`,
          })),
        );
        return undefined;
      }
      if (reading.missing.length > 0) {
        setupMet(project.configFile, reading.missing);
        return undefined;
      }
      if (consumer !== undefined) {
        for (const reference of consumerReferences(
          project,
          host,
          targetRoot,
          {
            id: consumer.id,
            root: consumer.path,
          },
          config,
        )) {
          consumed.set(referenceKey(reference), reference);
        }
        return undefined;
      }
      const configuration = ids.get(project.configFile) ?? project.configFile;
      const read = (): ProjectRead => {
        const held = inventory(project, host, targetRoot);
        const found = roots(project, held, targetRoot, options);
        const kept = skippedRoots(project, held, reading.skips);
        const rooted =
          kept.length === 0
            ? found
            : {
                ...found,
                liveUnderReachability: [
                  ...found.liveUnderReachability,
                  ...kept.map((id) => ({ id, kind: "type-error" as const, source: "" })),
                ],
              };
        return {
          configuration,
          configFile: project.configFile,
          held,
          rooted,
          typeErrorSkips: reading.skips.map((one) => one.record),
          skipped: skippedUnits(reading.skips, absoluteRoot),
          referenceOnly: project
            .ownSourceFiles()
            .filter((file) => referenceOnly(file.fileName))
            .flatMap((file) => relativePath(absoluteRoot, file.fileName) ?? []),
        };
      };
      return stage(project, { configuration, read });
    },
    discovered.derived ? "record" : "refuse",
    workspace?.programs,
  );
  for (const configFile of session.unopened) {
    if (consumerOf.has(configFile) || !isGuess(discovered, configFile)) {
      throw new DiscoveryError(`${configFile} opened no project`, []);
    }
    dropped(configFile, "the compiler opened no project for the configuration");
  }
  if (unbuildable.length > 0) {
    throw new SetupError(unbuildable);
  }
  if (failures.length > 0) {
    throw new DiscoveryError(
      `${String(failures.length)} error(s), so no answer was produced`,
      failures,
    );
  }
  const answers = session.projects.filter((answer): answer is Answer => answer !== undefined);
  const [first] = notBuilt;
  if (answers.length === 0 && setupDropped.length > 0) {
    throw new SetupError(setupDropped);
  }
  if (answers.length === 0 && first !== undefined) {
    throw new DiscoveryError(
      `no configuration discovery derived could be built; ${first.id}: ${first.error}`,
      [],
    );
  }
  return {
    answers,
    consumers: {
      loaded: loads.map((load) => load.consumer),
      references: [...consumed.values()],
    },
    notBuilt,
    unanswered: session.unanswered,
    componentsUnread: workspace?.componentsUnread ?? [],
  };
}

/** The projects one run analyzes, and what reading them left out. */
interface RunProjects {
  /** Each configuration the run analyzes, by the name discovery gives its project, in discovery order. */
  readonly configurations: readonly string[];
  /** The derived configurations the run dropped. */
  readonly notBuilt: readonly NotBuilt[];
  /** Every question the checker could not answer, each once. */
  readonly unanswered: readonly UnansweredQuestion[];
}

/**
 * The projects the run the scope and the configuration describe analyzes, each read
 * for the errors and setup failures that decide whether it is analyzed, dropped or
 * fails the run, exactly as the analysis reads them.
 */
export function runProjects(engine: Engine, host: Host, scope: Scope, config: Config): RunProjects {
  const read = readProjects(
    engine,
    host,
    scope,
    config,
    (_project, opened) => opened.configuration,
  );
  return { configurations: read.answers, notBuilt: read.notBuilt, unanswered: read.unanswered };
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
  const read = readProjects(engine, host, scope, config, (_project, opened) => opened.read());
  const projects = read.answers;

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
    findings: unmatchedRootFindings(
      unmatched,
      documentOf(host, provenance, ROOTS_SETTING, targetRoot),
    ),
    notBuilt: read.notBuilt,
    unanswered: read.unanswered,
  };
}

/** The run's sweep, beside the matrix it judged. */
export interface RunSweep {
  readonly matrix: Matrix;
  readonly sweep: SweepResult;
  /** The exemption records that hold under the sweep. */
  readonly exempt: readonly Exemption[];
  /**
   * The exemption records that held back a declaration some configuration of the run
   * would otherwise judge dead, in the declarations' site order.
   */
  readonly retained: readonly Exemption[];
  /** The derived configurations the run dropped. */
  readonly notBuilt: readonly NotBuilt[];
  /** Every question the checker could not answer, each once. */
  readonly unanswered: readonly UnansweredQuestion[];
  /**
   * Every declaration an unanswered question could have kept live, and every one only
   * such a declaration keeps live. The run reports none of them.
   */
  readonly heldByUnanswered: readonly string[];
  /** The lines of the units type errors skipped, on which the run reports nothing. */
  readonly skipped: readonly SkippedUnit[];
  /** The component files the run read, by path below the target root, each once. */
  readonly componentFiles: readonly string[];
}

/** One `<script` start tag of a component file the run read no block for. */
export interface ComponentWarning {
  /** The file, below the target root. */
  readonly path: string;
  readonly line: number;
  readonly reason: string;
}

/** The exemption classes this analyzer detects, each by its detector; any other retains nothing. */
const DETECTORS: Detectors = new Map<TSExemptionClass, Detector>([
  ["interface-satisfaction", interfaceSatisfaction],
  ["enum-group", enumGroup],
  ["template-field", templateField],
  ["reflective-lookup", reflectiveLookup],
  ["decorator", decorator],
  ["injection-container", injectionContainer],
  ["framework-lifecycle", frameworkLifecycle],
  ["serialization-contract", serializationContract],
]);

/** What the sweep of one run reads of each project, beside what a caller's stage adds. */
interface SweptProject<Extra> {
  readonly configFile: string;
  readonly configured: Configured;
  readonly exempt: readonly Exemption[];
  /** The declarations of the project an unanswered question could have kept live. */
  readonly unanswered: readonly string[];
  readonly typeErrorSkips: readonly TypeErrorSkip[];
  readonly skipped: readonly SkippedUnit[];
  /** The component files the project holds of its own, by path below the target root. */
  readonly componentFiles: readonly string[];
  readonly componentWarnings: readonly ComponentWarning[];
  readonly extra: Extra;
}

/** What a run read of its projects before any sweep: the matrix, its exemptions, and each project's answers. */
interface ReadRun<Extra> {
  readonly matrix: Matrix;
  readonly exempt: readonly Exemption[];
  /** The declarations of the run an unanswered question could have kept live, each once. */
  readonly unansweredHeld: readonly string[];
  readonly projects: readonly SweptProject<Extra>[];
  /** Every declared consumer, each loaded, in the scope's order. */
  readonly consumers: readonly LoadedConsumer[];
  /** The derived configurations the run dropped. */
  readonly notBuilt: readonly NotBuilt[];
  /** Every question the checker could not answer, each once. */
  readonly unanswered: readonly UnansweredQuestion[];
  /** Per configuration whose component files the run cannot read, the reason. */
  readonly componentsUnread: readonly ComponentsUnread[];
}

/**
 * Reads every project of the run, its references and exemptions, and `extra`'s answer,
 * while the project's view is open, and merges the projects into one matrix in the run's
 * order. Every configuration holds every consumer's references beside its own, because a
 * consumer calls the target whichever configuration the target is built under.
 */
function readRun<Extra>(
  engine: Engine,
  host: Host,
  scope: Scope,
  config: Config,
  mode: Mode,
  detectors: Detectors,
  extra: <Brand>(
    project: ProjectView<Brand>,
    read: ProjectRead,
    references: readonly Reference[],
  ) => Extra,
): ReadRun<Extra> {
  const targetRoot = scope.target.path;
  const disabled = disabledClasses(config);
  const templates = disabled.has("template-field")
    ? { delimiters: config.analysis.templateDelimiters, files: [] }
    : readTemplates(host, targetRoot, config.analysis);
  const consumers = scope.consumers.map((consumer) => consumer.path);
  const read = readProjects<SweptProject<Extra>>(engine, host, scope, config, (project, opened) => {
    const projectRead = opened.read();
    const resolved = references(project, projectRead.held, targetRoot, {
      testFiles: config.ts.testFiles,
    });
    const support = testSupportFiles(
      projectRead.held.symbols,
      resolved.references,
      projectRead.rooted.liveUnderReachability,
      resolved.testFilePaths,
    );
    const made = supportReferences(resolved.references, support);
    const configured: Configured = {
      configuration: projectRead.configuration,
      symbols: projectRead.held.symbols,
      references: made,
      roots: projectRead.rooted.liveUnderReachability,
      testFiles: resolved.testFilePaths,
      ...(support.size === 0 ? {} : { supportFiles: [...support].sort() }),
      ...(projectRead.referenceOnly.length === 0
        ? {}
        : { referenceOnly: projectRead.referenceOnly }),
    };
    const exempt = computeExemptions(
      { project, held: projectRead.held, targetRoot, templates, ts: config.ts, consumers },
      detectors,
      {
        disabled,
        mode,
        testFiles: new Set([...resolved.testFilePaths, ...support]),
      },
    );
    const unanswered = [
      ...projectRead.held.unanswered,
      ...projectRead.rooted.unanswered,
      ...made
        .filter((reference) => reference.resolution === "by-name")
        .map((reference) => reference.to),
      ...exempt.filter(isUnansweredRecord).map((record) => record.id),
    ];
    const components = project.ownSourceFiles().filter(isComponentFile);
    const pathOf = (file: (typeof components)[number]): string =>
      relativePath(targetRoot, file.fileName) ?? file.fileName;
    return {
      configFile: projectRead.configFile,
      configured,
      exempt,
      unanswered,
      typeErrorSkips: projectRead.typeErrorSkips,
      skipped: projectRead.skipped,
      componentFiles: components.map(pathOf),
      componentWarnings: components.flatMap((file) =>
        readComponent(file.originalText).warnings.map((warning) => ({
          path: pathOf(file),
          line: lineOf(file.originalText, warning.offset),
          reason: warning.reason,
        })),
      ),
      extra: extra(project, projectRead, made),
    };
  });
  const consumed = read.consumers.references;
  const projects = read.answers.map((one) =>
    consumed.length === 0
      ? one
      : {
          ...one,
          configured: {
            ...one.configured,
            references: [...one.configured.references, ...consumed],
          },
        },
  );
  return {
    matrix: matrixOf(projects.map((one) => one.configured)),
    exempt: exemptionsOf(projects.flatMap((one) => one.exempt)),
    unansweredHeld: [
      ...new Set([
        ...read.answers.flatMap((one) => one.unanswered),
        ...consumed.filter((one) => one.resolution === "by-name").map((one) => one.to),
      ]),
    ],
    projects,
    consumers: read.consumers.loaded,
    notBuilt: read.notBuilt,
    unanswered: read.unanswered,
    componentsUnread: read.componentsUnread,
  };
}

/**
 * The run swept under one set of marks with the records that hold. A record a component
 * file's markup holds counts only while the file is live, and what it holds may be what
 * keeps the file live, so each file's markup joins only once a sweep without it finds the
 * file live, until a sweep finds no further file live.
 */
function holdingSweep<Extra>(
  read: ReadRun<Extra>,
  input: Pick<SweepInput, "marked" | "mode">,
): { readonly swept: SweepInput; readonly result: SweepResult } {
  const paths = new Set(read.exempt.flatMap((record) => record.whileLive ?? []));
  let live = new Set<string>();
  for (;;) {
    const swept: SweepInput = {
      ...input,
      exempt: holdingWhile(read.exempt, live),
      unanswered: read.unansweredHeld,
    };
    const result = sweepMatrix(read.matrix, swept);
    const next = new Set(liveFilesAt(read.matrix, result, paths).map((one) => one.position.path));
    if (next.size === live.size) {
      return { swept, result };
    }
    live = next;
  }
}

/**
 * The sweep of a run read once, under one set of marks. Where a question went unanswered,
 * the run is swept once more without what that question could have kept live and without
 * the references that stood in for its answer, and every declaration that sweep judges
 * dead and this one judges live, or dead by another rule, is held by the gap too, as is
 * every declaration that makes such a reference.
 */
function sweptOf<Extra>(
  read: ReadRun<Extra>,
  input: Pick<SweepInput, "marked" | "mode">,
): RunSweep {
  const { swept, result } = holdingSweep(read, input);
  const exempt = swept.exempt ?? [];
  const held = new Set(read.unansweredHeld);
  if (held.size > 0) {
    // What a declaration reads where the checker did not answer is unknown, so a rule
    // over what it reads, the test of dead code among them, cannot judge it.
    for (const { configured } of read.projects) {
      for (const reference of configured.references) {
        if (reference.resolution === "by-name") {
          held.add(reference.from);
        }
      }
    }
    const dead = new Map(result.candidates.map((candidate) => [candidate.id, candidate]));
    const answered = matrixOf(
      read.projects.map(({ configured }) => ({
        ...configured,
        references: configured.references.filter((one) => one.resolution !== "by-name"),
      })),
    );
    const bare: SweepInput = {
      ...swept,
      exempt: exempt.filter((record) => !isUnansweredRecord(record)),
      unanswered: [],
    };
    for (const candidate of sweepMatrix(answered, bare).candidates) {
      const kept = dead.get(candidate.id);
      if (
        kept?.testOfDeadCode !== candidate.testOfDeadCode ||
        kept.relation !== candidate.relation
      ) {
        held.add(candidate.id);
      }
    }
  }
  return {
    matrix: read.matrix,
    sweep: result,
    exempt,
    retained: retainedIn(read.matrix, swept),
    notBuilt: read.notBuilt,
    unanswered: read.unanswered,
    heldByUnanswered: [...held],
    skipped: read.projects.flatMap((one) => one.skipped),
    componentFiles: [...new Set(read.projects.flatMap((one) => one.componentFiles))].sort(compare),
  };
}

/**
 * Sweeps the run the scope and the configuration describe. Each project's references
 * and exemptions are read against its own inventory while its view is open; the
 * projects then merge into one matrix in the run's order, which is swept under the
 * caller's marks and mode with the exemptions every project found. A record found in
 * one configuration holds in every configuration that holds its declaration, because
 * an exemption is evidence of a use the analysis cannot see and a use in one
 * configuration is a use. A project that carries an error ends the run before any
 * project is swept.
 */
export function runSweep(
  engine: Engine,
  host: Host,
  scope: Scope,
  config: Config,
  input: Pick<SweepInput, "marked" | "mode">,
  detectors: Detectors = DETECTORS,
): RunSweep {
  return sweptOf(
    readRun(engine, host, scope, config, input.mode, detectors, () => undefined),
    input,
  );
}

/** What each project contributes to the facts every emitter reads beside the sweep. */
interface EmitterExtra {
  readonly deprecation: Deprecation;
  readonly accessors: ReturnType<typeof accessorsOf>;
  readonly needs: ReturnType<typeof projectNeeds>;
  readonly implementations: ReturnType<typeof implementations>;
  readonly heldByInclusion: readonly string[];
  readonly rooted: Roots;
  readonly directives: readonly InlineDirective[];
  readonly declarationsNamed: readonly boolean[];
  readonly parts: ProjectParts;
}

/** Reads a run's projects with every per-project fact an emitter reads. */
function readEmitterRun(
  engine: Engine,
  host: Host,
  scope: Scope,
  config: Config,
  mode: Mode,
  detectors: Detectors,
): ReadRun<EmitterExtra> {
  const targetRoot = scope.target.path;
  const run = readRun(
    engine,
    host,
    scope,
    config,
    mode,
    detectors,
    (project, read, references) => ({
      deprecation: deprecatedDeclarations(project, read.held),
      accessors: accessorsOf(project, read.held),
      needs: projectNeeds(project, read.held, host),
      implementations: implementations(project, read.held),
      heldByInclusion: heldByInclusion(project, targetRoot),
      rooted: read.rooted,
      directives: inlineDirectives(project, read.held, targetRoot).filter(
        (directive) => !read.referenceOnly.includes(directive.site.path),
      ),
      declarationsNamed: declarationsNamed(project, read.held, configuredDeclarations(config)),
      parts: projectParts(project, read.held, references, targetRoot),
    }),
  );
  // Whether a declaration carries the marker decides its code, so one whose marker went
  // unread is reported by nothing.
  const unread = run.projects.flatMap((one) => one.extra.deprecation.unanswered);
  return unread.length === 0
    ? run
    : { ...run, unansweredHeld: [...new Set([...run.unansweredHeld, ...unread])] };
}

/**
 * The input every emitter reads over one sweep of a read run: the facts beside the sweep
 * each kind family reads, every per-project one read in the same session as the sweep.
 */
function emitterInputOver(
  host: Host,
  scope: Scope,
  config: Config,
  read: ReadRun<EmitterExtra>,
  input: Pick<SweepInput, "marked" | "mode">,
  selfCheck: SelfCheckFacts,
): EmitterInput {
  const targetRoot = scope.target.path;
  const swept = sweptOf(read, input);
  const { projects } = read;
  return {
    config,
    swept,
    deprecated: new Set(projects.flatMap((one) => one.extra.deprecation.deprecated)),
    stores: storesOf(
      projects.map((one) => ({
        references: one.configured.references,
        accessors: one.extra.accessors,
      })),
      swept.exempt,
      input.mode,
    ),
    dependencies: dependenciesOf(
      host,
      targetRoot,
      projects.map((one) => one.extra.needs),
      swept.sweep.candidates.map((candidate) => candidate.id),
    ),
    implementations: mergeImplementations(projects.map((one) => one.extra.implementations)),
    files: {
      tree: sourceTree(host, targetRoot),
      heldByInclusion: new Set(projects.flatMap((one) => one.extra.heldByInclusion)),
    },
    boundary: {
      consumers: {
        declared: scope.consumers.map((consumer) => moduleIdentity(host, consumer)),
        loaded: read.consumers.map((consumer) => consumer.id),
      },
      encapsulated: readManifest(host, targetRoot).declaresExports,
      edges: readEdgeSides(host, targetRoot),
    },
    selfCheck,
    intraFunction: intraFunctionFacts(
      projects.map((one) => one.extra.parts),
      projects.flatMap((one) => one.configured.references),
      new Set([...swept.exempt.map((one) => one.id), ...swept.heldByUnanswered]),
    ),
  };
}

/**
 * What every emitter reads of the run the scope and the configuration describe, swept
 * under the caller's marks: the run's sweep, the facts beside it each kind family reads,
 * and the sides of the target's declared cross-language edges that name a symbol of this
 * language. The run reads no suppression document, so the self-check family has nothing
 * to report.
 */
export function runEmitterInput(
  engine: Engine,
  host: Host,
  scope: Scope,
  config: Config,
  input: Pick<SweepInput, "marked" | "mode">,
  detectors: Detectors = DETECTORS,
): EmitterInput {
  const read = readEmitterRun(engine, host, scope, config, input.mode, detectors);
  return emitterInputOver(host, scope, config, read, input, NO_SELF_CHECK);
}

/** One run read for its findings: the input swept with and without its suppressions' marks. */
export interface AnalysisInputs {
  /** The run swept under the marks of every bound suppression record. */
  readonly marked: EmitterInput;
  /** The same run swept with no mark, which is what a record would have withheld. */
  readonly unmarked: EmitterInput;
  /** The run's suppression records and refusals, in reading order. */
  readonly suppressions: Suppressions;
}

/** One run read once, and analyzed under any set of baseline rows without reading it again. */
interface AnalysisReader {
  readonly run: RunFacts;
  readonly configured: readonly Configured[];
  /** The declarations of the run, which a baseline row binds against. */
  readonly symbols: readonly InventorySymbol[];
  /** The inputs of the run under the directives, the ignore file and the baseline given. */
  readonly inputsUnder: (baseline: Suppressions) => AnalysisInputs;
}

/**
 * Reads the run the scope and the configuration describe for its findings. The inline
 * directives, the ignore file's entries and the baseline's rows are bound before any
 * sweep, and the run is swept once under every bound record's mark and once under none,
 * so a record is decided against the finding its code would have produced. The
 * self-check family reports the refused suppressions and the roots that named nothing.
 * Beside the inputs it answers the projects and test-file rules a report names.
 */
function readAnalysis(
  engine: Engine,
  host: Host,
  scope: Scope,
  config: Config,
  provenance: Provenance,
  mode: Mode,
  detectors: Detectors,
): AnalysisReader {
  const targetRoot = scope.target.path;
  const read = readEmitterRun(engine, host, scope, config, mode, detectors);
  const symbols = read.matrix.union.symbols;
  const fixed = [
    inlineSuppressions(read.projects.map((one) => one.extra.directives)),
    readIgnoreFile(host, targetRoot, symbols),
  ];
  const inputsUnder = (baseline: Suppressions): AnalysisInputs =>
    inputsOver(host, scope, config, provenance, mode, read, [...fixed, baseline]);
  return {
    run: {
      projects: read.projects.map((one) => ({
        id: one.configured.configuration,
        configFile: one.configFile,
      })),
      testFileRules: testFileRulesOf(
        config.ts.testFiles,
        read.projects.flatMap((one) => one.configured.testFiles),
        read.projects.flatMap((one) => one.configured.supportFiles ?? []),
      ),
      typeErrorSkips: read.projects.flatMap((one) => one.typeErrorSkips),
      componentWarnings: [
        ...new Map(
          read.projects
            .flatMap((one) => one.componentWarnings)
            .map((one) => [`${one.path}:${String(one.line)}:${one.reason}`, one] as const),
        ).values(),
      ],
      consumers: read.consumers,
      notBuilt: read.notBuilt,
      unanswered: read.unanswered,
      componentsUnread: read.componentsUnread,
    },
    configured: read.projects.map((one) => one.configured),
    symbols,
    inputsUnder,
  };
}

/** The inputs of one read run under the suppression documents given, in reading order. */
function inputsOver(
  host: Host,
  scope: Scope,
  config: Config,
  provenance: Provenance,
  mode: Mode,
  read: ReadRun<EmitterExtra>,
  documents: readonly Suppressions[],
): AnalysisInputs {
  const targetRoot = scope.target.path;
  const suppressions: Suppressions = {
    records: documents.flatMap((one) => one.records),
    refusals: documents.flatMap((one) => one.refusals),
  };
  const facts: SelfCheckFacts = {
    refusals: suppressions.refusals,
    unmatchedRoots: unmatchedEverywhere(
      config.rootPatterns,
      read.projects.map((one) => one.extra.rooted),
    ),
    rootsDocument: documentOf(host, provenance, ROOTS_SETTING, targetRoot),
    unmatchedDeclarations: configuredDeclarations(config)
      .filter((_, at) => !read.projects.some((one) => one.extra.declarationsNamed[at] === true))
      .map((one) => ({
        ref: configuredRef(one.entry),
        key: one.key,
        document: documentOf(host, provenance, one.key, targetRoot),
      })),
  };
  const marked = [
    ...new Set(
      suppressions.records
        .filter((record) => !isPartKind(record.code))
        .map((record) => record.bound),
    ),
  ].filter((id) => id !== "");
  return {
    marked: emitterInputOver(host, scope, config, read, { marked, mode }, facts),
    unmarked: emitterInputOver(host, scope, config, read, { marked: [], mode }, facts),
    suppressions,
  };
}

/** One project of a run: the name the run gives it and the file it was opened from. */
export interface RunProject {
  readonly id: string;
  /** The compiler configuration file, absolute. */
  readonly configFile: string;
}

/** What a report states about the run beside its findings. */
export interface RunFacts {
  /** The projects the run analyzed, in the run's order. */
  readonly projects: readonly RunProject[];
  /** The rules that classified files as test files, each counted over every project at once. */
  readonly testFileRules: readonly TestFileRule[];
  /** Every consumer the run loaded beside the target, in the scope's order. */
  readonly consumers: readonly LoadedConsumer[];
  /** The derived configurations the run dropped. */
  readonly notBuilt: readonly NotBuilt[];
  /** Every question the checker could not answer, each once. */
  readonly unanswered: readonly UnansweredQuestion[];
  /** Every type error that skipped a unit, in the run's order. */
  readonly typeErrorSkips: readonly TypeErrorSkip[];
  /** Every `<script` start tag a component file holds that no block was read for, each once. */
  readonly componentWarnings: readonly ComponentWarning[];
  /** Per configuration whose component files the run cannot read, the reason. */
  readonly componentsUnread: readonly ComponentsUnread[];
}

/** One configuration whose component files a run cannot read. */
export interface ComponentsUnread {
  readonly configFile: string;
  readonly reason: string;
}

/** The findings of one run, beside what a report states about the run itself. */
export interface RunAnalysis {
  readonly result: PassResult;
  readonly run: RunFacts;
  /** The sweep the findings were decided over, under the mark of every bound record. */
  readonly swept: RunSweep;
  /** What each project answered, in the run's order, which the sweep was built from. */
  readonly configured: readonly Configured[];
}

/**
 * The analysis of the run the scope and the configuration describe: the run read with its
 * suppressions bound, every family's findings with the suppressions applied and the
 * declared edges evaluated, the projects and test-file rules the report names, and the sweep
 * an explanation reads.
 */
export function runAnalysis(
  engine: Engine,
  host: Host,
  scope: Scope,
  config: Config,
  provenance: Provenance,
  mode: Mode,
  detectors: Detectors = DETECTORS,
): RunAnalysis {
  const reader = readAnalysis(engine, host, scope, config, provenance, mode, detectors);
  const inputs = reader.inputsUnder(readBaseline(host, scope.target.path, reader.symbols));
  return analysisOf(reader, inputs);
}

/**
 * One count per configuration of the run in which the checker left a question unanswered:
 * the questions asked in its project, and the declarations of its own the run holds for them.
 */
export function unansweredCounts(analysis: RunAnalysis): readonly UnansweredCount[] {
  const held = new Set(analysis.swept.heldByUnanswered);
  return analysis.run.projects.flatMap((project) => {
    const questions = analysis.run.unanswered.filter(
      (one) => one.configFile === project.configFile,
    ).length;
    if (questions === 0) {
      return [];
    }
    const symbols = analysis.configured.find((one) => one.configuration === project.id)?.symbols;
    const declarations = new Set((symbols ?? []).map((one) => one.id).filter((id) => held.has(id)));
    return [{ configuration: project.id, questions, declarations: declarations.size }];
  });
}

function analysisOf(reader: AnalysisReader, inputs: AnalysisInputs): RunAnalysis {
  return {
    result: findingsPass(inputs),
    run: reader.run,
    swept: inputs.marked.swept,
    configured: reader.configured,
  };
}

/** A baseline write: the analysis of its first round, and the rows its fixpoint holds. */
interface BaselineWrite {
  /** The first round, which reads no baseline. */
  readonly first: RunAnalysis;
  /** The rows that remain when a round records no row and removes none, in recording order. */
  readonly rows: readonly Recorded[];
}

/**
 * The fixpoint a baseline write records. The first round reads no baseline; each later
 * round reads the rows recorded so far, records a row for each recordable finding no row
 * already names, and removes every row it reports stale. A removed row is not recorded
 * again, so the write ends.
 */
export function runBaselineWrite(
  engine: Engine,
  host: Host,
  scope: Scope,
  config: Config,
  provenance: Provenance,
  mode: Mode,
  reason: string,
  detectors: Detectors = DETECTORS,
): BaselineWrite {
  const reader = readAnalysis(engine, host, scope, config, provenance, mode, detectors);
  const first = analysisOf(reader, reader.inputsUnder({ records: [], refusals: [] }));
  let rows: readonly Recorded[] = [];
  const removed = new Set<string>();
  let result = first.result;
  let stale: ReadonlySet<string> = new Set<string>();
  for (;;) {
    const held = new Set(rows.map(rowKey));
    const added = recordedFindings(result.findings).filter(
      (row) => !held.has(rowKey(row)) && !removed.has(rowKey(row)),
    );
    if (added.length === 0 && stale.size === 0) {
      return { first, rows };
    }
    for (const key of stale) {
      removed.add(key);
    }
    rows = [...rows.filter((row) => !stale.has(rowKey(row))), ...added];
    const inputs = reader.inputsUnder(bindRows(rows, reason, reader.symbols));
    result = findingsPass(inputs);
    stale = staleRows(inputs.suppressions.records, result.ledger.verdicts);
  }
}

/** The baseline rows a round reports stale: every record a row binds to matched nothing. */
function staleRows(
  records: readonly SuppressionRecord[],
  verdicts: readonly Verdict[],
): ReadonlySet<string> {
  const live = new Set<string>();
  const stale = new Set<string>();
  records.forEach((record, at) => {
    if (record.mechanism !== "baseline") {
      return;
    }
    const key = rowKey(record);
    (verdicts[at] === "stale" ? stale : live).add(key);
  });
  return new Set([...stale].filter((key) => !live.has(key)));
}
