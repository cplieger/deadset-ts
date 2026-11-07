/**
 * Layer 2 of the command reader: one row per tool, its reader of a simple command's words after
 * its program word and the options it names its configuration file by, each as the tool
 * documents them, and one reader per shell builtin that moves the shell's directory. A reader
 * never guesses: an option it does not handle, or a dynamic word where it needs a value, leaves
 * the command unread. The same rows and readers decide, for layer 3, which words of a command
 * may write the file a runtime runs, so the two layers never read one command apart.
 */

import { hasURLScheme, isPathSpecifier, resolvePath } from "../paths.ts";
import { PART, type Word } from "./shell.ts";

/** One module a runtime loads before its entry, and the resolution its option names it by. */
export interface Preload {
  readonly specifier: string;
  /** `require` for a CommonJS `require` path, `import` for an ECMAScript module URL. */
  readonly resolution: "require" | "import";
}

/** What one simple command is read as. */
export type Reading =
  /** It runs `entry`, a path, after loading `preloads`. */
  | {
      readonly kind: "run";
      readonly entry: string | undefined;
      readonly preloads: readonly Preload[];
      /** `node` where the entry runs under Node itself. */
      readonly runtime: "node" | undefined;
    }
  /** It runs the command `words`, whose program word stands at `at` of the words read, as read. */
  | { readonly kind: "command"; readonly words: readonly Word[]; readonly at: number }
  /** It runs `text` as a command line of its own. */
  | { readonly kind: "line"; readonly text: string };

/**
 * A reader's answer where its tool's table does not model the command: an option the table
 * does not list, or a construct no row reads. Layer 2 reads it as not understood; for layer 3
 * the command may run a file no word writes, and every later word may still be a program word.
 */
interface Unknown {
  readonly kind: "unknown";
}

const UNKNOWN: Unknown = { kind: "unknown" };

function isUnknown(value: unknown): value is Unknown {
  return value === UNKNOWN;
}

type Reader = (words: readonly Word[]) => Reading | Unknown | undefined;

/** The options a tool takes before its first operand. */
export interface Options {
  /** The options that take a value, the next word or, for a long one, the text after `=`. */
  readonly valued: ReadonlySet<string>;
  /** The options that take none. */
  readonly flags: ReadonlySet<string>;
  /**
   * Whether its one-letter options read as getopt reads them: a valued one's value may stand in
   * the same word, as `-uNAME`, and several may share one word, the last of them valued or not,
   * as `-iS'…'` and `-iu NAME`: https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/V1_chap12.html
   */
  readonly attached?: boolean;
  /** The options whose value is optional and only written in the same word, as xargs's `-i[R]`. */
  readonly optional?: ReadonlySet<string>;
}

/**
 * One tool's options as its documentation gives them: its `options`, the object its reader
 * parses with; what follows them, a command, the file it runs, a command line, command lines
 * among its options, or the command it hands the paths it finds; the options that give a
 * command line, a valued one's value or, for a flag, its operands; its subcommands, each with
 * its own table; and whether it reads options after its first operand, up to a `--`.
 * Production reads `options`, `lines` and `later` only, through {@link linesOf}; the
 * enumerated property spells every field.
 */
export interface Grammar {
  readonly options: Options;
  readonly operand: "command" | "file" | "line" | "lines" | "appended";
  readonly lines?: ReadonlySet<string>;
  readonly subcommands?: ReadonlyMap<string, Grammar>;
  readonly later?: boolean;
  /** Whether its command stands only after a `--`, as `dotenvx run`'s. */
  readonly ended?: boolean;
  /** For a runtime, the options that run their value, or its test runner, in its file's place. */
  readonly inline?: ReadonlySet<string>;
  /** For a runtime, the words that pick a mode that runs no file, and the options that may stand before one. */
  readonly modes?: ReadonlySet<string>;
  readonly modeAfter?: ReadonlySet<string>;
  readonly doc: string;
}

/** The options before the first operand, with their values, and the operand's index. */
interface Read {
  readonly values: ReadonlyMap<string, readonly string[]>;
  /** The name of each option read, a flag's too. */
  readonly named: ReadonlySet<string>;
  readonly at: number;
  /** Whether a `--` ended the options. */
  readonly ended: boolean;
}

/** The text `word` writes before its first part only the run knows: all of it where it is static. */
function startOf(word: Word): string {
  return word.value ?? word.written?.split(PART)[0] ?? "";
}

/** One option {@link scanOptions} reads, with where its value is written: in the word at `at`, after `prefix`. */
interface Scanned {
  readonly name: string;
  readonly value?: { readonly at: number; readonly prefix: string };
}

/**
 * The options {@link scanOptions} reads, and where they end: at an operand, after a `--`, at
 * the words' end, at an option `options` does not hold, or at a dynamic word that may be one.
 */
interface Scan {
  readonly options: readonly Scanned[];
  readonly at: number;
  readonly stop: "operand" | "ended" | "end" | "unread" | "dynamic";
}

/**
 * The options one word `word`, starting with `-`, writes, the word at `at`, or `undefined` where
 * `options` does not hold one. A valued one's value is the next word's unless the word writes
 * it, and always where it is `dynamic`, whose written text goes on past `word`.
 */
function optionsInWord(
  word: string,
  at: number,
  options: Options,
  dynamic: boolean,
): readonly Scanned[] | undefined {
  const inWord = (name: string, prefix: string): Scanned => ({ name, value: { at, prefix } });
  if (word.startsWith("--")) {
    const equals = word.indexOf("=");
    const name = equals < 0 ? word : word.slice(0, equals);
    if (equals >= 0) {
      return options.valued.has(name) || options.optional?.has(name) === true
        ? [inWord(name, `${name}=`)]
        : undefined;
    }
    if (options.optional?.has(word) === true) {
      return [inWord(word, word)];
    }
    return options.valued.has(word) && !dynamic
      ? [{ name: word, value: { at: at + 1, prefix: "" } }]
      : undefined;
  }
  if (!dynamic && options.valued.has(word)) {
    return [{ name: word, value: { at: at + 1, prefix: "" } }];
  }
  if (options.attached !== true) {
    return options.optional?.has(word) === true ? [inWord(word, word)] : undefined;
  }
  const found: Scanned[] = [];
  for (let letter = 1; letter < word.length; letter += 1) {
    const name = `-${word.charAt(letter)}`;
    const prefix = word.slice(0, letter + 1);
    if (options.valued.has(name)) {
      const next = letter + 1 === word.length && !dynamic;
      return [...found, next ? { name, value: { at: at + 1, prefix: "" } } : inWord(name, prefix)];
    }
    if (options.optional?.has(name) === true) {
      return [...found, inWord(name, prefix)];
    }
    if (!options.flags.has(name)) {
      return undefined;
    }
    found.push({ name });
  }
  return found.length === 0 || dynamic ? undefined : found;
}

/**
 * The options `words` write from `from` on, read by `options`, the one reading of a table's
 * options that {@link optionsOf}, {@link optionLines} and {@link envSplit} share. A dynamic
 * word that starts with written text other than `-` is no option; one whose written start is a
 * valued option's ends them with that option's value in it, as `-S"$CMD"` does.
 */
function scanOptions(words: readonly Word[], options: Options, from = 0): Scan {
  const found: Scanned[] = [];
  for (let at = from; at < words.length; at += 1) {
    const one = words[at];
    const dynamic = one?.value === undefined;
    const word = one === undefined ? "" : startOf(one);
    if (!dynamic && word === "--") {
      return { options: found, at: at + 1, stop: "ended" };
    }
    if (!dynamic && options.flags.has(word)) {
      found.push({ name: word });
      continue;
    }
    if (!word.startsWith("-")) {
      return { options: found, at, stop: dynamic && word === "" ? "dynamic" : "operand" };
    }
    const read = optionsInWord(word, at, options, dynamic);
    if (dynamic || read === undefined) {
      return {
        options: [...found, ...(read ?? [])],
        at,
        stop: dynamic ? "dynamic" : "unread",
      };
    }
    found.push(...read);
    at = read.at(-1)?.value?.at ?? at;
  }
  return { options: found, at: words.length, stop: "end" };
}

/**
 * The options `words` start with, {@link UNKNOWN} where `options` does not hold one, or
 * `undefined` where a needed word is dynamic.
 */
function optionsOf(words: readonly Word[], options: Options): Read | Unknown | undefined {
  const scan = scanOptions(words, options);
  if (scan.stop === "unread") {
    return UNKNOWN;
  }
  if (scan.stop === "dynamic") {
    return undefined;
  }
  const values = new Map<string, string[]>();
  const named = new Set<string>();
  for (const { name, value } of scan.options) {
    named.add(name);
    const text = value === undefined ? undefined : words[value.at]?.value;
    if (value !== undefined && text === undefined) {
      return undefined;
    }
    if (value !== undefined && text !== undefined) {
      values.set(name, [...(values.get(name) ?? []), text.slice(value.prefix.length)]);
    }
  }
  return { values, named, at: scan.at, ended: scan.stop === "ended" };
}

/** The place of the first operand after the options `words` start with, `undefined` where {@link optionsOf} reads none. */
function operandAt(words: readonly Word[], options: Options): number | undefined {
  const read = optionsOf(words, options);
  return read === undefined || isUnknown(read) ? undefined : read.at;
}

/**
 * The path a URL's path text names, percent-decoded as Node's `fileURLToPath` does, with a
 * backslash read as the URL parser reads it, or `undefined` where it does not decode or
 * encodes a separator: https://nodejs.org/api/url.html#urlfileurltopathurl-options
 */
function urlPath(text: string): string | undefined {
  const path = text.replace(/[?#].*$/su, "").replaceAll("\\", "/");
  if (/%2f|%5c/iu.test(path)) {
    return undefined;
  }
  try {
    return decodeURIComponent(path);
  } catch {
    return undefined;
  }
}

/**
 * Where one preload is, read in `dir`: the absolute path of a file, a package's name, or
 * `undefined` where it names neither. `require` reads a path as written; an ECMAScript
 * specifier is a URL, so a relative one or a `file:` one is percent-decoded and any other
 * scheme loads no file: https://nodejs.org/api/esm.html#urls
 */
export function preloadTarget(
  preload: Preload,
  dir: string,
): { readonly path: string } | { readonly package: string } | undefined {
  const { specifier, resolution } = preload;
  if (resolution === "require") {
    return isPathSpecifier(specifier)
      ? { path: resolvePath(dir, specifier) }
      : hasURLScheme(specifier)
        ? undefined
        : { package: specifier };
  }
  if (!isPathSpecifier(specifier) && !hasURLScheme(specifier)) {
    return { package: specifier };
  }
  const local = /^file:(?:\/\/(?=\/))?/iu.exec(specifier);
  const rest = specifier.slice(local?.[0].length ?? 0);
  // `file://host/…` names a file on another host.
  if ((hasURLScheme(specifier) && local === null) || rest.startsWith("//")) {
    return undefined;
  }
  const path = urlPath(rest);
  return path === undefined ? undefined : { path: resolvePath(dir, path) };
}

/** A runtime's command line: its preload options, then its entry, and every later word handed to the program. */
interface Runtime {
  readonly preloads: ReadonlyMap<string, Preload["resolution"]>;
  readonly flags: readonly string[];
  /** The other options that take a value, the next word or the text after `=`. */
  readonly valued?: readonly string[];
  /** The options whose value is only written after `=`, as V8's `--stack-size=`. */
  readonly optional?: readonly string[];
  /** Whether the entry runs under Node itself. */
  readonly runsNode: boolean;
  /** The words that pick a mode that runs the entry, after its options or before them, as tsx's `watch`. */
  readonly subcommands?: ReadonlySet<string>;
  /** The words that pick a mode that runs no entry, as `bun install`. */
  readonly modes?: ReadonlySet<string>;
  /** The only options that may stand before a word that picks a mode, where not every one may. */
  readonly modeAfter?: ReadonlySet<string>;
  /** The options whose value it runs in its entry's place, as Node's `--eval`. */
  readonly inline?: readonly string[];
  /** Whether it runs its standard input as its entry where none is written, as Node does. */
  readonly stdin?: boolean;
  /** The options that run its test runner in its entry's place, whose files `entries/test-runners.ts` reads. */
  readonly runner?: readonly string[];
}

/** Where a runtime's words, those after its program word, write its entry, and what it preloads. */
interface RuntimeLine {
  /** The entry's place among the words, `undefined` where none is written. */
  readonly entry: number | undefined;
  readonly preloads: readonly Preload[];
  /** Whether it runs its standard input in its entry's place. */
  readonly stdin: boolean;
  /** Where an option runs its test runner, the place of the first word naming the files it runs. */
  readonly tests: number | undefined;
  /** The name of each option read. */
  readonly named: ReadonlySet<string>;
}

/** The options of a runtime's command line, as {@link optionsOf} reads them. */
function runtimeOptions(line: Runtime): Options {
  return {
    valued: new Set([...line.preloads.keys(), ...(line.inline ?? []), ...(line.valued ?? [])]),
    flags: new Set([...line.flags, ...(line.stdin === true ? ["-"] : [])]),
    optional: new Set(line.optional),
  };
}

/** The entries that name the runtime's own standard input: https://man7.org/linux/man-pages/man4/fd.4.html */
const STDIN_PATHS: ReadonlySet<string> = new Set(["/dev/stdin", "/dev/fd/0"]);

/**
 * How a runtime reads its words, those after its program word, {@link UNKNOWN} where one of
 * its options is unhandled, or `undefined` where a word it needs is dynamic: the one reading
 * layer 2 runs a runtime by and layer 3 finds the word that may write its entry by.
 */
function runtimeLine(line: Runtime, words: readonly Word[]): RuntimeLine | Unknown | undefined {
  const options = runtimeOptions(line);
  const before = optionsOf(words, options);
  if (before === undefined || isUnknown(before)) {
    return before;
  }
  const picked = words[before.at]?.value;
  const modal =
    line.modes?.has(picked ?? "") === true &&
    words
      .slice(0, before.at)
      .every((word) => line.modeAfter === undefined || line.modeAfter.has(word.value ?? ""));
  const from = picked !== undefined && line.subcommands?.has(picked) === true ? before.at + 1 : 0;
  const read = from === 0 ? before : optionsOf(words.slice(from), options);
  if (read === undefined || isUnknown(read)) {
    return read;
  }
  const values = (name: string): readonly string[] => [
    ...(from === 0 ? [] : (before.values.get(name) ?? [])),
    ...(read.values.get(name) ?? []),
  ];
  const named = new Set([...(from === 0 ? [] : before.named), ...read.named]);
  const runner = (line.runner ?? []).some((name) => named.has(name));
  const inline = runner || (line.inline ?? []).some((name) => values(name).length > 0);
  // `-` runs its standard input, and hands every later word to it.
  const dash = words.slice(0, from + read.at).some((word) => word.value === "-");
  const entry = dash ? words.length : from + read.at;
  const piped = STDIN_PATHS.has(words[entry]?.value ?? "");
  return {
    entry: inline || piped || entry >= words.length || (from === 0 && modal) ? undefined : entry,
    stdin: !inline && (piped || (line.stdin === true && entry >= words.length)),
    tests: runner ? from + read.at : undefined,
    named,
    preloads: [...line.preloads].flatMap(([name, resolution]) =>
      values(name).map((specifier) => ({ specifier, resolution })),
    ),
  };
}

/** The reader of a runtime's command line. */
function runtime(line: Runtime): Reader {
  return (words) => {
    const read = runtimeLine(line, words);
    if (isUnknown(read)) {
      return UNKNOWN;
    }
    const entry = read?.entry === undefined ? undefined : words[read.entry];
    if (
      read === undefined ||
      (read.stdin && words.some((word) => word.value === "-")) ||
      (entry !== undefined && entry.value === undefined) ||
      read.preloads.some((one) => preloadTarget(one, "/") === undefined)
    ) {
      return undefined;
    }
    return {
      kind: "run",
      entry: entry?.value,
      preloads: read.preloads,
      runtime: line.runsNode && entry !== undefined ? "node" : undefined,
    };
  };
}

/** The options that run their value, code or a script's name, in a runtime's entry's place. */
const INLINE = ["-e", "--eval", "-p", "--print"];

/**
 * `node [options] [entry] [arguments]`, https://nodejs.org/api/cli.html: the options that load
 * a module before the entry, `-r` as `require` does and the rest as an ECMAScript module;
 * `--run`, which runs a script of the manifest; and the options that leave the entry where it
 * is, `--inspect` and its kin and V8's taking their value only after `=`. With no entry, or
 * `-`, it runs its standard input, which the second layer does not read, but where `--test`
 * runs its test runner on the files its operands, or its default patterns, name.
 */
const NODE: Runtime = {
  preloads: new Map([
    ["-r", "require"],
    ["--require", "require"],
    ["--import", "import"],
    ["--loader", "import"],
    ["--experimental-loader", "import"],
  ]),
  flags: long(
    ...["no-warnings", "no-deprecation", "enable-source-maps", "experimental-vm-modules"],
    ...["experimental-strip-types", "no-experimental-strip-types", "experimental-transform-types"],
    ...["experimental-detect-module", "no-experimental-detect-module"],
    ...["experimental-require-module", "no-experimental-require-module", "trace-warnings"],
    ...["trace-deprecation", "trace-uncaught", "throw-deprecation", "pending-deprecation"],
    ...["expose-gc", "preserve-symlinks", "preserve-symlinks-main", "frozen-intrinsics"],
    ...["abort-on-uncaught-exception", "watch", "watch-preserve-output", "jitless"],
    ...["openssl-legacy-provider", "use-openssl-ca", "use-system-ca", "use-bundled-ca"],
    ...["no-addons", "insecure-http-parser", "version", "help", "v8-options", "test"],
    ...["test-only", "test-force-exit", "test-update-snapshots", "test-randomize"],
    ...["experimental-test-coverage", "experimental-test-module-mocks", "no-strip-types"],
    ...["experimental-test-snapshots"],
  ).concat(["-v", "-h"]),
  valued: [
    "-C",
    ...long("conditions", "input-type", "env-file", "env-file-if-exists", "title"),
    ...long("disable-warning", "unhandled-rejections", "watch-path", "dns-result-order"),
    ...long("icu-data-dir", "redirect-warnings", "diagnostic-dir", "max-http-header-size"),
    ...long("test-reporter", "test-reporter-destination", "test-concurrency", "test-timeout"),
    ...long("test-name-pattern", "test-skip-pattern", "test-shard", "test-isolation"),
    ...long("test-coverage-include", "test-coverage-exclude", "test-coverage-branches"),
    ...long("test-coverage-functions", "test-coverage-lines", "test-global-setup"),
  ],
  optional: long("inspect", "inspect-brk", "inspect-wait", "max-old-space-size", "stack-size"),
  runsNode: true,
  inline: [...INLINE, "--run"],
  stdin: true,
  runner: ["--test"],
};

/**
 * `tsx [watch] [options] <file> [arguments]`, https://tsx.is/usage, which takes Node's options
 * too: https://tsx.is/node-enhancement
 */
const TSX: Runtime = {
  preloads: new Map([
    ["-r", "require"],
    ["--require", "require"],
    ["--import", "import"],
  ]),
  // `tsx --test` runs Node's test runner on files only `node --test` is read for, so it caps.
  flags: [...NODE.flags.filter((name) => name !== "--test"), "--no-cache"],
  valued: [...(NODE.valued ?? []), "--tsconfig"],
  optional: NODE.optional ?? [],
  runsNode: false,
  subcommands: new Set(["watch"]),
  stdin: true,
};

/** `ts-node [options] [script] [arguments]`, https://typestrong.org/ts-node/docs/options; `--esm` picks no file. */
const TS_NODE: Runtime = {
  preloads: new Map([
    ["-r", "require"],
    ["--require", "require"],
  ]),
  flags: ["--esm", "-v", "--version", "-h", "--help"],
  runsNode: false,
  inline: INLINE,
};

/**
 * `bun [options] [run] [options] <file> [arguments]`, https://bun.com/docs/cli/run; its package
 * manager, test runner, bundler and `bun x` subcommands run no entry.
 */
const BUN: Runtime = {
  preloads: new Map([
    ["-r", "require"],
    ["--preload", "require"],
  ]),
  flags: [
    "--watch",
    "--hot",
    "--smol",
    "--bun",
    "--silent",
    "--no-install",
    "-v",
    "--version",
  ].concat(["-h", "--help"]),
  runsNode: false,
  subcommands: new Set(["run"]),
  modes: new Set(
    ["install", "i", "add", "a", "remove", "rm", "update", "outdated", "link", "unlink", "pm"]
      .concat(["test", "build", "init", "create", "c", "upgrade", "publish", "patch", "audit"])
      .concat(["info", "repl", "exec", "x"]),
  ),
  inline: INLINE,
};

/**
 * `deno [run|serve] [options] <file> [arguments]`, https://docs.deno.com/runtime/reference/cli/run/
 * and https://docs.deno.com/runtime/reference/cli/serve/, with the permission flags written
 * whole; its other subcommands run no entry: https://docs.deno.com/runtime/reference/cli/,
 * found past its global options only, so `deno -A lint` runs `lint`:
 * https://github.com/denoland/deno/blob/main/libs/cli_parser/src/parse.rs
 */
const DENO: Runtime = {
  preloads: new Map(),
  flags: ["-A", "--allow-all", "-q", "--quiet", "--watch", "--no-check", "-V", "--version"].concat(
    ["-h", "--help"],
    ["read", "write", "net", "env", "run", "sys", "ffi", "import"].map((name) => `--allow-${name}`),
  ),
  runsNode: false,
  subcommands: new Set(["run", "serve"]),
  modeAfter: new Set(["-q", "--quiet"]),
  modes: new Set(
    ["task", "test", "fmt", "lint", "compile", "install", "uninstall", "eval", "repl", "bench"]
      .concat(["check", "doc", "info", "init", "upgrade", "cache", "coverage", "types", "add"])
      .concat(["remove", "outdated", "publish", "jupyter", "clean", "completions", "help"]),
  ),
};

/** Hands on the command `words` from `at`, after the assignments `assigns` accepts. */
function afterAssignments(
  words: readonly Word[],
  at: number,
  assigns: (value: string) => boolean,
): Reading | undefined {
  let end = at;
  for (
    let word = words[end];
    word !== undefined && startOf(word).includes("=");
    word = words[end]
  ) {
    if (!assigns(startOf(word))) {
      return undefined;
    }
    end += 1;
  }
  const program = words[end];
  if (program !== undefined && (program.value === undefined || program.value.startsWith("-"))) {
    return undefined;
  }
  return program === undefined
    ? { kind: "run", entry: undefined, preloads: [], runtime: undefined }
    : { kind: "command", words: words.slice(end), at: end };
}

/**
 * GNU env's options, https://www.gnu.org/software/coreutils/manual/html_node/env-invocation.html,
 * whose `-S` and `--split-string` give a command line:
 * https://www.gnu.org/software/coreutils/manual/html_node/env-invocation.html#g_t_002dS_002f_002d_002dsplit_002dstring-usage-in-scripts
 */
const ENV: Options = {
  valued: new Set(["-u", "--unset", "-S", "--split-string", "-C", "--chdir"]),
  flags: new Set([
    ...["-i", "--ignore-environment", "-", "-v", "--debug", "-0", "--null"],
    "--list-signal-handling",
  ]),
  attached: true,
  optional: new Set(long("default-signal", "ignore-signal", "block-signal")),
};

/** env's options that give a command line, and the one that moves it to another directory. */
const SPLIT: ReadonlySet<string> = new Set(["-S", "--split-string"]);
const CHDIR: ReadonlySet<string> = new Set(["-C", "--chdir"]);

/**
 * The command line env runs where a `-S` or `--split-string` stands: GNU env splits its value
 * on blanks, puts those words in place of the option and its value, before env's later words,
 * and reads its options again from the first of them, parse_split_string of
 * https://github.com/coreutils/coreutils/blob/master/src/env.c. {@link UNKNOWN} where the value
 * is dynamic, writes a quote, an escape, a `$` or a `#`, which env reads otherwise, or follows
 * a `-C`; `undefined` where none stands.
 */
function envSplit(words: readonly Word[]): string | Unknown | undefined {
  const { options } = scanOptions(words, ENV);
  const split = options.findIndex(({ name }) => SPLIT.has(name));
  const value = options[split]?.value;
  if (value === undefined) {
    return undefined;
  }
  const text = words[value.at]?.value?.slice(value.prefix.length);
  if (
    text === undefined ||
    /['"\\$#]/u.test(text) ||
    options.slice(0, split).some(({ name }) => CHDIR.has(name))
  ) {
    return UNKNOWN;
  }
  const spliced = text.split(/\s+/u).filter((one) => one !== "");
  const later = words.slice(value.at + 1).map((word) => word.text);
  return ["env", ...spliced.map((one) => `'${one}'`), ...later].join(" ");
}

/**
 * `env [option]... [name=value]... [command [argument]...]`: the options that change only the
 * environment, `-i`, `-u` and `-v` in each spelling, and `-S`, read by {@link envSplit}. GNU env
 * takes any word holding an `=` after its first character as an assignment, and fails before
 * running anything on a `-u` name that is empty or holds an `=`. A dynamic word whose written
 * start is an assignment's is one, as env reads the text it expands to.
 */
const env: Reader = (words) => {
  const split = envSplit(words);
  if (split !== undefined) {
    return typeof split === "string" ? { kind: "line", text: split } : split;
  }
  const read = optionsOf(words, ENV);
  if (read === undefined || isUnknown(read) || [...CHDIR].some((name) => read.named.has(name))) {
    return read === undefined ? undefined : UNKNOWN;
  }
  const unset = [...(read.values.get("-u") ?? []), ...(read.values.get("--unset") ?? [])];
  return unset.some((name) => name === "" || name.includes("="))
    ? undefined
    : afterAssignments(words, read.at, (value) => !value.startsWith("="));
};

/** The command line env runs where a `-S` stands, as {@link envSplit} reads it. */
function envLines(words: readonly Word[]): Lines {
  const split = envSplit(words);
  return typeof split === "string" ? { ...NO_LINES, texts: [split] } : NO_LINES;
}

/** `cross-env [name=value]... command [argument]...`, https://github.com/kentcdodds/cross-env#usage */
const crossEnv: Reader = (words) => {
  const reading = afterAssignments(words, 0, (value) => /^\w+=/u.test(value));
  return reading?.kind === "command" ? reading : undefined;
};

/** The command a package runner's operand names: a package specifier's, whose version picks no other command. */
function commandName(operand: string, packaged: boolean): string {
  return packaged ? operand.replace(/(?<=.)@[^/@]*$/u, "") : operand;
}

/** The command a package runner hands on: its first word a package's or a command's name. */
function runnerCommand(words: readonly Word[], packaged: boolean): Reading | undefined {
  const [first, ...rest] = words;
  if (first?.value === undefined || first.value.startsWith("-")) {
    return undefined;
  }
  const name = commandName(first.value, packaged);
  return { kind: "command", words: [{ value: name, text: first.text }, ...rest], at: 0 };
}

/**
 * npx's and npm exec's options, https://docs.npmjs.com/cli/v11/commands/npx and
 * https://docs.npmjs.com/cli/v11/commands/npm-exec: `--package` (and npx's `-p`), `-c` and
 * `--call`, which give a command line, `--yes` and `--no`.
 */
function packageExecOptions(shortPackage: boolean): Options {
  return {
    valued: new Set(["--package", "-c", "--call", ...(shortPackage ? ["-p"] : [])]),
    flags: new Set(["-y", "--yes", "--no"]),
  };
}

const NPX = packageExecOptions(true);
const NPM_EXEC = packageExecOptions(false);
const CALL: ReadonlySet<string> = new Set(["-c", "--call"]);

/**
 * npx and npm exec, by `options`, before the first positional word, which is the package whose
 * command runs unless a `--package` names one. npm exec reads options after it too, unless a
 * `--` ends them.
 */
function packageExec(options: Options, laterOptions: boolean): Reader {
  return (words) => {
    const read = optionsOf(words, options);
    if (read === undefined || isUnknown(read)) {
      return read;
    }
    const operands = words.slice(read.at);
    if (laterOptions && !read.ended && operands.some((word) => word.value === undefined)) {
      return undefined;
    }
    // npm exec reads an option after its command as its own, whose table no row places.
    if (laterOptions && !read.ended && operands.some((word) => word.value?.startsWith("-"))) {
      return UNKNOWN;
    }
    const call = [...(read.values.get("-c") ?? []), ...(read.values.get("--call") ?? [])];
    if (call.length > 0) {
      return call.length === 1 && operands.length === 0 && call[0] !== undefined
        ? { kind: "line", text: call[0] }
        : undefined;
    }
    const packages = [...(read.values.get("--package") ?? []), ...(read.values.get("-p") ?? [])];
    return after(read.at, runnerCommand(operands, packages.length === 0));
  };
}

const npx = packageExec(NPX, false);
const npmExec = packageExec(NPM_EXEC, true);

/**
 * `npm run <script> [-- <arguments>]`, https://docs.npmjs.com/cli/v11/commands/npm-run-script:
 * it runs another script of the same manifest, which is read on its own.
 */
const npmRun: Reader = (words) => {
  const [script, ...rest] = words;
  const ended = rest.findIndex((word) => word.value === "--");
  const before = ended < 0 ? rest : rest.slice(0, ended);
  if (
    script?.value === undefined ||
    script.value.startsWith("-") ||
    before.some((word) => word.value?.startsWith("-") !== false)
  ) {
    return undefined;
  }
  return { kind: "run", entry: undefined, preloads: [], runtime: undefined };
};

/** `reading`, of the words after `skipped` others, as a reading of those words and them. */
function after<Read extends Reading | Unknown | undefined>(skipped: number, reading: Read): Read {
  return reading?.kind === "command" ? { ...reading, at: reading.at + skipped } : reading;
}

/**
 * A tool whose second word picks the reader of the rest. Where its own options `options` stand
 * before that word, it is not read, as they may run the command in another directory, and
 * {@link UNKNOWN} where `options` does not hold one.
 */
function subcommands(readers: ReadonlyMap<string, Reader>, options?: Options): Reader {
  return (words) => {
    const [first, ...rest] = words;
    if (options !== undefined && first?.value?.startsWith("-") === true) {
      return isUnknown(optionsOf(words, options)) ? UNKNOWN : undefined;
    }
    return first?.value === undefined ? undefined : after(1, readers.get(first.value)?.(rest));
  };
}

/** npm's own options before its subcommand: https://docs.npmjs.com/cli/v11/using-npm/config */
const NPM: Options = {
  valued: new Set(["-w", ...long("workspace", "prefix", "loglevel")]),
  flags: new Set([
    ...["-ws", ...letters("sqdy")],
    ...long("workspaces", "no-workspaces", "include-workspace-root", "if-present", "silent"),
    ...long("quiet", "verbose", "yes", "no"),
    ...["-v", "-h", ...long("version", "help")],
  ]),
};

/** `npm exec`, `npm x` and `npm run` with `run-script`. */
const npm = subcommands(
  new Map([
    ["exec", npmExec],
    ["x", npmExec],
    ["run", npmRun],
    ["run-script", npmRun],
  ]),
  NPM,
);

/** `yarn dlx`'s options: https://yarnpkg.com/cli/dlx */
const YARN_DLX: Options = {
  valued: new Set(["-p", "--package"]),
  flags: new Set(["-q", "--quiet"]),
};

/** `bunx`'s options: https://bun.com/docs/pm/bunx */
const BUNX: Options = { valued: new Set(["-p", "--package"]), flags: new Set() };

/**
 * pnpm's own options, which it reads before or after its subcommand, `exec`'s `-c` among them:
 * https://pnpm.io/pnpm-cli#options, https://pnpm.io/filtering, https://pnpm.io/cli/recursive,
 * https://pnpm.io/cli/exec
 */
const PNPM: Options = {
  valued: new Set([
    ...["-C", "-F", ...long("dir", "filter", "filter-prod", "test-pattern", "resume-from")],
    ...long("changed-files-ignore-pattern", "workspace-concurrency", "reporter", "loglevel"),
  ]),
  flags: new Set([
    ...letters("wrscvh"),
    ...long("version", "help"),
    ...long("workspace-root", "recursive", "parallel", "stream", "aggregate-output", "bail"),
    ...long("no-bail", "sort", "no-sort", "reverse", "report-summary", "fail-if-no-match"),
    ...long("silent", "color", "no-color", "shell-mode"),
  ]),
  attached: true,
};

/** The options of `pnpm exec` and `pnpm dlx` that run their operands in a shell: https://pnpm.io/cli/exec, https://pnpm.io/cli/dlx */
const PNPM_LINES: ReadonlySet<string> = new Set(["-c", "--shell-mode"]);

/** pnpm's options after `dlx`, its own and `--package`. */
const PNPM_DLX_OPTIONS: Options = { ...PNPM, valued: new Set([...PNPM.valued, "--package"]) };

/**
 * `pnpm exec <command>`, https://pnpm.io/cli/exec, which hands on every later word, read where
 * no option of pnpm's stands before it, which may run it in another directory or a shell.
 */
const pnpmExec: Reader = (words) => {
  const read = optionsOf(words, PNPM);
  if (read === undefined || isUnknown(read)) {
    return read;
  }
  return read.at > 0 ? undefined : runnerCommand(words, false);
};

/**
 * `pnpm dlx [--package <name>]... <command>`, https://pnpm.io/cli/dlx, and `pnpx`, its alias:
 * https://pnpm.io/cli/dlx#pnpx. Another option of pnpm's stands only unread.
 */
const pnpmDlx: Reader = (words) => {
  const read = optionsOf(words, PNPM_DLX_OPTIONS);
  if (read === undefined || isUnknown(read)) {
    return read;
  }
  return [...read.named].some((name) => name !== "--package")
    ? undefined
    : after(read.at, runnerCommand(words.slice(read.at), !read.values.has("--package")));
};

const pnpm = subcommands(
  new Map<string, Reader>([
    ["exec", pnpmExec],
    ["dlx", pnpmDlx],
  ]),
  PNPM,
);

/** yarn's own options before its subcommand: https://yarnpkg.com/cli */
const YARN: Options = {
  valued: new Set(["--cwd"]),
  flags: new Set(["-v", "-h", ...long("version", "help")]),
};

/**
 * `yarn node`, https://yarnpkg.com/cli/node, and `yarn dlx [-p <name>]... <command>`,
 * https://yarnpkg.com/cli/dlx, whose command runs in the current directory.
 */
const yarn = subcommands(
  new Map<string, Reader>([
    [
      "node",
      (words) => ({ kind: "command", words: [{ value: "node", text: "node" }, ...words], at: -1 }),
    ],
    [
      "dlx",
      (words) => {
        const read = optionsOf(words, YARN_DLX);
        return read === undefined || isUnknown(read)
          ? read
          : after(
              read.at,
              runnerCommand(
                words.slice(read.at),
                !read.values.has("-p") && !read.values.has("--package"),
              ),
            );
      },
    ],
  ]),
  YARN,
);

/** `bunx [-p <name>] <command>[@version] [arguments]`, https://bun.com/docs/pm/bunx */
const bunx: Reader = (words) => {
  const read = optionsOf(words, BUNX);
  return read === undefined || isUnknown(read)
    ? read
    : after(read.at, runnerCommand(words.slice(read.at), true));
};

/** `bun x`, which is `bunx`, and else bun's own command line. */
const bun: Reader = (words) =>
  words[0]?.value === "x" ? after(1, bunx(words.slice(1))) : runtime(BUN)(words);

/**
 * The options a tool documents for naming its configuration file, each taking the file as its
 * value, the next word or, for a long one, the text after `=`.
 */
interface ConfigurationOptions {
  readonly valued: ReadonlySet<string>;
  /** Where set, the tool reads options only before its first operand, and these others take a value. */
  readonly beforeOperand?: ReadonlySet<string>;
}

/** Where the words after a tool's program word write the command lines it hands to a shell. */
interface Lines {
  /** The places of the words that may each be one, each with the option text it starts with. */
  readonly at: ReadonlyMap<number, string>;
  /** Whether it reads command lines from its standard input. */
  readonly input: boolean;
  /** Whether it runs the first word a tool before it appends, as `xargs sh -c` and `xargs bash` do. */
  readonly appended?: boolean;
  /**
   * Whether it may run a file no word writes: a script none writes, as `bash -- "$1"` runs, or
   * one after an option its table does not list.
   */
  readonly unwritten?: boolean;
  /** The places, each from one word up to before another, whose words joined by blanks are one command line. */
  readonly joined?: readonly (readonly [number, number])[];
  /** The command lines it runs that no word writes whole, as env runs its `-S` value's words before its later ones. */
  readonly texts?: readonly string[];
  /** The texts it replaces, in each word at {@link at}, with a part only the run knows. */
  readonly replaced?: RegExp;
}

const NO_LINES: Lines = { at: new Map(), input: false };

/** The places `at`, each a whole word that is a command line. */
function wholeWords(at: readonly number[]): ReadonlyMap<number, string> {
  return new Map(at.map((one) => [one, ""]));
}

/** How the words after the program word of a tool that hands its commands the paths it finds read. */
interface Appending {
  /** Where each command it runs starts, `undefined` where it has an option or a construct no row reads. */
  readonly starts: readonly number[] | undefined;
  /** The texts it replaces with each path, in each word from `from` on. */
  readonly replaced: RegExp | undefined;
  readonly from: number;
  /** Where its command's words end and the paths it is handed begin, as at `parallel`'s `:::`. */
  readonly end?: number;
}

/** How a tool runs a command written after it. */
interface Launch {
  /** The subcommands it runs one after, where it runs one only after a subcommand. */
  readonly after?: ReadonlySet<string>;
  /** Its own options, which may stand before its subcommand. */
  readonly options?: Options;
  /** For a tool that hands each command it runs the paths it finds, how its words read. */
  readonly appends?: (words: readonly Word[]) => Appending;
  /** For a tool that hands command lines to a shell, where its words write them. */
  readonly lines?: (words: readonly Word[]) => Lines;
  /** Whether it runs a command only as a line {@link lines} places, as a shell does. */
  readonly line?: boolean;
}

/** Whether a word's written text, the text beside its parts, writes a path: text other than `/`, `\`, `.` and `..`. */
function writesPath(written: string | undefined): boolean {
  return (written ?? "")
    .split(/[/\\]/u)
    .some((segment) => !["", ".", ".."].includes(segment.replaceAll(PART, "")));
}

/**
 * A shell's options: POSIX sh's one-letter ones and the `set` ones bash takes, which may share a
 * word and may start with `+`, https://pubs.opengroup.org/onlinepubs/9799919799/utilities/sh.html,
 * and bash's `-o`, `-O`, `--rcfile` and `--init-file`, which take the next word, and its long
 * flags: https://www.gnu.org/software/bash/manual/html_node/Invoking-Bash.html
 */
const SHELL_OPTIONS: Options = {
  valued: new Set(["-o", "-O", "--rcfile", "--init-file"]),
  flags: new Set([
    ...letters("abCefhimnuvxlsrBEHPTckptD"),
    ...long("login", "norc", "noprofile", "posix", "restricted", "verbose", "noediting"),
    ...long("debugger", "dump-po-strings", "dump-strings", "help", "version"),
  ]),
  attached: true,
};

/** A shell's one-letter options that give its operand as a command line, and the one that has it read its standard input. */
const SHELL_LINES: ReadonlySet<string> = new Set(["-c"]);
const SHELL_INPUT = "-s";

/**
 * A shell's command lines: with an option holding `c`, or a dynamic word before its first
 * operand whose written text is only letters, `-` and `+`, each such word and that operand; its
 * standard input where neither stands and no operand names a script, or an option holding `s`
 * or such a word may say so; else its first operand is its script, appended where none stands,
 * its options read by {@link SHELL_OPTIONS}. This is the shell's own scan, not
 * {@link scanOptions}: `-c` is a flag whose operand is the command line, never an attached value.
 */
function shellLines(words: readonly Word[]): Lines {
  const dynamic: number[] = [];
  let command = false;
  let input = false;
  let unread = false;
  let operand = words.length;
  for (let at = 0; at < words.length; at += 1) {
    const value = words[at]?.value;
    const written = words[at]?.written?.replaceAll(PART, "");
    if (value === undefined && (written === undefined || /^[A-Za-z+-]*$/u.test(written))) {
      dynamic.push(at);
    } else if (value === undefined) {
      operand = at;
      break;
    } else if (value === "--" || value === "-" || !/^[-+]/u.test(value)) {
      operand = value === "--" || value === "-" ? at + 1 : at;
      break;
    } else {
      const named = value.startsWith("--")
        ? [value]
        : Array.from(value.slice(1), (one) => `-${one}`);
      command ||= value.startsWith("-") && named.some((one) => SHELL_LINES.has(one));
      input ||= value.startsWith("-") && named.includes(SHELL_INPUT);
      unread ||= named.some(
        (one) => !SHELL_OPTIONS.flags.has(one) && !SHELL_OPTIONS.valued.has(one),
      );
      at += SHELL_OPTIONS.valued.has(named.at(-1) ?? "") ? 1 : 0;
    }
  }
  const lines = command || dynamic.length > 0;
  const script = command || input ? undefined : words[operand];
  return {
    at: wholeWords(lines ? [...dynamic, ...(operand < words.length ? [operand] : [])] : []),
    input: !command && (input || dynamic.length > 0 || operand >= words.length),
    appended: !input && operand >= words.length,
    unwritten:
      unread || (script !== undefined && script.value === undefined && !writesPath(script.written)),
  };
}

/** Every word after the program word, each a command line. */
function everyWord(words: readonly Word[]): Lines {
  return { at: wholeWords(words.map((_, at) => at)), input: false };
}

/**
 * The values of the options `lines` among a tool's options `options`, each a command line, as
 * {@link scanOptions} reads them before its first operand or, where `later`, before a `--`,
 * each with the text its word writes before it. Where an option `options` does not hold
 * stands, every later word may be one.
 */
function optionLines(
  options: Options,
  lines: ReadonlySet<string>,
  later = false,
): (words: readonly Word[]) => Lines {
  return (words) => {
    const at = new Map<number, string>();
    for (let from = 0; from < words.length;) {
      const scan = scanOptions(words, options, from);
      for (const { name, value } of scan.options) {
        if (value !== undefined && value.at < words.length && lines.has(name)) {
          at.set(value.at, value.prefix);
        }
      }
      if (scan.stop === "unread") {
        for (let one = scan.at; one < words.length; one += 1) {
          at.set(one, "");
        }
      }
      if (scan.stop !== "operand" || !later) {
        break;
      }
      from = scan.at + 1;
    }
    return { at, input: false };
  };
}

/**
 * The lines of a tool whose subcommand `names`, after its own options `options`, reads its
 * words, and those options, as `read` does; where one of those options is unread, any word may be one.
 */
function subcommandLines(
  names: ReadonlySet<string>,
  read: (words: readonly Word[], before: readonly Word[]) => Lines,
  options?: Options,
): (words: readonly Word[]) => Lines {
  return (words) => {
    const sub = options === undefined ? 0 : operandAt(words, options);
    if (sub === undefined) {
      return everyWord(words);
    }
    const name = words[sub]?.value;
    if (name === undefined || !names.has(name)) {
      return NO_LINES;
    }
    const found = read(words.slice(sub + 1), words.slice(0, sub)).at;
    return { at: new Map([...found].map(([at, prefix]) => [at + sub + 1, prefix])), input: false };
  };
}

/** The lines of `pnpm dlx` or `pnpx`, its words, after pnpm's options `before`, as {@link pnpmLines} reads them. */
function dlxLines(words: readonly Word[], before: readonly Word[] = []): Lines {
  const scans = [scanOptions(before, PNPM), scanOptions(words, PNPM_DLX_OPTIONS)];
  return scans.some(
    (scan) => scan.stop === "unread" || scan.options.some(({ name }) => PNPM_LINES.has(name)),
  )
    ? everyWord(words)
    : NO_LINES;
}

/**
 * The lines of `pnpm exec` and `pnpm dlx`: every operand where one of {@link PNPM_LINES}
 * stands among pnpm's options before or after the subcommand, or where one of them is unread.
 */
const pnpmLines = subcommandLines(new Set(["exec", "dlx"]), dlxLines, PNPM);

/** Each of `texts` as a pattern of each place it stands in a word, or `undefined` where none is. */
function textsPattern(texts: readonly string[]): RegExp | undefined {
  const written = texts.filter((text) => text !== "");
  return written.length === 0
    ? undefined
    : new RegExp(
        written.map((text) => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"),
        "gu",
      );
}

/** The words of an appending tool with an option or a construct no row reads. */
const UNREAD: Appending = { starts: undefined, replaced: undefined, from: 0 };

/** The long options named `names`. */
function long(...names: readonly string[]): readonly string[] {
  return names.map((name) => `--${name}`);
}

/** The one-letter options `letters` name. */
function letters(written: string): readonly string[] {
  return Array.from(written, (letter) => `-${letter}`);
}

/** https://www.gnu.org/software/findutils/manual/html_node/find_html/xargs-options.html */
const XARGS: Options = {
  valued: new Set([
    ...letters("adEILnPs"),
    ...long("arg-file", "delimiter", "max-args", "max-procs", "max-chars", "process-slot-var"),
  ]),
  flags: new Set([
    ...letters("0prtxo"),
    ...long("null", "interactive", "no-run-if-empty", "verbose", "exit", "open-tty", "show-limits"),
  ]),
  attached: true,
  optional: new Set(["-e", "-i", "-l", ...long("eof", "replace", "max-lines")]),
};

/**
 * `xargs [option]... [command [argument]...]`: its command starts after its options, and `-I`,
 * `-i` and `--replace` name the text it replaces with each path it reads, `{}` where `-i` or
 * `--replace` names none. With no command it runs `echo`.
 */
function xargs(words: readonly Word[]): Appending {
  const read = optionsOf(words, XARGS);
  if (read === undefined || isUnknown(read)) {
    return UNREAD;
  }
  const defaulted = [...(read.values.get("-i") ?? []), ...(read.values.get("--replace") ?? [])];
  return {
    starts: [read.at],
    replaced: textsPattern([
      ...(read.values.get("-I") ?? []),
      ...defaulted.map((text) => (text === "" ? "{}" : text)),
    ]),
    from: read.at,
  };
}

/** `find`'s actions that run a command up to a `;` or `+`, each `{}` in its words a path it finds: https://www.gnu.org/software/findutils/manual/html_node/find_html/Single-File.html */
const FIND_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/**
 * GNU find's options and primaries that take the next word, two for `-fprintf`:
 * https://www.gnu.org/software/findutils/manual/html_node/find_html/Primary-Index.html
 */
const FIND_VALUED = new Set([
  ...["-D", "-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex"],
  ...["-iregex", "-lname", "-ilname", "-type", "-xtype", "-user", "-group", "-uid", "-gid"],
  ...["-perm", "-size", "-mtime", "-atime", "-ctime", "-mmin", "-amin", "-cmin", "-newer"],
  ...["-anewer", "-cnewer", "-inum", "-links", "-samefile", "-used", "-fstype", "-context"],
  ...["-maxdepth", "-mindepth", "-printf", "-fprint", "-fprint0", "-fls", "-regextype"],
  ...["-files0-from", "-fprintf"],
]);

/** find's `-newerXY` primaries, which take the next word too. */
const FIND_NEWER = /^-newer[aBcm][aBcmt]$/u;

/**
 * `find`'s words: its paths, up to the first that starts with `-` or is `(` or `!`, then its
 * expression. A dynamic word that is no primary's value, nor a path the expression follows,
 * may be an action, a construct no row reads.
 */
function find(words: readonly Word[]): Appending {
  const starts: number[] = [];
  let paths = true;
  for (let at = 0; at < words.length; at += 1) {
    const value = words[at]?.value;
    paths &&= value === undefined || !(value.startsWith("-") || value === "(" || value === "!");
    const next = words[at + 1]?.value;
    if (value === undefined) {
      if (paths && (next === undefined ? at + 1 === words.length : /^[-(!]/u.test(next))) {
        continue;
      }
      return UNREAD;
    }
    if (FIND_VALUED.has(value) || FIND_NEWER.test(value)) {
      at += value === "-fprintf" ? 2 : 1;
      continue;
    }
    if (FIND_ACTIONS.has(value)) {
      starts.push(at + 1);
      at = words.findIndex(
        (word, end) =>
          end > at &&
          (word.value === ";" || (word.value === "+" && words[end - 1]?.value === "{}")),
      );
      at = at < 0 ? words.length : at;
    }
  }
  return { starts, replaced: /\{\}/gu, from: starts[0] ?? words.length };
}

/** GNU parallel's options naming a text other than a `{…}` that it replaces with a part of each path. */
const PARALLEL_REPLACING = [
  "-I",
  ...long("er", "extensionreplace", "bnr", "basenamereplace", "dnr", "dirnamereplace"),
  ...long("bner", "basenameextensionreplace", "seqreplace", "slotreplace"),
];

/** https://www.gnu.org/software/parallel/parallel.html */
const PARALLEL: Options = {
  valued: new Set([
    ...PARALLEL_REPLACING,
    ...letters("jNnLaCdSE"),
    ...long("jobs", "max-args", "max-lines", "arg-file", "colsep", "delimiter", "sshlogin"),
    ...long("joblog", "results", "delay", "timeout", "halt", "tmpdir", "workdir", "eof"),
  ]),
  flags: new Set([
    ...letters("kvq0uXmr"),
    ...long("keep-order", "verbose", "bar", "progress", "eta", "tag", "dry-run", "null"),
    ...long("quote", "ungroup", "group", "line-buffer", "lb", "xargs", "no-notice"),
    ...long("will-cite", "shuf", "plus", "no-run-if-empty", "pipe"),
  ]),
  attached: true,
};

/**
 * `parallel [option]... [command [argument]...] [::: argument... | :::: file...]`: its command
 * starts after its options and ends at the first `:::` or `::::`, and every `{…}` in it, each
 * one of the replacement strings it documents, and each text its replacing options name
 * stand for a part of each path it is handed. A `{=…=}`, the path a perl expression computes,
 * is a construct no row reads.
 */
function parallel(words: readonly Word[]): Appending {
  const read = optionsOf(words, PARALLEL);
  if (read === undefined || isUnknown(read)) {
    return UNREAD;
  }
  const end = words.findIndex((word, at) => at >= read.at && /^::::?\+?$/u.test(word.value ?? ""));
  const command = words.slice(read.at, end < 0 ? undefined : end);
  // The word parallel is handed, its quotes removed, as `'{''=…=}'` writes `{=…=}`.
  if (command.some((word) => (word.value ?? word.written ?? word.text).includes("{="))) {
    return UNREAD;
  }
  const texts = textsPattern(PARALLEL_REPLACING.flatMap((name) => read.values.get(name) ?? []));
  return {
    starts: [read.at],
    replaced: new RegExp(
      [/\{[^{}\s]*\}/u.source, ...(texts === undefined ? [] : [texts.source])].join("|"),
      "gu",
    ),
    from: read.at,
    ...(end < 0 ? {} : { end }),
  };
}

/**
 * `parallel` hands a shell its command's words joined by blanks as one command line; with no
 * command before its `:::` each word after it, and with none at all each line it reads.
 */
function parallelLines(words: readonly Word[]): Lines {
  const { starts, end } = parallel(words);
  const [start] = starts ?? [];
  if (start === undefined) {
    return everyWord(words);
  }
  if (start === end) {
    return { at: wholeWords(words.slice(start + 1).map((_, at) => start + 1 + at)), input: false };
  }
  return start === words.length
    ? { at: new Map(), input: true }
    : { at: new Map(), input: false, joined: [[start, end ?? words.length]] };
}

/**
 * concurrently's options, read by yargs before and after its commands, each a long one's
 * `=` spelling too: https://github.com/open-cli-tools/concurrently/blob/main/bin/index.ts
 */
const CONCURRENTLY: Options = {
  valued: new Set([
    ...["-m", "-n", "-s", "-p", "-c", "-l", "-t"],
    ...long("max-processes", "names", "success", "hide", "shell", "teardown", "kill-signal"),
    ...long("kill-timeout", "prefix", "prefix-colors", "prefix-length", "timestamp-format"),
    ...long("restart-tries", "restart-after", "default-input-target", "name-separator"),
  ]),
  flags: new Set([
    ...["-r", "-g", "-P", "-k", "-i", "-h", "-v", "-V"],
    ...long("raw", "no-color", "group", "timings", "passthrough-arguments", "kill-others"),
    ...long("kill-others-on-fail", "pad-prefix", "handle-input", "help", "version"),
  ]),
};

/** concurrently's `--teardown`, whose value is a command line it runs before it exits. */
const TEARDOWN = "--teardown";

/**
 * The words with a `{N}`, `{@}` or `{*}`, which concurrently replaces with the arguments after
 * its `--` under `-P`, a part only the run knows: a `CONCURRENTLY_PASSTHROUGH_ARGUMENTS`
 * variable, which yargs's `.env` reads, sets `-P` where no word writes it.
 */
const PLACEHOLDER = /\{(?:\d+|@|\*)\}/gu;

/**
 * concurrently's command lines: each word that is no option nor an option's value, each
 * `--teardown` value, and the words after a `--` but under `-P`, where they are its commands'
 * arguments. From an option {@link CONCURRENTLY} does not list, every word may be one.
 */
function concurrentlyLines(words: readonly Word[]): Lines {
  const at = new Map<number, string>();
  let passthrough = false;
  for (let one = 0; one < words.length; one += 1) {
    const value = words[one]?.value;
    if (value === "--") {
      for (let later = one + 1; !passthrough && later < words.length; later += 1) {
        at.set(later, "");
      }
      break;
    }
    if (value === undefined || value === "-" || !value.startsWith("-")) {
      at.set(one, "");
      continue;
    }
    const equals = value.startsWith("--") ? value.indexOf("=") : -1;
    const name = equals < 0 ? value : value.slice(0, equals);
    if (equals < 0 && CONCURRENTLY.flags.has(name)) {
      passthrough ||= name === "-P" || name === "--passthrough-arguments";
    } else if (CONCURRENTLY.valued.has(name)) {
      const valueAt = equals < 0 ? (one += 1) : one;
      if (name === TEARDOWN && valueAt < words.length) {
        at.set(valueAt, equals < 0 ? "" : `${TEARDOWN}=`);
      }
    } else {
      for (let later = one; later < words.length; later += 1) {
        at.set(later, "");
      }
      return { at, input: false, unwritten: true, replaced: PLACEHOLDER };
    }
  }
  return { at, input: false, replaced: PLACEHOLDER };
}

/** `eval`'s operands joined by blanks, one command line: https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html#eval */
function evalLines(words: readonly Word[]): Lines {
  const from = words[0]?.value === "--" ? 1 : 0;
  return from >= words.length ? NO_LINES : { ...NO_LINES, joined: [[from, words.length]] };
}

/**
 * The script `.` and `source` run in the shell itself, their first operand: one written with
 * no path runs a file no word writes, as `bash "$F"` does, and so does an option, which POSIX
 * gives them none of: https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html#dot
 */
function sourceLines(words: readonly Word[]): Lines {
  const script = words[words[0]?.value === "--" ? 1 : 0];
  return {
    ...NO_LINES,
    unwritten:
      script !== undefined &&
      (script.value === undefined
        ? !writesPath(script.written)
        : script.value.startsWith("-") && script.value !== "--"),
  };
}

/** One tool's row: the reader of its command, and the options it names its configuration file by. */
interface Row {
  readonly read?: Reader;
  readonly configurations?: ConfigurationOptions;
  /** For a runtime, its command line. */
  readonly runtime?: Runtime;
  /** For a tool that runs a command written after it, how. */
  readonly launches?: Launch;
  /** Its options as its documentation gives them, which its command lines are placed by where its launch places none. */
  readonly grammar?: Grammar;
}

/**
 * The row of a launcher whose reader is `read`, which runs a command after `after` where
 * given, read after its own options `options`.
 */
function launcher(
  read: Reader | undefined,
  after: readonly string[] = [],
  lines?: Launch["lines"],
  options?: Options,
): Row {
  return {
    ...(read === undefined ? {} : { read }),
    launches: {
      ...(after.length === 0 ? {} : { after: new Set(after) }),
      ...(lines === undefined ? {} : { lines }),
      ...(options === undefined ? {} : { options }),
    },
  };
}

/** The row of a runtime. */
function runs(line: Runtime): Row {
  return { read: runtime(line), runtime: line };
}

/** The row of a tool that names its configuration file by `options` anywhere before a `--`. */
function configuredBy(...options: readonly string[]): Row {
  return { configurations: { valued: new Set(options) } };
}

/** The row of a shell, whose `-c` runs its operand as a command line. */
const SHELL: Row = { launches: { line: true, lines: shellLines } };

/**
 * The reader of a tool that runs the command after its options `options`, the first operand,
 * or where `ended` the first word after a `--`, before which only its options stand.
 */
function afterOptions(options: Options, ended = false): Reader {
  return (words) => {
    const end = words.findIndex((word) => word.value === "--");
    const read = optionsOf(ended && end >= 0 ? words.slice(0, end) : words, options);
    if (read === undefined || isUnknown(read)) {
      return read;
    }
    if (ended && end >= 0 && read.at !== end) {
      return undefined;
    }
    const at = ended && end >= 0 ? end + 1 : read.at;
    const program = words[at];
    return program?.value === undefined || program.value.startsWith("-")
      ? undefined
      : { kind: "command", words: words.slice(at), at };
  };
}

/**
 * c8's options, `c8 [opts] [script] [opts]`, https://github.com/bcoe/c8#cli-options, read by
 * yargs, which clusters no valued option's value: https://github.com/bcoe/c8/blob/main/lib/parse-args.js
 */
const C8: Options = {
  valued: new Set([
    ...["-c", "-r", "-o", "-n", "-x", "-e"],
    ...long("config", "reporter", "reports-dir", "report-dir", "src", "include", "exclude"),
    ...long("extension", "branches", "functions", "lines", "statements", "temp-directory"),
    ...long("resolve", "wrapper-length"),
  ]),
  flags: new Set([
    "-a",
    ...long("all", "exclude-node-modules", "exclude-after-remap", "skip-full", "check-coverage"),
    ...long("per-file", "100", "clean", "omit-relative", "allowExternal", "merge-async"),
    ...long("experimental-monocart", "no-clean", "no-exclude-node-modules", "no-omit-relative"),
  ]),
};

/**
 * nyc's options, `nyc [options] [bin-to-instrument]`, https://github.com/istanbuljs/nyc#usage,
 * each of `@istanbuljs/schema`'s with its alias: https://github.com/istanbuljs/schema/blob/master/index.js
 */
const NYC: Options = {
  valued: new Set([
    ...["-t", "-x", "-n", "-e", "-i", "-r"],
    ...long("cwd", "temp-dir", "exclude", "include", "extension", "ignore-class-methods"),
    ...long("parser-plugins", "require", "reporter", "report-dir", "cache-dir", "nycrc-path"),
    ...long("branches", "functions", "lines", "statements"),
  ]),
  flags: new Set([
    ...["-s", "-a", "-c"],
    ...long("exclude-node-modules", "auto-wrap", "es-modules", "compact", "preserve-comments"),
    ...long("produce-source-map", "source-map", "instrument", "exclude-after-remap", "per-file"),
    ...long("check-coverage", "show-process-tree", "skip-empty", "skip-full", "silent", "all"),
    ...long("eager", "cache", "babel-cache", "use-spawn-wrap", "hook-require", "clean"),
    ...long("hook-run-in-context", "hook-run-in-this-context", "in-place", "exit-on-error"),
    ...long("delete", "complete-copy", "no-clean", "no-cache", "no-instrument"),
  ]),
};

/**
 * dotenv-cli's options, `dotenv [-e <path>] [-v <name>=<value>] [-c [env]] [-- command]`,
 * https://github.com/entropitor/dotenv-cli#usage. minimist reads a flag's next word as its
 * value, so only `-e`, `-v` and `-c` are read where no `--` stands; `-p` and `--debug` run nothing.
 */
const DOTENV: Options = {
  valued: new Set(["-e", "-v", "-c"]),
  flags: new Set(["-o", "--override", "--no-expand", "-q"]),
  optional: new Set(["--quiet"]),
};

/** dotenv-cli, reading its flags only before a `--`. */
const dotenv: Reader = (words) =>
  words.some((word) => word.value === "--")
    ? afterOptions(DOTENV, true)(words)
    : afterOptions({ valued: DOTENV.valued, flags: new Set() })(words);

/**
 * env-cmd's options, `env-cmd [options] -- <command> [...args]`, read by commander, which
 * clusters short options: https://github.com/toddbluhm/env-cmd#-help. `-e` takes every word
 * after it that starts with no `-`, so it is read only before a `--`.
 */
const ENV_CMD: Options = {
  valued: new Set(["-f", "--file"]),
  flags: new Set([
    "-x",
    ...long("expand-envs", "recursive", "fallback", "no-override", "silent", "use-shell"),
    "--verbose",
  ]),
  attached: true,
};

/** env-cmd, whose `-e` and `--environments` stand only before a `--`. */
const envCmd: Reader = (words) =>
  words.some((word) => word.value === "--")
    ? afterOptions(
        { ...ENV_CMD, valued: new Set([...ENV_CMD.valued, "-e", "--environments"]) },
        true,
      )(words)
    : afterOptions(ENV_CMD)(words);

/** env-cmd's `--use-shell` hands its command's words, joined by blanks, to a shell. */
function envCmdLines(words: readonly Word[]): Lines {
  const reading = envCmd(words);
  return reading?.kind === "command" && words.some((word) => word.value === "--use-shell")
    ? { at: new Map(), input: false, joined: [[reading.at, words.length]] }
    : NO_LINES;
}

/**
 * `dotenvx run [options] -- <command>`, https://dotenvx.com/docs/advanced/run, whose command
 * stands after `--`: https://github.com/dotenvx/dotenvx/blob/main/src/cli/dotenvx.js
 */
const DOTENVX_RUN: Options = {
  valued: new Set([
    ...["-e", "-f", "-fk"],
    ...long("env", "env-file", "env-keys-file", "convention", "ignore", "token"),
  ]),
  flags: new Set(["-o", ...long("overload", "strict", "no-armor", "no-native")]),
  attached: true,
};

/** dotenvx's own options before its subcommand: https://dotenvx.com/docs/cli */
const DOTENVX: Options = {
  valued: new Set(["-l", "--log-level"]),
  flags: new Set([
    "-q",
    "-v",
    "-d",
    "-V",
    "-h",
    ...long("quiet", "verbose", "debug", "version", "help"),
  ]),
};

/**
 * cross-env-shell, which runs its words after the assignments, joined by blanks, as one
 * command line: https://github.com/kentcdodds/cross-env#cross-env-vs-cross-env-shell
 */
function crossEnvShellLines(words: readonly Word[]): Lines {
  const at = words.findIndex((word) => !/^\w+=/u.test(startOf(word)));
  return at < 0 ? NO_LINES : { at: new Map(), input: false, joined: [[at, words.length]] };
}

/** The row of each tool, by the name its program word's last segment writes, but its grammar. */
const ROWS: ReadonlyMap<string, Row> = new Map<string, Row>([
  ["node", runs(NODE)],
  ["tsx", runs(TSX)],
  ["ts-node", runs(TS_NODE)],
  ["bun", { read: bun, runtime: BUN, launches: { after: new Set(["x"]) } }],
  ["deno", runs(DENO)],
  ["env", launcher(env, [], envLines)],
  ["cross-env", launcher(crossEnv)],
  ["cross-env-shell", launcher(undefined, [], crossEnvShellLines)],
  ["c8", launcher(afterOptions(C8))],
  ["nyc", launcher(afterOptions(NYC))],
  ["dotenv", launcher(dotenv)],
  ["env-cmd", launcher(envCmd, [], envCmdLines)],
  [
    "dotenvx",
    launcher(
      subcommands(new Map([["run", afterOptions(DOTENVX_RUN, true)]]), DOTENVX),
      ["run"],
      undefined,
      DOTENVX,
    ),
  ],
  [
    "npx",
    {
      ...launcher(npx),
      // `-c` takes a command line, which is read as a configuration file's name as well, so
      // every configuration `fixtures/commands/observed.json` records stays named.
      configurations: {
        valued: new Set(["-c"]),
        beforeOperand: new Set(["--package", "-p", "--call"]),
      },
    },
  ],
  // The readers of npm and pnpm leave their own options before the subcommand unread, as each
  // of them, `--workspace` and `--filter` among them, may run the command in another directory.
  [
    "npm",
    launcher(
      npm,
      ["exec", "x"],
      subcommandLines(new Set(["exec", "x"]), optionLines(NPM_EXEC, CALL, true), NPM),
      NPM,
    ),
  ],
  // pnpm and yarn run a package's command of a name that is none of theirs:
  // https://pnpm.io/pnpm-cli, https://yarnpkg.com/cli/run; `yarn exec` runs its command in the
  // workspace's root, https://yarnpkg.com/cli/exec
  ["pnpm", launcher(pnpm, [], pnpmLines)],
  ["pnpx", launcher(pnpmDlx, [], (words) => dlxLines(words))],
  ["yarn", launcher(yarn)],
  ["bunx", launcher(bunx)],
  // The shell's `exec`, `command` and `builtin`, and the wrappers that run their operands.
  ...["exec", "command", "builtin", "nohup", "nice", "time", "timeout", "sudo"].map(
    (name) => [name, launcher(undefined)] as const,
  ),
  ["eval", { launches: { lines: evalLines } }],
  ["concurrently", { launches: { lines: concurrentlyLines } }],
  ...[".", "source"].map(
    (name) => [name, { launches: { line: true, lines: sourceLines } }] as const,
  ),
  ...["sh", "bash", "dash", "zsh", "ksh", "ash"].map((name) => [name, SHELL] as const),
  ["xargs", { launches: { appends: xargs } }],
  ["find", { launches: { appends: find } }],
  ["parallel", { launches: { appends: parallel, lines: parallelLines } }],
  // https://eslint.org/docs/latest/use/command-line-interface
  ["eslint", configuredBy("-c", "--config")],
  // https://prettier.io/docs/cli, whose `-c` is `--check`.
  ["prettier", configuredBy("--config")],
  // https://stylelint.io/user-guide/cli
  ["stylelint", configuredBy("-c", "--config")],
  // https://jestjs.io/docs/cli
  ["jest", configuredBy("-c", "--config")],
  // https://vitest.dev/guide/cli
  ["vitest", configuredBy("-c", "--config")],
  // https://vite.dev/guide/cli
  ["vite", configuredBy("-c", "--config")],
  // https://webpack.js.org/api/cli/
  ["webpack", configuredBy("-c", "--config")],
  // https://mochajs.org/#command-line-usage, whose `-c` is `--color`.
  ["mocha", configuredBy("--config")],
]);

/** A runtime's {@link Grammar}, from the same table its reader reads by. */
function runtimeGrammar(line: Runtime, doc: string): Grammar {
  const { valued, flags, optional } = runtimeOptions(line);
  const inline = new Set([...(line.inline ?? []), ...(line.runner ?? [])]);
  const options: Options = {
    valued: new Set([...valued].filter((name) => !inline.has(name))),
    flags: new Set([...flags].filter((name) => name !== "-" && !inline.has(name))),
    ...(optional === undefined || optional.size === 0 ? {} : { optional }),
  };
  const one: Grammar = { options, operand: "file", inline, doc };
  const modes = {
    ...(line.modes === undefined ? {} : { modes: line.modes }),
    ...(line.modeAfter === undefined ? {} : { modeAfter: line.modeAfter }),
  };
  return {
    ...one,
    ...modes,
    subcommands: new Map([...(line.subcommands ?? [])].map((name) => [name, one])),
  };
}

/**
 * Each tool's {@link Grammar}: its options, the object its reader parses with, and how its
 * other words read, which production reads only through {@link linesOf} and the enumerated
 * property spells whole. Tools with no table, `sudo` and `nohup` among them, have none: after
 * them every later word may be a program word.
 */
const GRAMMARS: ReadonlyMap<string, Grammar> = new Map<string, Grammar>([
  ["node", runtimeGrammar(NODE, "https://nodejs.org/api/cli.html")],
  ["tsx", runtimeGrammar(TSX, "https://tsx.is/usage")],
  ["ts-node", runtimeGrammar(TS_NODE, "https://typestrong.org/ts-node/docs/options")],
  ["bun", runtimeGrammar(BUN, "https://bun.com/docs/cli/run")],
  ["deno", runtimeGrammar(DENO, "https://docs.deno.com/runtime/reference/cli/run/")],
  [
    "env",
    {
      options: ENV,
      operand: "command",
      lines: new Set(["-S", "--split-string"]),
      doc: "https://www.gnu.org/software/coreutils/manual/html_node/env-invocation.html",
    },
  ],
  [
    "npx",
    {
      options: NPX,
      operand: "command",
      lines: CALL,
      doc: "https://docs.npmjs.com/cli/v11/commands/npx",
    },
  ],
  [
    "npm",
    {
      options: NPM,
      operand: "command",
      subcommands: new Map(
        ["exec", "x"].map((name) => [
          name,
          {
            options: NPM_EXEC,
            operand: "command",
            lines: CALL,
            later: true,
            doc: "https://docs.npmjs.com/cli/v11/commands/npm-exec",
          },
        ]),
      ),
      doc: "https://docs.npmjs.com/cli/v11/using-npm/config",
    },
  ],
  [
    "pnpm",
    {
      options: PNPM,
      operand: "command",
      subcommands: new Map([
        [
          "exec",
          { options: PNPM, operand: "command", lines: PNPM_LINES, doc: "https://pnpm.io/cli/exec" },
        ],
        [
          "dlx",
          {
            options: PNPM_DLX_OPTIONS,
            operand: "command",
            lines: PNPM_LINES,
            doc: "https://pnpm.io/cli/dlx",
          },
        ],
      ]),
      lines: PNPM_LINES,
      doc: "https://pnpm.io/pnpm-cli#options",
    },
  ],
  [
    "yarn",
    {
      options: YARN,
      operand: "command",
      subcommands: new Map([
        ["dlx", { options: YARN_DLX, operand: "command", doc: "https://yarnpkg.com/cli/dlx" }],
      ]),
      doc: "https://yarnpkg.com/cli",
    },
  ],
  ["bunx", { options: BUNX, operand: "command", doc: "https://bun.com/docs/pm/bunx" }],
  [
    "pnpx",
    {
      options: PNPM_DLX_OPTIONS,
      operand: "command",
      lines: PNPM_LINES,
      doc: "https://pnpm.io/cli/dlx#pnpx",
    },
  ],
  ["c8", { options: C8, operand: "command", doc: "https://github.com/bcoe/c8#cli-options" }],
  ["nyc", { options: NYC, operand: "command", doc: "https://github.com/istanbuljs/nyc#usage" }],
  // Its flags stand only before a `--`, so a form with one before no `--` caps.
  [
    "dotenv",
    { options: DOTENV, operand: "command", doc: "https://github.com/entropitor/dotenv-cli#usage" },
  ],
  [
    "env-cmd",
    {
      options: ENV_CMD,
      operand: "command",
      lines: new Set(["--use-shell"]),
      doc: "https://github.com/toddbluhm/env-cmd#-help",
    },
  ],
  [
    "dotenvx",
    {
      options: DOTENVX,
      operand: "command",
      subcommands: new Map([
        [
          "run",
          {
            options: DOTENVX_RUN,
            operand: "command",
            ended: true,
            doc: "https://dotenvx.com/docs/advanced/run",
          },
        ],
      ]),
      doc: "https://dotenvx.com/docs",
    },
  ],
  ...["sh", "bash", "dash", "zsh", "ksh", "ash"].map(
    (name) =>
      [
        name,
        {
          options: SHELL_OPTIONS,
          operand: "line",
          lines: SHELL_LINES,
          doc: "https://pubs.opengroup.org/onlinepubs/9799919799/utilities/sh.html",
        },
      ] as const,
  ),
  [
    "concurrently",
    {
      options: CONCURRENTLY,
      operand: "lines",
      lines: new Set([TEARDOWN]),
      doc: "https://github.com/open-cli-tools/concurrently/blob/main/bin/index.ts",
    },
  ],
  [
    "xargs",
    {
      options: XARGS,
      operand: "appended",
      doc: "https://www.gnu.org/software/findutils/manual/html_node/find_html/xargs-options.html",
    },
  ],
  [
    "parallel",
    {
      options: PARALLEL,
      operand: "appended",
      doc: "https://www.gnu.org/software/parallel/parallel.html",
    },
  ],
]);

/**
 * The row of each tool, by the name its program word's last segment writes, with its grammar,
 * which the enumerated property of `text/named-files.property.test.ts` spells every option of.
 */
export const TOOLS: ReadonlyMap<string, Row> = new Map(
  [...ROWS].map(([name, row]) => {
    const grammar = GRAMMARS.get(name);
    return [name, grammar === undefined ? row : { ...row, grammar }];
  }),
);

/** Where the words after the program word of `row` write the command lines it hands to a shell. */
function linesOf(row: Row | undefined): ((words: readonly Word[]) => Lines) | undefined {
  const grammar = row?.grammar;
  return (
    row?.launches?.lines ??
    (grammar?.lines === undefined || row?.launches === undefined
      ? undefined
      : optionLines(grammar.options, grammar.lines, grammar.later))
  );
}

/**
 * The row of a simple command's program word, by the name its last path segment writes, as a
 * package runner's operand where `packaged`, its version removed.
 */
function rowOf(program: Word | undefined, packaged = false): Row | undefined {
  const name = programName(program)?.replace(/\.(?:exe|cmd)$/iu, "");
  return name === undefined ? undefined : TOOLS.get(commandName(name, packaged));
}

/**
 * The last path segment of a program word, a dynamic one's too where it writes that segment
 * whole after a `/`, as `"$(npm root)/.bin/tsx"` does, or `undefined` where the run computes it.
 */
function programName(program: Word | undefined): string | undefined {
  const text = program?.value ?? program?.written;
  const last = text?.slice(text.lastIndexOf("/") + 1);
  return last === undefined ||
    last.includes(PART) ||
    (program?.value === undefined && last === text)
    ? undefined
    : last;
}

/** What the reader of one simple command's program reads it as, or `undefined` where none understands it. */
export function readTool(words: readonly Word[]): Reading | undefined {
  const reading = readRow(words);
  return reading?.kind === "unknown" ? undefined : reading;
}

/** The command each launcher of `words` hands on to in turn, as {@link readTool} reads it, and what its last one is read as. */
export function handedOn(
  words: readonly Word[],
): readonly [readonly Word[], Exclude<Reading, { readonly kind: "command" }> | undefined] {
  let handed = words;
  let reading = readTool(handed);
  while (reading?.kind === "command") {
    handed = reading.words;
    reading = readTool(handed);
  }
  return [handed, reading];
}

/** What one simple command writes to its standard output, by the places of its words, the program word's 0. */
export interface Output {
  /** The places of the words each written as one line, as `cat`'s operands name files. */
  readonly at: readonly number[];
  /** The places, from one word up to before another, whose words joined by blanks are one line. */
  readonly joined: readonly (readonly [number, number])[];
  /** The lines it writes that no word writes whole. */
  readonly texts: readonly string[];
  /** Whether it writes its own standard input too. */
  readonly input: boolean;
}

/** bash's `echo` options, which a word holds only, and a word holding any other letter is written: https://www.gnu.org/software/bash/manual/html_node/Bash-Builtins.html#index-echo */
const ECHO_OPTION = /^-[neE]+$/u;

/** The escapes of a `printf` format this reading writes, each the text it stands for; any other is unread. */
const PRINTF_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["\\n", "\n"],
  ["\\t", "\t"],
  ["\\\\", "\\"],
  ["%%", "%"],
]);

/**
 * What one simple command writes to its standard output, `undefined` where no row reads it,
 * another program's output among it. `echo` writes its operands joined by blanks as one line,
 * `undefined` where one holds a `\` or `-e` stands, as XSI echo reads escapes:
 * https://pubs.opengroup.org/onlinepubs/9799919799/utilities/echo.html. `printf` writes its
 * format, `undefined` where it holds a conversion or an escape other than `%%`, `\n`, `\t` and
 * `\\`, or other operands follow it, whose output POSIX leaves unspecified:
 * https://pubs.opengroup.org/onlinepubs/9799919799/utilities/printf.html. `cat` writes the file
 * each operand names and, with none or a `-`, its own standard input:
 * https://pubs.opengroup.org/onlinepubs/9799919799/utilities/cat.html.
 */
export function outputOf(words: readonly Word[]): Output | undefined {
  const name = programName(words[0]);
  const none: Output = { at: [], joined: [], texts: [], input: false };
  if (name === "echo") {
    let from = 1;
    while (ECHO_OPTION.test(words[from]?.value ?? "")) {
      from += 1;
    }
    const escaped =
      words.slice(1, from).some((word) => word.value?.includes("e") === true) ||
      words.slice(from).some((word) => (word.value ?? word.written ?? word.text).includes("\\"));
    return escaped ? undefined : { ...none, joined: [[from, words.length]] };
  }
  if (name === "printf") {
    const operands = words.slice(words[1]?.value === "--" ? 2 : 1);
    const [format, ...more] = operands;
    const known = format?.value;
    if (known === undefined || known.startsWith("-") || more.length > 0) {
      return known === "-v" ? none : undefined;
    }
    const rest = known.replaceAll(/\\.|%./gsu, (escape) =>
      PRINTF_ESCAPES.has(escape) ? "" : "\0",
    );
    return rest.includes("\\") || rest.includes("%") || rest.includes("\0")
      ? undefined
      : {
          ...none,
          texts: [known.replaceAll(/\\.|%./gsu, (escape) => PRINTF_ESCAPES.get(escape) ?? escape)],
        };
  }
  if (name !== "cat") {
    return undefined;
  }
  const operands = words.flatMap((word, at) =>
    at > 0 && !/^-./u.test(word.value ?? "") ? [at] : [],
  );
  return {
    ...none,
    at: operands.filter((at) => words[at]?.value !== "-"),
    input: operands.length === 0 || operands.some((at) => words[at]?.value === "-"),
  };
}

/** What the reader of one simple command's program reads it as, {@link UNKNOWN} where its table does not model it. */
function readRow(words: readonly Word[]): Reading | Unknown | undefined {
  const [program, ...rest] = words;
  return after(1, rowOf(program)?.read?.(rest));
}

/** The files a runtime's test runner runs: the patterns its operands write, and whether it strips types. */
export interface TestRun {
  readonly patterns: readonly string[];
  readonly stripped: boolean;
}

/**
 * The test run of one simple command whose program word names a runtime, as `node --test`, the
 * one reading of its options that tests.1 roots its files by, or `undefined` where it runs no
 * test runner, its table does not model it or a word it needs is dynamic.
 */
export function testRun(words: readonly Word[]): TestRun | undefined {
  const [program, ...rest] = words;
  const line = rowOf(program)?.runtime;
  const read = line === undefined ? undefined : runtimeLine(line, rest);
  if (read === undefined || isUnknown(read) || read.tests === undefined) {
    return undefined;
  }
  const patterns = rest.slice(read.tests).map((word) => word.value);
  return patterns.every((one) => one !== undefined)
    ? {
        patterns,
        stripped:
          !read.named.has("--no-strip-types") && !read.named.has("--no-experimental-strip-types"),
      }
    : undefined;
}

/** Whether `input`, the file a `<` names, writes no path, so a reader of it runs a file no word writes. */
function unnamed(input: Word | undefined): boolean {
  return input !== undefined && input.value === undefined && !writesPath(input.written);
}

/**
 * The launch of the program word `program`, at `at` of `words`, where it may run a command
 * written after it: after one of its subcommands, past its own options, or a dynamic word or an
 * unread option that may be one, and for a shell where its words write a command line.
 */
function launchAt(words: readonly Word[], at: number, program: Word): Launch | undefined {
  const launch = rowOf(program)?.launches;
  if (launch?.after !== undefined) {
    const sub = launch.options === undefined ? 0 : operandAt(words.slice(at + 1), launch.options);
    const next = sub === undefined ? undefined : words[at + 1 + sub];
    return sub === undefined ||
      (next !== undefined && (next.value === undefined || launch.after.has(next.value)))
      ? launch
      : undefined;
  }
  return launch?.line !== true || (launch.lines?.(words.slice(at + 1)).at.size ?? 0) > 0
    ? launch
    : undefined;
}

/** The program words of one simple command, as {@link chainOf} reads them. */
interface Chain {
  /** Each static program word, by its place: the first word, and each one a launcher hands on. */
  readonly programs: ReadonlyMap<number, Word>;
  /** The place of the first dynamic word that may be a program word. */
  readonly dynamic: number | undefined;
  /** The words, each holding a text a launcher replaces with a path it finds dynamic, that text a part. */
  readonly words: readonly Word[];
  /** Each such text, by the place of the words it may stand in. */
  readonly replaced: ReadonlyMap<number, RegExp>;
  /** Where the words of an appending launcher's command end, as at `parallel`'s `:::`. */
  readonly end: number | undefined;
  /** The place of the first appending launcher with an option or a construct no row reads. */
  readonly unread: number | undefined;
  /** Whether a launcher's reader reads a word its table does not model, {@link UNKNOWN}. */
  readonly unknown: boolean;
}

/**
 * The program words of `words`, a simple command: the first word, the program word each
 * launcher hands a command on to, as its reader reads it or, for one that hands its commands
 * the paths it finds, where each starts after its options, and, after a launcher whose words
 * its reader does not read or that has no reader, each later word up to the first dynamic one.
 */
function chainOf(words: readonly Word[]): Chain {
  const read = [...words];
  const replaced = new Map<number, RegExp>();
  const programs = new Map<number, Word>();
  let dynamic: number | undefined;
  let end: number | undefined;
  let unread: number | undefined;
  let unknown = false;
  const scanned = new Set<number>();
  const queue: (readonly [number, Word | undefined])[] = [[0, read[0]]];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const [at, program] = next;
    if (program === undefined || programs.has(at)) {
      continue;
    }
    if (programName(program) === undefined) {
      dynamic = Math.min(dynamic ?? at, at);
      continue;
    }
    programs.set(at, program);
    const launch = launchAt(read, at, program);
    const appending = launch?.appends?.(read.slice(at + 1));
    const pattern = appending?.replaced;
    for (
      let later = at + 1 + (appending?.from ?? read.length);
      pattern !== undefined && later < read.length;
      later += 1
    ) {
      const word = read[later];
      const written = word?.written?.replace(pattern, PART);
      replaced.set(later, pattern);
      if (word !== undefined && written !== undefined && written !== word.written) {
        read[later] = { value: undefined, text: word.text, written };
      }
    }
    if (appending?.end !== undefined) {
      end = Math.min(end ?? read.length, at + 1 + appending.end);
    }
    if (appending !== undefined && appending.starts === undefined) {
      unread = Math.min(unread ?? at, at);
    }
    const reading =
      launch === undefined || appending !== undefined
        ? undefined
        : readRow([program, ...read.slice(at + 1)]);
    unknown ||= reading?.kind === "unknown";
    if (appending?.starts !== undefined) {
      queue.push(
        ...appending.starts.map((start) => [at + 1 + start, read[at + 1 + start]] as const),
      );
    } else if (reading?.kind === "command") {
      queue.push([at + reading.at, reading.words[0]]);
    } else if (launch !== undefined && (reading === undefined || reading.kind === "unknown")) {
      // An earlier scan that reached `later` queued every word from there to the same stop.
      for (let later = at + 1; later < read.length && !scanned.has(later); later += 1) {
        scanned.add(later);
        queue.push([later, read[later]]);
        if (programName(read[later]) === undefined) {
          break;
        }
      }
    }
  }
  return { programs, dynamic, words: read, replaced, end, unread, unknown };
}

/** A character a glob reads specially, so a pattern holding one names more than the path it writes. */
const GLOB = /[*?[\]{}]/u;

/** What of one simple command may write the file a command runs, read by {@link fileOperands}. */
interface FileOperands {
  /** The places of the words that may write it. */
  readonly places: ReadonlySet<number>;
  /** Whether it may run a file no word of the command writes. */
  readonly unwritten: boolean;
  /** The places of the words it hands a shell as a command line, each with the option text it starts with. */
  readonly lines: ReadonlyMap<number, string>;
  /** Whether it reads command lines from its standard input. */
  readonly input: boolean;
  /** Whether a runtime runs its standard input as its entry, as `node` given no file does. */
  readonly stdin: boolean;
  /** The texts, by the place of each word they may stand in, a launcher replaces with each path it finds. */
  readonly replaced: ReadonlyMap<number, RegExp>;
  /** The places, each from one word up to before another, whose words joined by blanks it hands a shell as one command line. */
  readonly joined: readonly (readonly [number, number])[];
  /** The command lines it hands a shell that no word writes whole. */
  readonly texts: readonly string[];
}

/**
 * The words of one simple command that may write the file a runtime runs (roots.13): where
 * `program` holds, a dynamic program word and every word after it; after each program word
 * {@link chainOf} places that names a runtime, its entry, or every later word its reader does
 * not read. A runtime with no entry after a tool that hands it the paths it finds, a command a
 * row's table does not model, or one that reads command lines or its standard input from the
 * file `input`, which a `<` names with no path, runs a file no word writes. `tests` lets tests.1 root this command's own test run; otherwise a test runner's
 * pattern may write a file, and a dynamic or glob one, or none, runs a file no word writes.
 */
export function fileOperands(
  words: readonly Word[],
  program: boolean,
  input?: Word,
  tests = false,
): FileOperands {
  const chain = chainOf(words);
  const read = chain.words;
  const places = new Set<number>();
  const fromHere = (at: number): void => {
    for (let later = at; later < read.length; later += 1) {
      places.add(later);
    }
  };
  if (program && chain.dynamic !== undefined) {
    fromHere(chain.dynamic);
  }
  let unwritten = chain.unknown || chain.unread !== undefined;
  let reads = false;
  let stdin = false;
  const programs = [...chain.programs].sort(([one], [other]) => one - other);
  const [handed] = tests ? handedOn(words) : [[]];
  // Where the command reader's own test run is this runtime's, tests.1 roots its files.
  const rooted =
    testRun(handed) !== undefined &&
    handed.every((word, at) => read[read.length - handed.length + at]?.value === word.value)
      ? read.length - handed.length
      : -1;
  const appender =
    programs.find(([, word]) => rowOf(word)?.launches?.appends !== undefined)?.[0] ?? -1;
  for (const [named, word] of programs) {
    const line = rowOf(word, true)?.runtime;
    if (line === undefined) {
      continue;
    }
    const end = chain.end !== undefined && named < chain.end ? chain.end : read.length;
    const runtime = runtimeLine(line, read.slice(named + 1, end));
    if (runtime === undefined || isUnknown(runtime)) {
      fromHere(named + 1);
      unwritten ||= isUnknown(runtime);
      continue;
    }
    stdin ||= runtime.stdin;
    if (runtime.tests !== undefined && named !== rooted) {
      const from = named + 1 + runtime.tests;
      const patterns = read.slice(from, end);
      patterns.forEach((_, at) => places.add(from + at));
      unwritten ||=
        patterns.length === 0 ||
        patterns.some((one) => one.value === undefined || GLOB.test(one.value));
    }
    if (runtime.entry === undefined) {
      unwritten ||= appender >= 0 && appender < named;
    } else {
      places.add(named + 1 + runtime.entry);
    }
  }
  const lines = new Map<number, string>();
  const replaced = new Map(chain.replaced);
  const joined: (readonly [number, number])[] = [];
  const texts: string[] = [];
  for (const [at, word] of programs) {
    const found = linesOf(rowOf(word))?.(read.slice(at + 1)) ?? NO_LINES;
    for (const [one, prefix] of found.at) {
      lines.set(at + 1 + one, prefix);
      if (found.replaced !== undefined) {
        replaced.set(at + 1 + one, found.replaced);
      }
    }
    joined.push(...(found.joined ?? []).map(([from, to]) => [at + 1 + from, at + 1 + to] as const));
    texts.push(...(found.texts ?? []));
    reads ||= found.input;
    unwritten ||=
      found.unwritten === true || (found.appended === true && appender >= 0 && appender < at);
  }
  unwritten ||= (reads || stdin) && unnamed(input);
  return { places, unwritten, lines, input: reads, stdin, replaced, joined, texts };
}

/**
 * The configuration files one simple command names, as written: each static value of an option
 * its program's row names a configuration file by, and none for a program with no such row.
 */
export function configurationsOf(words: readonly Word[]): readonly string[] {
  const [program, ...rest] = words;
  const options = rowOf(program)?.configurations;
  const found: string[] = [];
  for (let at = 0; options !== undefined && at < rest.length; at += 1) {
    const word = rest[at]?.value;
    if (word === "--" || (word === undefined && options.beforeOperand !== undefined)) {
      break;
    }
    const equals = word?.startsWith("--") === true ? word.indexOf("=") : -1;
    const name = equals < 0 ? word : word?.slice(0, equals);
    if (name !== undefined && options.valued.has(name)) {
      const value = equals < 0 ? rest[(at += 1)]?.value : word?.slice(equals + 1);
      found.push(...(value === undefined || value === "" ? [] : [value]));
    } else if (options.beforeOperand !== undefined && name !== undefined) {
      if (!name.startsWith("-")) {
        break;
      }
      at += options.beforeOperand.has(name) && equals < 0 ? 1 : 0;
    }
  }
  return found;
}

/** One way the shell that ran a command goes on: in `dir`, `undefined` where unknown, after the status `ok`. */
export interface Outcome {
  readonly dir: string | undefined;
  readonly ok: boolean;
}

/**
 * Each way a builtin, run in `dir`, leaves the shell running it, none where it ends that
 * shell, or `undefined` where it leaves it as any other command does.
 */
type Builtin = (
  operands: readonly Word[],
  dir: string | undefined,
) => readonly Outcome[] | undefined;

/** Either status, in a directory the analysis does not know. */
const ELSEWHERE: readonly Outcome[] = [
  { dir: undefined, ok: true },
  { dir: undefined, ok: false },
];

const elsewhere: Builtin = () => ELSEWHERE;

/** The directory a builtin's one operand states, where it is static and starts with no character of `options`. */
function statedDirectory(operands: readonly Word[], options: string): string | undefined {
  const [dir] = operands;
  return operands.length === 1 && dir?.value !== undefined && !options.includes(dir.value.charAt(0))
    ? dir.value
    : undefined;
}

/** `cd` to a stated directory is taken to enter it, as `roots.13` states. */
const cd: Builtin = (operands, dir) => {
  const to = statedDirectory(operands, "-");
  return to === undefined
    ? ELSEWHERE
    : [{ dir: dir === undefined ? undefined : resolvePath(dir, to), ok: true }];
};

/** `pushd` enters a stated directory, or fails and leaves the shell where it was. */
const pushd: Builtin = (operands, dir) => {
  const to = statedDirectory(operands, "-+");
  return to === undefined
    ? ELSEWHERE
    : [
        { dir: dir === undefined ? undefined : resolvePath(dir, to), ok: true },
        { dir, ok: false },
      ];
};

/**
 * `exec` with a command replaces the shell, which exits where it cannot; with none it only
 * redirects: https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html#exec
 */
const exec: Builtin = ([command]) => {
  if (command === undefined) {
    return undefined;
  }
  return command.value === undefined || command.value.startsWith("-") ? ELSEWHERE : [];
};

/** `exit` ends the shell whatever its operands, in dash and in bash. */
const exit: Builtin = () => [];

/** The builtins that run another command in the same shell, where that one may be any builtin. */
const runsBuiltin: Builtin = (operands) =>
  operands.some((word) => word.value === undefined || BUILTINS.has(word.value))
    ? ELSEWHERE
    : undefined;

/**
 * The shell builtins that may move or end the shell running them: `cd`,
 * https://pubs.opengroup.org/onlinepubs/9799919799/utilities/cd.html; `pushd` and `popd`,
 * https://www.gnu.org/software/bash/manual/html_node/Directory-Stack-Builtins.html; `exit`,
 * `exec`, and `return`, whose effect outside a function POSIX leaves unspecified,
 * https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html#return; and `.`,
 * `eval`, `source`, `command` and `builtin`, which run other text or another builtin.
 */
const BUILTINS: ReadonlyMap<string, Builtin> = new Map<string, Builtin>([
  ["cd", cd],
  ["pushd", pushd],
  ["popd", elsewhere],
  ["exit", exit],
  ["exec", exec],
  ["return", elsewhere],
  [".", elsewhere],
  ["source", elsewhere],
  ["eval", elsewhere],
  ["command", runsBuiltin],
  ["builtin", runsBuiltin],
]);

/**
 * Each way the shell running one simple command in its own environment, in `dir`, goes on
 * after a builtin that may move or end it, or `undefined` where the command is no such
 * builtin. A program word the shell computes may be any builtin.
 */
export function readBuiltin(
  words: readonly Word[],
  dir: string | undefined,
): readonly Outcome[] | undefined {
  const [program, ...rest] = words;
  if (program === undefined) {
    return undefined;
  }
  return program.value === undefined ? ELSEWHERE : BUILTINS.get(program.value)?.(rest, dir);
}
