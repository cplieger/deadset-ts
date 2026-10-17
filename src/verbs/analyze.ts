import { CONTRACT_VERSION, EXIT_CLEAN, type Format } from "../contract/contract.generated.ts";
import {
  runAnalysis,
  runBaselineWrite,
  unansweredCounts,
  type RunAnalysis,
  type RunProject,
} from "../analysis.ts";
import { kindOf } from "../config.ts";
import { CONFORMANCE, DECLARED_GAPS } from "../conformance.ts";
import { analyzerProvenance, verdictOf } from "../findings-pass.ts";
import { dirnamePath, joinPath, normalizePath, relativePath, resolvePath } from "../paths.ts";
import type { Host } from "../host.ts";
import type { ManifestEntry } from "../manifest.ts";
import { moduleIdentity, type NotBuilt } from "../load/discover.ts";
import { partialNotes } from "../partial.ts";
import {
  buildReport,
  capFindings,
  sortFindings,
  type ReportConfiguration,
  type ReportNotBuilt,
  type ReportNote,
} from "../report.ts";
import { reportRefusals } from "../report-schema.ts";
import { json } from "../reporters/json.ts";
import { RENDERINGS } from "../reporters/reporters.ts";
import { parseTemplate, TemplateError, type Template } from "../reporters/template.ts";
import { resolve } from "../resolve.ts";
import { otherSchemeRows, rowReason, writeBaseline, type Recorded } from "../suppress-file.ts";
import type { UnseenLoad } from "../unseen-loads.ts";
import { type Verb, type VerbOptions } from "./verb.ts";
import { UsageError } from "../usage.ts";
import { bytewise } from "../text/compare.ts";
import { productFault, failureExit } from "../failure.ts";
import { diagnose, message } from "../product.ts";
import { ownVersion } from "./version.ts";

/** The options `analyze` takes beside the ones every verb takes. */
export const ANALYZE_OPTIONS: VerbOptions = {
  plain: ["report", "baseline-write", "exit-code", "template"],
  repeatable: ["format"],
};

/** The two values `--exit-code` takes; on, the default, puts the run's verdict in the exit code. */
const EXIT_CODE_ON = "on";
const EXIT_CODE_OFF = "off";

/** The formats this analyzer renders, for a message that names them. */
function formatNames(): string {
  return [...RENDERINGS.keys()].sort(bytewise).join(", ");
}

/** The renderings one invocation writes: the ones it named, else the configuration's. */
function formatsOf(named: readonly string[], configured: readonly Format[]): readonly Format[] {
  const formats = named.length > 0 ? named : configured;
  const seen = new Set<string>();
  for (const format of formats) {
    if (!RENDERINGS.has(format as Format)) {
      throw new UsageError(
        `${JSON.stringify(format)} is not a format this analyzer renders: the formats are ${formatNames()}`,
      );
    }
    if (seen.has(format)) {
      throw new UsageError(`the format ${JSON.stringify(format)} is named twice`);
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
    throw failureExit(
      "unreportable-path",
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
      throw failureExit(
        "unreportable-path",
        `the project ${one.id} would be opened from ${one.configFile}, which is not below the target ${targetRoot}, so no report can name it: analyze a target that holds it`,
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
      throw failureExit(
        "unreportable-path",
        `the project ${one.id} is opened from ${one.configFile}, which is not below the target ${targetRoot}, so no report can name it: analyze a target that holds it`,
      );
    }
    return { id: one.id, project };
  });
}

/**
 * Writes one document the run was asked for. A document that cannot be produced or written
 * ends the run with the run failure that names it and `fix`, the documents written before it
 * kept.
 */
function writeDocument(
  host: Host,
  path: string,
  fix: string,
  produce: () => Iterable<string>,
): void {
  try {
    host.writeDocument(path, produce());
  } catch (error: unknown) {
    throw failureExit("unwritten-output", `${path}: ${message(error)}: ${fix}`);
  }
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
      throw new UsageError(
        "the template format renders the template --template names, and none was named",
      );
    }
    return undefined;
  }
  let source: string;
  try {
    source = host.readFile(resolvePath(invoked, named));
  } catch (error: unknown) {
    throw new UsageError(`--template=${named}: ${message(error)}`);
  }
  try {
    return parseTemplate(source);
  } catch (error: unknown) {
    if (!(error instanceof TemplateError)) {
      throw error;
    }
    throw new UsageError(`--template=${named}: ${error.message}`);
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
    throw new UsageError(
      "analyze writes its report to the path --report names, and no path was named",
    );
  }
  const exitCode = option("exit-code") ?? EXIT_CODE_ON;
  if (exitCode !== EXIT_CODE_ON && exitCode !== EXIT_CODE_OFF) {
    throw new UsageError(
      `--exit-code=${JSON.stringify(exitCode)}: the values are ${EXIT_CODE_ON} and ${EXIT_CODE_OFF}`,
    );
  }
  const { config, provenance } = resolve(inputs());
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

  const version = ownVersion(host);

  let recorded: readonly Recorded[];
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
  const warnings = run.componentWarnings;
  const unread = run.componentsUnread.map(
    ({ configFile, reason }) =>
      `${relativePath(resolvePath(invoked, targetRoot), configFile) ?? configFile}: its component files are not read: ${reason}`,
  );
  const unfound = run.librariesUnfound.map(
    ({ configFile, error }) =>
      `${relativePath(resolvePath(invoked, targetRoot), configFile) ?? configFile}: ${error}: the configuration is analyzed without that library`,
  );
  const partial = partialNotes({
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
      kind: kindOf(config.target.kind),
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
  const report = capFindings(
    sortFindings(built, config.reporters.sort),
    config.reporters.max_findings,
  );
  const verdict = verdictOf(result, config);

  const [refused] = reportRefusals(report);
  if (refused !== undefined) {
    throw productFault(
      `built a report that breaks the report schema at ${refused.pointer || "the document"}: ${refused.keyword}: ${refused.reason}`,
    );
  }
  writeDocument(host, documents.report, "name a path the run can write", () => json(report));
  const options = {
    readSource: (path: string) => host.readFile(joinPath(targetRoot, path)),
    template,
  };
  for (const format of documents.formats) {
    const rendering = RENDERINGS.get(format);
    if (rendering !== undefined) {
      writeDocument(
        host,
        documents.report + rendering.suffix,
        "name a path the run can write, or correct the template that renders it",
        () => rendering.render(report, options),
      );
    }
  }
  const baselinePath = documents.baseline;
  if (baselinePath !== undefined) {
    writeDocument(
      host,
      baselinePath,
      "name a path the run can write, or repair the rows of the baseline the run would keep",
      () => {
        const kept =
          host.kindOf(baselinePath) === "file" ? otherSchemeRows(host.readFile(baselinePath)) : [];
        return writeBaseline(recorded, analyzerProvenance(version), kept);
      },
    );
  }

  for (const note of partial) {
    diagnose(err, note);
  }
  for (const line of [...unread, ...unfound]) {
    diagnose(err, line);
  }
  for (const warning of warnings) {
    diagnose(
      err,
      `${warning.path}:${String(warning.line)}: a <script> start tag that begins a line is not read as a block: ${warning.reason}`,
    );
  }
  for (const skip of report.type_error_skips) {
    diagnose(
      err,
      `${skip.path}:${String(skip.line)}: ${skip.message}: the function or statement holding this type error is not evaluated`,
    );
  }
  if (report.totals.pending > 0) {
    diagnose(
      err,
      `${counted(report.totals.pending, "pending finding")}: the report names a declared cross-language edge, and no merge has resolved it`,
    );
  }
  if (report.totals.stale_suppressions > 0) {
    diagnose(err, counted(report.totals.stale_suppressions, "stale suppression"));
  }
  if (exitCode === EXIT_CODE_OFF) {
    if (verdict !== EXIT_CLEAN) {
      diagnose(
        err,
        `the exit code is configured off: the verdict of this run is ${String(verdict)}`,
      );
    }
    return EXIT_CLEAN;
  }
  return verdict;
};
