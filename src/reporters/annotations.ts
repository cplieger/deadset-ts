import { fails } from "../config.ts";
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

/**
 * One workflow annotation per finding, then one per stale suppression, each naming its
 * file, line, column and last line, titled by its code and kind. A finding at or above the
 * failing severity is an error and one below it a warning; a stale suppression is an error,
 * because its kind is fixed on at the failing severity.
 */
export function annotations(report: Report, options: RenderOptions): string {
  const lines = report.findings.map((found) =>
    command(
      fails(found.severity, options.failOn) ? "error" : "warning",
      found.position,
      found.position.end_line,
      `${found.code} ${found.kind}`,
      found.message,
    ),
  );
  for (const stale of report.stale_suppressions) {
    lines.push(
      command(
        "error",
        stale.position,
        stale.position.line,
        `${stale.code} ${kindName(stale.code)}`,
        stale.message,
      ),
    );
  }
  return lines.map((line) => `${line}\n`).join("");
}
