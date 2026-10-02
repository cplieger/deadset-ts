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
import {
  consumerLoads,
  consumerReferences,
  moduleIdentity,
  type LoadedConsumer,
} from "./consumers.ts";
import { decorator } from "./decorator.ts";
import { dependenciesOf, projectNeeds } from "./dependencies.ts";
import { deprecatedDeclarations } from "./deprecation.ts";
import { diagnosticErrors, discoverProjects, DiscoveryError } from "./discover.ts";
import { readEdgeSides } from "./edges.ts";
import { enumGroup } from "./enum-group.ts";
import {
  computeExemptions,
  disabledClasses,
  exemptionsOf,
  retainedIn,
  type Detector,
  type Detectors,
} from "./exempt.ts";
import type { TSExemptionClass } from "./exempt-classes.ts";
import { heldByInclusion, sourceTree } from "./file-facts.ts";
import type { Finding } from "./finding.ts";
import { findingsPass, type PassResult } from "./findings-pass.ts";
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
import { inventory, type Inventory } from "./inventory.ts";
import { readManifest } from "./manifest.ts";
import {
  matrixOf,
  referenceKey,
  sweepMatrix,
  type Configured,
  type Matrix,
  type SweepResult,
} from "./matrix.ts";
import { relativePath, resolvePath } from "./paths.ts";
import { byPosition, type Position } from "./position.ts";
import { reflectiveLookup } from "./reflective-lookup.ts";
import { references, testFileRulesOf, type Reference, type TestFileRule } from "./references.ts";
import { roots, unmatchedEverywhere, type RootKind, type Roots } from "./roots.ts";
import type { Scope } from "./scope.ts";
import { serializationContract } from "./serialization-contract.ts";
import { diagnosticsOf, runSession, type Engine, type ProjectView } from "./session.ts";
import { accessorsOf, storesOf } from "./stores.ts";
import type { Suppressions } from "./suppress.ts";
import { readBaseline, readIgnoreFile } from "./suppress-file.ts";
import { inlineDirectives, inlineSuppressions, type InlineDirective } from "./suppress-inline.ts";
import type { Exemption, Mode, SweepInput } from "./sweep.ts";
import { readTemplates, templateField } from "./template-field.ts";

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
  /** The compiler configuration file the project was opened from, absolute. */
  readonly configFile: string;
  readonly held: Inventory;
  readonly rooted: Roots;
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
}

/**
 * Reads every project the scope discovers, and every project of every consumer it
 * declares, in one snapshot. Each is checked for errors first. A target project is then
 * enumerated and rooted, and `stage` reads the rest of what it needs from the project
 * while its view is open; a consumer project is read for its references to the target's
 * declarations. A project carrying an error fails the run with no answer, as every verb
 * that reads declarations does, and so does a declared consumer that cannot be loaded.
 */
function readProjects<Answer>(
  engine: Engine,
  host: Host,
  scope: Scope,
  config: Config,
  stage: <Brand>(project: ProjectView<Brand>, read: ProjectRead) => Answer,
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
  const options = {
    manifest: readManifest(host, targetRoot),
    patterns: config.rootPatterns,
    entryFiles: config.ts.entryFiles,
    testFiles: config.ts.testFiles,
    publishedAPI: config.targetKind === "library",
  };
  const failures: Diagnostic[] = [];
  const consumed = new Map<string, Reference>();
  const { projects } = runSession(
    engine,
    [...discovered.configFiles, ...consumerOf.keys()],
    (project) => {
      const errors = diagnosticErrors(diagnosticsOf(project));
      if (errors.length > 0) {
        failures.push(...errors);
        return undefined;
      }
      const consumer = consumerOf.get(project.configFile);
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
      const held = inventory(project, host, targetRoot);
      const rooted = roots(project, held, targetRoot, options);
      const configuration = ids.get(project.configFile) ?? project.configFile;
      return stage(project, { configuration, configFile: project.configFile, held, rooted });
    },
  );
  if (failures.length > 0) {
    throw new DiscoveryError(
      `${String(failures.length)} error(s); no answer was produced`,
      failures,
    );
  }
  return {
    answers: projects.filter((answer): answer is Answer => answer !== undefined),
    consumers: {
      loaded: loads.map((load) => load.consumer),
      references: [...consumed.values()],
    },
  };
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
  const projects = readProjects(engine, host, scope, config, (_project, read) => read).answers;

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
  };
}

/** The run's sweep, beside the matrix it judged. */
export interface RunSweep {
  readonly matrix: Matrix;
  readonly sweep: SweepResult;
  /**
   * The exemption records that held back a declaration some configuration of the run
   * would otherwise judge dead, in the declarations' site order.
   */
  readonly retained: readonly Exemption[];
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
  readonly extra: Extra;
}

/** What a run read of its projects before any sweep: the matrix, its exemptions, and each project's answers. */
interface ReadRun<Extra> {
  readonly matrix: Matrix;
  readonly exempt: readonly Exemption[];
  readonly projects: readonly SweptProject<Extra>[];
  /** Every declared consumer, each loaded, in the scope's order. */
  readonly consumers: readonly LoadedConsumer[];
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
  extra: <Brand>(project: ProjectView<Brand>, read: ProjectRead) => Extra,
): ReadRun<Extra> {
  const targetRoot = scope.target.path;
  const disabled = disabledClasses(config);
  const templates = disabled.has("template-field")
    ? { delimiters: config.analysis.templateDelimiters, files: [] }
    : readTemplates(host, targetRoot, config.analysis);
  const consumers = scope.consumers.map((consumer) => consumer.path);
  const read = readProjects(engine, host, scope, config, (project, projectRead) => {
    const resolved = references(project, projectRead.held, targetRoot, {
      testFiles: config.ts.testFiles,
    });
    const configured: Configured = {
      configuration: projectRead.configuration,
      symbols: projectRead.held.symbols,
      references: resolved.references,
      roots: projectRead.rooted.liveUnderReachability,
      testFiles: resolved.testFilePaths,
    };
    const exempt = computeExemptions(
      { project, held: projectRead.held, targetRoot, templates, ts: config.ts, consumers },
      detectors,
      {
        disabled,
        mode,
        testFiles: new Set(resolved.testFilePaths),
      },
    );
    return {
      configFile: projectRead.configFile,
      configured,
      exempt,
      extra: extra(project, projectRead),
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
    projects,
    consumers: read.consumers.loaded,
  };
}

/** The sweep of a run read once, under one set of marks. */
function sweptOf<Extra>(
  read: ReadRun<Extra>,
  input: Pick<SweepInput, "marked" | "mode">,
): RunSweep {
  const swept: SweepInput = { ...input, exempt: read.exempt };
  return {
    matrix: read.matrix,
    sweep: sweepMatrix(read.matrix, swept),
    retained: retainedIn(read.matrix, swept),
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
  readonly deprecated: readonly string[];
  readonly accessors: ReturnType<typeof accessorsOf>;
  readonly needs: ReturnType<typeof projectNeeds>;
  readonly implementations: ReturnType<typeof implementations>;
  readonly heldByInclusion: readonly string[];
  readonly rooted: Roots;
  readonly directives: readonly InlineDirective[];
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
  return readRun(engine, host, scope, config, mode, detectors, (project, read) => ({
    deprecated: deprecatedDeclarations(project, read.held),
    accessors: accessorsOf(project, read.held),
    needs: projectNeeds(project, read.held, host),
    implementations: implementations(project, read.held),
    heldByInclusion: heldByInclusion(project, targetRoot),
    rooted: read.rooted,
    directives: inlineDirectives(project, read.held, targetRoot),
  }));
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
    deprecated: new Set(projects.flatMap((one) => one.extra.deprecated)),
    stores: storesOf(
      projects.map((one) => ({
        references: one.configured.references,
        accessors: one.extra.accessors,
      })),
      read.exempt,
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

/**
 * Reads the run the scope and the configuration describe for its findings. The inline
 * directives, the ignore file's entries and the baseline's rows are read and bound before
 * any sweep, and the run is swept once under every bound record's mark and once under
 * none, so a record is decided against the finding its code would have produced. The
 * self-check family reports the refused suppressions and the roots that named nothing.
 * Beside the inputs it answers the projects and test-file rules a report names.
 */
function runAnalysisInputs(
  engine: Engine,
  host: Host,
  scope: Scope,
  config: Config,
  provenance: Provenance,
  mode: Mode,
  detectors: Detectors,
): {
  readonly inputs: AnalysisInputs;
  readonly run: RunFacts;
  readonly configured: readonly Configured[];
} {
  const targetRoot = scope.target.path;
  const read = readEmitterRun(engine, host, scope, config, mode, detectors);
  const symbols = read.matrix.union.symbols;
  const documents = [
    inlineSuppressions(read.projects.map((one) => one.extra.directives)),
    readIgnoreFile(host, targetRoot, symbols),
    readBaseline(host, targetRoot, symbols),
  ];
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
  };
  const marked = [...new Set(suppressions.records.map((record) => record.bound))].filter(
    (id) => id !== "",
  );
  return {
    inputs: {
      marked: emitterInputOver(host, scope, config, read, { marked, mode }, facts),
      unmarked: emitterInputOver(host, scope, config, read, { marked: [], mode }, facts),
      suppressions,
    },
    run: {
      projects: read.projects.map((one) => ({
        id: one.configured.configuration,
        configFile: one.configFile,
      })),
      testFileRules: testFileRulesOf(
        config.ts.testFiles,
        read.projects.flatMap((one) => one.configured.testFiles),
      ),
      consumers: read.consumers,
    },
    configured: read.projects.map((one) => one.configured),
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
  const { inputs, run, configured } = runAnalysisInputs(
    engine,
    host,
    scope,
    config,
    provenance,
    mode,
    detectors,
  );
  return { result: findingsPass(inputs), run, swept: inputs.marked.swept, configured };
}
