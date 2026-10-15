import {
  runAnalysis,
  runBaselineWrite,
  unansweredCounts,
  type ComponentWarning,
  type RunAnalysis,
  type RunProject,
} from "../analysis.ts";
import { ConfigError, kindOf, type Format } from "../config.ts";
import { CONFORMANCE, DECLARED_GAPS } from "../conformance.ts";
import { moduleIdentity } from "../consumers.ts";
import { analyzerProvenance, verdictOf } from "../findings-pass.ts";
import { dirnamePath, joinPath, normalizePath, relativePath, resolvePath } from "../paths.ts";
import type { Host } from "../host.ts";
import type { ManifestEntry } from "../manifest.ts";
import type { NotBuilt } from "../discover.ts";
import { partialNotes } from "../partial.ts";
import {
  buildReport,
  LANGUAGE,
  capFindings,
  sortFindings,
  type Report,
  type ReportConfiguration,
  type ReportNotBuilt,
  type ReportNote,
} from "../report.ts";
import { json } from "../reporters/json.ts";
import { RENDERINGS } from "../reporters/reporters.ts";
import { parseTemplate, TemplateError, type Template } from "../reporters/template.ts";
import { resolve } from "../resolve.ts";
import { otherSchemeRows, rowReason, writeBaseline, type Recorded } from "../suppress-file.ts";
import type { UnseenLoad } from "../unseen-loads.ts";
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

/**
 * One note per manifest entry the run reads back to no source file: what the entry names
 * reaches nothing, so the findings its file would have rooted are reported.
 */
function unmappedNotes(
  entries: readonly ManifestEntry[],
  targetRoot: string,
): readonly ReportNote[] {
  return entries.map((entry) => {
    const named = relativePath(targetRoot, entry.path) ?? entry.path;
    return {
      kind: "unmapped-entry",
      path: relativePath(targetRoot, entry.dir) ?? ".",
      key: "ts.entry_files",
      message: `the manifest's ${entry.member} names ${named}, which reads back to no source file of the target: name the file it is built from in ts.entry_files`,
    };
  });
}

/**
 * One note per load of a production file the run cannot resolve, each site once: a file
 * it loads is a root the run does not see, so `ts.roots_complete` lifts no cap there.
 */
function unseenLoadNotes(loads: readonly UnseenLoad[]): readonly ReportNote[] {
  return [
    ...new Map(
      loads.map((load) => {
        const { path, line, column } = load.position;
        const site = `${path}:${String(line)}:${String(column)}`;
        const note: ReportNote = {
          kind: "computed-load",
          path: dirnamePath(path),
          message: `${site} loads a module by a computed path the analysis cannot resolve, so the configurations compiling it report what no root reaches at probable at most, whatever ts.roots_complete says`,
        };
        return [site, note] as const;
      }),
    ).values(),
  ];
}

/** Each project the run dropped as a report names it, by its configuration file below the target. */
function notBuiltOf(dropped: readonly NotBuilt[], targetRoot: string): readonly ReportNotBuilt[] {
  return dropped.map((one) => {
    const project = relativePath(targetRoot, one.configFile);
    if (project === undefined) {
      throw new ReportPathError(
        `the project ${one.id} would be opened from ${one.configFile}, which is not below the target ${targetRoot}, so no report can name it`,
      );
    }
    return { id: one.id, project, error: one.error };
  });
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
 * Analyzes the scope and writes the JSON report to the path `--report` names, each
 * `--format` rendering beside it with the format's suffix appended, and under
 * `--baseline-write` the baseline a fixpoint over the analysis records, the report being its
 * first round. Diagnostics go to the error stream and nothing to the output stream; the
 * verdict is the exit code, or 0 under `--exit-code=off`, and a rendering that cannot be
 * written ends the run with 3.
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
  let partial: readonly string[];
  let warnings: readonly ComponentWarning[];
  let unread: readonly string[];
  let unfound: readonly string[];
  try {
    const root = runRelative(invoked, targetRoot);
    const mode = { production: true };
    let analysis: RunAnalysis;
    if (documents.baseline === undefined) {
      analysis = runAnalysis(openClient(config), host, scoped, config, provenance, mode);
      recorded = [];
    } else {
      const reason = rowReason(analyzerProvenance(version));
      const write = runBaselineWrite(
        openClient(config),
        host,
        scoped,
        config,
        provenance,
        mode,
        reason,
      );
      analysis = write.first;
      recorded = write.rows;
    }
    const { result, run } = analysis;
    warnings = run.componentWarnings;
    unread = run.componentsUnread.map(
      ({ configFile, reason }) =>
        `${relativePath(resolvePath(invoked, targetRoot), configFile) ?? configFile}: its component files are not read: ${reason}`,
    );
    unfound = run.librariesUnfound.map(
      ({ configFile, error }) =>
        `${relativePath(resolvePath(invoked, targetRoot), configFile) ?? configFile}: ${error}: the configuration is analyzed without that library`,
    );
    partial = partialNotes({
      notBuilt: run.notBuilt,
      unanswered: run.unanswered,
      targetRoot: resolvePath(invoked, targetRoot),
    });
    const built = buildReport({
      contractVersion: CONTRACT_VERSION,
      version,
      conformance: CONFORMANCE,
      declaredGaps: DECLARED_GAPS,
      target: {
        kind: kindOf(kind, LANGUAGE),
        root,
        identity: moduleIdentity(host, scoped.target),
      },
      configurations: configurationsOf(run.projects, targetRoot),
      notBuilt: notBuiltOf(run.notBuilt, targetRoot),
      loaded: run.consumers.map((consumer) => ({
        id: consumer.id,
        path: runRelative(invoked, consumer.path),
      })),
      unavailable: [],
      result,
      testFileRules: run.testFileRules,
      typeErrorSkips: run.typeErrorSkips,
      unanswered: unansweredCounts(analysis),
      conventionsApplied: run.conventionsApplied,
      listsComponents: config.reporters.cascade === "full",
      notes: [
        ...unmappedNotes(run.unmappedEntries, resolvePath(invoked, targetRoot)),
        ...unseenLoadNotes(run.unseenLoads),
      ],
    });
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
    host.writeDocument(documents.report, json(report));
    const options = {
      readSource: (path: string) => host.readFile(joinPath(targetRoot, path)),
      template,
    };
    for (const format of documents.formats) {
      const rendering = RENDERINGS.get(format);
      if (rendering !== undefined) {
        host.writeDocument(documents.report + rendering.suffix, rendering.render(report, options));
      }
    }
    if (documents.baseline !== undefined) {
      const kept =
        host.kindOf(documents.baseline) === "file"
          ? otherSchemeRows(host.readFile(documents.baseline))
          : [];
      host.writeDocument(
        documents.baseline,
        writeBaseline(recorded, analyzerProvenance(version), kept),
      );
    }
  } catch (error: unknown) {
    err.write(`deadset-ts: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_FAILURE;
  }

  for (const note of partial) {
    err.write(`deadset-ts: ${note}\n`);
  }
  for (const line of [...unread, ...unfound]) {
    err.write(`deadset-ts: ${line}\n`);
  }
  for (const warning of warnings) {
    err.write(
      `deadset-ts: ${warning.path}:${String(warning.line)}: a <script> start tag that begins a line is not read as a block: ${warning.reason}\n`,
    );
  }
  for (const skip of report.type_error_skips) {
    err.write(
      `deadset-ts: ${skip.path}:${String(skip.line)}: ${skip.message}: the function or statement holding this type error is not evaluated\n`,
    );
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
