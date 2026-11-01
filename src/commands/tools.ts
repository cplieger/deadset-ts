/**
 * Layer 2 of the command reader: one row per tool, its reader of a simple command's words after
 * its program word and the options it names its configuration file by, each as the tool
 * documents them, and one reader per shell builtin that moves the shell's directory. A reader
 * never guesses: an option it does not handle, or a dynamic word where it needs a value, leaves
 * the command unread.
 */

import { resolvePath } from "../paths.ts";
import type { Word } from "./shell.ts";

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
  /** It runs the command `words`. */
  | { readonly kind: "command"; readonly words: readonly Word[] }
  /** It runs `text` as a command line of its own. */
  | { readonly kind: "line"; readonly text: string };

type Reader = (words: readonly Word[]) => Reading | undefined;

/** The options a tool takes before its first operand. */
interface Options {
  /** The options that take a value, the next word or, for a long one, the text after `=`. */
  readonly valued: ReadonlySet<string>;
  /** The options that take none. */
  readonly flags: ReadonlySet<string>;
  /** Whether a one-letter valued option may carry its value in the same word, as `-uNAME`. */
  readonly attached?: boolean;
}

/** The options before the first operand, with their values, and the operand's index. */
interface Read {
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly at: number;
  /** Whether a `--` ended the options. */
  readonly ended: boolean;
}

/** The options `words` start with, or `undefined` where one is unhandled or a needed word is dynamic. */
function optionsOf(words: readonly Word[], options: Options): Read | undefined {
  const values = new Map<string, string[]>();
  const keep = (name: string, value: string): void => {
    values.set(name, [...(values.get(name) ?? []), value]);
  };
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at]?.value;
    if (word === undefined) {
      return undefined;
    }
    if (word === "--") {
      return { values, at: at + 1, ended: true };
    }
    if (!word.startsWith("-") || options.flags.has(word)) {
      if (!word.startsWith("-")) {
        return { values, at, ended: false };
      }
      continue;
    }
    const equals = word.startsWith("--") ? word.indexOf("=") : -1;
    const name = equals < 0 ? word : word.slice(0, equals);
    if (options.valued.has(name)) {
      const value = equals < 0 ? words[(at += 1)]?.value : word.slice(equals + 1);
      if (value === undefined) {
        return undefined;
      }
      keep(name, value);
    } else if (
      options.attached === true &&
      options.valued.has(word.slice(0, 2)) &&
      !word.startsWith("--")
    ) {
      keep(word.slice(0, 2), word.slice(2));
    } else {
      return undefined;
    }
  }
  return { values, at: words.length, ended: false };
}

/** A specifier that starts with a URL scheme, `file:` and `node:` among them. */
const SCHEME = /^[a-z][a-z\d+.-]*:/iu;

/** A specifier written as a path: `.`, `..`, or one starting `./`, `../` or `/`. */
const RELATIVE = /^(?:\.{1,2}(?:\/|$)|\/)/u;

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
    return RELATIVE.test(specifier)
      ? { path: resolvePath(dir, specifier) }
      : SCHEME.test(specifier)
        ? undefined
        : { package: specifier };
  }
  if (!RELATIVE.test(specifier) && !SCHEME.test(specifier)) {
    return { package: specifier };
  }
  const local = /^file:(?:\/\/(?=\/))?/iu.exec(specifier);
  const rest = specifier.slice(local?.[0].length ?? 0);
  // `file://host/…` names a file on another host.
  if ((SCHEME.test(specifier) && local === null) || rest.startsWith("//")) {
    return undefined;
  }
  const path = urlPath(rest);
  return path === undefined ? undefined : { path: resolvePath(dir, path) };
}

/** A runtime: its preload options, then its entry, and every later word handed to the program. */
function runtime(
  preloads: ReadonlyMap<string, Preload["resolution"]>,
  flags: readonly string[],
  runsNode: boolean,
  subcommand?: string,
): Reader {
  const options = { valued: new Set(preloads.keys()), flags: new Set(flags) };
  return (words) => {
    const from = subcommand !== undefined && words[0]?.value === subcommand ? 1 : 0;
    const read = optionsOf(words.slice(from), options);
    if (read === undefined) {
      return undefined;
    }
    const entry = words[from + read.at];
    const loads = [...preloads].flatMap(([name, resolution]) =>
      (read.values.get(name) ?? []).map((specifier) => ({ specifier, resolution })),
    );
    if (
      (entry !== undefined && entry.value === undefined) ||
      loads.some((one) => preloadTarget(one, "/") === undefined)
    ) {
      return undefined;
    }
    return {
      kind: "run",
      entry: entry?.value,
      preloads: loads,
      runtime: runsNode && entry !== undefined ? "node" : undefined,
    };
  };
}

/**
 * `node [options] [entry] [arguments]`, https://nodejs.org/api/cli.html: the options that load
 * a module before the entry, `-r` as `require` does and the rest as an ECMAScript module.
 * `-e`, `-p` and `-` run text that is no file, so they are unhandled.
 */
const node = runtime(
  new Map([
    ["-r", "require"],
    ["--require", "require"],
    ["--import", "import"],
    ["--loader", "import"],
    ["--experimental-loader", "import"],
  ]),
  [],
  true,
);

/** `tsx [watch] [options] <file> [arguments]`, https://tsx.is/usage, https://tsx.is/node-enhancement */
const tsx = runtime(
  new Map([
    ["-r", "require"],
    ["--require", "require"],
    ["--import", "import"],
  ]),
  [],
  false,
  "watch",
);

/** `ts-node [options] [script] [arguments]`, https://typestrong.org/ts-node/docs/options; `--esm` picks no file. */
const tsNode = runtime(
  new Map([
    ["-r", "require"],
    ["--require", "require"],
  ]),
  ["--esm"],
  false,
);

/** Hands on the command `words` from `at`, after the assignments `assigns` accepts. */
function afterAssignments(
  words: readonly Word[],
  at: number,
  assigns: (value: string) => boolean,
): Reading | undefined {
  let end = at;
  while (end < words.length && words[end]?.value?.includes("=") === true) {
    if (!assigns(words[end]?.value ?? "")) {
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
    : { kind: "command", words: words.slice(end) };
}

/**
 * `env [option]... [name=value]... [command [argument]...]`,
 * https://www.gnu.org/software/coreutils/manual/html_node/env-invocation.html: the options that
 * change only the environment, `-i`, `-u` and `-v` in each spelling. GNU env takes any word
 * holding an `=` after its first character as an assignment, and fails before running anything
 * on a `-u` name that is empty or holds an `=`.
 */
const env: Reader = (words) => {
  const read = optionsOf(words, {
    valued: new Set(["-u", "--unset"]),
    flags: new Set(["-i", "--ignore-environment", "-", "-v", "--debug"]),
    attached: true,
  });
  const unset = [...(read?.values.get("-u") ?? []), ...(read?.values.get("--unset") ?? [])];
  return read === undefined || unset.some((name) => name === "" || name.includes("="))
    ? undefined
    : afterAssignments(words, read.at, (value) => !value.startsWith("="));
};

/** `cross-env [name=value]... command [argument]...`, https://github.com/kentcdodds/cross-env#usage */
const crossEnv: Reader = (words) => {
  const reading = afterAssignments(words, 0, (value) => /^\w+=/u.test(value));
  return reading?.kind === "command" ? reading : undefined;
};

/** The command a package runner hands on: its first word a package's or a command's name. */
function runnerCommand(words: readonly Word[], packaged: boolean): Reading | undefined {
  const [first, ...rest] = words;
  if (first?.value === undefined || first.value.startsWith("-")) {
    return undefined;
  }
  // A package specifier names the package's command; a version picks no other command.
  const name = packaged ? first.value.replace(/(?<=.)@[^/@]*$/u, "") : first.value;
  return { kind: "command", words: [{ value: name, text: first.text }, ...rest] };
}

/**
 * npx and npm exec, https://docs.npmjs.com/cli/v11/commands/npx and
 * https://docs.npmjs.com/cli/v11/commands/npm-exec: `--package` (and npx's `-p`), `--call`,
 * `--yes` and `--no`, before the first positional word, which is the package whose command
 * runs unless a `--package` names one. npm exec reads options after it too, unless a `--` ends them.
 */
function packageExec(shortPackage: boolean, laterOptions: boolean): Reader {
  const valued = new Set(["--package", "-c", "--call", ...(shortPackage ? ["-p"] : [])]);
  return (words) => {
    const read = optionsOf(words, { valued, flags: new Set(["-y", "--yes", "--no"]) });
    if (read === undefined) {
      return undefined;
    }
    const operands = words.slice(read.at);
    if (
      laterOptions &&
      !read.ended &&
      operands.some((word) => word.value?.startsWith("-") !== false)
    ) {
      return undefined;
    }
    const call = [...(read.values.get("-c") ?? []), ...(read.values.get("--call") ?? [])];
    if (call.length > 0) {
      return call.length === 1 && operands.length === 0 && call[0] !== undefined
        ? { kind: "line", text: call[0] }
        : undefined;
    }
    const packages = [...(read.values.get("--package") ?? []), ...(read.values.get("-p") ?? [])];
    return runnerCommand(operands, packages.length === 0);
  };
}

const npx = packageExec(true, false);
const npmExec = packageExec(false, true);

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

/** A tool whose second word picks the reader of the rest. */
function subcommands(readers: ReadonlyMap<string, Reader>): Reader {
  return ([first, ...rest]) =>
    first?.value === undefined ? undefined : readers.get(first.value)?.(rest);
}

/** `npm exec`, `npm x` and `npm run` with `run-script`. */
const npm = subcommands(
  new Map([
    ["exec", npmExec],
    ["x", npmExec],
    ["run", npmRun],
    ["run-script", npmRun],
  ]),
);

/**
 * `pnpm exec <command>`, https://pnpm.io/cli/exec, which hands on every later word, and
 * `pnpm dlx [--package <name>]... <command>`, https://pnpm.io/cli/dlx.
 */
const pnpm = subcommands(
  new Map<string, Reader>([
    ["exec", (words) => runnerCommand(words, false)],
    [
      "dlx",
      (words) => {
        const read = optionsOf(words, { valued: new Set(["--package"]), flags: new Set() });
        return read === undefined
          ? undefined
          : runnerCommand(words.slice(read.at), !read.values.has("--package"));
      },
    ],
  ]),
);

/**
 * `yarn node`, https://yarnpkg.com/cli/node, and `yarn dlx [-p <name>]... <command>`,
 * https://yarnpkg.com/cli/dlx, whose command runs in the current directory.
 */
const yarn = subcommands(
  new Map<string, Reader>([
    ["node", (words) => ({ kind: "command", words: [{ value: "node", text: "node" }, ...words] })],
    [
      "dlx",
      (words) => {
        const read = optionsOf(words, {
          valued: new Set(["-p", "--package"]),
          flags: new Set(["-q", "--quiet"]),
        });
        return read === undefined
          ? undefined
          : runnerCommand(
              words.slice(read.at),
              !read.values.has("-p") && !read.values.has("--package"),
            );
      },
    ],
  ]),
);

/** `bunx [-p <name>] <command>[@version] [arguments]`, https://bun.com/docs/pm/bunx */
const bunx: Reader = (words) => {
  const read = optionsOf(words, { valued: new Set(["-p", "--package"]), flags: new Set() });
  return read === undefined ? undefined : runnerCommand(words.slice(read.at), true);
};

/**
 * The options a tool documents for naming its configuration file, each taking the file as its
 * value, the next word or, for a long one, the text after `=`.
 */
interface ConfigurationOptions {
  readonly valued: ReadonlySet<string>;
  /** Where set, the tool reads options only before its first operand, and these others take a value. */
  readonly beforeOperand?: ReadonlySet<string>;
}

/** One tool's row: the reader of its command, and the options it names its configuration file by. */
interface Row {
  readonly read?: Reader;
  readonly configurations?: ConfigurationOptions;
}

/** The row of a tool whose reader is `read`. */
function reading(read: Reader): Row {
  return { read };
}

/** The row of a tool that names its configuration file by `options` anywhere before a `--`. */
function configuredBy(...options: readonly string[]): Row {
  return { configurations: { valued: new Set(options) } };
}

/** The row of each tool, by its program word: its name, or a path to it in `node_modules/.bin`. */
const TOOLS: ReadonlyMap<string, Row> = new Map<string, Row>([
  ["node", reading(node)],
  ["tsx", reading(tsx)],
  ["ts-node", reading(tsNode)],
  ["env", reading(env)],
  ["cross-env", reading(crossEnv)],
  [
    "npx",
    {
      read: npx,
      // `-c` takes a command line, which is read as a configuration file's name as well, so
      // every configuration `fixtures/commands/observed.json` records stays named.
      configurations: {
        valued: new Set(["-c"]),
        beforeOperand: new Set(["--package", "-p", "--call"]),
      },
    },
  ],
  ["npm", reading(npm)],
  ["pnpm", reading(pnpm)],
  ["yarn", reading(yarn)],
  ["bunx", reading(bunx)],
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

/** The row of a simple command's program word, by its name or a path to it in `node_modules/.bin`. */
function rowOf(program: Word | undefined): Row | undefined {
  const name =
    program?.value === undefined
      ? undefined
      : /^(?:.*\/)?node_modules\/\.bin\/([^/]+)$|^([^/]+)$/u.exec(program.value);
  const tool = name?.[1] ?? name?.[2];
  return tool === undefined ? undefined : TOOLS.get(tool);
}

/**
 * What the reader of one simple command's program reads it as, or `undefined` where none
 * understands it. A program word that is any other path runs that file, whatever its name.
 */
export function readTool(words: readonly Word[]): Reading | undefined {
  const [program, ...rest] = words;
  return rowOf(program)?.read?.(rest);
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
