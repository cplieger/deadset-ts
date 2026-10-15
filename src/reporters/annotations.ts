import type { Severity } from "../config.ts";
import { coalesced } from "../json-chunks.ts";
import { KINDS } from "../kinds.ts";
import type { Report } from "../report.ts";
import type { RenderOptions } from "./reporter.ts";

/** The escapes a workflow command's message needs, so a line break does not end the command. */
const DATA_ESCAPES: Readonly<Record<string, string>> = { "%": "%25", "\r": "%0D", "\n": "%0A" };

/** The escapes a property value needs: a message's, and the property list's two separators. */
const PROPERTY_ESCAPES: Readonly<Record<string, string>> = {
  ...DATA_ESCAPES,
  ":": "%3A",
  ",": "%2C",
};

function escapeData(value: string): string {
  return value.replace(/[%\r\n]/gu, (char) => DATA_ESCAPES[char] ?? char);
}

function escapeProperty(value: string): string {
  return value.replace(/[%\r\n:,]/gu, (char) => PROPERTY_ESCAPES[char] ?? char);
}

/** The name of the kind a code names, and the code itself where no live kind carries it. */
function kindName(code: string): string {
  return KINDS.get(code)?.name ?? code;
}

/** The workflow command a record is written as. */
type Level = "error" | "warning" | "notice";

/** The command each finding severity is annotated with, whatever the failing severity. */
const LEVELS: Readonly<Record<Severity, Level>> = {
  deny: "error",
  warn: "warning",
  allow: "notice",
};

function command(
  level: Level,
  at: { readonly path: string; readonly line: number; readonly column: number },
  endLine: number,
  title: string,
  message: string,
): string {
  return `::${level} file=${escapeProperty(at.path)},line=${String(at.line)},col=${String(at.column)},endLine=${String(endLine)},title=${escapeProperty(title)}::${escapeData(message)}`;
}

/** The title and the message prefix of a type-error skip's annotation. */
const SKIP_TITLE = "type error skipped";
const SKIP_MESSAGE =
  "the analysis did not evaluate the function or statement holding this type error: ";

/**
 * The annotations `contract/grammar/annotations.md` states: one per finding, at the
 * command its severity names, and one error per stale suppression, each naming its file,
 * line, column and last line and titled by its code and kind; then one warning per
 * type-error skip naming its file and line, and one per note naming its directory.
 */
export function annotations(report: Report, _options: RenderOptions): Iterable<string> {
  return coalesced(
    (function* lines(): Generator<string, void, undefined> {
      for (const found of report.findings) {
        yield `${command(
          LEVELS[found.severity],
          found.position,
          found.position.end_line,
          `${found.code} ${found.kind}`,
          found.message,
        )}\n`;
      }
      for (const stale of report.stale_suppressions) {
        yield `${command(
          "error",
          stale.position,
          stale.position.line,
          `${stale.code} ${kindName(stale.code)}`,
          stale.message,
        )}\n`;
      }
      for (const skip of report.type_error_skips) {
        yield `::warning file=${escapeProperty(skip.path)},line=${String(skip.line)},title=${escapeProperty(SKIP_TITLE)}::${escapeData(SKIP_MESSAGE + skip.message)}\n`;
      }
      for (const note of report.notes) {
        yield `::warning file=${escapeProperty(note.path)},title=${escapeProperty(note.kind)}::${escapeData(note.message)}\n`;
      }
    })(),
  );
}
