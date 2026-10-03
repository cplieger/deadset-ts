import type { Format, Severity } from "../config.ts";
import type { Report } from "../report.ts";
import type { Template } from "./template.ts";

/** What a rendering reads beside the report. */
export interface RenderOptions {
  /** The lowest severity at which a finding fails the run. */
  readonly failOn: Severity;
  /** The text of the file at one path below the target root, or a throw naming why not. */
  readonly readSource: (path: string) => string;
  /** The template the template rendering renders, where one was named. */
  readonly template: Template | undefined;
}

/** One rendering of a report, as the pieces of the file it is written to, in order. */
type Reporter = (report: Report, options: RenderOptions) => Iterable<string>;

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

/** A rendering that cannot be written, which ends the run with the failure code. */
export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderError";
  }
}
