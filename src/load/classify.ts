import type { SourceFile } from "@typescript/native/ast";
import { conventionFailuresFor } from "../conventions.ts";
import type { Host } from "../host.ts";
import { relativePath, resolvePath } from "../paths.ts";
import { diagnosticsOf, ownedAs, type ProjectView } from "../session.ts";
import { skipAt, type Skip } from "../type-errors.ts";
import {
  classOf,
  MISSING_GLOBAL_TYPE,
  projectErrors,
  renderDiagnostic,
  type LocatedDiagnostic,
} from "./diagnostics.ts";
import { targetRelative, type LoadedConsumer, type NotBuilt, type Origin } from "./discover.ts";
import { missingModule, pathsOf, type ModuleContext } from "./expected-module.ts";
import { FailureExit, failureLine, type Failure } from "../failure.ts";
import type { ConsumerWorkspace, ProgramPlan, RunPlan } from "./plan.ts";
import { ownErrors } from "./workspace-run.ts";

/** What keeps one configuration from being analyzed. */
type Failed =
  /** Its project carries an error that leaves it unloaded. */
  | { readonly kind: "load"; readonly errors: readonly [LocatedDiagnostic, ...LocatedDiagnostic[]] }
  | { readonly kind: "setup"; readonly failures: readonly [Failure, ...Failure[]] }
  /** The snapshot opened no project for it. */
  | { readonly kind: "unopened" };

/** What a failure ends or drops, by where the configuration comes from. */
const POLICY: Readonly<Record<Origin, Readonly<Record<Failed["kind"], "drop" | "end">>>> = {
  declared: { load: "end", setup: "end", unopened: "end" },
  scope: { load: "end", setup: "end", unopened: "end" },
  derived: { load: "drop", setup: "drop", unopened: "drop" },
  consumer: { load: "end", setup: "end", unopened: "end" },
};

/** One library an analyzed configuration names that the compiler cannot find. */
export interface LibraryUnfound {
  readonly configFile: string;
  /** The compiler's error, rendered as a dropped configuration's is. */
  readonly error: string;
}

/** One target project the run analyzes, as classification leaves it. */
interface Analyzed<Brand> {
  readonly plan: ProgramPlan;
  /** The project, its own files the target's. */
  readonly project: ProjectView<Brand>;
  /** Every type error of its own files, with the unit it skips. */
  readonly skips: readonly Skip[];
  /** Whether it holds one file only for the references that file makes. */
  readonly referenceOnly: (file: string) => boolean;
}

/** One consumer project the run reads the references of. */
interface Consumed<Brand> {
  readonly project: ProjectView<Brand>;
  readonly consumer: LoadedConsumer;
}

/** Every opened project of a run that may be read, and what the run notes about the others. */
export interface Classified {
  readonly analyzed: readonly Analyzed<unknown>[];
  readonly consumed: readonly Consumed<unknown>[];
  /** The derived configurations dropped, discovery's first, then in configuration order. */
  readonly notBuilt: readonly NotBuilt[];
  readonly librariesUnfound: readonly LibraryUnfound[];
}

/**
 * The errors of one project's own files: an import of a module the project expects and
 * nothing provides is a setup failure, every other error a type error skipping its unit.
 */
function readErrors<Brand>(
  project: ProjectView<Brand>,
  errors: readonly LocatedDiagnostic[],
  context: ModuleContext,
): { readonly missing: readonly Failure[]; readonly skips: readonly Skip[] } {
  const files = new Map<string, SourceFile>(
    project.ownSourceFiles().map((file) => [file.fileName, file]),
  );
  const missing: Failure[] = [];
  const skips: Skip[] = [];
  for (const { diagnostic, at } of errors) {
    const file = diagnostic.fileName === undefined ? undefined : files.get(diagnostic.fileName);
    const kind = classOf(diagnostic, true);
    if (file === undefined || kind === "ignored") {
      continue;
    }
    const line = at?.line ?? 1;
    const path = relativePath(context.targetRoot, file.fileName) ?? file.fileName;
    const expected =
      kind === "module-not-found" ? missingModule(context, file, diagnostic.pos) : undefined;
    if (expected !== undefined) {
      missing.push({
        failureClass: "missing-module",
        detail: `${path}:${String(line)}: ${path} imports ${JSON.stringify(expected.specifier)}, ${expected.reason}`,
      });
      continue;
    }
    const skip = skipAt(file, diagnostic.pos, line, diagnostic.text, context.targetRoot);
    if (skip !== undefined) {
      skips.push(skip);
    }
  }
  return { missing, skips };
}

function nonEmpty<T>(items: readonly T[]): readonly [T, ...T[]] | undefined {
  const [first, ...rest] = items;
  return first === undefined ? undefined : [first, ...rest];
}

/** One target project read for what keeps it from being analyzed, or the skips it is analyzed with. */
function classifyTarget<Brand>(
  host: Host,
  run: RunPlan,
  plan: ProgramPlan,
  view: ProjectView<Brand>,
  unfound: LibraryUnfound[],
): Failed | Analyzed<Brand> {
  const { workspace, root } = run;
  const unbuildable = workspace?.unbuildable(plan.configFile);
  if (unbuildable !== undefined) {
    return {
      kind: "setup",
      failures: [{ failureClass: "workspace-member-without-source", detail: unbuildable }],
    };
  }
  const referenceOnly =
    workspace === undefined
      ? () => false
      : workspace.referenceOnly(plan.configFile, view.rootFiles);
  const project =
    workspace === undefined
      ? view
      : ownedAs(view, (file, external) => workspace.ownFile(file, external));
  const raw = projectErrors(diagnosticsOf(project));
  const load = nonEmpty(raw.load);
  if (load !== undefined) {
    return { kind: "load", errors: load };
  }
  const reading = readErrors(project, ownErrors(raw.check, referenceOnly), {
    host,
    targetRoot: root,
    paths: pathsOf(plan.configFile, plan.parsed.options),
    member: (manifest) => workspace?.workspace.memberOf(manifest) !== undefined,
  });
  const failures =
    nonEmpty(reading.missing) ??
    nonEmpty(
      conventionFailuresFor(
        run.conventions,
        plan.configFile,
        project.ownSourceFiles().map((file) => file.fileName),
      ),
    );
  if (failures !== undefined) {
    return { kind: "setup", failures };
  }
  const display = (path: string): string => relativePath(root, path) ?? path;
  unfound.push(
    ...raw.unfound.map((one) => ({
      configFile: plan.configFile,
      error: renderDiagnostic(one, display),
    })),
  );
  const missingGlobal = raw.unfound.find(
    ({ diagnostic }) => diagnostic.code === MISSING_GLOBAL_TYPE,
  );
  // The checker types every use of a missing global against nothing and places no error in
  // a file, so every file of the project is skipped whole.
  const skips =
    missingGlobal === undefined
      ? reading.skips
      : [
          ...reading.skips,
          ...project.ownSourceFiles().map((file) => ({
            record: {
              path: display(file.fileName),
              line: 1,
              message: missingGlobal.diagnostic.text,
            },
            file,
            unit: file,
          })),
        ];
  return { plan, project, skips, referenceOnly };
}

/**
 * One consumer project read for what keeps its references from being read. A workspace
 * declaration that cannot be read fails it where an import asks whether a package is a member.
 */
function classifyConsumer<Brand>(
  host: Host,
  place: ConsumerWorkspace | undefined,
  plan: ProgramPlan,
  consumer: LoadedConsumer,
  project: ProjectView<Brand>,
): Failed | Consumed<Brand> {
  const raw = projectErrors(diagnosticsOf(project));
  const load = nonEmpty(raw.load);
  if (load !== undefined) {
    return { kind: "load", errors: load };
  }
  let faulted: string | undefined;
  const reading = readErrors(project, raw.check, {
    host,
    targetRoot: resolvePath(host.workingDirectory(), consumer.path),
    paths: pathsOf(plan.configFile, plan.parsed.options),
    member: (manifest) => {
      if (place !== undefined && "fault" in place) {
        faulted = place.fault;
        return false;
      }
      return place?.workspace?.memberOf(manifest) !== undefined;
    },
  });
  const details =
    faulted === undefined
      ? reading.missing.map(
          (one) =>
            `the consumer ${consumer.path} does not build, its dependencies not installed: ${one.detail}`,
        )
      : [
          `the consumer ${consumer.path} imports a dependency a package below it declares, and its workspace declaration cannot be read to tell whether that package is a member: ${faulted}`,
        ];
  const failures = nonEmpty(
    details.map((detail) => ({ failureClass: "missing-consumer" as const, detail })),
  );
  return failures === undefined ? { project, consumer } : { kind: "setup", failures };
}

/** The setup failure one failed configuration ends the run with, its located errors printed first. */
function ending(plan: ProgramPlan, failed: Failed, root: string): readonly Failure[] {
  if (failed.kind === "setup") {
    return failed.failures;
  }
  const what =
    failed.kind === "load"
      ? `the configuration ${relativePath(root, plan.configFile) ?? plan.configFile} does not load, its errors printed above`
      : `the compiler opened no project for ${plan.configFile}`;
  return plan.consumer === undefined
    ? [
        {
          failureClass: "no-program",
          detail: `${what}: correct the configuration, or name the configurations to analyze`,
        },
      ]
    : [
        {
          failureClass: "missing-consumer",
          detail: `${what}, for the consumer ${plan.consumer.path}: check the consumer out at ${plan.consumer.path} and install its dependencies`,
        },
      ];
}

/** The first line of the error that drops one derived configuration. */
function droppedBy(failed: Failed, root: string): string {
  return failed.kind === "load"
    ? targetRelative(
        renderDiagnostic(failed.errors[0], (path) => relativePath(root, path) ?? path),
        root,
      )
    : failed.kind === "setup"
      ? targetRelative(failureLine(failed.failures[0]), root)
      : "the compiler opened no project for the configuration";
}

/**
 * Every opened project of the run classified as analyzed, dropped or failing by the policy
 * table, before any stage reads one. A failure that ends the run is one {@link FailureExit}, by
 * this precedence: a configuration the snapshot opened nothing for, then the setup failures,
 * then the configurations that did not load with their errors, then, where every derived
 * configuration was dropped, their setup failures or the first reason.
 */
export function classify(
  host: Host,
  run: RunPlan,
  views: ReadonlyMap<string, ProjectView<unknown>>,
): Classified {
  const { root } = run;
  const notBuilt: NotBuilt[] = [...run.discovery.notBuilt];
  const librariesUnfound: LibraryUnfound[] = [];
  const analyzed: Analyzed<unknown>[] = [];
  const consumed: Consumed<unknown>[] = [];
  const ended = new Map<Failed["kind"], { plan: ProgramPlan; failed: Failed }[]>();
  const dropped: Failed[] = [];
  const unopened = run.plans.filter((plan) => !views.has(plan.configFile));
  const outcomes = [
    ...run.plans.flatMap((plan) => {
      const view = views.get(plan.configFile);
      return view === undefined
        ? []
        : [
            {
              plan,
              outcome:
                plan.consumer === undefined
                  ? classifyTarget(host, run, plan, view, librariesUnfound)
                  : classifyConsumer(
                      host,
                      run.consumerWorkspaces.get(plan.consumer.path),
                      plan,
                      plan.consumer,
                      view,
                    ),
            },
          ];
    }),
    ...unopened.map((plan) => ({ plan, outcome: { kind: "unopened" } as const })),
  ];
  for (const { plan, outcome } of outcomes) {
    if (!("kind" in outcome)) {
      if ("consumer" in outcome) {
        consumed.push(outcome);
      } else {
        analyzed.push(outcome);
      }
    } else if (POLICY[plan.origin][outcome.kind] === "end") {
      ended.set(outcome.kind, [...(ended.get(outcome.kind) ?? []), { plan, failed: outcome }]);
    } else {
      dropped.push(outcome);
      notBuilt.push({ id: plan.id, configFile: plan.configFile, error: droppedBy(outcome, root) });
    }
  }
  for (const kind of ["unopened", "setup", "load"] as const) {
    const all = ended.get(kind) ?? [];
    const failures = nonEmpty(all.flatMap(({ plan, failed }) => ending(plan, failed, root)));
    if (failures !== undefined) {
      throw new FailureExit(
        kind === "unopened" ? [failures[0]] : failures,
        all.flatMap(({ failed }) => (failed.kind === "load" ? failed.errors : [])),
      );
    }
  }
  const setupDropped = nonEmpty(
    dropped.flatMap((one) => (one.kind === "setup" ? one.failures : [])),
  );
  const [first] = notBuilt;
  if (analyzed.length === 0 && first !== undefined) {
    throw new FailureExit(
      setupDropped ?? [
        {
          failureClass: "no-program",
          detail: `no configuration discovery derived could be built; ${first.id}: ${first.error}`,
        },
      ],
    );
  }
  return { analyzed, consumed, notBuilt, librariesUnfound };
}
