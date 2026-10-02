import type { Format } from "../config.ts";
import { annotations } from "./annotations.ts";
import { json } from "./json.ts";
import { RenderError, type Rendering, type Renderings } from "./reporter.ts";
import { sarif } from "./sarif.ts";
import { renderTemplate } from "./template.ts";
import { text } from "./text.ts";

/**
 * Every format this analyzer renders, each by its reporter and its file suffix. A format
 * absent from the table is refused rather than silently not written.
 */
export const RENDERINGS: Renderings = new Map<Format, Rendering>([
  ["text", { render: text, suffix: ".txt" }],
  ["json", { render: json, suffix: ".json" }],
  ["github", { render: annotations, suffix: ".annotations" }],
  ["sarif", { render: sarif, suffix: ".sarif" }],
  [
    "template",
    {
      render: (report, options) => {
        if (options.template === undefined) {
          throw new RenderError("the template rendering renders a template, and none was named");
        }
        return renderTemplate(options.template, report);
      },
      suffix: ".tmpl",
    },
  ],
]);
