import type { Confidence, Severity } from "../config.ts";
import { KINDS } from "../kinds.ts";
import type { Report, WireFinding, WireStaleSuppression } from "../report.ts";
import { lineHashes, symbolFingerprint } from "./fingerprint.ts";
import { RenderError, type RenderOptions } from "./reporter.ts";
import { RULE_TEXTS } from "./rules.ts";
import { utf8Bytes } from "./sha256.ts";

const SCHEMA =
  "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json";
const VERSION = "2.1.0";
/** The unit a finding's column counts. */
const COLUMN_KIND = "utf16CodeUnits";
const URI_BASE_ID = "%SRCROOT%";
const ROOT_DESCRIPTION = "The target root, the directory the analyzer was run on.";

/** The most related locations one result carries; the report stays complete beyond them. */
const MAX_RELATED = 100;

const INDENT = 2;

const LEVEL: Readonly<Record<Severity, string>> = { deny: "error", warn: "warning", allow: "note" };
const PROBLEM: Readonly<Record<Severity, string>> = {
  deny: "error",
  warn: "warning",
  allow: "recommendation",
};
const PRECISION: Readonly<Record<Confidence, string>> = {
  certain: "very-high",
  probable: "high",
  possible: "medium",
};

/** The text up to and including the first full stop a space follows or that ends the text. */
function firstSentence(text: string): string {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "." && (i + 1 === text.length || text[i + 1] === " ")) {
      return text.slice(0, i + 1);
    }
  }
  return text;
}

/**
 * One rule per live kind of this analyzer's language, in code order, whether or not a result
 * names it, so a rule's index is the same in every run and under every configuration.
 */
function rules(): readonly Record<string, unknown>[] {
  return [...RULE_TEXTS].map(([code, text]) => {
    const kind = KINDS.get(code);
    if (kind === undefined) {
      throw new RenderError(`the rule ${code} names no live kind`);
    }
    return {
      id: code,
      name: kind.name,
      shortDescription: { text: firstSentence(text.rule) },
      fullDescription: { text: text.rule },
      help: {
        text: text.precondition === undefined ? text.rule : `${text.rule}\n\n${text.precondition}`,
      },
      defaultConfiguration: { level: LEVEL[kind.defaultSeverity] },
      properties: {
        precision: PRECISION[kind.maxClass],
        problem: { severity: PROBLEM[kind.defaultSeverity] },
      },
    };
  });
}

/** The characters a path segment keeps unencoded beside letters and digits. */
const SEGMENT_KEPT = "-_.~$&+:=@";

function isAlphanumeric(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a)
  );
}

/** One path segment percent-encoded as RFC 3986 requires of a path segment. */
function encodeSegment(segment: string): string {
  return utf8Bytes(segment)
    .map((byte) =>
      isAlphanumeric(byte) || SEGMENT_KEPT.includes(String.fromCharCode(byte))
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
    )
    .join("");
}

/**
 * A target-relative path as a relative reference: each segment encoded, and a colon in the
 * first segment encoded as well, where it would otherwise read as a scheme.
 */
function relativeReference(path: string): string {
  const segments = path.split("/").map(encodeSegment);
  segments[0] = (segments[0] ?? "").replaceAll(":", "%3A");
  return segments.join("/");
}

interface Located {
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

function physicalLocation(at: Located, endLine: number): Record<string, unknown> {
  return {
    artifactLocation: { uri: relativeReference(at.path), uriBaseId: URI_BASE_ID },
    region: { startLine: at.line, startColumn: at.column, endLine },
  };
}

/** The line fingerprints of the files one rendering reads, each file read and hashed once. */
function lineHashCache(read: (path: string) => string): (at: Located) => string {
  const held = new Map<string, readonly string[]>();
  return (at) => {
    let hashes = held.get(at.path);
    if (hashes === undefined) {
      let text: string;
      try {
        text = read(at.path);
      } catch (error: unknown) {
        throw new RenderError(
          `read ${at.path} for its line fingerprint: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      hashes = lineHashes(text);
      held.set(at.path, hashes);
    }
    const hash = hashes[at.line - 1];
    if (hash === undefined || at.line < 1) {
      throw new RenderError(
        `${at.path} holds ${String(hashes.length)} lines and a record names line ${String(at.line)}`,
      );
    }
    return hash;
  };
}

interface Related {
  readonly label: string;
  readonly at: Located;
  readonly endLine: number;
}

/** Every position a finding names beyond its own, in the mapping's order, the first hundred. */
function relatedOf(found: WireFinding): readonly Related[] {
  const related: Related[] = [];
  for (const one of found.details.implementations ?? []) {
    related.push({ label: "implementation", at: one.position, endLine: one.position.end_line });
  }
  for (const at of found.details.write_positions ?? []) {
    related.push({ label: "write", at, endLine: at.end_line });
  }
  return related.slice(0, MAX_RELATED);
}

/** The finding's message, then a link to each related location, since only a linked one shows. */
function messageWithLinks(message: string, related: readonly Related[]): string {
  if (related.length === 0) {
    return message;
  }
  const links = related.map(
    (one, i) =>
      `[${one.label} ${one.at.path}:${String(one.at.line)}:${String(one.at.column)}](${String(i + 1)})`,
  );
  return `${message} (see ${links.join(", ")})`;
}

/** Every member of the finding the mapping places nowhere else, under its schema name. */
function propertiesOf(found: WireFinding): Record<string, unknown> {
  return {
    language: found.language,
    symbol: found.symbol,
    reachability_class: found.reachability_class,
    confidence: found.confidence,
    ...(found.liveness_relation === undefined
      ? {}
      : { liveness_relation: found.liveness_relation }),
    test_only: found.test_only,
    generated: found.generated,
    component: found.component,
    retained_by: found.retained_by,
    configurations: found.configurations,
    consumers_loaded: found.consumers_loaded,
    fixability: found.fixability,
    details: found.details,
  };
}

function ruleIndex(index: ReadonlyMap<string, number>, code: string): number {
  const at = index.get(code);
  if (at === undefined) {
    throw new RenderError(`the run has no rule ${code}, which one of its records names`);
  }
  return at;
}

function findingResult(
  found: WireFinding,
  index: ReadonlyMap<string, number>,
  hashOf: (at: Located) => string,
): Record<string, unknown> {
  const related = relatedOf(found);
  return {
    ruleId: found.code,
    ruleIndex: ruleIndex(index, found.code),
    level: LEVEL[found.severity],
    message: { text: messageWithLinks(found.message, related) },
    locations: [{ physicalLocation: physicalLocation(found.position, found.position.end_line) }],
    ...(related.length === 0
      ? {}
      : {
          relatedLocations: related.map((one, i) => ({
            id: i + 1,
            physicalLocation: physicalLocation(one.at, one.endLine),
            message: { text: one.label },
          })),
        }),
    partialFingerprints: {
      primaryLocationLineHash: hashOf(found.position),
      "deadsetSymbolRef/v1": symbolFingerprint(found.code, found.symbol.ref),
    },
    properties: propertiesOf(found),
  };
}

/** A stale suppression at the failing level, at its own site; it is no finding, so it carries no member bag. */
function staleResult(
  stale: WireStaleSuppression,
  index: ReadonlyMap<string, number>,
  hashOf: (at: Located) => string,
): Record<string, unknown> {
  return {
    ruleId: stale.code,
    ruleIndex: ruleIndex(index, stale.code),
    level: LEVEL.deny,
    message: { text: stale.message },
    locations: [{ physicalLocation: physicalLocation(stale.position, stale.position.line) }],
    partialFingerprints: {
      primaryLocationLineHash: hashOf(stale.position),
      "deadsetSymbolRef/v1": symbolFingerprint(stale.code, stale.symbol),
    },
  };
}

/**
 * The report as one SARIF 2.1.0 log of one run, mapped as the Contract states. A suppressed
 * finding has no record in the report and so no result, and the totals the run carries
 * count it. A file the rendering cannot read, or a line it does not hold, fails the
 * rendering, because a line fingerprint computed from other bytes opens a second alert.
 */
export function sarif(report: Report, options: RenderOptions): string {
  const ruleList = rules();
  const index = new Map([...RULE_TEXTS.keys()].map((code, at) => [code, at]));
  const hashOf = lineHashCache(options.readSource);
  const results = [
    ...report.findings.map((found) => findingResult(found, index, hashOf)),
    ...report.stale_suppressions.map((stale) => staleResult(stale, index, hashOf)),
  ];
  const languages = [...report.analyzer.languages].sort().join("+");
  const log = {
    $schema: SCHEMA,
    version: VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: report.analyzer.name,
            version: report.analyzer.version,
            semanticVersion: report.analyzer.version,
            rules: ruleList,
          },
        },
        automationDetails: { id: `deadset/${languages}/` },
        columnKind: COLUMN_KIND,
        originalUriBaseIds: { [URI_BASE_ID]: { description: { text: ROOT_DESCRIPTION } } },
        results,
        properties: { totals: report.totals },
      },
    ],
  };
  return `${JSON.stringify(log, null, INDENT)}\n`;
}
