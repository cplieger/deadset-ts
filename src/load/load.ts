import type { PartialConfig } from "../config.ts";
import type { Host } from "../host.ts";
import { resolvePath } from "../paths.ts";
import type { UnansweredQuestion } from "../query.ts";
import type { Scope } from "../scope.ts";
import { openSession, type Engine } from "../session.ts";
import { classify, type Classified } from "./classify.ts";
import { planRun, programBuilds, type RunPlan } from "./plan.ts";

/** The run as the load phase opens it, valid only inside the reader it is handed to. */
interface OpenedRun {
  readonly plan: RunPlan;
  readonly classified: Classified;
  /**
   * Every file a configuration read from a file holds, absolute, so a file another
   * configuration compiles is no outside file. A program the run forms resolves no emitted
   * output back to its source, so its files are read as outside files too.
   */
  readonly runFiles: ReadonlySet<string>;
}

/** What one loaded run answered, beside its plan and its classification. */
export interface LoadedRun<Result> extends Omit<OpenedRun, "runFiles"> {
  readonly result: Result;
  /** Every question the checker could not answer, each once, in the order first asked. */
  readonly unanswered: readonly UnansweredQuestion[];
}

/**
 * Plans the run, opens every configuration in one snapshot of one client, classifies every
 * project, and hands the analyzed and the consumer projects to `read` while the client answers.
 * A run that cannot be analyzed ends with one {@link FailureExit} before `read` is called.
 */
export function loadRun<Result>(
  engine: Engine,
  host: Host,
  scope: Scope,
  config: PartialConfig,
  read: (opened: OpenedRun) => Result,
): LoadedRun<Result> {
  const plan = planRun(engine, host, scope, config);
  return openSession(
    engine,
    plan.plans.map((one) => one.configFile),
    { programs: programBuilds(host, plan.plans) },
    (session, unanswered) => {
      const classified = classify(
        engine,
        host,
        plan,
        new Map(session.views.map((view) => [view.configFile, view])),
      );
      const formed = new Set(
        plan.plans.filter((one) => one.written !== undefined).map((one) => one.configFile),
      );
      const runFiles = new Set(
        session.views
          .filter((view) => !formed.has(view.configFile))
          .flatMap((view) =>
            view
              .ownSourceFiles()
              .map((file) => resolvePath(host.workingDirectory(), file.fileName)),
          ),
      );
      return {
        plan,
        classified,
        result: read({ plan, classified, runFiles }),
        unanswered: unanswered(),
      };
    },
  );
}
