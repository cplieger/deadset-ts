import { rmSync } from "node:fs";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { run, type Writer } from "./run.ts";

const LOAD_TIMEOUT = 60_000;

const SCRIPT = `<script lang="ts">
interface Row {
  note: string;
  label: string;
  title: string;
  count: number;
  width: number;
  size: number;
  depth: number;
  w: number;
  h: number;
  x: number;
  y: number;
  idle: string;
}
const row: Row = {
  note: "", label: "", title: "", count: 0, width: 0, size: 0,
  depth: 0, w: 0, h: 0, x: 0, y: 0, idle: "",
};
</script>
`;

class MemoryWriter implements Writer {
  text = "";
  write(text: string): void {
    this.text += text;
  }
}

/** `markup` starts at line 1, column 11, after `<template>`. */
function retainedByMarkup(markup: string): string[] {
  const root = writeProject({
    "package.json": `${JSON.stringify({ name: "app", private: true, type: "module", main: "./src/main.ts" })}\n`,
    "deadset.json": `${JSON.stringify({ target: { kind: "application" } })}\n`,
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ESNext",
        lib: ["ESNext"],
        module: "NodeNext",
        moduleResolution: "nodenext",
        noEmit: true,
      },
      include: ["src/**/*.ts", "src/**/*.vue"],
    })}\n`,
    "src/main.ts": 'import View from "./View.vue";\n\nexport const all = [View];\n',
    "src/View.vue": `<template>${markup}</template>\n${SCRIPT}`,
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
    .map((line) => {
      const [ref = "", , site = "", detail = ""] = line.split("\t");
      return `${ref.replace(/^[^#]*#/u, "")} ${site.replace(/^src\/View\.vue:/u, "")} ${detail}`;
    });
}

describe("a template literal in a component's markup", () => {
  it(
    "names what each substitution writes, and nothing its text or an escaped backtick writes",
    () => {
      expect(
        retainedByMarkup(
          [
            '<p :title="`idle{idle} $ idle ${row.note} idle` + row.label"></p>',
            '<p :alt="`idle \\`idle\\` ${row.y}`"></p>',
            '<p :id="`${row.w}x${row.h}`"></p>',
          ].join(""),
        ),
      ).toEqual([
        'Row.note 1:47 named by :title="`idle{idle} $ idle ${row.note} idle` + row.label"',
        'Row.label 1:65 named by :title="`idle{idle} $ idle ${row.note} idle` + row.label"',
        'Row.w 1:130 named by :id="`${row.w}x${row.h}`"',
        'Row.h 1:139 named by :id="`${row.w}x${row.h}`"',
        'Row.y 1:106 named by :alt="`idle \\`idle\\` ${row.y}`"',
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "ends a substitution at its own closing brace, past one in a string, a template literal or an object",
    () => {
      expect(
        retainedByMarkup(
          [
            "<p :a=\"`${'}' + row.title} idle`\"></p>",
            "<p :b='`${\"}\" + row.count} idle`'></p>",
            '<p :c="`${`}` + row.width} idle`"></p>',
            '<p :d="`${ { k: 1 }.k + row.size } idle`"></p>',
          ].join(""),
        ),
      ).toEqual([
        "Row.title 1:31 named by :a=\"`${'}' + row.title} idle`\"",
        "Row.count 1:69 named by :b='`${\"}\" + row.count} idle`'",
        'Row.width 1:107 named by :c="`${`}` + row.width} idle`"',
        'Row.size 1:153 named by :d="`${ { k: 1 }.k + row.size } idle`"',
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "names what a substitution of a template literal inside a substitution writes",
    () => {
      expect(retainedByMarkup('<p :title="`${ `${row.depth}` }`"></p>')).toEqual([
        'Row.depth 1:33 named by :title="`${ `${row.depth}` }`"',
      ]);
    },
    LOAD_TIMEOUT,
  );

  it(
    "names what comes before a template literal that is never closed",
    () => {
      expect(retainedByMarkup('<p :title="row.note + `idle"></p>')).toEqual([
        'Row.note 1:26 named by :title="row.note + `idle"',
      ]);
    },
    LOAD_TIMEOUT,
  );
});
