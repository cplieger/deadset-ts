import { fails } from "../config.ts";
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

function command(
  level: "error" | "warning",
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
 * One workflow annotation per finding, then one per stale suppression, each naming its
 * file, line, column and last line, titled by its code and kind, then one warning per
 * type-error skip naming its file and line. A finding at or above the failing severity is
 * an error and one below it a warning; a stale suppression is an error, because its kind
 * is fixed on at the failing severity.
 */
export function annotations(report: Report, options: RenderOptions): Iterable<string> {
  return coalesced(
    (function* lines(): Generator<string, void, undefined> {
      for (const found of report.findings) {
        yield `${command(
          fails(found.severity, options.failOn) ? "error" : "warning",
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
    })(),
  );
}
