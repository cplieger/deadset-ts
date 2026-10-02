import type { Format } from "../config.ts";
import type { Report } from "../report.ts";

/** One rendering of a report, as the text of the file it is written to. */
export type Reporter = (report: Report) => string;

/**
 * One format this analyzer renders: its reporter, and the suffix appended to the report's
 * path to name the file the rendering is written to, so no rendering lands on the report or
 * on another rendering whatever extension the report's path carries.
 */
export interface Rendering {
  readonly render: Reporter;
  readonly suffix: string;
}

/** Every format this analyzer renders, each by its rendering. */
export type Renderings = ReadonlyMap<Format, Rendering>;
