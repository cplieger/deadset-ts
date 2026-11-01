/**
 * The one reader of every command string the analysis reads. Layer 3, the holding rule
 * `roots.ts` applies through `text/named-files.ts`, reads all of the string's text whatever
 * the other two layers make of it; layer 1 parses the string and layer 2 reads each simple
 * command a tool's reader understands, and they only add the files and modules it runs.
 */

import { joinPath, resolvePath } from "../paths.ts";
import { shellLine, type Pipeline, type Word } from "./shell.ts";
import {
  configurationsOf,
  preloadTarget,
  readBuiltin,
  readTool,
  type Outcome,
  type Preload,
  type Reading,
} from "./tools.ts";

/** One program a read command runs. */
interface Run {
  /** The directory it runs in, absolute where the string's directory is. */
  readonly dir: string;
  /** The path of the file it runs, as written. */
  readonly entry: string | undefined;
  /** The modules it loads before the entry. */
  readonly preloads: readonly Preload[];
  readonly runtime: "node" | undefined;
}

/** One simple command's words, `undefined` for a dynamic one, with the directory it runs in. */
interface CommandWords {
  readonly dir: string;
  readonly words: readonly (string | undefined)[];
}

/** One configuration file a command names by its tool's configuration option, as written, with its command's directory. */
interface NamedConfiguration {
  readonly dir: string;
  readonly written: string;
}

/** What one command string runs. */
export interface CommandReading {
  readonly runs: readonly Run[];
  /**
   * Each simple command read in the directory it runs in, and each one of the string's own
   * line in the string's directory too, wherever and whether it runs.
   */
  readonly commands: readonly CommandWords[];
  readonly configurations: readonly NamedConfiguration[];
  /** The text layer 3 reads: all of the string. */
  readonly held: string;
}

/**
 * The outcomes of one pipeline run in `dir`: those of the builtin that is its one member, as
 * `readBuiltin` gives them, a directory the analysis does not know after a part layer 1 does
 * not read, and either status in `dir` otherwise, a pipeline of several members included,
 * whose members each run in a subshell.
 */
function outcomesOf(pipeline: Pipeline, dir: string | undefined): readonly Outcome[] {
  const [only] = pipeline.alone ? pipeline.commands : [];
  const outcomes = pipeline.opaque
    ? [
        { dir: undefined, ok: true },
        { dir: undefined, ok: false },
      ]
    : ((only === undefined ? undefined : readBuiltin(only, dir)) ?? [
        { dir, ok: true },
        { dir, ok: false },
      ]);
  return outcomes.map((one) => ({ dir: one.dir, ok: one.ok !== pipeline.negated }));
}

/** The one directory every outcome is in, or `undefined` where they differ or none is known. */
function oneDirectory(outcomes: readonly Outcome[]): string | undefined {
  const dirs = new Set(outcomes.map((one) => one.dir));
  return dirs.size === 1 ? [...dirs][0] : undefined;
}

/**
 * What `text`, run in `dir`, `undefined` where not known, runs. A pipeline is read where every
 * way its and-or list reaches it leaves the shell in one known directory, none after an `exit`;
 * a background list moves and ends no later one. The words and configuration files of every
 * simple command of the string's own line are read in `dir` as well, wherever they run.
 */
export function readCommands(text: string, dir: string | undefined): CommandReading {
  const runs: Run[] = [];
  const commands: CommandWords[] = [];
  const configurations: NamedConfiguration[] = [];
  const readCommand = (words: readonly Word[], at: string): void => {
    commands.push({ dir: at, words: words.map((word) => word.value) });
    let handed = words;
    let reading: Reading | undefined = readTool(handed);
    while (reading?.kind === "command") {
      handed = reading.words;
      reading = readTool(handed);
    }
    if (reading?.kind === "line") {
      readLine(reading.text, at);
      return;
    }
    configurations.push(...configurationsOf(handed).map((written) => ({ dir: at, written })));
    if (reading !== undefined && (reading.entry !== undefined || reading.preloads.length > 0)) {
      runs.push({
        dir: at,
        entry: reading.entry,
        preloads: reading.preloads,
        runtime: reading.runtime,
      });
    }
  };
  const readLine = (source: string, start: string | undefined): void => {
    let at = start;
    for (const list of shellLine(source)) {
      let outcomes: readonly Outcome[] = [{ dir: at, ok: true }];
      for (const pipeline of list.pipelines) {
        const { operator } = pipeline;
        const reached = outcomes.filter(
          (one) => operator === undefined || one.ok === (operator === "&&"),
        );
        const where = reached.length === 0 ? undefined : oneDirectory(reached);
        if (where !== undefined) {
          pipeline.commands.forEach((words) => {
            readCommand(words, where);
          });
        }
        const next = reached.flatMap((one) => outcomesOf(pipeline, one.dir));
        const passed = outcomes.filter((one) => !reached.includes(one));
        outcomes = [
          ...new Map(
            [...passed, ...next].map((one) => [`${String(one.ok)}\u0000${one.dir ?? ""}`, one]),
          ).values(),
        ];
      }
      if (!list.background) {
        at = oneDirectory(outcomes);
      }
    }
  };
  readLine(text, dir);
  if (dir !== undefined) {
    for (const words of shellLine(text).flatMap((list) =>
      list.pipelines.flatMap((pipeline) => pipeline.commands),
    )) {
      commands.push({ dir, words: words.map((word) => word.value) });
      configurations.push(...configurationsOf(words).map((written) => ({ dir, written })));
    }
  }
  const unique = <T>(all: readonly T[]): T[] => [
    ...new Map(all.map((one) => [JSON.stringify(one), one])).values(),
  ];
  return {
    runs,
    commands: unique(commands),
    configurations: unique(configurations),
    held: text,
  };
}

/** The extensions a runtime or a loader tries after a path written without one. */
const TRIED_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

/** One file a run loads, as written, and every absolute path it may be at. */
interface Load {
  readonly written: string;
  readonly paths: readonly string[];
}

/**
 * The files `run` loads: its entry, and each preload written as a path. Each may be at its
 * path, with each extension tried, and as a directory's `index` file.
 */
export function loadsOf(run: Run): readonly Load[] {
  const written = [
    ...(run.entry === undefined
      ? []
      : [{ written: run.entry, path: resolvePath(run.dir, run.entry) }]),
    ...run.preloads.flatMap((preload) => {
      const target = preloadTarget(preload, run.dir);
      return target !== undefined && "path" in target
        ? [{ written: preload.specifier, path: target.path }]
        : [];
    }),
  ];
  return written.map(({ written: one, path }) => ({
    written: one,
    paths: [
      path,
      ...TRIED_EXTENSIONS.map((extension) => `${path}${extension}`),
      ...TRIED_EXTENSIONS.map((extension) => joinPath(path, `index${extension}`)),
    ],
  }));
}

/** The module specifiers `run` preloads that name a package rather than a path. */
export function preloadedPackages(run: Run): readonly string[] {
  return run.preloads.flatMap((preload) => {
    const target = preloadTarget(preload, run.dir);
    return target !== undefined && "package" in target ? [target.package] : [];
  });
}

/** One path a command string names, with the word or the load that names it. */
interface NamedPath {
  readonly path: string;
  readonly written: string;
}

/**
 * Every path `reading` names: each static word of its commands read against the directory the
 * command runs in, a word holding `*` aside, which a tool reads as a pattern, and every path a
 * file a read command runs or preloads may be at.
 */
export function pathsNamed(reading: CommandReading): readonly NamedPath[] {
  const named = [
    ...reading.commands.flatMap(({ dir, words }) =>
      words.flatMap((word) =>
        word === undefined || word.includes("*")
          ? []
          : [{ path: resolvePath(dir, word), written: word }],
      ),
    ),
    ...reading.runs
      .flatMap(loadsOf)
      .flatMap(({ written, paths }) => paths.map((path) => ({ path, written }))),
  ];
  return [...new Map(named.map((one) => [`${one.path}\u0000${one.written}`, one])).values()];
}
