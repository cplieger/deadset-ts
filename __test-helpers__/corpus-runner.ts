import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { nodeHost } from "../bin/node-host.ts";
import { runSweep } from "../src/analysis.ts";
import type { DeclaredGap } from "../src/conformance.ts";
import type { Host } from "../src/host.ts";
import {
  ANALYZER_NAME,
  LANGUAGE,
  type Report,
  type WireFinding,
  type WireStaleSuppression,
} from "../src/report.ts";
import { resolve } from "../src/resolve.ts";
import { run, type Writer } from "../src/run.ts";
import { readScope, scopeForDir } from "../src/scope.ts";
import { openEngine } from "../src/session.ts";
import { contractDocument, fixture, readFixture, ROOT } from "./fixtures.ts";
import { schemaValidator } from "./json-schema.ts";

/**
 * The conformance corpus runner: every fixture of the committed corpus copy with a
 * TypeScript rendering, answered through the `analyze` verb as a repository is, in two
 * phases, and recorded as the results document the corpus schemas shape.
 */

/** The declared-gap document this analyzer commits beside its source. */
const GAPS_FILE = "conformance.json";

/** The directory of a rendering holding the target; every other one is a consumer. */
const TARGET = "target";

/** The ignore file's name and location, which the suppression grammar fixes. */
const IGNORE_FILE = "deadset-ignore.json";

const NONE = "none";
const STALE_SUPPRESSION = "DS1703";
const UNMATCHED_ROOT = "DS1704";

/** The confidence and subject kind the report schema fixes for a stale-suppression record. */
const RECORD_CONFIDENCE = "certain";
const RECORD_SUBJECT = "suppression";

type Outcome = "pass" | "gap" | "fail";

interface Component {
  readonly root?: boolean;
  readonly symbol_count?: number;
  readonly deletable_lines?: number;
}

/** One expectation row; a member it omits states nothing and is not compared. */
interface Row {
  readonly symbol: string;
  readonly report: string;
  readonly symbol_kind?: string;
  readonly confidence?: string;
  readonly reachability_class?: string;
  readonly liveness_relation?: string;
  readonly configurations?: readonly string[];
  readonly retained_by?: readonly string[];
  readonly details?: Readonly<Record<string, unknown>>;
  readonly component?: Component;
}

interface ExpectationFile {
  readonly name: string;
  readonly languages: readonly string[];
  readonly target_kind: string;
  readonly consumers?: readonly string[];
  readonly closed_world?: readonly string[];
  readonly configured_roots?: Readonly<Record<string, string>>;
  readonly expect: readonly Row[];
}

interface Manifest {
  readonly symbols: Readonly<Record<string, { readonly file?: string; readonly line?: number }>>;
}

/** What the analyzer reported at one expectation, in the expectation file's vocabulary. */
interface Actual {
  readonly report: string;
  readonly symbol_kind?: string;
  readonly confidence?: string;
  readonly reachability_class?: string;
  readonly liveness_relation?: string;
  readonly configurations?: readonly string[];
  readonly retained_by?: readonly string[];
  readonly details?: Readonly<Record<string, unknown>>;
  readonly component?: Component;
}

interface Suppression {
  readonly suppressed: boolean;
  readonly stale: boolean;
}

interface ExpectationResult {
  readonly symbol: string;
  readonly result: Outcome;
  readonly capability?: string;
  readonly actual: Actual;
  suppression?: Suppression;
  readonly message?: string;
}

interface Unexpected {
  readonly file: string;
  readonly line: number;
  readonly report: string;
}

interface FixtureResult {
  readonly fixture: string;
  readonly result: Outcome;
  readonly expectations: readonly ExpectationResult[];
  readonly unexpected: readonly Unexpected[];
  readonly message?: string;
}

export interface Results {
  readonly corpus_version: string;
  readonly product: { readonly name: string; readonly version: string; readonly language: string };
  readonly result: "pass" | "fail";
  readonly totals: {
    readonly fixtures: number;
    readonly pass: number;
    readonly gap: number;
    readonly fail: number;
  };
  readonly fixtures: readonly FixtureResult[];
}

interface IgnoreEntry {
  readonly code: string;
  readonly symbol: string;
  readonly path: string;
  readonly reason: string;
}

/** What one analysis of a rendering answered: its report and the retained listing by site. */
interface Answered {
  readonly report: Report;
  readonly retained: ReadonlyMap<string, readonly string[]>;
}

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

/** A fixture the runner could not complete, so the run's record says why. */
class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureError";
  }
}

const validateReport = schemaValidator(
  {
    "report.schema.json": contractDocument("report.schema.json"),
    "finding.schema.json": contractDocument("finding.schema.json"),
  },
  "report.schema.json",
);

/** Two strings ordered bytewise. */
function compare(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/** The corpus document of the committed copy: its version and the subjects no record binds to. */
function corpus(): { readonly version: string; readonly rows: ReadonlySet<string> } {
  const document = JSON.parse(readFixture("corpus-document", "corpus.json")) as {
    readonly corpus_version: string;
    readonly subject_shapes: { readonly row: readonly string[] };
  };
  return { version: document.corpus_version, rows: new Set(document.subject_shapes.row) };
}

/** Every fixture of the committed copy whose expectation file lists this analyzer's language, by name. */
export function corpusFixtures(): readonly string[] {
  return readdirSync(fixture("corpus"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => expectationOf(name).languages.includes(LANGUAGE))
    .sort(compare);
}

function expectationOf(name: string): ExpectationFile {
  return readJson(fixture("corpus", name, "expect.json")) as ExpectationFile;
}

export function committedGaps(): readonly DeclaredGap[] {
  return (readJson(join(ROOT, GAPS_FILE)) as { readonly gaps: readonly DeclaredGap[] }).gaps;
}

/** Every file below one directory, relative to it, with the SHA-256 of its bytes. */
function filesUnder(dir: string): Map<string, string> {
  const held = new Map<string, string>();
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      held.set(
        relative(dir, path).split("\\").join("/"),
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      );
    }
  };
  walk(dir);
  return held;
}

/** One position as an expectation and a finding are compared at, from the rendering root. */
function siteOf(path: string, line: number): string {
  return `${TARGET}/${path}:${String(line)}`;
}

/** Each logical name of the fixture bound to its site, or to the configured entry it names. */
function sitesOf(file: ExpectationFile, manifest: Manifest): Map<string, string> {
  const sites = new Map<string, string>();
  for (const row of file.expect) {
    const configured = file.configured_roots?.[row.symbol];
    const bound = manifest.symbols[row.symbol];
    if (configured !== undefined) {
      if (bound !== undefined) {
        throw new FixtureError(`${row.symbol} is both a configured root and a manifest symbol`);
      }
      continue;
    }
    if (bound?.file === undefined || bound.line === undefined) {
      throw new FixtureError(`the manifest binds no file and line for ${row.symbol}`);
    }
    sites.set(row.symbol, `${bound.file}:${String(bound.line)}`);
  }
  return sites;
}

/** The repository document the fixture is answered under: its target kind, world and roots. */
function configOf(file: ExpectationFile): string {
  const world = file.closed_world ?? [];
  if (world.includes("matrix")) {
    throw new FixtureError(
      "the fixture declares the matrix complete, and the corpus spells no project matrix of a TypeScript rendering",
    );
  }
  const patterns = Object.keys(file.configured_roots ?? {})
    .sort(compare)
    .map((name) => file.configured_roots?.[name] ?? "");
  return `${JSON.stringify({
    target: { kind: file.target_kind },
    ...(world.includes("consumers") ? { consumers: { complete: true } } : {}),
    ...(patterns.length > 0 ? { roots: { patterns } } : {}),
  })}\n`;
}

/** The scope document naming each consumer of the fixture beside the target, or none. */
function scopeOf(file: ExpectationFile, rendering: string): string | undefined {
  const consumers = file.consumers ?? [];
  if (consumers.length === 0) {
    return undefined;
  }
  return `${JSON.stringify({
    target: { path: join(rendering, TARGET), role: "target" },
    consumers: consumers.map((name) => ({ path: join(rendering, name), role: "consumer" })),
  })}\n`;
}

/** One fixture's run: where it is copied, and the documents both analyses read. */
interface CorpusRun {
  readonly dir: string;
  readonly rendering: string;
  readonly config: string;
  readonly scope: string | undefined;
}

function hostAt(dir: string): Host {
  return { ...nodeHost(), workingDirectory: () => dir };
}

/**
 * One analysis of the rendering: the report the `analyze` verb writes, held to the
 * report schema, and the retained listing of the same sweep `print-retained` reads,
 * keyed by the site of each declaration an exemption held back.
 */
function analyzeRendering(at: CorpusRun, phase: string): Answered {
  const report = join(at.dir, `${phase}.report.json`);
  const err = new MemoryWriter();
  const args = [
    "analyze",
    `--target=${join("rendering", TARGET)}`,
    `--config=${join(at.dir, "deadset.json")}`,
    ...(at.scope === undefined ? [] : [`--scope=${join(at.dir, "scope.json")}`]),
    `--report=${report}`,
  ];
  const code = run(args, new MemoryWriter(), err, hostAt(at.dir));
  if (code !== 0 && code !== 1 && code !== 4) {
    throw new FixtureError(`the ${phase} analysis exited ${String(code)}: ${err.text.trim()}`);
  }
  const document = readJson(report) as Report;
  const errors = validateReport(document);
  if (errors.length > 0) {
    throw new FixtureError(
      `the ${phase} report does not meet the report schema: ${errors[0] ?? ""}`,
    );
  }

  const host = hostAt(at.dir);
  const scope =
    at.scope === undefined
      ? scopeForDir(host, join("rendering", TARGET))
      : readScope(host, join(at.dir, "scope.json"));
  const { config } = resolve({ repository: at.config, repositoryLabel: "deadset.json" });
  const engine = openEngine({ collectTiming: false });
  let swept: ReturnType<typeof runSweep>;
  try {
    swept = runSweep(engine, host, scope, config, { marked: [], mode: { production: true } });
  } finally {
    engine.close();
  }
  const union = swept.matrix.union;
  const retained = new Map<string, string[]>();
  for (const record of swept.retained) {
    const symbol = union.symbols[union.at(record.id)];
    if (symbol === undefined) {
      continue;
    }
    const site = siteOf(symbol.position.path, symbol.position.line);
    const classes = retained.get(site) ?? [];
    if (!classes.includes(record.class)) {
      classes.push(record.class);
    }
    retained.set(site, classes.sort(compare));
  }
  return { report: document, retained };
}

function findingsAt(findings: readonly WireFinding[], site: string | undefined): WireFinding[] {
  return findings.filter((one) => siteOf(one.position.path, one.position.line) === site);
}

/** The members of an object one row pins, read from the finding's own object of that name. */
function pinned(
  wanted: Readonly<Record<string, unknown>> | undefined,
  held: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (wanted === undefined) {
    return undefined;
  }
  const actual: Record<string, unknown> = {};
  for (const member of Object.keys(wanted)) {
    if (Object.hasOwn(held, member)) {
      actual[member] = held[member];
    }
  }
  return actual;
}

/** One finding in the expectation file's vocabulary, carrying the members the row names. */
function answerFrom(row: Row, found: WireFinding): Actual {
  const details = pinned(row.details, found.details as Readonly<Record<string, unknown>>);
  const component = pinned(
    row.component as Readonly<Record<string, unknown>> | undefined,
    found.component,
  );
  return {
    report: found.code,
    ...(row.symbol_kind === undefined ? {} : { symbol_kind: found.symbol.kind }),
    confidence: found.confidence,
    ...(row.reachability_class === undefined
      ? {}
      : { reachability_class: found.reachability_class }),
    ...(row.liveness_relation === undefined || found.liveness_relation === undefined
      ? {}
      : { liveness_relation: found.liveness_relation }),
    ...(row.configurations === undefined ? {} : { configurations: found.configurations }),
    ...(details === undefined || Object.keys(details).length === 0 ? {} : { details }),
    ...(component === undefined || Object.keys(component).length === 0 ? {} : { component }),
  };
}

/** One stale-suppression record in the expectation file's vocabulary. */
function answerFromRecord(row: Row, found: WireStaleSuppression): Actual {
  return {
    report: found.code,
    ...(row.symbol_kind === undefined ? {} : { symbol_kind: RECORD_SUBJECT }),
    confidence: RECORD_CONFIDENCE,
    ...(row.details?.["mechanism"] === undefined
      ? {}
      : { details: { mechanism: found.mechanism } }),
  };
}

/** Every member the row states and the answer does not match, in one line, or empty. */
function differences(row: Row, actual: Actual): string {
  const held: string[] = [];
  const scalars: [string, string | undefined, string | undefined][] = [
    ["report", row.report, actual.report],
    ["confidence", row.confidence, actual.confidence],
    ["symbol_kind", row.symbol_kind, actual.symbol_kind],
    ["reachability_class", row.reachability_class, actual.reachability_class],
    ["liveness_relation", row.liveness_relation, actual.liveness_relation],
  ];
  for (const [member, want, got] of scalars) {
    if (want !== undefined && want !== got) {
      held.push(`${member} want ${JSON.stringify(want)} got ${JSON.stringify(got ?? "")}`);
    }
  }
  if (
    row.configurations !== undefined &&
    JSON.stringify(row.configurations) !== JSON.stringify(actual.configurations ?? [])
  ) {
    held.push(
      `configurations want ${JSON.stringify(row.configurations)} got ${JSON.stringify(actual.configurations ?? [])}`,
    );
  }
  for (const [name, wanted, got] of [
    ["details", row.details, actual.details],
    ["component", row.component, actual.component],
  ] as const) {
    for (const [member, want] of Object.entries(wanted ?? {})) {
      const value = (got as Readonly<Record<string, unknown>> | undefined)?.[member];
      if (JSON.stringify(want) !== JSON.stringify(value)) {
        held.push(
          `${name}.${member} want ${JSON.stringify(want)} got ${value === undefined ? "nothing" : JSON.stringify(value)}`,
        );
      }
    }
  }
  return held.join("; ");
}

/** What the analyzer answered for one row, and what differs from it, or an empty message. */
function answerOf(
  row: Row,
  site: string | undefined,
  entry: string | undefined,
  held: Answered,
): { actual: Actual; message: string } {
  if (entry !== undefined) {
    const found = held.report.findings.filter(
      (one) => one.code === UNMATCHED_ROOT && one.symbol.ref === entry,
    );
    if (row.report === NONE) {
      const named = found[0];
      return named === undefined
        ? { actual: { report: NONE }, message: "" }
        : {
            actual: answerFrom(row, named),
            message: `want no ${UNMATCHED_ROOT} naming ${entry}, got one`,
          };
    }
    return answered(row, found, `${UNMATCHED_ROOT} naming ${entry}`);
  }
  if (row.report === STALE_SUPPRESSION) {
    const records = held.report.stale_suppressions.filter(
      (one) => siteOf(one.position.path, one.position.line) === site,
    );
    const record = records[0];
    if (record === undefined || records.length > 1) {
      return {
        actual: record === undefined ? { report: NONE } : answerFromRecord(row, record),
        message: `want exactly one ${STALE_SUPPRESSION} record at ${site ?? ""}, got ${String(records.length)}`,
      };
    }
    const actual = answerFromRecord(row, record);
    return { actual, message: differences(row, actual) };
  }
  const found = findingsAt(held.report.findings, site);
  if (row.report !== NONE) {
    return answered(row, found, `finding at ${site ?? ""}`);
  }
  if (found[0] !== undefined) {
    return {
      actual: answerFrom(row, found[0]),
      message: `want no finding at ${site ?? ""}, got ${found.map((one) => one.code).join(" ")}`,
    };
  }
  const classes = held.retained.get(site ?? "") ?? [];
  const actual: Actual = { report: NONE, ...(classes.length > 0 ? { retained_by: classes } : {}) };
  const wanted = [...(row.retained_by ?? [])].sort(compare);
  return wanted.length > 0 && JSON.stringify(wanted) !== JSON.stringify(classes)
    ? {
        actual,
        message: `want the retained listing to name ${JSON.stringify(wanted)} at ${site ?? ""}, got ${JSON.stringify(classes)}`,
      }
    : { actual, message: "" };
}

/** The answer to a row naming a code, from the findings that could answer it. */
function answered(
  row: Row,
  found: readonly WireFinding[],
  where: string,
): { actual: Actual; message: string } {
  const first = found[0];
  if (first === undefined) {
    return { actual: { report: NONE }, message: `want ${row.report} as the ${where}, got none` };
  }
  const actual = answerFrom(row, first);
  if (found.length > 1) {
    return {
      actual,
      message: `want exactly one ${where}, got ${found.map((one) => one.code).join(" ")}`,
    };
  }
  return { actual, message: differences(row, actual) };
}

/** Every finding and record at a position no row resolves to, ordered by file, line and code. */
export function unexpectedOf(
  report: Report,
  sites: ReadonlyMap<string, string>,
  entries: ReadonlySet<string>,
): Unexpected[] {
  const expected = new Set(sites.values());
  const reported = [
    ...report.findings.map((one) => ({
      code: one.code,
      ref: one.symbol.ref,
      path: one.position.path,
      line: one.position.line,
    })),
    ...report.stale_suppressions.map((one) => ({
      code: one.code,
      ref: "",
      path: one.position.path,
      line: one.position.line,
    })),
  ];
  return reported
    .filter((one) =>
      one.code === UNMATCHED_ROOT
        ? !entries.has(one.ref)
        : !expected.has(siteOf(one.path, one.line)),
    )
    .map((one) => ({ file: `${TARGET}/${one.path}`, line: one.line, report: one.code }))
    .sort((a, b) => compare(a.file, b.file) || a.line - b.line || compare(a.report, b.report));
}

/**
 * The second phase: every finding the first analysis reported at a row's position that a
 * record can bind to is written into the rendering's ignore file, the rendering is
 * analyzed again, and each such row records whether its position fell silent and whether
 * its entry was reported stale. It returns the bytes it gave the ignore file, the one file
 * of the rendering the run writes.
 */
function suppressionPhase(
  at: CorpusRun,
  file: ExpectationFile,
  sites: ReadonlyMap<string, string>,
  first: Answered,
  rows: ExpectationResult[],
  shapes: ReadonlySet<string>,
): string | undefined {
  const covered = new Map<string, IgnoreEntry>();
  for (const row of file.expect) {
    if (row.report === NONE || row.report === STALE_SUPPRESSION) {
      continue;
    }
    const found = findingsAt(first.report.findings, sites.get(row.symbol))[0];
    if (found === undefined || shapes.has(found.symbol.kind)) {
      continue;
    }
    covered.set(row.symbol, {
      code: found.code,
      symbol: found.symbol.ref,
      path: found.position.path,
      reason: "Written by the conformance run to check that the finding it names is suppressed.",
    });
  }
  if (covered.size === 0) {
    return undefined;
  }

  const path = join(at.rendering, TARGET, IGNORE_FILE);
  const own = existsSync(path)
    ? (readJson(path) as { description?: string; ignore: IgnoreEntry[] })
    : {
        description: "The adjudications the conformance run writes for its suppression phase.",
        ignore: [],
      };
  const body = `${JSON.stringify({ ...own, ignore: [...own.ignore, ...covered.values()] }, null, 2)}\n`;
  writeFileSync(path, body);

  const second = analyzeRendering(at, "second");
  for (const row of rows) {
    const entry = covered.get(row.symbol);
    if (entry === undefined) {
      continue;
    }
    row.suppression = {
      suppressed: findingsAt(second.report.findings, sites.get(row.symbol)).every(
        (one) => one.code !== entry.code,
      ),
      stale: second.report.stale_suppressions.some(
        (one) => one.entry.code === entry.code && one.entry.symbol === entry.symbol,
      ),
    };
  }
  return createHash("sha256").update(body).digest("hex");
}

/** The capabilities one row exercises: its code, else the classes it names. */
function exercised(row: Row): readonly string[] {
  return row.report === NONE ? (row.retained_by ?? []) : [row.report];
}

/** The capability a declared gap covers for one row of one fixture, or undefined. */
function coveringGap(
  gaps: readonly DeclaredGap[],
  fixtureName: string,
  row: Row,
): string | undefined {
  return gaps.find(
    (gap) =>
      gap.fixture === fixtureName &&
      (gap.symbol === undefined || gap.symbol === row.symbol) &&
      exercised(row).includes(gap.capability),
  )?.capability;
}

/** The message of a gap row whose expectation the analyzer answers as written. */
export const STALE_GAP =
  "the analyzer answers this expectation as written, and a declared gap covers it";

/**
 * One row's outcome, its members in the order the results schema lists them: a gap
 * wherever a declared gap covers a capability the row exercises, whatever the analyzer
 * answered; otherwise a pass when the answer matches and the suppression phase held, and a
 * fail when either does not.
 */
function decide(
  row: Row,
  held: ExpectationResult,
  gaps: readonly DeclaredGap[],
  name: string,
): ExpectationResult {
  let message = held.message;
  if (message === undefined && held.suppression !== undefined) {
    const { suppressed, stale } = held.suppression;
    if (!suppressed || stale) {
      message = `the report phase agrees and the suppression phase does not: suppressed is ${String(suppressed)} and stale is ${String(stale)}`;
    }
  }
  const capability = coveringGap(gaps, name, row);
  let result: Outcome = message === undefined ? "pass" : "fail";
  if (capability !== undefined) {
    result = "gap";
    message ??= STALE_GAP;
  }
  return {
    symbol: held.symbol,
    result,
    ...(capability === undefined ? {} : { capability }),
    actual: held.actual,
    ...(held.suppression === undefined ? {} : { suppression: held.suppression }),
    ...(message === undefined ? {} : { message }),
  };
}

function failedFixture(name: string, message: string): FixtureResult {
  return { fixture: name, result: "fail", expectations: [], unexpected: [], message };
}

/** Runs one fixture's two phases and returns the row the results document carries for it. */
function answerFixture(
  name: string,
  gaps: readonly DeclaredGap[],
  shapes: ReadonlySet<string>,
): FixtureResult {
  const dir = mkdtempSync(join(tmpdir(), "deadset-ts-corpus-"));
  try {
    const file = expectationOf(name);
    const manifest = readJson(fixture("corpus", name, "ts", "fixture.json")) as Manifest;
    const rows = [...file.expect].sort((a, b) => compare(a.symbol, b.symbol));
    const sites = sitesOf(file, manifest);
    const rendering = join(dir, "rendering");
    cpSync(fixture("corpus", name, "ts"), rendering, { recursive: true });
    const before = filesUnder(rendering);
    const at: CorpusRun = {
      dir,
      rendering,
      config: configOf(file),
      scope: scopeOf(file, rendering),
    };
    writeFileSync(join(dir, "deadset.json"), at.config);
    if (at.scope !== undefined) {
      writeFileSync(join(dir, "scope.json"), at.scope);
    }

    const first = analyzeRendering(at, "first");
    const entries = new Set(Object.values(file.configured_roots ?? {}));
    const answers = rows.map((row) => {
      const { actual, message } = answerOf(
        row,
        sites.get(row.symbol),
        file.configured_roots?.[row.symbol],
        first,
      );
      const held: ExpectationResult = {
        symbol: row.symbol,
        result: "fail",
        actual,
        ...(message === "" ? {} : { message }),
      };
      return { row, held };
    });
    const written = suppressionPhase(
      at,
      file,
      sites,
      first,
      answers.map((one) => one.held),
      shapes,
    );
    if (written !== undefined) {
      before.set(`${TARGET}/${IGNORE_FILE}`, written);
    }
    const after = filesUnder(rendering);
    if (JSON.stringify([...after].sort()) !== JSON.stringify([...before].sort())) {
      throw new FixtureError("the analyses changed a file of the rendering");
    }

    const decided = answers.map(({ row, held }) => decide(row, held, gaps, name));
    const unexpected = unexpectedOf(first.report, sites, entries);
    const outcomes = decided.map((one) => one.result);
    let result: Outcome = "pass";
    if (unexpected.length > 0 || outcomes.includes("fail")) {
      result = "fail";
    } else if (outcomes.includes("gap")) {
      result = "gap";
    }
    return { fixture: name, result, expectations: decided, unexpected };
  } catch (error: unknown) {
    if (!(error instanceof FixtureError)) {
      throw error;
    }
    return failedFixture(name, error.message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The run over every fixture, recorded as the results document the Contract's schema shapes. */
export function runCorpus(): Results {
  const { version, rows } = corpus();
  const gaps = committedGaps();
  const fixtures = corpusFixtures().map((name) => answerFixture(name, gaps, rows));
  const count = (outcome: Outcome): number =>
    fixtures.filter((one) => one.result === outcome).length;
  return {
    corpus_version: version,
    product: { name: ANALYZER_NAME, version: nodeHost().analyzerVersion(), language: LANGUAGE },
    result: count("fail") > 0 ? "fail" : "pass",
    totals: {
      fixtures: fixtures.length,
      pass: count("pass"),
      gap: count("gap"),
      fail: count("fail"),
    },
    fixtures,
  };
}
