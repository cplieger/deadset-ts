import {
  ConfigError,
  defaultConfig,
  type BuildConfiguration,
  type Cascade,
  type Config,
  type Confidence,
  type ConsumerTests,
  type Format,
  type GeneratedFiles,
  type Inputs,
  type Language,
  type Origin,
  type Provenance,
  type Severity,
  type Sort,
  type Source,
  type TargetKind,
  type TemplateDelimiters,
} from "./config.ts";
import { FIXED_SEVERITY_CODES } from "./kinds.ts";
import {
  checkDocument,
  malformed,
  nestFlags,
  SCHEMA_ROOT,
  SEVERITY_SECTION,
  type KeyNode,
} from "./schema.ts";

/** Names the command-line flags in a refusal, where a document is named by its path. */
const FLAGS_LABEL = "the command-line flags";

/** The length of a severity key naming a whole family: the prefix and two digits. */
const FAMILY_KEY_LENGTH = 4;

const SEVERITY_KEY = /^DS[0-9]{2}([0-9]{2})?$/u;
const EXEMPTION_CLASS = /^[a-z][a-z0-9-]*$/u;
const CONTRACT_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/u;

const TARGET_KINDS: readonly TargetKind[] = ["application", "library"];
const CONFIDENCES: readonly Confidence[] = ["certain", "probable", "possible"];
const GENERATED_FILES: readonly GeneratedFiles[] = ["exclude", "include"];
const CONSUMER_TESTS: readonly ConsumerTests[] = ["test", "production"];
const LANGUAGES: readonly Language[] = ["go", "ts"];
const SEVERITIES: readonly Severity[] = ["allow", "warn", "deny"];
const FORMATS: readonly Format[] = ["text", "json", "github", "sarif", "template"];
const SORTS: readonly Sort[] = ["position", "size"];
const CASCADES: readonly Cascade[] = ["roots", "full"];

/**
 * One configuration document, read as the settings it supplies. Every member is
 * possibly undefined, so a key the document omits is distinguishable from one it
 * sets to a value equal to the default, which is what makes resolution per
 * setting rather than per document.
 */
interface Doc {
  readonly contractVersion: string | undefined;
  readonly targetKind: TargetKind | undefined;
  readonly languages: readonly Language[] | undefined;
  readonly minConfidence: Confidence | undefined;
  readonly generatedFiles: GeneratedFiles | undefined;
  readonly consumerTests: ConsumerTests | undefined;
  readonly configurations: readonly BuildConfiguration[] | undefined;
  readonly matrixComplete: boolean | undefined;
  readonly templateDirs: readonly string[] | undefined;
  readonly templateDelimiters: TemplateDelimiters | undefined;
  readonly consumersComplete: boolean | undefined;
  readonly rootPatterns: readonly string[] | undefined;
  readonly severity: ReadonlyMap<string, Severity> | undefined;
  readonly exemptionsDisabled: readonly string[] | undefined;
  readonly formats: readonly Format[] | undefined;
  readonly sort: Sort | undefined;
  readonly cascade: Cascade | undefined;
  readonly maxFindings: number | undefined;
  readonly failOn: Severity | undefined;
  readonly testFiles: readonly string[] | undefined;
  readonly entryFiles: readonly string[] | undefined;
}

/** One document the resolution reads, with the origin its settings carry. */
interface DocSource {
  readonly doc: Doc;
  readonly kind: Source;
  readonly label: string;
  readonly flagLabels: ReadonlyMap<string, string>;
}

/**
 * The origin one setting of this source carries. A flag names itself per setting,
 * because one invocation carries many.
 */
function originOf(source: DocSource, path: string): Origin {
  if (source.kind === "flag") {
    return { source: "flag", label: source.flagLabels.get(path) ?? "" };
  }
  return { source: source.kind, label: source.label };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function member(parent: Record<string, unknown> | undefined, name: string): unknown {
  if (parent === undefined || !Object.hasOwn(parent, name)) {
    return undefined;
  }
  return parent[name];
}

function section(
  parent: Record<string, unknown> | undefined,
  name: string,
  path: string,
  label: string,
): Record<string, unknown> | undefined {
  const value = member(parent, name);
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw malformed(label, path, "is not an object");
  }
  return value;
}

function spell(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

function readEnum<T extends string>(
  parent: Record<string, unknown> | undefined,
  name: string,
  path: string,
  label: string,
  allowed: readonly T[],
): T | undefined {
  const value = member(parent, name);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw malformed(label, path, "is not a string");
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw malformed(label, path, `${JSON.stringify(value)} is not one of ${spell(allowed)}`);
  }
  return value as T;
}

function readString(
  parent: Record<string, unknown> | undefined,
  name: string,
  path: string,
  label: string,
): string | undefined {
  const value = member(parent, name);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw malformed(label, path, "is not a string");
  }
  return value;
}

function readBoolean(
  parent: Record<string, unknown> | undefined,
  name: string,
  path: string,
  label: string,
): boolean | undefined {
  const value = member(parent, name);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw malformed(label, path, "is not a boolean");
  }
  return value;
}

function readCount(
  parent: Record<string, unknown> | undefined,
  name: string,
  path: string,
  label: string,
): number | undefined {
  const value = member(parent, name);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw malformed(label, path, "is not an integer");
  }
  if (value < 0) {
    throw malformed(label, path, `${String(value)} is below the minimum of 0`);
  }
  return value;
}

/**
 * One array of strings, refusing an array shorter than its minimum, one holding an
 * empty entry, one naming an entry twice, and, where a closed set is given, one
 * holding an entry outside it.
 */
function readStrings<T extends string>(
  parent: Record<string, unknown> | undefined,
  name: string,
  path: string,
  label: string,
  minItems: number,
  allowed?: readonly T[],
): readonly T[] | undefined {
  const value = member(parent, name);
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw malformed(label, path, "is not an array");
  }
  if (value.length < minItems) {
    throw malformed(
      label,
      path,
      `holds ${String(value.length)} entries, want at least ${String(minItems)}`,
    );
  }
  const seen = new Set<string>();
  for (const entry of value as unknown[]) {
    if (typeof entry !== "string") {
      throw malformed(label, path, "holds an entry that is not a string");
    }
    if (entry === "") {
      throw malformed(label, path, "holds an empty entry");
    }
    if (seen.has(entry)) {
      throw malformed(label, path, `names ${JSON.stringify(entry)} twice`);
    }
    if (allowed !== undefined && !(allowed as readonly string[]).includes(entry)) {
      throw malformed(label, path, `${JSON.stringify(entry)} is not one of ${spell(allowed)}`);
    }
    seen.add(entry);
  }
  return value as readonly T[];
}

function requireMember(value: string | undefined, path: string, label: string): string {
  if (value === undefined || value === "") {
    throw malformed(label, path, "is required and names nothing");
  }
  return value;
}

/**
 * The build matrix: every entry names an identifier, an operating system and an
 * architecture.
 */
function readConfigurations(
  analysis: Record<string, unknown> | undefined,
  label: string,
): readonly BuildConfiguration[] | undefined {
  const value = member(analysis, "configurations");
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw malformed(label, "analysis.configurations", "is not an array");
  }
  return (value as unknown[]).map((entry, index) => {
    const at = `analysis.configurations[${String(index)}]`;
    if (!isRecord(entry)) {
      throw malformed(label, at, "is not an object");
    }
    return {
      id: requireMember(readString(entry, "id", `${at}.id`, label), `${at}.id`, label),
      os: requireMember(readString(entry, "os", `${at}.os`, label), `${at}.os`, label),
      arch: requireMember(readString(entry, "arch", `${at}.arch`, label), `${at}.arch`, label),
      tags: readStrings(entry, "tags", `${at}.tags`, label, 0) ?? [],
    };
  });
}

/**
 * The action delimiter pair: once a document names the object both members are
 * required, because a pair carrying one member names no delimiters at all, so the
 * refusal names the member the document left out rather than pairing the one it
 * named with a default.
 */
function readDelimiters(
  analysis: Record<string, unknown> | undefined,
  label: string,
): TemplateDelimiters | undefined {
  const at = "analysis.template_delimiters";
  const pair = section(analysis, "template_delimiters", at, label);
  if (pair === undefined) {
    return undefined;
  }
  return {
    left: requireMember(readString(pair, "left", `${at}.left`, label), `${at}.left`, label),
    right: requireMember(readString(pair, "right", `${at}.right`, label), `${at}.right`, label),
  };
}

/**
 * A severity key that names no setting, because the Contract fixes the severity of
 * the kind or kinds it names.
 */
function unimplementedSeverityKey(label: string, path: string, reason: string): ConfigError {
  return new ConfigError(
    "unimplemented-key",
    path,
    `${label}: key ${JSON.stringify(path)} is not implemented: ${reason}`,
  );
}

/**
 * Every code whose severity the Contract fixes that one severity key names, in
 * ascending code order: the code itself, or every code of the family its
 * two-digit prefix names. A family key covers every such code, so a refusal names
 * them all rather than the first one found.
 */
function fixedByContract(code: string): string[] {
  return FIXED_SEVERITY_CODES.filter(
    (candidate) =>
      code === candidate || (code.length === FAMILY_KEY_LENGTH && candidate.startsWith(code)),
  ).sort();
}

/** The codes a refusal names: one on its own, and several with the last joined by and. */
function spellCodes(codes: readonly string[]): string {
  if (codes.length < 2) {
    return codes.join("");
  }
  return `${codes.slice(0, -1).join(", ")} and ${String(codes[codes.length - 1])}`;
}

/**
 * The severity object, one code at a time.
 *
 * A key is one issue-kind code or one two-digit family prefix, and a key naming a
 * kind whose severity the Contract fixes, or a family prefix whose range holds
 * one, is an unimplemented key rather than a setting.
 *
 * Whether a key names a kind this analyzer reports is not decided here. This
 * analyzer reports no issue kind, so the question has one answer for every key
 * and asking it would refuse the whole object.
 */
function readSeverity(
  document: Record<string, unknown> | undefined,
  label: string,
): ReadonlyMap<string, Severity> | undefined {
  const object = section(document, SEVERITY_SECTION, SEVERITY_SECTION, label);
  if (object === undefined) {
    return undefined;
  }
  const severity = new Map<string, Severity>();
  for (const code of Object.keys(object).sort()) {
    const path = `${SEVERITY_SECTION}.${code}`;
    if (!SEVERITY_KEY.test(code)) {
      throw unimplementedSeverityKey(
        label,
        path,
        "a severity key is one issue-kind code or one two-digit family prefix",
      );
    }
    const fixed = fixedByContract(code);
    if (fixed.length > 0) {
      throw unimplementedSeverityKey(
        label,
        path,
        `the Contract fixes the severity of ${spellCodes(fixed)}, which this key names`,
      );
    }
    const value = readEnum(object, code, path, label, SEVERITIES);
    if (value !== undefined) {
      severity.set(code, value);
    }
  }
  return severity;
}

/** The exemption classes named for switching off. */
function readExemptions(
  document: Record<string, unknown> | undefined,
  label: string,
): readonly string[] | undefined {
  const exemptions = section(document, "exemptions", "exemptions", label);
  const disabled = readStrings(exemptions, "disabled", "exemptions.disabled", label, 0);
  if (disabled === undefined) {
    return undefined;
  }
  for (const entry of disabled) {
    if (!EXEMPTION_CLASS.test(entry)) {
      throw malformed(
        label,
        "exemptions.disabled",
        `${JSON.stringify(entry)} is not an exemption class name`,
      );
    }
  }
  return disabled;
}

/**
 * Reads one already-parsed configuration document as the settings it supplies,
 * refusing every constraint the closed key list declares that a parse cannot
 * express: a value of the wrong type, a value outside a closed set, an array that
 * repeats an entry or holds too few, and a count below its minimum.
 */
function readDoc(value: unknown, label: string): Doc {
  if (!isRecord(value)) {
    throw malformed(label, "", "is not one JSON object");
  }
  const analysis = section(value, "analysis", "analysis", label);
  const matrix = section(analysis, "matrix", "analysis.matrix", label);
  const target = section(value, "target", "target", label);
  const consumers = section(value, "consumers", "consumers", label);
  const roots = section(value, "roots", "roots", label);
  const reporters = section(value, "reporters", "reporters", label);
  const ts = section(value, "ts", "ts", label);
  section(value, "go", "go", label);
  section(value, "provenance", "provenance", label);

  const contractVersion = readString(value, "contract_version", "contract_version", label);
  if (contractVersion !== undefined && !CONTRACT_VERSION_PATTERN.test(contractVersion)) {
    throw malformed(
      label,
      "contract_version",
      `${JSON.stringify(contractVersion)} is not a semantic version`,
    );
  }

  return {
    contractVersion,
    targetKind: readEnum(target, "kind", "target.kind", label, TARGET_KINDS),
    languages: readStrings(analysis, "languages", "analysis.languages", label, 0, LANGUAGES),
    minConfidence: readEnum(
      analysis,
      "min_confidence",
      "analysis.min_confidence",
      label,
      CONFIDENCES,
    ),
    generatedFiles: readEnum(
      analysis,
      "generated_files",
      "analysis.generated_files",
      label,
      GENERATED_FILES,
    ),
    consumerTests: readEnum(
      analysis,
      "consumer_tests",
      "analysis.consumer_tests",
      label,
      CONSUMER_TESTS,
    ),
    configurations: readConfigurations(analysis, label),
    matrixComplete: readBoolean(matrix, "complete", "analysis.matrix.complete", label),
    templateDirs: readStrings(analysis, "template_dirs", "analysis.template_dirs", label, 0),
    templateDelimiters: readDelimiters(analysis, label),
    consumersComplete: readBoolean(consumers, "complete", "consumers.complete", label),
    rootPatterns: readStrings(roots, "patterns", "roots.patterns", label, 0),
    severity: readSeverity(value, label),
    exemptionsDisabled: readExemptions(value, label),
    formats: readStrings(reporters, "formats", "reporters.formats", label, 1, FORMATS),
    sort: readEnum(reporters, "sort", "reporters.sort", label, SORTS),
    cascade: readEnum(reporters, "cascade", "reporters.cascade", label, CASCADES),
    maxFindings: readCount(reporters, "max_findings", "reporters.max_findings", label),
    failOn: readEnum(reporters, "fail_on", "reporters.fail_on", label, SEVERITIES),
    testFiles: readStrings(ts, "test_files", "ts.test_files", label, 1),
    entryFiles: readStrings(ts, "entry_files", "ts.entry_files", label, 0),
  };
}

/** Parses one document's text and walks it against the closed key list. */
function parseDocument(text: string, node: KeyNode, label: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error: unknown) {
    throw malformed(label, "", error instanceof Error ? error.message : String(error));
  }
  checkDocument(text, node, label);
  return value;
}

/** Names a document in a refusal: the path the invocation passed, or what it is. */
function labelOr(label: string | undefined, named: string): string {
  return label === undefined || label === "" ? named : label;
}

/**
 * Decodes the documents one invocation supplies, in the order they outrank each
 * other, skipping every source it does not carry.
 */
function readSources(inputs: Inputs): DocSource[] {
  const sources: DocSource[] = [];
  const flagLabels = inputs.flagLabels ?? new Map<string, string>();
  if (inputs.flags !== undefined) {
    const flat = parseDocument(inputs.flags, { kind: "map" }, FLAGS_LABEL);
    if (!isRecord(flat)) {
      throw malformed(FLAGS_LABEL, "", "is not one JSON object");
    }
    sources.push({
      doc: readDoc(nestFlags(flat, FLAGS_LABEL), FLAGS_LABEL),
      kind: "flag",
      label: "",
      flagLabels,
    });
  }
  const held: readonly { kind: Source; named: string; text?: string; label?: string }[] = [
    {
      kind: "repository",
      named: "the repository configuration",
      ...(inputs.repository === undefined ? {} : { text: inputs.repository }),
      ...(inputs.repositoryLabel === undefined ? {} : { label: inputs.repositoryLabel }),
    },
    {
      kind: "central",
      named: "the central configuration",
      ...(inputs.central === undefined ? {} : { text: inputs.central }),
      ...(inputs.centralLabel === undefined ? {} : { label: inputs.centralLabel }),
    },
  ];
  for (const entry of held) {
    if (entry.text === undefined) {
      continue;
    }
    const label = labelOr(entry.label, entry.named);
    sources.push({
      doc: readDoc(parseDocument(entry.text, SCHEMA_ROOT, label), label),
      kind: entry.kind,
      label: entry.label ?? "",
      flagLabels,
    });
  }
  return sources;
}

/**
 * The value the highest-ranked source carrying one supplies, with where it came
 * from recorded, or the default.
 */
function settle<T>(
  fallback: T,
  path: string,
  provenance: Map<string, Origin>,
  sources: readonly DocSource[],
  read: (doc: Doc) => T | undefined,
): T {
  for (const source of sources) {
    const value = read(source.doc);
    if (value !== undefined) {
      provenance.set(path, originOf(source, path));
      return value;
    }
  }
  provenance.set(path, { source: "default", label: "" });
  return fallback;
}

/**
 * The severity object, resolved one code at a time so a code only the central
 * configuration names keeps its central value. An object that resolves empty
 * carries one entry for the object itself.
 */
function settleSeverity(
  provenance: Map<string, Origin>,
  sources: readonly DocSource[],
): ReadonlyMap<string, Severity> {
  const codes = new Set<string>();
  for (const source of sources) {
    for (const code of source.doc.severity?.keys() ?? []) {
      codes.add(code);
    }
  }
  const severity = new Map<string, Severity>();
  for (const code of [...codes].sort()) {
    const path = `${SEVERITY_SECTION}.${code}`;
    for (const source of sources) {
      const value = source.doc.severity?.get(code);
      if (value === undefined) {
        continue;
      }
      severity.set(code, value);
      provenance.set(path, originOf(source, path));
      break;
    }
  }
  if (codes.size > 0) {
    return severity;
  }
  provenance.set(SEVERITY_SECTION, { source: "default", label: "" });
  for (const source of sources) {
    if (source.doc.severity !== undefined) {
      provenance.set(SEVERITY_SECTION, originOf(source, SEVERITY_SECTION));
      break;
    }
  }
  return severity;
}

/** Names one configuration source and whether the invocation carried it. */
function describeSource(
  named: string,
  text: string | undefined,
  label: string | undefined,
): string {
  if (text === undefined) {
    return `${named} (not present)`;
  }
  return `${named} (${labelOr(label, "unnamed")})`;
}

/**
 * Refuses a provenance entry whose source names no file or flag, which would
 * print a provenance value the closed key list refuses to read back.
 */
function checkLabels(provenance: ReadonlyMap<string, Origin>): void {
  for (const path of [...provenance.keys()].sort()) {
    const origin = provenance.get(path);
    if (origin !== undefined && origin.source !== "default" && origin.label === "") {
      throw malformed(
        origin.source === "flag" ? FLAGS_LABEL : origin.source,
        path,
        `came from ${origin.source}, which names no file or flag`,
      );
    }
  }
}

/**
 * Applies a command-line flag over the repository configuration over the central
 * configuration over the default each key declares, and returns the resolved
 * configuration with the origin of every setting.
 *
 * It throws a {@link ConfigError} for a document that names a key the closed key
 * list does not declare, a document that names one key twice, and a resolved
 * configuration no source supplied a target kind for. Every one of them maps to
 * the usage exit code.
 */
export function resolve(inputs: Inputs): { config: Config; provenance: Provenance } {
  const sources = readSources(inputs);
  const defaults = defaultConfig();
  const provenance = new Map<string, Origin>();
  const at = <T>(path: string, fallback: T, read: (doc: Doc) => T | undefined): T =>
    settle(fallback, path, provenance, sources, read);

  const config: Config = {
    contractVersion: at("contract_version", defaults.contractVersion, (doc) => doc.contractVersion),
    targetKind: at<TargetKind | "">("target.kind", "", (doc) => doc.targetKind),
    analysis: {
      languages: at("analysis.languages", defaults.analysis.languages, (doc) => doc.languages),
      minConfidence: at(
        "analysis.min_confidence",
        defaults.analysis.minConfidence,
        (doc) => doc.minConfidence,
      ),
      generatedFiles: at(
        "analysis.generated_files",
        defaults.analysis.generatedFiles,
        (doc) => doc.generatedFiles,
      ),
      consumerTests: at(
        "analysis.consumer_tests",
        defaults.analysis.consumerTests,
        (doc) => doc.consumerTests,
      ),
      configurations: at(
        "analysis.configurations",
        defaults.analysis.configurations,
        (doc) => doc.configurations,
      ),
      matrixComplete: at(
        "analysis.matrix.complete",
        defaults.analysis.matrixComplete,
        (doc) => doc.matrixComplete,
      ),
      templateDirs: at(
        "analysis.template_dirs",
        defaults.analysis.templateDirs,
        (doc) => doc.templateDirs,
      ),
      templateDelimiters: at(
        "analysis.template_delimiters",
        defaults.analysis.templateDelimiters,
        (doc) => doc.templateDelimiters,
      ),
    },
    consumersComplete: at(
      "consumers.complete",
      defaults.consumersComplete,
      (doc) => doc.consumersComplete,
    ),
    rootPatterns: at("roots.patterns", defaults.rootPatterns, (doc) => doc.rootPatterns),
    severity: settleSeverity(provenance, sources),
    exemptionsDisabled: at(
      "exemptions.disabled",
      defaults.exemptionsDisabled,
      (doc) => doc.exemptionsDisabled,
    ),
    reporters: {
      formats: at("reporters.formats", defaults.reporters.formats, (doc) => doc.formats),
      sort: at("reporters.sort", defaults.reporters.sort, (doc) => doc.sort),
      cascade: at("reporters.cascade", defaults.reporters.cascade, (doc) => doc.cascade),
      maxFindings: at(
        "reporters.max_findings",
        defaults.reporters.maxFindings,
        (doc) => doc.maxFindings,
      ),
      failOn: at("reporters.fail_on", defaults.reporters.failOn, (doc) => doc.failOn),
    },
    ts: {
      testFiles: at("ts.test_files", defaults.ts.testFiles, (doc) => doc.testFiles),
      entryFiles: at("ts.entry_files", defaults.ts.entryFiles, (doc) => doc.entryFiles),
    },
  };

  if (config.targetKind === "") {
    throw new ConfigError(
      "missing-target-kind",
      "target.kind",
      "target.kind is not set, it has no default and is never inferred: searched " +
        `${describeSource("the repository configuration", inputs.repository, inputs.repositoryLabel)} and ` +
        describeSource("the central configuration", inputs.central, inputs.centralLabel),
    );
  }
  checkLabels(provenance);
  return { config, provenance };
}
