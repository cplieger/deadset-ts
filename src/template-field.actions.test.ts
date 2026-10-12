import { rmSync } from "node:fs";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { run, type Writer } from "./run.ts";

const LOAD_TIMEOUT = 60_000;

const PAGE = `export class Page {
  title = "";
  body = "";
  label = "";
  px = "";
  and = "";
}

export const page = new Page();
`;

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

function retainedBy(template: string, delimiters?: { left: string; right: string }): string[] {
  const root = writeProject({
    "package.json": `${JSON.stringify({ name: "app", private: true, type: "module", main: "./src/main.ts" })}\n`,
    "deadset.json": `${JSON.stringify({
      target: { kind: "application" },
      analysis: {
        template_dirs: ["templates"],
        ...(delimiters === undefined ? {} : { template_delimiters: delimiters }),
      },
    })}\n`,
    "src/main.ts": PAGE,
    "templates/page.html": template,
  });
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const out = new MemoryWriter();
  const err = new MemoryWriter();
  expect(run(["print-retained", `--target=${root}`], out, err, nodeHost())).toBe(0);
  expect(err.text).toBe("");
  return out.text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.replace(/^[^#]*#/u, ""));
}

describe("a template action", () => {
  it(
    "is read at the first character of the file, and each one after it at its own column",
    () => {
      expect(retainedBy("{{ title }}{{body}}\n  {{ label }}\n")).toEqual([
        "Page.title\ttemplate-field\ttemplates/page.html:1:4\tnamed by {{title}}",
        "Page.body\ttemplate-field\ttemplates/page.html:1:14\tnamed by {{body}}",
        "Page.label\ttemplate-field\ttemplates/page.html:2:6\tnamed by {{label}}",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "names nothing a quoted string writes, in any quote and past an escaped quote, and what follows it",
    () => {
      expect(
        retainedBy(
          [
            '{{ "label" \'label\' `label` `${label}` "\\" label" }}',
            '{{ "x" title }}',
            "{{ 'x' body }}",
            '{{ px "never closed }}',
            "",
          ].join("\n"),
        ),
      ).toEqual([
        'Page.title\ttemplate-field\ttemplates/page.html:2:8\tnamed by {{"x" title}}',
        "Page.body\ttemplate-field\ttemplates/page.html:3:8\tnamed by {{'x' body}}",
        'Page.px\ttemplate-field\ttemplates/page.html:4:4\tnamed by {{px "never closed}}',
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "names nothing a number writes, its letters included",
    () => {
      expect(retainedBy("{{ 10px title }}\n")).toEqual([
        "Page.title\ttemplate-field\ttemplates/page.html:1:9\tnamed by {{10px title}}",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is recorded with each run of white space in it written as one space",
    () => {
      expect(retainedBy("{{  title \n\t |   upper  }}\n")).toEqual([
        "Page.title\ttemplate-field\ttemplates/page.html:1:5\tnamed by {{title | upper}}",
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "is read between delimiters that are one and the same",
    () => {
      expect(retainedBy("$title$ and $body$\n", { left: "$", right: "$" })).toEqual([
        "Page.title\ttemplate-field\ttemplates/page.html:1:2\tnamed by $title$",
        "Page.body\ttemplate-field\ttemplates/page.html:1:14\tnamed by $body$",
      ]);
    },
    LOAD_TIMEOUT,
  );
});
