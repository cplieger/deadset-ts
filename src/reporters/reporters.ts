import type { Format } from "../config.ts";
import { json } from "./json.ts";
import type { Rendering, Renderings } from "./reporter.ts";
import { text } from "./text.ts";

/**
 * Every format this analyzer renders, each by its reporter and its file suffix. A format
 * absent from the table is refused rather than silently not written.
 */
export const RENDERINGS: Renderings = new Map<Format, Rendering>([
  ["text", { render: text, suffix: ".txt" }],
  ["json", { render: json, suffix: ".json" }],
]);
