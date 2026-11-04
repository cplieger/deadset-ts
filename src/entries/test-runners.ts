/**
 * The test runners a convention row names by its `testRunner`, and `node --test`, which no
 * package enables: each reads the files its runner runs as tests from the runner's
 * configuration and from the commands a manifest's scripts run it with, as the runner's own
 * source reads them. A value a reader needs that the text does not write out names no file.
 */

import { readJSON, readJSONFile } from "../fs/manifest.ts";
import type { Host } from "../host.ts";
import { ancestors, dirnamePath, joinPath, relativePath, resolvePath } from "../paths.ts";
import { globExpression } from "../text/glob.ts";
import {
  documentValue,
  membersNamed,
  textsOf,
  type StaticModule,
  type Value,
} from "./static-module.ts";

/** One pattern of the files a runner runs, over the files below `dir`. */
export interface TestGlob {
  readonly dir: string;
  /** What names the files, as written. */
  readonly pattern: string;
  /** Whether the file of one absolute name is one the pattern names. */
  readonly matches: (fileName: string) => boolean;
}

/** One simple command of a manifest's scripts, a dynamic word `undefined`, in the directory it runs in. */
export interface ScriptCommand {
  readonly dir: string;
  readonly words: readonly (string | undefined)[];
}

/** One configuration file a runner reads. */
interface Configuration {
  /** Its directory, absolute. */
  readonly dir: string;
  readonly module: StaticModule;
}

/** What a runner reads for one manifest that declares it. */
export interface RunnerInput {
  readonly host: Host;
  /** The manifest's directory, absolute. */
  readonly dir: string;
  /** The manifest's document. */
  readonly manifest: unknown;
  /** The first of `names` in `dir` the host holds, read once per run; `undefined` where it holds none. */
  readonly configuration: (dir: string, names: readonly string[]) => Configuration | undefined;
  readonly scripts: readonly ScriptCommand[];
}

/** The files one runner runs as tests for one manifest that declares it. */
export type TestRunner = (input: RunnerInput) => readonly TestGlob[];

/** A member's last value: `null` where the object writes none, `undefined` where it may hide one or is no object. */
function lastOf(object: Value, key: string): Value | null | undefined {
  if (object.kind !== "object") {
    return undefined;
  }
  const values = membersNamed(object, key);
  return values === undefined ? undefined : (values.at(-1) ?? null);
}

/** The one object a configuration's default export writes, `undefined` where it writes anything else. */
function configurationObject(module: StaticModule): Value | undefined {
  const [only, ...more] = module.defaultExport;
  return only?.kind === "object" && more.length === 0 ? only : undefined;
}

/** The strings a member holds, one or an array of them: `null` where absent, `undefined` where not written out. */
function stringsOf(object: Value, key: string): readonly string[] | null | undefined {
  const value = lastOf(object, key);
  return value === null || value === undefined ? value : textsOf(value, true);
}

/** A boolean member: `null` where absent, `undefined` where it is written as anything else. */
function booleanOf(object: Value, key: string): boolean | null | undefined {
  const value = lastOf(object, key);
  return value === null ? null : value?.kind === "boolean" ? value.value : undefined;
}

/** A manifest's member, `undefined` where it has none. */
function manifestMember(manifest: unknown, key: string): unknown {
  return typeof manifest === "object" && manifest !== null && !Array.isArray(manifest)
    ? (manifest as Readonly<Record<string, unknown>>)[key]
    : undefined;
}

/** The configuration a path names, read where the host holds it. */
function configurationAt(input: RunnerInput, path: string): Configuration | undefined {
  const dir = dirnamePath(path);
  return input.configuration(dir, [path.slice(dir.length + 1)]);
}

/** Whether a pattern holds a character a glob reads specially. */
const MAGIC = /[*?[\]{}()!+@]/u;

/** A glob over the path below `dir`, case compared unless `caseless`. */
function belowGlob(dir: string, pattern: string, caseless = false): TestGlob {
  const expression = globExpression(pattern.replace(/^(?:\.\/)+/u, ""));
  const tested = caseless ? new RegExp(expression.source, "iu") : expression;
  return {
    dir,
    pattern,
    matches: (fileName) => {
      const below = relativePath(dir, fileName);
      return below !== undefined && below !== "" && tested.test(below);
    },
  };
}

/** The glob less every file one of `excludes` names. */
function less(glob: TestGlob, excludes: readonly ((fileName: string) => boolean)[]): TestGlob {
  return excludes.length === 0
    ? glob
    : { ...glob, matches: (name) => glob.matches(name) && !excludes.some((one) => one(name)) };
}

/** The one file a path names. */
function exactly(cwd: string, path: string): TestGlob {
  const file = resolvePath(cwd, path);
  return { dir: dirnamePath(file), pattern: path, matches: (name) => name === file };
}

/** The words after the first one naming one of `programs`, by its name or a path ending in it. */
function afterProgram(
  command: ScriptCommand,
  programs: readonly string[],
): readonly (string | undefined)[] | undefined {
  const at = command.words.findIndex(
    (word) => word !== undefined && programs.includes(word.slice(word.lastIndexOf("/") + 1)),
  );
  return at < 0 ? undefined : command.words.slice(at + 1);
}

/** The options a command line takes, each written with its dashes. */
interface OptionTable {
  /** The options that take the next word, or the text after `=`, as their value. */
  readonly valued: ReadonlySet<string>;
  readonly flags: ReadonlySet<string>;
  /** Whether a long option the table does not name is read where its value follows `=`. */
  readonly assigned?: boolean;
}

/** One command's options and operands. */
interface Parsed {
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly operands: readonly string[];
}

/** One command's options and operands, `undefined` where it holds a dynamic word or an option the table does not name. */
function parsed(words: readonly (string | undefined)[], table: OptionTable): Parsed | undefined {
  const values = new Map<string, string[]>();
  const operands: string[] = [];
  const keep = (name: string, value: string): void => {
    values.set(name, [...(values.get(name) ?? []), value]);
  };
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at];
    if (word === undefined) {
      return undefined;
    }
    if (word === "--") {
      const rest = words.slice(at + 1);
      return rest.every((one) => one !== undefined)
        ? { values, operands: [...operands, ...rest] }
        : undefined;
    }
    if (!word.startsWith("-") || word === "-") {
      operands.push(word);
      continue;
    }
    const equals = word.startsWith("--") ? word.indexOf("=") : -1;
    const name = equals < 0 ? word : word.slice(0, equals);
    if (table.valued.has(name)) {
      const value = equals < 0 ? words[(at += 1)] : word.slice(equals + 1);
      if (value === undefined) {
        return undefined;
      }
      keep(name, value);
    } else if (table.flags.has(name)) {
      keep(name, equals < 0 ? "true" : word.slice(equals + 1));
    } else if (!(table.assigned === true && equals > 0)) {
      return undefined;
    }
  }
  return { values, operands };
}

/** Every value one command gives the options `names`, in order. */
function optionValues(command: Parsed, ...names: readonly string[]): readonly string[] {
  return names.flatMap((name) => command.values.get(name) ?? []);
}

/** A table of options by their long names and one-letter aliases, each flag with its `--no-` form. */
function optionTable(
  valued: readonly string[],
  flags: readonly string[],
  aliases: Readonly<Record<string, readonly string[]>>,
): OptionTable {
  const named = (name: string): readonly string[] =>
    [name, ...(aliases[name] ?? [])].map((one) => (one.length === 1 ? `-${one}` : `--${one}`));
  return {
    valued: new Set(valued.flatMap(named)),
    flags: new Set(flags.flatMap((flag) => [...named(flag), `--no-${flag}`])),
  };
}

/**
 * Mocha's options, `lib/cli/run-option-metadata` of 10.8 to 12.0: its array, string and number
 * options take a value and its boolean ones none; `--config` and `--package` also take a `--no-`
 * form. A Node option mocha hands on is not named, so a command writing one is not read.
 */
const MOCHA_OPTIONS = optionTable(
  [
    ...["extension", "file", "global", "ignore", "node-option", "reporter-option", "require"],
    ...["spec", "watch-files", "watch-ignore", "retries", "jobs", "config", "fgrep", "grep"],
    ...["package", "reporter", "ui", "slow", "timeout"],
  ],
  [
    ...["allow-uncaught", "async-only", "bail", "check-leaks", "clear-screen", "color", "delay"],
    ...["diff", "dry-run", "exit", "fail-hook-affected-tests", "pass-on-failing-test-suite"],
    ...["fail-zero", "forbid-only", "forbid-pending", "full-trace", "inline-diffs", "invert"],
    ...["list-interfaces", "list-reporters", "no-colors", "parallel", "posix-exit-codes"],
    ...["recursive", "sort", "watch", "config", "package"],
  ],
  {
    "async-only": ["A"],
    bail: ["b"],
    color: ["c", "colors"],
    fgrep: ["f"],
    global: ["globals"],
    grep: ["g"],
    ignore: ["exclude"],
    invert: ["i"],
    jobs: ["j"],
    "no-colors": ["C"],
    "node-option": ["n"],
    parallel: ["p"],
    reporter: ["R"],
    "reporter-option": ["reporter-options", "O"],
    require: ["r"],
    slow: ["s"],
    sort: ["S"],
    timeout: ["t", "timeouts"],
    ui: ["u"],
    watch: ["w"],
  },
);

/** The test-file options one mocha source sets. */
interface MochaSource {
  readonly spec: readonly string[];
  readonly file: readonly string[];
  readonly ignore: readonly string[];
  /** Absent where the source sets none. */
  readonly extension?: readonly string[];
  readonly recursive?: boolean;
}

/** The test-file options a mocha configuration object sets, `undefined` where one is not written out. */
function mochaObject(object: Value): MochaSource | undefined {
  const spec = stringsOf(object, "spec");
  const file = stringsOf(object, "file");
  const ignore = stringsOf(object, "ignore");
  const exclude = stringsOf(object, "exclude");
  const extension = stringsOf(object, "extension");
  const recursive = booleanOf(object, "recursive");
  if ([spec, file, ignore, exclude, extension, recursive].includes(undefined)) {
    return undefined;
  }
  return {
    spec: spec ?? [],
    file: file ?? [],
    ignore: [...(ignore ?? []), ...(exclude ?? [])],
    ...(extension === null || extension === undefined ? {} : { extension }),
    ...(recursive === null || recursive === undefined ? {} : { recursive }),
  };
}

/** The test-file options one mocha command line sets. */
function mochaCommand(command: Parsed): MochaSource {
  const recursive = optionValues(command, "--recursive", "--no-recursive");
  const extension = optionValues(command, "--extension");
  return {
    spec: [...command.operands, ...optionValues(command, "--spec")],
    file: optionValues(command, "--file"),
    ignore: optionValues(command, "--ignore", "--exclude"),
    ...(extension.length > 0 ? { extension } : {}),
    ...(command.values.has("--no-recursive")
      ? { recursive: false }
      : recursive.length > 0
        ? { recursive: recursive.at(-1) !== "false" }
        : {}),
  };
}

/**
 * The files one mocha spec names, `lib/cli/lookup-files`: an existing file itself, the files of
 * an existing directory with one of `extensions` and a name not starting with `.`, at any depth
 * where `recursive`, a glob as written, and any other path with an extension appended.
 */
function mochaSpec(
  host: Host,
  cwd: string,
  spec: string,
  extensions: readonly string[],
  recursive: boolean,
): TestGlob {
  const path = resolvePath(cwd, spec);
  const braced = `{${extensions.map((one) => one.replace(/^\./u, "")).join(",")}}`;
  const kind = host.kindOf(path);
  if (kind === "file") {
    return exactly(cwd, spec);
  }
  if (kind === "directory") {
    const inner = belowGlob(path, `${recursive ? "**/" : ""}*.${braced}`);
    return {
      ...inner,
      pattern: spec,
      matches: (name) =>
        inner.matches(name) && !name.slice(name.lastIndexOf("/") + 1).startsWith("."),
    };
  }
  return belowGlob(cwd, MAGIC.test(spec) ? spec : `${spec}.${braced}`);
}

/**
 * Mocha over the configuration files it looks for, in its order of preference, the nearest at
 * or above the working directory (`lib/cli/config`): one run with no operand, and one per
 * script command naming `mocha` or `_mocha`, its sources merged as `lib/cli/options` merges
 * them. A list each source sets is joined, `extension` replacing the default where any sets
 * it, and the command line, then the file, then the manifest's `mocha` member decides
 * `recursive`; a run with no spec runs `./test`.
 */
function mochaRunner(configNames: readonly string[]): TestRunner {
  return (input) => {
    const { host, dir, manifest, scripts } = input;
    const nearest = (from: string): Configuration | undefined => {
      for (const at of ancestors(from)) {
        const found = input.configuration(at, configNames);
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    };
    /**
     * The document `lib/cli/options` `loadPkgRc` reads the `mocha` member of, `undefined` where
     * the run fails: the file the last non-empty `--package` names, failing it where it cannot be
     * read, else the nearest `package.json` at or above `cwd`, none where that cannot be read;
     * either failing it where it does not parse to a document `pkg.mocha` can be read on. `null`
     * for none, or where the last of `--package` and `--no-package` is the latter.
     */
    const packageOf = (
      cwd: string,
      words: readonly (string | undefined)[],
      command: Parsed,
    ): unknown => {
      const last = words.findLast(
        (word) => word === "--no-package" || word === "--package" || word?.startsWith("--package="),
      );
      if (last === "--no-package") {
        return null;
      }
      const named = optionValues(command, "--package").at(-1);
      const explicit = named !== undefined && named !== "";
      const path = explicit
        ? resolvePath(cwd, named)
        : ancestors(cwd)
            .map((at) => joinPath(at, "package.json"))
            .find((one) => host.kindOf(one) === "file");
      if (path === undefined) {
        return null;
      }
      if (path === joinPath(dir, "package.json")) {
        return manifest;
      }
      const read = readJSONFile(host, path);
      if (read.kind === "unread") {
        return explicit ? undefined : null;
      }
      return read.kind === "malformed" || read.value === null ? undefined : read.value;
    };
    const run = (cwd: string, words: readonly (string | undefined)[]): readonly TestGlob[] => {
      const command = parsed(words, MOCHA_OPTIONS);
      if (command === undefined) {
        return [];
      }
      const named = optionValues(command, "--config").at(-1);
      const file = command.values.has("--no-config")
        ? undefined
        : named === undefined
          ? nearest(cwd)
          : configurationAt(input, resolvePath(cwd, named));
      const object = file === undefined ? null : configurationObject(file.module);
      const fromFile =
        object === null ? null : object === undefined ? undefined : mochaObject(object);
      const pkg = packageOf(cwd, words, command);
      const held = pkg === null || pkg === undefined ? undefined : manifestMember(pkg, "mocha");
      const fromManifest = held === undefined ? null : mochaObject(documentValue(held));
      if (
        pkg === undefined ||
        (named !== undefined && file === undefined) ||
        fromFile === undefined ||
        fromManifest === undefined
      ) {
        return [];
      }
      const sources = [mochaCommand(command), fromFile ?? [], fromManifest ?? []].flat();
      const spec = sources.flatMap((one) => one.spec);
      const set = sources.flatMap((one) => one.extension ?? []);
      const extensions = set.length > 0 ? [...new Set(set)] : ["js", "cjs", "mjs"];
      const recursive = sources.find((one) => one.recursive !== undefined)?.recursive ?? false;
      const ignored = sources
        .flatMap((one) => one.ignore)
        .map((one) => belowGlob(cwd, one).matches);
      return [
        ...(spec.length > 0 ? spec : ["./test"]).map((one) =>
          less(mochaSpec(host, cwd, one, extensions, recursive), ignored),
        ),
        ...sources.flatMap((one) => one.file).map((one) => exactly(cwd, one)),
      ];
    };
    return [
      ...run(dir, []),
      ...scripts.flatMap((command) => {
        const words = afterProgram(command, ["mocha", "_mocha"]);
        return words === undefined ? [] : run(command.dir, words);
      }),
    ];
  };
}

const MOCHARC = [".mocharc.yaml", ".mocharc.yml", ".mocharc.jsonc", ".mocharc.json"];

/** Mocha 10 and 11, which read no `.mocharc.mjs`. */
export const MOCHA_10 = mochaRunner([".mocharc.cjs", ".mocharc.js", ...MOCHARC]);

/** Mocha 12. */
export const MOCHA_12 = mochaRunner([".mocharc.cjs", ".mocharc.js", ".mocharc.mjs", ...MOCHARC]);

/** A regular expression a runner writes as text, `undefined` where it is none. */
function expressionOf(source: string): RegExp | undefined {
  try {
    return new RegExp(source, "u");
  } catch {
    try {
      return new RegExp(source);
    } catch {
      return undefined;
    }
  }
}

/** One Jest version's defaults (jest-config `Defaults`), its `testMatch` read over a file's whole path. */
interface JestDefaults {
  readonly testMatch: readonly RegExp[];
  readonly moduleFileExtensions: readonly string[];
}

/** The text `<rootDir>` stands for in one of Jest's paths, `rootDir` itself. */
function inRoot(text: string, rootDir: string): string {
  return text.replaceAll("<rootDir>", rootDir);
}

/**
 * Jest over the configuration files it looks for in a directory, in its order
 * (jest-config `resolveConfigPath`): one run with no option, and one per script command naming
 * `jest` with its `--config` or `-c` file. A configuration's own file, else its `package.json`
 * member `jest`, else the defaults, configure a directory; two of them configure none.
 */
function jestRunner(configNames: readonly string[], defaults: JestDefaults): TestRunner {
  return (input) => {
    const { host, dir, scripts } = input;
    const directory = (at: string, depth: number): readonly TestGlob[] => {
      const file = input.configuration(at, configNames);
      const manifestPath = joinPath(at, "package.json");
      const manifest =
        host.kindOf(manifestPath) === "file" ? readJSON(host, manifestPath) : undefined;
      const held = manifestMember(manifest, "jest");
      if (file !== undefined && held !== undefined) {
        return [];
      }
      if (file !== undefined) {
        return configured(file, depth);
      }
      if (typeof held === "string") {
        const named = configurationAt(input, resolvePath(at, held));
        return named === undefined ? [] : configured(named, depth);
      }
      return manifest === undefined && held === undefined
        ? []
        : project(
            held === undefined
              ? { kind: "object", members: [], at: undefined }
              : documentValue(held),
            at,
            depth,
          );
    };
    const configured = (file: Configuration, depth: number): readonly TestGlob[] => {
      const object = configurationObject(file.module);
      return object === undefined ? [] : project(object, file.dir, depth);
    };
    const project = (object: Value, base: string, depth: number): readonly TestGlob[] => {
      const rootValue = lastOf(object, "rootDir");
      const rootDir =
        rootValue === null
          ? base
          : rootValue?.kind === "text"
            ? resolvePath(base, inRoot(rootValue.text, base))
            : undefined;
      if (rootDir === undefined) {
        return [];
      }
      const projects = lastOf(object, "projects");
      if (projects === undefined || (projects !== null && projects.kind !== "array")) {
        return [];
      }
      if (projects !== null && projects.elements.length > 0) {
        return depth > 4
          ? []
          : projects.elements.flatMap((one) =>
              one.kind === "object"
                ? project(one, rootDir, depth + 1)
                : one.kind === "text"
                  ? projectDirectories(host, inRoot(one.text, rootDir), rootDir).flatMap((at) =>
                      host.kindOf(at) === "file"
                        ? [configurationAt(input, at) ?? []]
                            .flat()
                            .flatMap((named) => configured(named, depth + 1))
                        : directory(at, depth + 1),
                    )
                  : [],
            );
      }
      return testsOf(object, rootDir, defaults);
    };
    const named = scripts.flatMap((command) => {
      const words = afterProgram(command, ["jest"]);
      const at = words?.findIndex((word) => word === "--config" || word === "-c") ?? -1;
      const written =
        words?.find((word) => word?.startsWith("--config=") === true)?.slice("--config=".length) ??
        (at < 0 ? undefined : words?.[at + 1]);
      return written === undefined ? [] : [resolvePath(command.dir, written)];
    });
    return [
      ...directory(dir, 0),
      ...named.flatMap((path) =>
        host.kindOf(path) === "directory"
          ? directory(path, 0)
          : [configurationAt(input, path) ?? []].flat().flatMap((file) => configured(file, 0)),
      ),
    ];
  };
}

/**
 * The paths one Jest `projects` string names: itself, or, where it is a glob, every
 * directory and file its segments match below the directories the earlier ones name.
 */
function projectDirectories(host: Host, written: string, rootDir: string): readonly string[] {
  const path = resolvePath(rootDir, written);
  if (!MAGIC.test(path)) {
    return [path];
  }
  let found = ["/"];
  for (const segment of path.split("/").filter((one) => one !== "")) {
    if (!MAGIC.test(segment)) {
      found = found
        .map((one) => joinPath(one, segment))
        .filter((one) => host.kindOf(one) !== "absent");
      continue;
    }
    const expression = globExpression(segment);
    found = found.flatMap((one) =>
      host.kindOf(one) === "directory"
        ? host
            .readDirectory(one)
            .filter((entry) => expression.test(entry.name))
            .map((entry) => joinPath(one, entry.name))
        : [],
    );
  }
  return found;
}

/**
 * The tests one Jest project runs: files below each of its `roots` with one of its
 * `moduleFileExtensions`, the only files jest-haste-map lists, that a `testMatch` glob, or a
 * `testRegex` expression, matches over the whole path, and no `testPathIgnorePatterns`
 * expression does. A project writing both `testMatch` and `testRegex` runs none.
 */
function testsOf(object: Value, rootDir: string, defaults: JestDefaults): readonly TestGlob[] {
  const roots = stringsOf(object, "roots");
  const match = stringsOf(object, "testMatch");
  const regex = stringsOf(object, "testRegex");
  const ignore = stringsOf(object, "testPathIgnorePatterns");
  const extensions = stringsOf(object, "moduleFileExtensions");
  if (
    roots === undefined ||
    match === undefined ||
    regex === undefined ||
    ignore === undefined ||
    extensions === undefined
  ) {
    return [];
  }
  const listed = (extensions ?? defaults.moduleFileExtensions).map((one) => `.${one}`);
  const ignored = (ignore ?? ["/node_modules/"]).map((one) => expressionOf(inRoot(one, rootDir)));
  if (ignored.includes(undefined) || ((match ?? []).length > 0 && (regex ?? []).length > 0)) {
    return [];
  }
  const tests: readonly { pattern: string; test: (path: string) => boolean }[] =
    (regex ?? []).length > 0
      ? (regex ?? []).flatMap((one) => {
          const expression = expressionOf(one);
          return expression === undefined
            ? []
            : [{ pattern: one, test: (path: string) => expression.test(path) }];
        })
      : match !== null
        ? jestGlobs(match, rootDir)
        : defaults.testMatch.map((expression) => ({
            pattern: expression.source,
            test: (path: string) => expression.test(path),
          }));
  return (roots ?? ["<rootDir>"]).flatMap((root) => {
    const at = resolvePath(rootDir, inRoot(root, rootDir));
    return tests.map(({ pattern, test }) => ({
      dir: at,
      pattern,
      matches: (name: string) =>
        relativePath(at, name) !== undefined &&
        listed.some((extension) => name.endsWith(extension)) &&
        test(name) &&
        !ignored.some((expression) => expression?.test(name) === true),
    }));
  });
}

/** Jest's `testMatch` globs over the whole path, a `!` glob leaving out what it matches. */
function jestGlobs(
  globs: readonly string[],
  rootDir: string,
): readonly { pattern: string; test: (path: string) => boolean }[] {
  const expression = (glob: string): RegExp =>
    globExpression(inRoot(glob, rootDir).replace(/^\/+/u, ""));
  const excluded = globs
    .filter((one) => one.startsWith("!"))
    .map((one) => expression(one.slice(1)));
  return globs
    .filter((one) => !one.startsWith("!"))
    .map((glob) => {
      const included = expression(glob);
      return {
        pattern: glob,
        test: (path: string) => {
          const bare = path.replace(/^\/+/u, "");
          return included.test(bare) && !excluded.some((one) => one.test(bare));
        },
      };
    });
}

/** Jest 29, which reads no `.mts` or `.cts` configuration and by default runs no `.mjs`, `.cjs`, `.mts` or `.cts` test. */
export const JEST_29 = jestRunner(
  ["jest.config.js", "jest.config.ts", "jest.config.mjs", "jest.config.cjs", "jest.config.json"],
  {
    testMatch: [
      /\/__tests__\/(?:[^/]+\/)*[^/]*\.[jt]sx?$/u,
      /\/(?:[^/]*\.)?(?:spec|test)+\.[jt]sx?$/u,
    ],
    moduleFileExtensions: ["js", "mjs", "cjs", "jsx", "ts", "tsx", "json", "node"],
  },
);

/** Jest 30. */
export const JEST_30 = jestRunner(
  [
    "jest.config.js",
    "jest.config.ts",
    "jest.config.mjs",
    "jest.config.mts",
    "jest.config.cjs",
    "jest.config.cts",
    "jest.config.json",
  ],
  {
    testMatch: [
      /\/__tests__\/(?:[^/]+\/)*[^/]*\.[mc]?[jt]sx?$/u,
      /\/(?:[^/]*\.)?(?:spec|test)+\.[mc]?[jt]sx?$/u,
    ],
    moduleFileExtensions: ["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "json", "node"],
  },
);

/** The directories AVA leaves out, `ignore-by-default` 2.1 with `node_modules`. */
const AVA_IGNORED =
  /(?:^|\/)(?:\.git|\.log|\.nyc_output|\.sass-cache|\.yarn|bower_components|coverage|node_modules)\//u;

/** AVA's default exclusions (`lib/globs`), over the path below the project directory. */
const AVA_HELPERS = [
  /(?:^|\/)__tests__\/(?:.*\/)?__(?:helper|fixture)s?__\//iu,
  /(?:^|\/)tests?\/(?:.*\/)?(?:helper|fixture)s?\//iu,
];

/** The extensions an AVA configuration's `extensions` names, an array or an object's keys. */
function avaExtensions(object: Value): readonly string[] | null | undefined {
  const value = lastOf(object, "extensions");
  if (value === null || value === undefined) {
    return value;
  }
  if (value.kind === "object") {
    return value.members.every((member) => member.key !== undefined)
      ? value.members.flatMap((member) => member.key ?? [])
      : undefined;
  }
  return textsOf(value, true);
}

/**
 * AVA over the first configuration file of the nearest directory holding one, up to the
 * repository's, or the manifest's `ava` member; both, or a function, configure nothing
 * (`lib/load-config`). Its tests match its `files` globs below the manifest's directory without
 * regard to case, a list of exclusions only joining the defaults (`lib/globs`), with one of its
 * extensions, in no directory AVA ignores and named without a leading `_`. Its command line
 * only filters these, so none is read.
 */
function avaRunner(configNames: readonly string[], defaults: readonly string[]): TestRunner {
  return (input) => {
    const { host, dir, manifest } = input;
    let file: Configuration | undefined;
    for (const at of ancestors(dir)) {
      file = input.configuration(at, configNames);
      if (file !== undefined || host.kindOf(joinPath(at, ".git")) !== "absent") {
        break;
      }
    }
    const held = manifestMember(manifest, "ava");
    if (file !== undefined && held !== undefined) {
      return [];
    }
    const object =
      file === undefined
        ? held === undefined
          ? { kind: "object" as const, members: [], at: undefined }
          : documentValue(held)
        : configurationObject(file.module);
    const files = object === undefined ? undefined : stringsOf(object, "files");
    const extensions = object === undefined ? undefined : avaExtensions(object);
    if (files === undefined || extensions === undefined || files?.length === 0) {
      return [];
    }
    const pattern = `{${(extensions ?? defaults).join(",")}}`;
    const written =
      files === null || files.every((one) => one.startsWith("!"))
        ? [
            `test.${pattern}`,
            `{src,source}/test.${pattern}`,
            `**/__tests__/**/*.${pattern}`,
            `**/*.spec.${pattern}`,
            `**/*.test.${pattern}`,
            `**/test-*.${pattern}`,
            `**/test/**/*.${pattern}`,
            `**/tests/**/*.${pattern}`,
            ...(files ?? []),
          ]
        : files;
    const excluded = [
      ...written
        .filter((one) => one.startsWith("!"))
        .map((one) => belowGlob(dir, one.slice(1), true).matches),
      ...(files === null || files.every((one) => one.startsWith("!"))
        ? AVA_HELPERS.map(
            (expression) => (name: string) => expression.test(relativePath(dir, name) ?? ""),
          )
        : []),
    ];
    const kept = new RegExp(
      `\\.(?:${(extensions ?? defaults).map((one) => one.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|")})$`,
      "u",
    );
    return written
      .filter((one) => !one.startsWith("!"))
      .map((one) => {
        const glob = less(belowGlob(dir, one, true), excluded);
        return {
          ...glob,
          matches: (name: string) => {
            const below = relativePath(dir, name) ?? "";
            return (
              glob.matches(name) &&
              kept.test(name) &&
              !AVA_IGNORED.test(below) &&
              !below.split("/").some((segment) => segment.startsWith(".")) &&
              !name.slice(name.lastIndexOf("/") + 1).startsWith("_")
            );
          },
        };
      });
  };
}

const AVA_CONFIG = ["ava.config.js", "ava.config.cjs", "ava.config.mjs"];

/** AVA 6 and 7. */
export const AVA_6 = avaRunner(AVA_CONFIG, ["cjs", "mjs", "js"]);

/** AVA 8, which reads no `ava.config.cjs` and defaults to no `.cjs` test. */
export const AVA_8 = avaRunner(["ava.config.js", "ava.config.mjs"], ["mjs", "js"]);

/**
 * The options of `node` (https://nodejs.org/api/cli.html) a test run writes: the ones that take
 * a value, the flags, and any long option whose value follows `=`.
 */
const NODE_OPTIONS: OptionTable = {
  valued: new Set([
    ...["-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file"],
    ...["--env-file-if-exists", "--conditions", "-C", "--input-type", "--watch-path"],
    ...["--test-reporter", "--test-reporter-destination", "--test-concurrency"],
    ...["--test-name-pattern", "--test-skip-pattern", "--test-timeout", "--test-shard"],
    ...["--test-coverage-include", "--test-coverage-exclude", "--test-coverage-branches"],
    ...["--test-coverage-functions", "--test-coverage-lines", "--test-isolation"],
    ...["--test-global-setup"],
  ]),
  flags: new Set([
    ...["--test", "--test-only", "--watch", "--test-force-exit", "--test-update-snapshots"],
    ...["--test-randomize", "--experimental-test-coverage", "--experimental-test-module-mocks"],
    ...["--experimental-test-snapshots", "--experimental-strip-types", "--no-strip-types"],
    ...["--no-experimental-strip-types", "--experimental-transform-types", "--enable-source-maps"],
    ...["--experimental-vm-modules", "--experimental-detect-module", "--no-warnings"],
    ...["--no-experimental-detect-module", "--experimental-require-module", "--trace-warnings"],
    ...["--no-experimental-require-module", "--expose-gc", "--inspect", "--inspect-brk"],
  ]),
  assigned: true,
};

/** The patterns `node --test` runs with no operand (`doc/api/test.md`), the TypeScript ones where types are stripped. */
function nodeTestDefaults(stripped: boolean): readonly string[] {
  const forms = ["**/*.test", "**/*-test", "**/*_test", "**/test-*", "**/test", "**/test/**/*"];
  return [
    ...forms.map((one) => `${one}.{cjs,mjs,js}`),
    ...(stripped ? forms.map((one) => `${one}.{cts,mts,ts}`) : []),
  ];
}

/**
 * The files each `node --test` command of a manifest's scripts runs: its operands, each a glob
 * read in the command's directory, or the default patterns where it writes none. A command
 * holding a dynamic word or an option {@link NODE_OPTIONS} does not name runs no file here.
 */
export function nodeTestGlobs(scripts: readonly ScriptCommand[]): readonly TestGlob[] {
  return scripts.flatMap((command) => {
    const words = afterProgram(command, ["node"]);
    const read = words === undefined ? undefined : parsed(words, NODE_OPTIONS);
    if (!read?.values.has("--test")) {
      return [];
    }
    const stripped =
      !read.values.has("--no-strip-types") && !read.values.has("--no-experimental-strip-types");
    const patterns = read.operands.length > 0 ? read.operands : nodeTestDefaults(stripped);
    return patterns.map((one) => belowGlob(command.dir, one));
  });
}
