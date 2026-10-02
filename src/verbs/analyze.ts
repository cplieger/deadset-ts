import { runAnalysis, type RunProject } from "../analysis.ts";
import { ConfigError, type Format } from "../config.ts";
import { CONFORMANCE, DECLARED_GAPS } from "../conformance.ts";
import { analyzerProvenance, recordedFindings, verdictOf } from "../findings-pass.ts";
import { packageScope } from "../inventory.ts";
import { joinPath, normalizePath, relativePath, resolvePath } from "../paths.ts";
import type { Host } from "../host.ts";
import {
  buildReport,
  capFindings,
  sortFindings,
  type Report,
  type ReportConfiguration,
} from "../report.ts";
import { json } from "../reporters/json.ts";
import { RENDERINGS } from "../reporters/reporters.ts";
import { parseTemplate, TemplateError, type Template } from "../reporters/template.ts";
import { resolve } from "../resolve.ts";
import type { Module } from "../scope.ts";
import { writeBaseline, type Recorded } from "../suppress-file.ts";
import { CONTRACT_VERSION } from "../version.ts";
import { EXIT_CLEAN, EXIT_FAILURE, type Verb, type VerbOptions } from "./verb.ts";

/** The options `analyze` takes beside the ones every verb takes. */
export const ANALYZE_OPTIONS: VerbOptions = {
  plain: ["report", "baseline-write", "exit-code", "template"],
  repeatable: ["format"],
};

/** The two values `--exit-code` takes; on, the default, puts the run's verdict in the exit code. */
const EXIT_CODE_ON = "on";
const EXIT_CODE_OFF = "off";

/** Why a declared consumer is not loaded, which every report names it with. */
const NOT_LOADED = "this analyzer loads no consumer beside the target";

/** A path of the run no report can name, which ends the run with the failure code. */
class ReportPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportPathError";
  }
}

/** The formats this analyzer renders, for a message that names them. */
function formatNames(): string {
  return [...RENDERINGS.keys()].sort().join(", ");
}

/** The renderings one invocation writes: the ones it named, else the configuration's. */
function formatsOf(named: readonly string[], configured: readonly Format[]): readonly Format[] {
  const formats = named.length > 0 ? named : configured;
  const seen = new Set<string>();
  for (const format of formats) {
    if (!RENDERINGS.has(format as Format)) {
      throw new ConfigError(
        "malformed",
        "",
        `${JSON.stringify(format)} is not a format this analyzer renders: the formats are ${formatNames()}`,
      );
    }
    if (seen.has(format)) {
      throw new ConfigError("malformed", "", `the format ${JSON.stringify(format)} is named twice`);
    }
    seen.add(format);
  }
  return formats as readonly Format[];
}

/**
 * One directory of the run below the directory the run was invoked from, as a report names
 * it. A report admits that directory and every path below it and none that climbs out, so a
 * target elsewhere has no spelling a report can carry and fails the run.
 */
function runRelative(invoked: string, path: string): string {
  if (normalizePath(invoked) === normalizePath(path)) {
    return ".";
  }
  const below = relativePath(invoked, path);
  if (below === undefined) {
    throw new ReportPathError(
      `a report names its target relative to the directory the run was invoked from, and ${invoked} does not contain ${path}: run from a directory that does`,
    );
  }
  return below;
}

/** Each project of the run as a report names it, by its configuration file below the target. */
function configurationsOf(
  projects: readonly RunProject[],
  targetRoot: string,
): readonly ReportConfiguration[] {
  return projects.map((one) => {
    const project = relativePath(targetRoot, one.configFile);
    if (project === undefined) {
      throw new ReportPathError(
        `the project ${one.id} is opened from ${one.configFile}, which is not below the target ${targetRoot}, so no report can name it`,
      );
    }
    return { id: one.id, project };
  });
}

/** The name one module publishes itself under: the scope's, else its manifest's. */
function identityOf(module: Module, host: Host): string {
  return module.id === "" ? packageScope(host, module.path)("index.ts").package : module.id;
}

/** A count with its noun, so a message reads for one record as well as for several. */
function counted(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * The template `--template` names, read and parsed before any analysis, so a template that
 * cannot be read or does not parse refuses the invocation. The template format with no
 * template named is refused the same way.
 */
function templateOf(
  host: Host,
  invoked: string,
  named: string | undefined,
  formats: readonly Format[],
): Template | undefined {
  if (named === undefined || named === "") {
    if (formats.includes("template")) {
      throw new ConfigError(
        "malformed",
        "",
        "the template format renders the template --template names, and none was named",
      );
    }
    return undefined;
  }
  let source: string;
  try {
    source = host.readFile(resolvePath(invoked, named));
  } catch (error: unknown) {
    throw new ConfigError(
      "malformed",
      "",
      `--template=${named}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return parseTemplate(source);
  } catch (error: unknown) {
    if (!(error instanceof TemplateError)) {
      throw error;
    }
    throw new ConfigError("malformed", "", `--template=${named}: ${error.message}`);
  }
}

/** Every document one invocation asked for: the report, each rendering beside it, a baseline. */
interface Documents {
  readonly report: string;
  readonly formats: readonly Format[];
  readonly baseline: string | undefined;
}

/**
 * Analyzes the scope under the configuration and writes the JSON report to the path
 * `--report` names, each rendering `--format` names beside it at the report's path with the
 * format's suffix appended, and a baseline of every finding where `--baseline-write` names a
 * path. The template format renders the template `--template` names. Nothing is written to
 * the output stream; diagnostics go to the error stream and the verdict is the exit code, or 0
 * under `--exit-code=off`, and a rendering that cannot be written ends the run with 3.
 */
export const analyzeVerb: Verb = ({ err, host, inputs, scope, openClient, option, repeated }) => {
  const reportPath = option("report");
  if (reportPath === undefined || reportPath === "") {
    throw new ConfigError(
      "malformed",
      "",
      "analyze writes its report to the path --report names, and no path was named",
    );
  }
  const exitCode = option("exit-code") ?? EXIT_CODE_ON;
  if (exitCode !== EXIT_CODE_ON && exitCode !== EXIT_CODE_OFF) {
    throw new ConfigError(
      "malformed",
      "",
      `--exit-code=${JSON.stringify(exitCode)}: the values are ${EXIT_CODE_ON} and ${EXIT_CODE_OFF}`,
    );
  }
  const { config, provenance } = resolve(inputs());
  const kind = config.targetKind;
  if (kind === "") {
    throw new ConfigError("missing-target-kind", "target.kind", "target.kind is not set");
  }
  const invoked = host.workingDirectory();
  const baseline = option("baseline-write");
  const documents: Documents = {
    report: resolvePath(invoked, reportPath),
    formats: formatsOf(repeated("format"), config.reporters.formats),
    baseline: baseline === undefined ? undefined : resolvePath(invoked, baseline),
  };
  const template = templateOf(host, invoked, option("template"), documents.formats);
  const scoped = scope();
  const targetRoot = scoped.target.path;

  let version: string;
  try {
    version = host.analyzerVersion();
  } catch (error: unknown) {
    err.write(`deadset-ts: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_FAILURE;
  }

  let report: Report;
  let recorded: readonly Recorded[];
  let verdict: number;
  try {
    const root = runRelative(invoked, targetRoot);
    const { result, run } = runAnalysis(openClient(false), host, scoped, config, provenance, {
      production: true,
    });
    const built = buildReport({
      contractVersion: CONTRACT_VERSION,
      version,
      conformance: CONFORMANCE,
      declaredGaps: DECLARED_GAPS,
      target: { kind, root, identity: identityOf(scoped.target, host) },
      configurations: configurationsOf(run.projects, targetRoot),
      unavailable: scoped.consumers.map((consumer) => ({
        id: identityOf(consumer, host),
        reason: NOT_LOADED,
      })),
      result,
      testFileRules: run.testFileRules,
    });
    // The baseline records every finding, so its rows are taken before the cap bounds what
    // a rendering prints: a baseline missing a reported finding fails the next run on it.
    recorded = recordedFindings(result);
    report = capFindings(sortFindings(built, config.reporters.sort), config.reporters.maxFindings);
    verdict = verdictOf(result, config);
  } catch (error: unknown) {
    if (!(error instanceof ReportPathError)) {
      throw error;
    }
    err.write(`deadset-ts: ${error.message}\n`);
    return EXIT_FAILURE;
  }

  try {
    host.writeFile(documents.report, json(report));
    const options = {
      failOn: config.reporters.failOn,
      readSource: (path: string) => host.readFile(joinPath(targetRoot, path)),
      template,
    };
    for (const format of documents.formats) {
      const rendering = RENDERINGS.get(format);
      if (rendering !== undefined) {
        host.writeFile(documents.report + rendering.suffix, rendering.render(report, options));
      }
    }
    if (documents.baseline !== undefined) {
      host.writeFile(documents.baseline, writeBaseline(recorded, analyzerProvenance(version)));
    }
  } catch (error: unknown) {
    err.write(`deadset-ts: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_FAILURE;
  }

  if (report.totals.pending > 0) {
    err.write(
      `deadset-ts: ${counted(report.totals.pending, "pending finding")}: the report names a declared cross-language edge, and no merge has resolved it\n`,
    );
  }
  if (report.totals.stale_suppressions > 0) {
    err.write(`deadset-ts: ${counted(report.totals.stale_suppressions, "stale suppression")}\n`);
  }
  if (exitCode === EXIT_CODE_OFF) {
    if (verdict !== EXIT_CLEAN) {
      err.write(
        `deadset-ts: the exit code is configured off: the verdict of this run is ${String(verdict)}\n`,
      );
    }
    return EXIT_CLEAN;
  }
  return verdict;
};
