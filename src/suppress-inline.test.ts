import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nodeHost } from "../bin/node-host.ts";
import { readFixture } from "../__test-helpers__/fixtures.ts";
import { writeProject } from "../__test-helpers__/projects.ts";
import { discoverProjects } from "./discover.ts";
import { inventory } from "./inventory.ts";
import { scopeForDir } from "./scope.ts";
import { openEngine, runSession } from "./session.ts";
import {
  classifyComment,
  DIRECTIVE_EXPRESSIONS,
  inlineDirectives,
  inlineSuppressions,
  tokenStart,
  type InlineDirective,
} from "./suppress-inline.ts";

/** One case of the published suppression token corpus. */
interface CorpusCase {
  readonly input: { readonly comment?: string; readonly line_offset?: number };
  readonly kind: string;
  readonly accepted: boolean;
  readonly rule: string;
  readonly reason: string;
  readonly reports?: readonly string[];
}

const CORPUS = JSON.parse(
  readFixture("contract", "grammar", "suppression-corpus.json"),
) as readonly CorpusCase[];

/** The outcome the grammar page's rule vocabulary gives a refused case under its rule. */
const REFUSED: Readonly<Record<string, string>> = {
  namespace: "not a directive",
  "first-token": "not a directive",
  "line-comment-only": "not a directive",
  "directive-name": "exit 2",
  "reason-separator": "exit 2",
  "code-list": "exit 2",
  "reason-required": "DS1701",
  "line-above": "DS1703",
};

/** What the grammar declares one inline case to be. */
function declared(one: CorpusCase): string {
  if (one.accepted) {
    return "accepted";
  }
  const outcome = REFUSED[one.rule] ?? `no outcome for ${one.rule}`;
  return one.reports === undefined ? outcome : one.reports.join(" ");
}

/** What this analyzer makes of one inline case: the comment, at its line offset. */
function outcome(one: CorpusCase): string {
  const directive = classifyComment(one.input.comment ?? "");
  switch (directive.is) {
    case "none":
      return "not a directive";
    case "malformed":
      return "exit 2";
    case "no-reason":
      return directive.codes.map(() => "DS1701").join(" ");
    case "directive":
      return one.input.line_offset === -1 || one.input.line_offset === 0 ? "accepted" : "DS1703";
  }
}

describe("the inline directive's three expressions", () => {
  it("are the three the grammar page publishes, byte for byte", () => {
    const published = readFixture("contract", "grammar", "suppression.md")
      .split("\n")
      .filter((line) => line.startsWith(String.raw`^//[ \t]*deadset:`));

    expect(published).toEqual([
      DIRECTIVE_EXPRESSIONS.candidate,
      DIRECTIVE_EXPRESSIONS.wellFormed,
      DIRECTIVE_EXPRESSIONS.noReason,
    ]);
  });
});

describe("every inline case of the published token corpus", () => {
  const inline = CORPUS.filter((one) => one.kind === "inline");

  it.each(inline.map((one) => [one.input.comment ?? "", one] as const))(
    "%j has the outcome the grammar declares",
    (_comment, one) => {
      expect(outcome(one)).toBe(declared(one));
    },
  );

  it("is read, and none of it is left out", () => {
    expect(inline.length).toBe(33);
  });
});

describe("a well-formed directive", () => {
  it("carries every code it names and its reason, trailing whitespace trimmed", () => {
    expect(
      classifyComment("// deadset:ignore DS1001,DS1101 -- kept -- for the plugin loader.   "),
    ).toEqual({
      is: "directive",
      codes: ["DS1001", "DS1101"],
      reason: "kept -- for the plugin loader.",
    });
  });
});

describe("the first token at or after an offset", () => {
  it("is past whitespace, line comments, block comments and a leading hashbang", () => {
    const text = "#!/usr/bin/env node\n  // note\n  /* block */\n  export const x = 1;";

    expect(text.slice(tokenStart(text, 0))).toBe("export const x = 1;");
  });

  it.each([
    ["a line comment ended by a carriage return", "// a\rx", 0, 5],
    ["a line comment ended by a line separator", "// a\u2028x", 0, 5],
    ["a line comment ended by a paragraph separator", "// a\u2029x", 0, 5],
    ["a line comment that ends the text", "// a", 0, 4],
    ["a first line that is no hashbang", "x\ny", 0, 0],
    ["an offset past a hashbang's line", "#!x\nab cd", 6, 7],
    ["a block comment whose opener is followed by a solidus", "/*/ x */y", 0, 8],
    ["a block comment that is never closed", "/* x", 0, 4],
  ])("is read past %s", (_case, text, from, want) => {
    expect(tokenStart(text, from)).toBe(want);
  });
});

function inlineOf(files: Readonly<Record<string, string>>): {
  readonly comments: readonly string[];
  readonly records: readonly string[];
} {
  const root = writeProject(files);
  try {
    const host = nodeHost();
    const engine = openEngine({ collectTiming: false });
    const { configFiles } = discoverProjects(engine, host, scopeForDir(host, root));
    const { projects } = runSession(engine, configFiles, (project) =>
      inlineDirectives(project, inventory(project, host, root), root),
    );
    const { records } = inlineSuppressions(projects);
    return {
      comments: projects.flat().map((one) => `${String(one.site.line)} ${one.text}`),
      records: records.map(
        (one) => `${one.code} ${String(one.site.line)} ${one.symbol.replace(/^.*#/u, "")}`,
      ),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the inline directives of a project", () => {
  it("are the comments in the namespace and no other", () => {
    expect(
      inlineOf({
        "a.ts":
          "// a plain note\n// deadset:ignore DS1001 -- kept\nexport function kept(): void {}\n",
      }).comments,
    ).toEqual(["2 // deadset:ignore DS1001 -- kept"]);
  });

  it("are read inside a declaration's body, binding the member below each", () => {
    expect(
      inlineOf({
        "a.ts": [
          "export class Box {",
          "  // deadset:ignore DS1101 -- read by the plugin loader",
          "  open(): void {}",
          "}",
          "",
        ].join("\n"),
      }).records,
    ).toEqual(["DS1101 2 Box.open"]);
  });

  it("are not read inside a string, a template, a regular expression or a block comment", () => {
    expect(
      inlineOf({
        "a.ts": [
          'export const first = "first";',
          'export const second = "// deadset:ignore one";',
          "export const third = `// deadset:ignore two`;",
          "export const fourth = /\\/\\/ deadset:ignore three/u;",
          "/*// deadset:ignore four */",
          "/*/ // deadset:ignore five */",
          "",
        ].join("\n"),
      }).comments,
    ).toEqual([]);
  });

  it("are not read where JSX text holds a line-comment opener after other text", () => {
    expect(
      inlineOf({
        "tsconfig.json": JSON.stringify({
          compilerOptions: { strict: true, jsx: "preserve", noEmit: true },
          include: ["**/*.tsx"],
        }),
        "view.tsx": [
          "declare global {",
          "  namespace JSX {",
          "    interface IntrinsicElements {",
          "      [name: string]: unknown;",
          "    }",
          "  }",
          "}",
          "export const view = (",
          "  <a>",
          "    <b>see // deadset:ignore junk</b>",
          "  </a>",
          ");",
          "",
        ].join("\n"),
      }).comments,
    ).toEqual([]);
  });

  it("are read after a block comment, an empty one included", () => {
    expect(
      inlineOf({
        "a.ts": [
          "/* a note */ /**/",
          "// deadset:ignore DS1001 -- kept",
          "export function kept(): void {}",
          "",
        ].join("\n"),
      }).records,
    ).toEqual(["DS1001 2 kept"]);
  });

  it("are not read inside a block comment the file never closes", () => {
    expect(
      inlineOf({ "a.ts": "export function kept(): void {}\n/* // deadset:ignore junk\n" }).comments,
    ).toEqual([]);
  });

  it("bind a declaration once however many of its parts begin on the line", () => {
    expect(
      inlineOf({
        "a.ts":
          "// deadset:ignore DS1001 -- kept\nexport function kept(value: number): number {\n  return value;\n}\n",
      }).records,
    ).toEqual(["DS1001 1 kept"]);
  });

  it("bind every declaration that begins on the line", () => {
    expect(
      inlineOf({ "a.ts": "// deadset:ignore DS1001 -- kept\nexport const a = 1, b = 2;\n" })
        .records,
    ).toEqual(["DS1001 1 a", "DS1001 1 b"]);
  });

  it("bind the function from the line above a parameter of a wrapped signature", () => {
    expect(
      inlineOf({
        "a.ts": [
          "export function wrapped(",
          "  first: number,",
          "  // deadset:ignore DS1801 -- the published callback shape",
          "  second: number,",
          "): number {",
          "  return first;",
          "}",
          "",
        ].join("\n"),
      }).records,
    ).toEqual(["DS1801 3 wrapped"]);
  });

  it("bind a variable written on a later line of its statement from the line above the keyword", () => {
    expect(
      inlineOf({
        "a.ts": "// deadset:ignore DS1001 -- kept\nexport const\n  wrapped = 1;\n",
      }).records,
    ).toEqual(["DS1001 1 wrapped"]);
  });
});

function writtenAt(
  line: number,
  text: string,
  bound: readonly (readonly [name: string, line: number, column: number])[],
): InlineDirective {
  return {
    site: { path: "src/a.ts", line, column: 1 },
    text,
    directive: classifyComment(text),
    bound: bound.map(([name, at, column]) => {
      const declared = {
        id: `src/a.ts:${String(at)}:${String(column)}`,
        ref: `ts://@example/app/src/a.ts#${name}`,
        position: { path: "src/a.ts", line: at, column },
      };
      return { declared, part: declared };
    }),
  };
}

function recordsOf(perProject: readonly (readonly InlineDirective[])[]): string[] {
  return inlineSuppressions(perProject).records.map(
    (one) => `${one.code} ${String(one.site.line)} ${one.symbol.replace(/^.*#/u, "")}`,
  );
}

describe("the inline directives of a run's projects", () => {
  const kept = "// deadset:ignore DS1001 -- kept";

  it("bind nothing for a comment outside the namespace", () => {
    expect(inlineSuppressions([[writtenAt(1, "// a plain note", [["a", 2, 1]])]])).toEqual({
      records: [],
      refusals: [],
    });
  });

  it("bind, for one directive several projects hold, the union of what each declares there", () => {
    expect(
      recordsOf([
        [
          writtenAt(1, kept, [
            ["a", 2, 1],
            ["b", 2, 8],
          ]),
        ],
        [
          writtenAt(1, kept, [
            ["a", 2, 1],
            ["c", 2, 15],
          ]),
        ],
      ]),
    ).toEqual(["DS1001 1 a", "DS1001 1 b", "DS1001 1 c"]);
  });

  it("are recorded in file order, whichever project holds each", () => {
    expect(
      recordsOf([[writtenAt(5, kept, [["late", 6, 1]])], [writtenAt(1, kept, [["early", 2, 1]])]]),
    ).toEqual(["DS1001 1 early", "DS1001 5 late"]);
  });

  it("record one directive's declarations in file order, whatever order bound them", () => {
    expect(
      recordsOf([
        [
          writtenAt(1, kept, [
            ["second", 3, 1],
            ["first", 2, 1],
          ]),
        ],
      ]),
    ).toEqual(["DS1001 1 first", "DS1001 1 second"]);
  });
});
