import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { heldWords } from "../commands/held.ts";
import { loadsOf, readCommands } from "../commands/read.ts";
import { parseLine } from "../commands/shell.ts";
import { TOOLS, type Grammar, type Options } from "../commands/tools.ts";

/** Each tool's grammar, from the row its reader reads by. */
const GRAMMARS: ReadonlyMap<string, Grammar> = new Map(
  [...TOOLS].flatMap(([name, row]) => (row.grammar === undefined ? [] : [[name, row.grammar]])),
);
import { APPENDED_EXTENSIONS } from "../extensions.ts";
import { spelledFiles } from "./named-files.ts";

/** What the words of `text`, a command string, name of `files` below `root`, the target root. */
function readIn(
  text: string,
  files: readonly { readonly file: string; readonly paths: readonly string[] }[],
  root = "/pkg",
): { readonly files: readonly string[]; readonly unwritten: boolean } {
  return spelledFiles(heldWords([{ text, shell: true }]), root, root, files);
}

/** A second checkout of the package, whose own directories no word of the repository writes. */
const OTHER_ROOT = "/home/runner/work/pkg/pkg";

/** The files of the package a drawn text spells one of. */
const FILES = [
  "/pkg/a.ts",
  "/pkg/lib/index.mjs",
  "/pkg/src/b c.cts",
  "/pkg/src/deep/x.y.tsx",
  "/pkg/web/@app/main.ts",
];

/** Text that may stand before a path: shell syntax, launcher options, quotes and other words. */
const BEFORE = ["", " ", "node ", "--inject:", "$(pwd)/", '"', "'", "\\", "=", "&&", "(", ","];

/** Text that may stand after a path. */
const AFTER = ["", " ", " node", '"', "'", "=", "&&", ")", ",", ":3", ";", "."];

/**
 * Every spelling of `file` below `/pkg` the rule names it by as a path: relative to the
 * package, with `/` or `\` between names, with or without `./`, its extension or, for an index
 * file, its `/index` part, `.` for the package's own, but never one bare segment.
 */
function spellingsOf(file: string): readonly string[] {
  const relative = file.slice("/pkg/".length);
  const bare = relative.replace(/\.[cm]?[jt]sx?$/u, "");
  const forms = [relative, bare];
  if (bare.endsWith("index")) {
    forms.push(bare === "index" ? "." : bare.slice(0, -"/index".length));
  }
  return forms
    .flatMap((form) => [form, `./${form}`])
    .filter((form) => form.includes("/") || form.includes(".") || form === relative)
    .flatMap((form) => [form, form.replaceAll("/", "\\")]);
}

/** The names a bare word may hold that no path is: each file's last segment or directory without its extension. */
const BARE = ["a", "lib", "b c", "x.y", "index", "deep", "src", "main", "@app"];

/** The files a word of the grammar below is drawn from and judged against. */
const GRAMMAR_FILES = [
  "/pkg/index.ts",
  "/pkg/lint.ts",
  "/pkg/scripts/lint.js",
  "/pkg/scripts/lint-fast.mjs",
  "/pkg/scripts/sub/index.ts",
  "/pkg/tools/scripts/check.ts",
  "/pkg/@tools/build-web.mjs",
  "/pkg/@app/main-lint.js",
  "/pkg/lib/index.mjs",
  "/pkg/src/deep/x.y.tsx",
];

/** Parts only a run knows: an expression, parameters, a command substitution and globs. */
const PARTS = ["${{ matrix.tool }}", "$1", "$TOOL", "${NAME}", "$(echo x)", "*", "?", "[l]"];

/** The parts a double quote leaves a part, and the glob characters it makes literal. */
const EXPANDS_QUOTED = new Set(["${{ matrix.tool }}", "$1", "$TOOL", "${NAME}", "$(echo x)"]);

/** The extensions a name of a file drops (roots.13). */
const EXTENSIONS = [...APPENDED_EXTENSIONS, ".d.ts", ".d.mts", ".d.cts"];

/** One segment of a drawn word: written text, and `null` where a part stands. */
type Segment = readonly (string | null)[];

interface Word {
  readonly segments: readonly Segment[];
  readonly directory: boolean;
}

/** `file` without the extension it ends with. */
function bareOf(file: string): string {
  const extension = EXTENSIONS.filter((one) => file.endsWith(one)).sort(
    (one, other) => other.length - one.length,
  )[0];
  return extension === undefined ? file : file.slice(0, -extension.length);
}

/** The written text of a segment, its parts left out. */
function writtenOf(segment: Segment): string {
  return segment.filter((piece) => piece !== null).join("");
}

/** Whether a segment's written text writes a path: text beside its parts other than `.` and `..`. */
function writesPath(segment: Segment): boolean {
  return segment.some((piece) => piece !== null && piece !== "" && piece !== "." && piece !== "..");
}

/**
 * A drawn word's segments as roots.13 reads them below `/pkg`, the root: the segment its leading
 * `..` climbs past the root writes is the root's own directory, which names nothing, and the
 * empty one an absolute word starts with is none.
 */
function belowRoot(word: Word): readonly Segment[] {
  const [first, , ...rest] = word.segments;
  if (isAbsolute(word)) {
    return word.segments.slice(1);
  }
  return first?.length === 1 && first[0] === ".." ? [first, ...rest] : word.segments;
}

/** Whether a drawn word starts with `/`. */
function isAbsolute(word: Word): boolean {
  const [first] = word.segments;
  return first?.length === 1 && first[0] === "";
}

/**
 * Where roots.13 reads an absolute word from, whose segments before its last, or all of them
 * for a directory's, each write a path and so may each be one of the root's own directories:
 * its last segment that writes a path, or `undefined` where it is no such word.
 */
function absoluteFrom(word: Word): number | undefined {
  const segments = belowRoot(word).filter((one) => !(one.length === 1 && one[0] === "."));
  const read = word.directory ? segments.length : segments.length - 1;
  return isAbsolute(word) && segments.slice(0, read).every(writesPath)
    ? segments.findLastIndex(writesPath)
    : undefined;
}

/**
 * Whether roots.13 says `word` names `file`, read from the rule's text and not the matcher's
 * code, where `runs` says whether the word may write the file a command runs: a word whose
 * last segment holds a part by the dynamic-word sentences, any other by the names its last
 * segment writes.
 */
function namedByRule(word: Word, file: string, runs: boolean): boolean {
  const { directory } = word;
  const last = word.segments.at(-1) ?? [];
  const segments = belowRoot(word);
  const index = bareOf(file).endsWith("/index") ? bareOf(file).slice(0, -"/index".length) : "";
  if (!last.includes(null)) {
    const name = writtenOf(last);
    const parent = index.slice(index.lastIndexOf("/") + 1);
    const stem = bareOf(file).slice(bareOf(file).lastIndexOf("/") + 1);
    if (directory) {
      return index !== "" && name === parent;
    }
    return (
      name === stem ||
      (index !== "" && name === parent) ||
      EXTENSIONS.some((extension) => name === `${stem}${extension}`)
    );
  }
  const own = writtenOf(last);
  const extension = EXTENSIONS.some((one) =>
    new RegExp(`${one.replaceAll(".", "\\.")}(?!\\w)`, "u").test(own),
  );
  if (!segments.some(writesPath) || !(word.segments.length > 1 || directory || extension || runs)) {
    return false;
  }
  const read = directory ? segments.length : segments.length - 1;
  let from = 0;
  for (let at = 0; at < read; at += 1) {
    if (!writesPath(segments[at] ?? [])) {
      from = at + 1;
    }
  }
  const absolute = absoluteFrom(word);
  const kept =
    absolute === undefined
      ? segments.slice(from).filter((segment) => !(segment.length === 1 && segment[0] === "."))
      : segments.filter((segment) => !(segment.length === 1 && segment[0] === ".")).slice(absolute);
  const spellings = directory ? [index] : [file, bareOf(file), index];
  if (kept.length === 0) {
    return index !== "";
  }
  const pattern = new RegExp(
    `(?:^|/)${kept
      .map((segment) =>
        segment
          .map((piece) => (piece === null ? ".*" : piece.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")))
          .join(""),
      )
      .join("/")}$`,
    "u",
  );
  return spellings.some((one) => one !== "" && pattern.test(one));
}

/**
 * Whether roots.13 says the static word `written`, where a runtime may take it as its entry,
 * names `file` as that entry: a path of it, with or without its extension or `/index` part,
 * ends after a `/` in the word's text, read from past its last `..` and without `.` segments.
 */
function namedAsEntry(written: string, file: string): boolean {
  const segments = written
    .replaceAll("\\", "/")
    .split("/")
    .filter((one) => one !== "" && one !== ".");
  const kept = segments.slice(segments.lastIndexOf("..") + 1).join("/");
  const index = bareOf(file).endsWith("/index") ? bareOf(file).slice(0, -"/index".length) : "";
  const spellings = written.endsWith("/") ? [index] : [file, bareOf(file), index];
  return kept !== "" && spellings.some((one) => one !== "" && one.endsWith(`/${kept}`));
}

/** Whether roots.13 says `word`, where it may write the file a command runs, makes the package's file findings `possible`. */
function capsByRule(word: Word, runs: boolean): boolean {
  if (!runs || !(word.segments.at(-1) ?? []).includes(null)) {
    return false;
  }
  const segments = belowRoot(word).filter((one) => !(one.length === 1 && one[0] === "."));
  const absolute = absoluteFrom(word);
  // An absolute word whose root may be at its last segment that writes a path, with parts below it.
  return (
    !segments.some(writesPath) ||
    (absolute !== undefined && absolute >= 0 && absolute < segments.length - 1)
  );
}

/** Each way the grammar writes one written segment: whole, as a part, or mixed with one. */
function formsOf(name: string): readonly Segment[] {
  const half = Math.ceil(name.length / 2);
  return [
    [name],
    [null],
    [name.slice(0, half), null],
    [null, name.slice(half)],
    [name.slice(0, half), null, name.slice(half)],
  ];
}

/** Every product of one choice from each list. */
function product<T>(lists: readonly (readonly T[])[]): readonly (readonly T[])[] {
  return lists.reduce<readonly (readonly T[])[]>(
    (done, list) => done.flatMap((head) => list.map((one) => [...head, one])),
    [[]],
  );
}

/**
 * Every word of the grammar drawn from a spelling of `file`: each ending of it, each segment
 * written whole, as a part or mixed with one, the extension kept on the last, after each
 * leading form, with one part somewhere at least.
 */
function wordsOf(file: string): readonly (readonly Segment[])[] {
  const relative = file.slice("/pkg/".length);
  const bare = bareOf(relative);
  const spellings = [relative, bare, ...(bare.endsWith("/index") ? [bare.slice(0, -6)] : [])];
  return spellings.flatMap((spelling) => {
    const names = spelling.split("/");
    const extension = spelling.slice(bareOf(spelling).length);
    return names.flatMap((_, from) => {
      const ending = names.slice(from);
      const lastName = bareOf(ending.at(-1) ?? "");
      return product([
        ...ending.slice(0, -1).map(formsOf),
        formsOf(lastName).map((segment) => [...segment, ...(extension === "" ? [] : [extension])]),
      ])
        .filter((segments) => segments.some((segment) => segment.includes(null)))
        .flatMap((segments) =>
          [[], ["."], [".."], ["@zz"], [""]].map((lead) => [
            ...lead.map((one) => [one]),
            ...segments,
          ]),
        );
    });
  });
}

/** One command a drawn word stands in: the text before it, and whether the word may write the file it runs. */
const CONTEXTS: readonly (readonly [string, boolean])[] = [
  ["node ", true],
  ["cat ", false],
  ["X=", false],
  ["node --require ", true],
  ["node -C dev ", true],
  ["npx tsx@4 ", true],
];

/** Text that may stand after a word. */
const AFTER_WORD = ["", ".", ",", ")", ":3", ";", " node", '"'];

/**
 * How a drawn word is written: as it is, in double quotes, with each part in double quotes,
 * with each written piece in single quotes, as one alternative of a brace expansion, or inside
 * a command substitution, whose own word is a part and writes no path.
 */
type Form = "plain" | "quoted" | "quoted parts" | "quoted text" | "brace" | "substitution";
const FORMS: readonly Form[] = [
  "plain",
  "quoted",
  "quoted parts",
  "quoted text",
  "brace",
  "substitution",
];

/**
 * `segments` written in `form`, with `part` for each part and `trailing` after it, or
 * undefined where a shell reads a longer part or the form would make a glob literal.
 */
function written(
  segments: readonly Segment[],
  part: string,
  separator: string,
  trailing: string,
  form: Form,
): string | undefined {
  const longer = segments.some((segment) =>
    segment.some((piece, at) => piece === null && /^\w/u.test(segment[at + 1] ?? "")),
  );
  if (
    (part === "$TOOL" && longer) ||
    (!EXPANDS_QUOTED.has(part) && (form === "quoted" || form === "quoted parts")) ||
    (part === "$(echo x)" && form === "brace")
  ) {
    return undefined;
  }
  const text = `${segments
    .map((segment) =>
      segment
        .map((piece) =>
          piece === null
            ? form === "quoted parts"
              ? `"${part}"`
              : part
            : form === "quoted text" && piece !== ""
              ? `'${piece}'`
              : piece,
        )
        .join(""),
    )
    .join(separator)}${trailing}`;
  switch (form) {
    case "quoted":
      return `"${text}"`;
    case "brace":
      return `{${text},zz}`;
    case "substitution":
      return `$(echo ${text})`;
    default:
      return text;
  }
}

/** Whether both readings roots.13 makes of a command string parse. */
function parses(line: string): boolean {
  return [line, line.replaceAll(/\\(?![\r\n`])/gu, "/")].every(
    (one) => (parseLine(one).errors ?? []).length === 0,
  );
}

/**
 * `spelling` written as one shell word beside `around`: a shell splits an unquoted blank, so a
 * spelling with one is quoted with a quote `around` does not hold. Where it holds both, one of
 * them opens a quote no other closes, the blank stands inside it, and the line does not parse.
 */
function oneWord(spelling: string, around: string): string {
  const quote = ['"', "'"].find((one) => !around.includes(one));
  return !spelling.includes(" ") || quote === undefined ? spelling : `${quote}${spelling}${quote}`;
}

describe("spelledFiles", () => {
  const spelled = FILES.map((one) => ({ file: one, paths: [one] }));

  it("names every file one of whose spellings stands in the text as a path", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FILES),
        fc.nat(),
        fc.constantFrom(...BEFORE),
        fc.constantFrom(...AFTER),
        (file, pick, before, after) => {
          const spellings = spellingsOf(file);
          const spelling = spellings[pick % spellings.length]!;
          const text = `${before}${oneWord(spelling, before + after)}${after}`;

          expect(readIn(text, spelled).files, text).toContain(file);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("names no file a bare word spells, but where a runtime may take it as its entry", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...BARE),
        fc.constantFrom(...BEFORE.filter((one) => !/[/\\]$/u.test(one))),
        fc.constantFrom(...AFTER),
        (word, before, after) => {
          const text = `${before}${word}${after}`;
          const named = readIn(text, spelled).files;
          // Only `node ` makes the word a runtime's entry; an `after` with no blank may go on with it.
          const entry = word.split(" ")[0] ?? "";
          const exact = ["", " ", " node", ";"].includes(after) && !word.includes(" ");

          if (before !== "node ") {
            expect(named, text).toEqual([]);
          } else if (exact) {
            expect(named, text).toEqual(FILES.filter((file) => namedAsEntry(entry, file)));
          } else {
            expect(
              named.filter((file) => !namedAsEntry(entry, file)),
              text,
            ).toEqual([]);
          }
        },
      ),
      { numRuns: 2000 },
    );
  });

  it.each(GRAMMAR_FILES)(
    "names exactly the files roots.13 says each word of the grammar drawn from %s names, and caps where it says, at two checkouts alike",
    (drawn) => {
      const grammar = GRAMMAR_FILES.map((one) => ({ file: one, paths: [one] }));
      const otherGrammar = GRAMMAR_FILES.map((one) => {
        const file = `${OTHER_ROOT}${one.slice("/pkg".length)}`;
        return { file, paths: [file] };
      });
      const words = [...new Set(wordsOf(drawn).map((one) => JSON.stringify(one)))];
      const disagreements: string[] = [];
      let read = 0;
      let exact = 0;
      for (const [at, encoded] of words.entries()) {
        const segments = JSON.parse(encoded) as Segment[];
        for (const separator of ["/", "\\"]) {
          for (const [t, trailing] of ["", "/", "\\", "//", "\\\\"].entries()) {
            for (const [p, part] of PARTS.entries()) {
              for (const [f, form] of FORMS.entries()) {
                const [before, runs] = CONTEXTS[(at + t + p + f) % CONTEXTS.length]!;
                const after = AFTER_WORD[(at + 3 * t + p + f) % AFTER_WORD.length]!;
                const text = written(segments, part, separator, trailing, form);
                if (text === undefined) {
                  continue;
                }
                const line = `${before}${text}${after}`;
                read += 1;
                const word = { segments, directory: trailing !== "" };
                const inner = form !== "substitution" && runs;
                const got = readIn(line, grammar);
                const named = new Set(got.files);
                // Every reading of a line with a `\\` and of one that does not parse is fail-closed,
                // so only a miss there disagrees; elsewhere either direction does.
                const twoSided = separator === "/" && trailing.indexOf("\\") < 0 && parses(line);
                exact += twoSided ? 1 : 0;
                for (const file of GRAMMAR_FILES) {
                  const want = namedByRule(word, file, inner);
                  if (named.has(file) !== want && (twoSided || want)) {
                    disagreements.push(`${line} ${named.has(file) ? "names" : "misses"} ${file}`);
                  }
                }
                const caps = capsByRule(word, inner) || (form === "substitution" && runs);
                if (got.unwritten !== caps && (twoSided || caps)) {
                  disagreements.push(`${line} ${got.unwritten ? "caps" : "does not cap"}`);
                }
                if ((at + t + p + f) % 3 === 0) {
                  const elsewhere = readIn(line, otherGrammar, OTHER_ROOT);
                  const back = elsewhere.files.map((one) => `/pkg${one.slice(OTHER_ROOT.length)}`);
                  if (
                    JSON.stringify({ files: back, unwritten: elsewhere.unwritten }) !==
                    JSON.stringify(got)
                  ) {
                    disagreements.push(`${line} reads otherwise at ${OTHER_ROOT}`);
                  }
                }
              }
            }
          }
        }
      }

      expect(read).toBeGreaterThan(1000);
      expect(exact).toBeGreaterThan(read / 6);
      expect(disagreements.slice(0, 30)).toEqual([]);
    },
    900_000,
  );
});

/** A runtime of the second layer, as a command writes it, with the options its row reads and some it does not. */
const RUNTIMES: readonly {
  readonly name: string;
  readonly read: readonly string[];
  readonly unread: readonly string[];
}[] = [
  {
    name: "node",
    read: [
      "",
      "-r ./setup.cjs ",
      "--require=./setup.cjs ",
      "--import tsx ",
      "--loader=ts-node/esm ",
      "-C development ",
      "--watch-path src ",
      "--inspect ",
      "--env-file=.env ",
    ],
    unread: ["--frobnicate ", "--check ", "--cpu-prof-dir x "],
  },
  {
    name: "tsx",
    read: ["", "--import ./env.ts ", "-r ./setup.cjs ", "--tsconfig tsconfig.json ", "--no-cache "],
    unread: ["--frobnicate x ", "--zz "],
  },
  { name: "tsx watch", read: ["", "--require ./setup.cjs "], unread: ["--clear-screen=false "] },
  {
    name: "ts-node",
    read: ["", "--esm ", "-r tsconfig-paths/register "],
    unread: ["-P tsconfig.json ", "-T "],
  },
  { name: "bun", read: ["", "-r ./setup.ts ", "--watch "], unread: ["--hot=x ", "--cwd x "] },
  { name: "bun run", read: ["", "--preload ./setup.ts "], unread: ["--env-file .env "] },
  { name: "deno run", read: ["", "-A ", "--allow-net "], unread: ["--allow-read=. "] },
];

/** Whether `name` is a one-letter option. */
function isShort(name: string): boolean {
  return /^-[^-]$/u.test(name);
}

/**
 * Every spelling of each option of `options`, `value` a valued one's value: alone, a valued one
 * apart, after `=` for a long one and attached for a one-letter one where its table says so,
 * and, where it does, one-letter flags clustered with another flag or ending in a valued one.
 */
function optionSpellings(options: Options, value: string): readonly string[] {
  const found: string[] = [...options.flags];
  for (const name of options.valued) {
    found.push(`${name} ${value}`);
    if (!isShort(name)) {
      found.push(`${name}=${value}`);
    } else if (options.attached === true) {
      found.push(`${name}${value}`);
    }
  }
  for (const name of options.optional ?? []) {
    found.push(isShort(name) ? `${name}${value}` : `${name}=${value}`);
  }
  if (options.attached === true) {
    const flags = [...options.flags].filter(isShort);
    for (const [at, flag] of flags.entries()) {
      found.push(`${flag}${(flags[(at + 1) % flags.length] ?? flag).slice(1)}`);
      for (const name of [...options.valued].filter(isShort)) {
        found.push(`${flag}${name.slice(1)} ${value}`, `${flag}${name.slice(1)}${value}`);
      }
    }
  }
  return found;
}

/** A value no file of the package writes, for a valued option. */
const VALUE = "vv";

/** The runtimes of {@link GRAMMARS}, each subcommand that runs a file apart, with each option of their tables. */
const TABLE_RUNTIMES = [...GRAMMARS].flatMap(([name, grammar]) =>
  grammar.operand !== "file"
    ? []
    : ["", ...grammar.subcommands!.keys()].map((sub) => ({
        name: sub === "" ? name : `${name} ${sub}`,
        /** Whether `entry` after `option` picks a mode that runs no file. */
        modal: (option: string, entry: string): boolean =>
          sub === "" &&
          grammar.modes?.has(entry) === true &&
          (grammar.modeAfter === undefined || option === "" || grammar.modeAfter.has(option)),
        spellings: ["", ...optionSpellings(grammar.options, "./setup.cjs")],
        unread: [
          "--zz-unread ",
          `-Z ${VALUE} `,
          ...[...grammar.options.flags]
            .filter((one) => !isShort(one))
            .map((one) => `${one}=${VALUE} `),
        ],
      })),
);

/**
 * Whether `spelling` writes a valued option of `grammar` that gives a command line: its value
 * runs in the command's place, as env's `-S vv` runs `vv`, so no command written after it does.
 */
function givesLine(spelling: string, grammar: Grammar): boolean {
  return [...(grammar.lines ?? [])].some(
    (name) =>
      grammar.options.valued.has(name) &&
      (isShort(name)
        ? new RegExp(`^-[^-\\s]*${name.slice(1)}`, "u").test(spelling)
        : spelling.startsWith(name)),
  );
}

/** The subcommand forms of a grammar that runs a command: none, or each subcommand with its table. */
function commandHeads(name: string, grammar: Grammar): readonly (readonly [string, Grammar])[] {
  const subs = [...(grammar.subcommands ?? [])];
  return subs.length === 0
    ? [[`${name} `, grammar]]
    : subs.map(([sub, one]) => [`${name} ${sub} `, one]);
}

/**
 * Each way a row of {@link GRAMMARS} hands on a command or a command line, spelled from its
 * table: every spelling of every option before the command, before and after a subcommand,
 * two of them in a row, with a `--` after them, and every spelling of each option that gives a
 * command line, a valued one's value written apart, after `=`, attached or ending a cluster.
 */
function grammarForms(): readonly ((line: string) => string)[] {
  const forms: ((line: string) => string)[] = [];
  for (const [name, grammar] of GRAMMARS) {
    if (grammar.operand === "file") {
      continue;
    }
    const top = optionSpellings(grammar.options, VALUE).filter(
      (spelling) => !givesLine(spelling, grammar),
    );
    for (const [head, sub] of grammar.operand === "command"
      ? commandHeads(name, grammar)
      : [[`${name} `, grammar] as const]) {
      const own =
        head === `${name} `
          ? top
          : optionSpellings(sub.options, VALUE).filter((spelling) => !givesLine(spelling, sub));
      const end = sub.ended === true ? "-- " : "";
      if (grammar.operand === "lines") {
        for (const [at, spelling] of own.entries()) {
          const next = own[(at + 1) % own.length] ?? "";
          forms.push((line) => `${head}${spelling} '${line}'`);
          forms.push((line) => `${head}'${line}' ${spelling}`);
          // Under -P the words after a `--` are its commands' arguments.
          if (!/^-P$|^--passthrough-arguments$/u.test(spelling) && !/-P|passthrough/u.test(next)) {
            forms.push((line) => `${head}${spelling} ${next} -- '${line}'`);
          }
        }
      } else if (grammar.operand !== "line") {
        const before = (spelling: string): string =>
          head === `${name} `
            ? `${head}${spelling} `
            : `${name} ${spelling} ${head.slice(name.length + 1)}`;
        forms.push((line) => `${head}${end}${line}`);
        for (const [at, spelling] of own.entries()) {
          const next = own[(at + 1) % own.length] ?? "";
          forms.push((line) => `${head}${spelling} ${end}${line}`);
          forms.push((line) => `${head}${spelling} ${next} -- ${line}`);
        }
        if (head !== `${name} `) {
          for (const spelling of top) {
            forms.push((line) => `${before(spelling)}${end}${line}`);
          }
        }
      }
      for (const option of sub.lines ?? []) {
        const valued = sub.options.valued.has(option);
        const spelled = valued
          ? [
              (line: string) => `${option} '${line}'`,
              (line: string) =>
                isShort(option)
                  ? sub.options.attached === true
                    ? `${option}'${line}'`
                    : `${option} '${line}'`
                  : `${option}='${line}'`,
              ...(sub.options.attached === true && isShort(option)
                ? [...sub.options.flags]
                    .filter(isShort)
                    .flatMap((flag) => [
                      (line: string) => `${flag}${option.slice(1)}'${line}'`,
                      (line: string) => `${flag}${option.slice(1)} '${line}'`,
                    ])
                : []),
            ]
          : [
              (line: string) => `${option} '${line}'`,
              ...(sub.options.attached === true && isShort(option)
                ? [...sub.options.flags]
                    .filter((flag) => isShort(flag) && flag !== option)
                    .flatMap((flag) => [
                      (line: string) => `${flag}${option.slice(1)} '${line}'`,
                      (line: string) => `${option}${flag.slice(1)} '${line}'`,
                    ])
                : []),
            ];
        for (const [at, spell] of spelled.entries()) {
          const spelling = own[at % Math.max(own.length, 1)] ?? "";
          forms.push((line) => `${head}${spell(line)}`);
          forms.push((line) => `${head}${spelling} ${spell(line)}`);
        }
        if (head !== `${name} ` && !valued) {
          forms.push((line) => `${name} ${option} ${head.slice(name.length + 1)}'${line}'`);
        }
      }
    }
  }
  return forms;
}

/** The launchers before a runtime, with whether a package runner's version may follow them. */
const LAUNCHERS: readonly (readonly [string, boolean])[] = [
  ["", false],
  ["npx ", true],
  ["npx -y ", true],
  ["npx --yes -- ", true],
  ["pnpm exec ", false],
  ["pnpm dlx ", true],
  ["pnpm ", false],
  ["yarn ", false],
  ["yarn dlx ", true],
  ["bunx ", true],
  ["npm exec -- ", true],
  ["npm x -- ", true],
  ["env A=1 ", false],
  ["cross-env A=$X ", false],
  ["env -u HOME ", false],
  ["nohup ", false],
  ["nice -n 5 ", false],
  ["timeout 5m ", false],
  ["exec ", false],
  ["eval ", false],
  ["sudo -E ", false],
  ["/usr/bin/env ", false],
  ["ls | xargs -I{} ", false],
  ["pnpm -r exec ", false],
  ["pnpm --filter web exec ", false],
  ["npm -w web exec -- ", true],
  ...[...GRAMMARS]
    .filter(([, grammar]) => grammar.operand === "command")
    .flatMap(([name, grammar]) =>
      commandHeads(name, grammar).map(([head, one]): readonly [string, boolean] => [
        `${head}${one.ended === true ? "-- " : ""}`,
        false,
      ]),
    )
    .filter(
      ([head]) =>
        ![
          "npm exec ",
          "npm x ",
          "pnpm exec ",
          "pnpm dlx ",
          "yarn dlx ",
          "bunx ",
          "npx ",
          "env ",
        ].includes(head),
    ),
];

/** The entry words a command is drawn with: static spellings, and words of the grammar with a part. */
function entriesOf(file: string): readonly (readonly [string, Word])[] {
  const relative = file.slice("/pkg/".length);
  const statics = [
    relative,
    bareOf(relative),
    `./${bareOf(relative)}`,
    bareOf(relative).split("/").at(-1) ?? "",
  ];
  return [
    ...statics.map((one): readonly [string, Word] => [
      one,
      { segments: one.split("/").map((segment) => [segment]), directory: false },
    ]),
    ...wordsOf(file)
      .filter((_, at) => at % 7 === 0)
      .flatMap((segments) =>
        PARTS.slice(0, 5).flatMap((part) => {
          const text = written(segments, part, "/", "", "plain");
          return text === undefined ? [] : [[text, { segments, directory: false }] as const];
        }),
      ),
  ];
}

/**
 * The ways a command line is handed to a shell that runs it unchanged: as it is, as a shell's
 * `-c` operand behind each option form, as the line `eval`, `concurrently` with `-P` or as a
 * `--teardown`, `npx -c`, `npm exec --call`, `pnpm --shell-mode` and `env -S` run, each option
 * of theirs written apart, attached or before the subcommand, as the command `parallel` runs,
 * and on a shell's standard input.
 */
const WRAPPERS: readonly ((line: string) => string)[] = [
  (line) => line,
  (line) => `sh -c '${line}'`,
  (line) => `bash -o pipefail -ec '${line}' name`,
  (line) => `sudo -E bash -c '${line}'`,
  (line) => `xargs sh -c '${line}'`,
  (line) => `eval '${line}'`,
  (line) => `concurrently -n a,b '${line}' vite`,
  (line) => `pnpm concurrently '${line}'`,
  (line) => `concurrently -P '${line}' -- a`,
  (line) => `concurrently 'vite' -k --teardown '${line}'`,
  (line) => `eval ${line}`,
  (line) => `npx -c '${line}'`,
  (line) => `npm exec --call='${line}'`,
  (line) => `pnpm dlx --shell-mode '${line}'`,
  (line) => `env -S '${line}'`,
  (line) => `bash <<'EOF'\n${line}\nEOF`,
  (line) => `sh -s <<EOF\n${line}\nEOF`,
  (line) => `echo '${line}' | sh`,
  (line) => `cat <<'EOF' | bash -e\n${line}\nEOF`,
  (line) => `env -S"${line}"`,
  (line) => `npx --call="${line}"`,
  (line) => `pnpm -r exec -c '${line}'`,
  (line) => `pnpm --shell-mode --filter web exec '${line}'`,
  (line) => `npm -w web exec -c '${line}'`,
  (line) => `parallel '${line}' ::: a`,
  (line) => `ls | parallel -j4 '${line}'`,
];

/** The tools that hand each command they run the paths they find, with the text each replaces with a path. */
const APPENDERS: readonly (readonly [string, string, string])[] = [
  ["xargs -I % ", "%", ""],
  ["xargs -0 -I% ", "%", ""],
  ["xargs -i ", "{}", ""],
  ["xargs --replace=@@ ", "@@", ""],
  ["find . -name '*.js' -exec ", "{}", " \\;"],
  ["find . -execdir ", "{}", " +"],
  ["parallel ", "{}", " ::: a"],
  ["parallel -j4 ", "{.}", ""],
  ["parallel -I ,, ", ",,", ""],
  ["xargs -i% ", "%", ""],
  ["xargs -IFILE ", "FILE", ""],
  ["parallel -I,, ", ",,", " ::: a"],
];

/**
 * Programs that run no command, each with text before a runtime's name it writes in an argument.
 * None stands after a launcher no reader reads, as `sudo`: there each later word may be a
 * program word (roots.13).
 */
const ARGUMENT_PROGRAMS = [
  "echo ",
  "echo using ",
  "grep -r ",
  "printf %s ",
  "curl https://example.com/",
  "cat /usr/bin/",
  "env A=1 echo ",
  "pnpm exec echo ",
  "npx -y echo ",
];

/** Words no row's table lists: an option, alone, valued, attached, and a one-letter one. */
const UNKNOWN_TOKENS = ["--zz-unknown", "--zz=vv", "-Z", "-Zvv"];

/**
 * Each way a row of {@link GRAMMARS} that runs a command or a command line is written with one
 * of {@link UNKNOWN_TOKENS} among its options: after its name or its subcommand, before its
 * subcommand, and after one of its own options.
 */
function unknownForms(): readonly ((line: string) => string)[] {
  const forms: ((line: string) => string)[] = [];
  for (const [name, grammar] of GRAMMARS) {
    if (grammar.operand === "file") {
      continue;
    }
    for (const [at, token] of UNKNOWN_TOKENS.entries()) {
      if (grammar.operand === "line") {
        forms.push(
          (line) => `${name} ${token} -c '${line}'`,
          (line) => `${name} -e ${token} -c '${line}'`,
        );
        continue;
      }
      if (grammar.operand === "lines") {
        forms.push(
          (line) => `${name} ${token} '${line}'`,
          (line) => `${name} 'vite' ${token} '${line}'`,
        );
        continue;
      }
      const heads =
        grammar.operand === "command"
          ? commandHeads(name, grammar)
          : [[`${name} `, grammar] as const];
      for (const [head, one] of heads) {
        const own = optionSpellings(one.options, VALUE);
        const spelling = own[at % Math.max(own.length, 1)] ?? "";
        forms.push((line) => `${head}${token} ${line}`);
        forms.push((line) => `${head}${spelling} ${token} ${line}`);
        if (head !== `${name} `) {
          forms.push((line) => `${name} ${token} ${head.slice(name.length + 1)}${line}`);
        }
      }
    }
  }
  return forms;
}

/** `parallel` commands whose entry is a perl expression's computed path, in each spelling, each before an entry text. */
const PERL_ENTRIES = [
  (head: string) => `parallel ${head}'{= s/x/y/ =}' ::: a`,
  (head: string) => `parallel ${head}{= s/x/y/ =} ::: a`,
  (head: string) => `parallel '${head}{= s/x/y/ =}' ::: a`,
  (head: string) => `parallel ${head}scripts/'{= s/x/y/ =}' ::: a`,
  (head: string) => `ls | parallel -j4 ${head}{=s/x/y/=}`,
  (head: string) => `parallel ${head}'{''= s/x/y/ =}' ::: a`,
  (head: string) => `parallel ${head}"{"= s/x/y/ =} ::: a`,
];

/** Commands that run what their standard input carries: shells read it as command lines, runtimes as code. */
const STDIN_READERS: readonly (readonly [string, boolean])[] = [
  ["bash -e", true],
  ["sh", true],
  ["bash -s -- x", true],
  ["node", false],
  ["node --no-warnings", false],
  ["node -", false],
  ["tsx", false],
  ["c8 node", false],
  ["deno run -", false],
];

/**
 * Each standard input a line may be given from outside, as the shell parser reads it, that no
 * word writes a path of, with whether only a shell reads it as running a file: a no-path `<`,
 * a pipe from a file `cat` reads or from another program, a `<&`, and command lines a
 * here-document, a here-string or an `echo` before a pipe writes.
 */
const OUTSIDE_STDIN: readonly (readonly [(line: string) => string, boolean])[] = [
  [(line) => `${line} < "$F"`, false],
  [(line) => `< \${{ inputs.script }} ${line}`, false],
  [(line) => `cat "$F" | ${line}`, false],
  [(line) => `cat < "$F" | ${line}`, false],
  [(line) => `curl -fsSL "$URL" | ${line}`, false],
  [(line) => `${line} <&3 3< "$F"`, false],
  [(line) => `{ ${line}; } < "$F"`, false],
  [(line) => `${line} <<'EOF'\n$RUNNER lint\nEOF`, true],
  [(line) => `${line} <<< '$RUNNER lint'`, true],
  [(line) => `echo '$RUNNER lint' | ${line}`, true],
];

/**
 * Each way a command before a pipe writes `line`, a runtime's command line, as its output: echo
 * its operands joined by blanks, however quotes split them, and printf a format with no conversion.
 */
const WRITERS: readonly ((line: string) => string)[] = [
  (line) => `echo ${line}`,
  (line) => `echo -n ${line}`,
  (line) => {
    const [first = "", ...rest] = line.split(" ");
    return `echo "${first}" ${rest.join(" ")}`;
  },
  (line) =>
    `echo ${line
      .split(" ")
      .filter((word) => word !== "")
      .map((word) => `'${word}'`)
      .join(" ")}`,
  (line) => `printf '${line}\\n'`,
  (line) => `printf -- '${line}'`,
];

/** A command each of whose program words, after the launchers, may be any text. */
const DYNAMIC_LINES = [
  'bash $FLAGS "$CMD"',
  "sh $FLAGS",
  'sh -c "$CMD"',
  'eval "$CMD"',
  'concurrently "$CMD"',
  'concurrently -P "node {1}" -- lint',
  'concurrently --passthrough-arguments "{@}" -- lint',
  'concurrently "node {*}"',
  'concurrently --teardown "$CMD" vite',
  'source "$CMD"',
  ". $1",
  'node /dev/stdin < "$CMD"',
  "find . $ACTION node {} \\;",
  'npx -c "$CMD"',
  'env -S "$CMD"',
  'echo "$CMD" | sh',
  "sh <<EOF\n$CMD\nEOF",
  "xargs -I % sh -c %",
  "xargs sh -c",
  'parallel ::: "$CMD"',
  "find . -exec sh -c {} \\;",
  'bash -- "$CMD"',
  "sh -euo pipefail -- $1",
  "sh - ${{ inputs.script }}",
  "xargs -I % bash -- %",
  "ls | xargs bash",
  "find . -exec sh -- {} \\;",
];

describe("the run places of a command", () => {
  /** One drawn command: its text, the line the second layer runs it as, and its entry. */
  interface Drawn {
    readonly line: string;
    readonly instance: string;
    readonly entry: string;
    readonly word: Word;
    readonly dynamic: boolean;
  }

  /**
   * Every disagreement between what the third layer holds or caps of `drawn` and what the
   * second layer runs of its instance, where the entry is the drawn file's own path: any
   * file the runtime may run as the entry must be held or the package capped.
   */
  function disagreementsOf(command: Drawn, file: string): readonly string[] {
    const grammar = GRAMMAR_FILES.map((one) => ({ file: one, paths: [one] }));
    const { line, entry, word, dynamic } = command;
    const got = readIn(line, grammar);
    const held = new Set(got.files);
    const runs = readCommands(command.instance, "/pkg").runs.filter(
      (one) => one.entry !== undefined,
    );
    const found = runs.flatMap((run) =>
      run.entry === file.slice("/pkg/".length)
        ? []
        : [`${command.instance} second layer runs ${run.entry ?? ""}`],
    );
    const loaded = new Set(runs.flatMap((one) => loadsOf(one).flatMap((load) => load.paths)));
    for (const one of GRAMMAR_FILES) {
      const may = dynamic
        ? namedByRule(word, one, true)
        : namedAsEntry(entry, one) || namedByRule(word, one, true);
      const instanceRuns = dynamic && namedByRule(word, one, true) && loaded.has(one);
      if ((may || instanceRuns) && !held.has(one) && !got.unwritten) {
        found.push(`${line} drops ${one}`);
      }
    }
    if (dynamic && capsByRule(word, true) && !got.unwritten) {
      found.push(`${line} does not cap`);
    }
    return found;
  }

  it.each(GRAMMAR_FILES)(
    "holds or caps every file the runtime of each drawn command may run as its entry, drawn from %s, as the second layer reads the command, whichever shell it is handed to",
    (drawn) => {
      const entries = entriesOf(drawn);
      const own = drawn.slice("/pkg/".length);
      const disagreements: string[] = [];
      let read = 0;
      let byLayer2 = 0;
      let turn = 0;
      for (const [launcher, packaged] of LAUNCHERS) {
        for (const runtime of RUNTIMES) {
          const versions = packaged && !runtime.name.includes(" ") ? ["", "@4"] : [""];
          for (const version of versions) {
            for (const option of [...runtime.read, ...runtime.unread]) {
              for (const after of ["", " --flag", " out.txt"]) {
                const [program, ...mode] = runtime.name.split(" ");
                const head = `${launcher}${program ?? ""}${version}${mode.map((one) => ` ${one}`).join("")} ${option}`;
                byLayer2 += readCommands(`${head}${own}${after}`, "/pkg").runs.some(
                  (one) => one.entry !== undefined,
                )
                  ? 1
                  : 0;
                for (const wrap of WRAPPERS) {
                  turn += 1;
                  const [entry, word] = entries[turn % entries.length]!;
                  read += 1;
                  disagreements.push(
                    ...disagreementsOf(
                      {
                        line: wrap(`${head}${entry}${after}`),
                        instance: `${head}${own}${after}`,
                        entry,
                        word,
                        dynamic: entry.includes("$"),
                      },
                      drawn,
                    ),
                  );
                }
              }
            }
          }
        }
      }

      expect(read).toBeGreaterThan(10_000);
      expect(byLayer2 * WRAPPERS.length).toBeGreaterThan(read / 4);
      expect(disagreements.slice(0, 30)).toEqual([]);
    },
    900_000,
  );

  it.each(GRAMMAR_FILES)(
    "holds or caps every file a runtime after a tool that hands it the paths it finds may run, its entry written with the tool's replacement text for each part, drawn from %s",
    (drawn) => {
      const own = drawn.slice("/pkg/".length);
      const words = [...new Set(wordsOf(drawn).map((one) => JSON.stringify(one)))].map(
        (one) => JSON.parse(one) as Segment[],
      );
      const disagreements: string[] = [];
      let read = 0;
      for (const [at, segments] of words.entries()) {
        for (const [appender, part, tail] of APPENDERS) {
          const runtime = RUNTIMES[at % RUNTIMES.length]!;
          const option = runtime.read[at % runtime.read.length] ?? "";
          const entry = written(segments, part, "/", "", "plain");
          if (entry === undefined) {
            continue;
          }
          read += 1;
          const head = `${runtime.name} ${option}`;
          disagreements.push(
            ...disagreementsOf(
              {
                line: `${appender}${head}${entry}${tail}`,
                instance: `${head}${own}`,
                entry,
                word: { segments, directory: false },
                dynamic: true,
              },
              drawn,
            ),
          );
        }
      }

      expect(read).toBeGreaterThan(100);
      expect(disagreements.slice(0, 30)).toEqual([]);
    },
    300_000,
  );

  /** Each runtime of {@link TABLE_RUNTIMES} with each option spelling of its own, and whether an entry after it picks a mode. */
  const TABLE_HEADS = TABLE_RUNTIMES.flatMap((runtime) =>
    [...runtime.spellings, ...runtime.unread].map((option) => ({
      head: `${runtime.name} ${option === "" ? "" : `${option.trimEnd()} `}`,
      modal: (entry: string) => runtime.modal(option.trimEnd(), entry),
    })),
  );

  it.each(GRAMMAR_FILES)(
    "holds or caps every file a runtime may run as its entry, drawn from %s, after every spelling of every option of each row's table, and with every spelling of each option of a runtime's own",
    (drawn) => {
      const entries = entriesOf(drawn);
      const own = drawn.slice("/pkg/".length);
      const disagreements: string[] = [];
      const runtimes = TABLE_HEADS;
      let read = 0;
      const check = (
        wrap: (line: string) => string,
        { head, modal }: (typeof runtimes)[number],
        turn: number,
      ): void => {
        for (const step of [0, 1]) {
          const [entry, word] = entries[(turn * 2 + step) % entries.length]!;
          if (modal(entry)) {
            continue;
          }
          read += 1;
          disagreements.push(
            ...disagreementsOf(
              {
                line: wrap(`${head}${entry}`),
                instance: `${head}${own}`,
                entry,
                word,
                dynamic: entry.includes("$"),
              },
              drawn,
            ),
          );
        }
      };
      grammarForms().forEach((wrap, turn) => {
        check(wrap, runtimes[turn % runtimes.length]!, turn);
      });
      runtimes.forEach((head, turn) => {
        check(WRAPPERS[turn % WRAPPERS.length]!, head, turn);
      });

      expect(read).toBeGreaterThan(2000);
      expect(disagreements.slice(0, 30)).toEqual([]);
    },
    600_000,
  );

  it.each(GRAMMAR_FILES)(
    "holds or caps every file a runtime may run as its entry, drawn from %s, where a word no row's table models stands among a tool's or the runtime's options or in env's -S value, which env splits before its later words",
    (drawn) => {
      const entries = entriesOf(drawn);
      const own = drawn.slice("/pkg/".length);
      const disagreements: string[] = [];
      // A nested -S runs its value as the program, so the runtime after it is an argument.
      const envOptions = [
        "",
        ...optionSpellings(TOOLS.get("env")!.grammar!.options, VALUE).filter(
          (one) => !/S|split-string/u.test(one),
        ),
      ];
      let read = 0;
      const check = (line: (entry: string) => string, turn: number, unknown = false): void => {
        const { head, modal } = TABLE_HEADS[turn % TABLE_HEADS.length]!;
        const [entry, word] = entries[turn % entries.length]!;
        if (modal(entry)) {
          return;
        }
        read += 1;
        const got = disagreementsOf(
          {
            line: line(`${head}${entry}`),
            instance: `${head}${own}`,
            entry,
            word,
            dynamic: entry.includes("$"),
          },
          drawn,
        );
        disagreements.push(...got);
        if (
          unknown &&
          !readIn(line(`${head}${entry}`), [{ file: drawn, paths: [drawn] }]).unwritten
        ) {
          disagreements.push(`${line(`${head}${entry}`)} does not cap`);
        }
      };
      unknownForms().forEach((wrap, turn) => {
        check(wrap, turn, true);
      });
      TABLE_HEADS.forEach(({ head }, turn) => {
        const token = UNKNOWN_TOKENS[turn % UNKNOWN_TOKENS.length]!;
        const [program, ...rest] = head.trimEnd().split(" ");
        check(
          () => `${program ?? ""} ${token} ${rest.join(" ")} ${entries[turn % entries.length]![0]}`,
          turn,
          true,
        );
        check(() => `${head}${token} ${entries[turn % entries.length]![0]}`, turn, true);
      });
      TABLE_HEADS.forEach(({ head }, turn) => {
        const option = envOptions[turn % envOptions.length]!;
        const [entry] = entries[turn % entries.length]!;
        const split = `${option} ${head}`.trim();
        check(() => `env -S'${split}' ${entry}`, turn);
        check(() => `env -S '${split}' ${entry}`, turn);
        check(() => `env -u HOME --split-string='${split}' ${entry}`, turn);
        check(() => `env -S'${split} \\c' ${entry}`, turn, true);
        check(() => `env -S'${split} \${X}' ${entry}`, turn, true);
      });

      expect(read).toBeGreaterThan(2000);
      expect(disagreements.slice(0, 30)).toEqual([]);
    },
    600_000,
  );

  it.each(GRAMMAR_FILES)(
    "reads a runtime's name an argument of another program writes, before an entry drawn from %s, as any other word, and the second layer runs no entry there",
    (drawn) => {
      const grammar = GRAMMAR_FILES.map((one) => ({ file: one, paths: [one] }));
      const entries = entriesOf(drawn);
      const disagreements: string[] = [];
      let read = 0;
      for (const [at, [entry]] of entries.entries()) {
        for (const before of ARGUMENT_PROGRAMS) {
          const runtime = RUNTIMES[at % RUNTIMES.length]!;
          const options = [...runtime.read, ...runtime.unread];
          const option = options[(at + read) % options.length] ?? "";
          for (const wrap of WRAPPERS.slice(0, 2)) {
            read += 1;
            const line = (name: string): string => wrap(`${before}${name} ${option}${entry}`);
            const got = readIn(line(runtime.name), grammar);
            const plain = readIn(line(runtime.name.replace(/^\S+/u, "zz")), grammar);
            if (JSON.stringify(got) !== JSON.stringify(plain)) {
              disagreements.push(`${line(runtime.name)} reads otherwise than a word`);
            }
            if (
              readCommands(line(runtime.name), "/pkg").runs.some((one) => one.entry !== undefined)
            ) {
              disagreements.push(`${line(runtime.name)} second layer runs an entry`);
            }
          }
        }
      }

      expect(read).toBeGreaterThan(500);
      expect(disagreements.slice(0, 30)).toEqual([]);
    },
    300_000,
  );

  it("caps the package where a command or command line each row's table hands on, in every spelling, runs a program word that may be any text", () => {
    const grammar = GRAMMAR_FILES.map((one) => ({ file: one, paths: [one] }));
    const forms = grammarForms();
    // A static runtime is read in any quoted text, so only a dynamic program word shows a
    // command line the reading misses.
    const missed = [...forms, ...unknownForms()].flatMap((wrap) =>
      ["$RUNNER lint", '"$CMD"'].map(wrap).filter((one) => !readIn(one, grammar).unwritten),
    );
    const perl = PERL_ENTRIES.flatMap((write) =>
      TABLE_HEADS.map(({ head }) => write(head)).filter((one) => !readIn(one, grammar).unwritten),
    );

    expect(forms.length).toBeGreaterThan(500);
    expect(missed.slice(0, 30)).toEqual([]);
    expect(perl.slice(0, 30)).toEqual([]);
  }, 60_000);

  it("caps the package where a command that runs its standard input is handed, by each wrapper that hands on a command line, a standard input no word writes a path of", () => {
    const grammar = GRAMMAR_FILES.map((one) => ({ file: one, paths: [one] }));
    // A wrapper that feeds the line its own standard input leaves none to hand on.
    const handing = WRAPPERS.filter((wrap) => !/<<|\| *(?:sh|bash)/u.test(wrap("x")));
    const missed: string[] = [];
    let read = 0;
    for (const wrap of handing) {
      for (const [reader, shell] of STDIN_READERS) {
        for (const [give, onlyShell] of OUTSIDE_STDIN) {
          if (onlyShell && !shell) {
            continue;
          }
          read += 1;
          const line = give(wrap(reader));
          if (!readIn(line, grammar).unwritten) {
            missed.push(line);
          }
        }
      }
    }

    expect(handing.length).toBeGreaterThan(15);
    expect(read).toBeGreaterThan(1000);
    expect(missed.slice(0, 30)).toEqual([]);
  });

  it.each(GRAMMAR_FILES)(
    "holds or caps every file a runtime may run as its entry, drawn from %s, where echo or printf before a pipe writes the command line a shell reads, as the second layer reads that line",
    (drawn) => {
      const entries = entriesOf(drawn);
      const own = drawn.slice("/pkg/".length);
      const shells = STDIN_READERS.filter(([, shell]) => shell).map(([reader]) => reader);
      const handing = WRAPPERS.filter((wrap) => !/<<|\| *(?:sh|bash)/u.test(wrap("x")));
      const disagreements: string[] = [];
      let read = 0;
      TABLE_HEADS.forEach(({ head, modal }, turn) => {
        for (const [step, write] of WRITERS.entries()) {
          const [entry, word] = entries[(turn + step) % entries.length]!;
          if (modal(entry)) {
            continue;
          }
          const reader = shells[(turn + step) % shells.length]!;
          const wrap = handing[(turn + step) % handing.length]!;
          read += 1;
          disagreements.push(
            ...disagreementsOf(
              {
                line: `${write(`${head}${entry}`)} | ${wrap(reader)}`,
                instance: `${head}${own}`,
                entry,
                word,
                dynamic: entry.includes("$"),
              },
              drawn,
            ),
          );
        }
      });

      expect(read).toBeGreaterThan(1000);
      expect(disagreements.slice(0, 30)).toEqual([]);
    },
    600_000,
  );

  it("caps the package where node runs its test runner, after every spelling of every option of its table, but in a manifest's script the test runs tests.1 roots", () => {
    const grammar = GRAMMAR_FILES.map((one) => ({ file: one, paths: [one] }));
    const heads = TABLE_HEADS.filter(({ head }) => head.startsWith("node "));
    const missed: string[] = [];
    let rooted = 0;
    for (const { head } of heads) {
      for (const wrap of WRAPPERS.slice(0, 2)) {
        const line = wrap(`${head}--test`);
        const tested = spelledFiles(
          heldWords([{ text: line, shell: true, tested: true }]),
          "/pkg",
          "/pkg",
          grammar,
        );
        const tests = readCommands(line, "/pkg").tests;
        rooted += tests.length > 0 && !tested.unwritten ? 1 : 0;
        if (!readIn(line, grammar).unwritten) {
          missed.push(`${line} outside a manifest's script`);
        }
        if (tests.length === 0 && !tested.unwritten) {
          missed.push(`${line} in a manifest's script`);
        }
      }
    }

    expect(heads.length).toBeGreaterThan(100);
    expect(rooted).toBeGreaterThan(heads.length / 2);
    expect(missed.slice(0, 30)).toEqual([]);
  });

  it.each(LAUNCHERS.map(([launcher]) => launcher))(
    "caps the package where each command after %j may run any text as its program word",
    (launcher) => {
      const grammar = GRAMMAR_FILES.map((one) => ({ file: one, paths: [one] }));
      const missed = DYNAMIC_LINES.flatMap((line) =>
        WRAPPERS.slice(0, 2)
          .map((wrap) => wrap(`${launcher}${line}`))
          .filter((one) => !readIn(one, grammar).unwritten),
      );

      expect(missed).toEqual([]);
    },
  );
});
