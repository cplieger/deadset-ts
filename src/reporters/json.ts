import type { Report } from "../report.ts";

/** The indentation of the report document, which with the schema's member order fixes its bytes. */
const INDENT = 2;

/** The report document itself: the report, indented, with a closing newline. */
export const json = (report: Report): string => `${JSON.stringify(report, null, INDENT)}\n`;
