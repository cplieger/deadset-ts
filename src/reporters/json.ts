import { jsonChunks } from "../json-chunks.ts";
import type { Report } from "../report.ts";

/** The indentation of the report document, which with the schema's member order fixes its bytes. */
const INDENT = 2;

/** The report document itself, in pieces: the report, indented, with a closing newline. */
export const json = (report: Report): Iterable<string> => jsonChunks(report, INDENT);
