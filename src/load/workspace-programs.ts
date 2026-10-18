/**
 * The programs of a workspace's configurations, each reading the members it imports
 * from source. Each round builds the programs, answers their member imports, and gives
 * the answers back as static resolutions, which the compiler reads as the program's own
 * files rather than a library's, until a round adds none. A configuration with no
 * member import keeps the project the compiler opens for it.
 */

import { ModuleKind, ModuleResolutionKind } from "@typescript/native/sync";
import type {
  CreateSnapshotProgramParams,
  ModuleResolutionEntry,
  ModuleResolver,
  Program,
  ResolutionMode,
} from "@typescript/native/sync";
import { isStringLiteralLikeNode } from "@typescript/native/ast";
import type { StringLiteralLikeNode } from "@typescript/native/ast";
import type { Host } from "../host.ts";
import { JAVASCRIPT_FILE } from "../javascript-file.ts";
import { isRecord } from "../json-document.ts";
import { dirnamePath, resolvePath } from "../paths.ts";
import { batched, type Engine, type ProgramBuild } from "../session.ts";
import type { WorkspaceResolver } from "./workspace-resolution.ts";
import { bytewise } from "../text/compare.ts";
import { PRODUCT } from "../product.ts";
import type { Parsed } from "./discover.ts";
import type { Build, CompilerOptions } from "./plan.ts";

/** One member import no member source answers for. */
interface UnresolvedImport {
  /** The importing file, absolute. */
  readonly file: string;
  readonly specifier: string;
  readonly reason: string;
}

/** What reading one configuration's member imports did. */
export interface MemberReading {
  readonly configFile: string;
  /** The files the configuration itself compiles, absolute. */
  readonly fileNames: readonly string[];
  readonly unresolved: readonly UnresolvedImport[];
  /**
   * Why the configuration's component files are not read, where the snapshots read
   * component files and its program reads none.
   */
  readonly componentsUnread: string | undefined;
}

/** One configuration as a written configuration or a described program. */
type Written = Exclude<Build, { readonly kind: "project" }>;

/** The programs one run builds instead of opening projects, with what reading them did. */
interface WorkspacePrograms {
  /** Per configuration that imports a member, how the snapshot reads it. */
  readonly programs: ReadonlyMap<string, Written>;
  readonly readings: readonly MemberReading[];
}

/** One configuration the rounds read: its parse and the options the plan builds it with. */
export interface PlannedConfiguration {
  readonly configFile: string;
  readonly parsed: Parsed;
  readonly options: CompilerOptions;
  /** The configuration of a program the run forms, which only the snapshot holds, at `configFile`. */
  readonly written?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * The options a configuration's program is built with: the plan's, less the ones that lay
 * out an emitted program's inputs and outputs. The analysis emits nothing, and a member's
 * source is outside the importer's root directory by construction, which the compiler
 * refuses under such a layout.
 */
function analysisOptions(
  options: CompilerOptions,
  readsJavaScript: boolean,
): CreateSnapshotProgramParams["compilerOptions"] {
  const {
    composite,
    rootDir: _rootDir,
    outDir: _outDir,
    declarationDir: _declarationDir,
    tsBuildInfoFile: _tsBuildInfoFile,
    ...kept
  } = options;
  const read = readsJavaScript ? { ...kept, allowJs: true } : kept;
  return composite === true ? { ...read, declaration: true } : read;
}

/**
 * Whether one reading answers a member import with a JavaScript file, which its program reads
 * as source only where it allows JavaScript, a program formed for a JavaScript member being the
 * member's source.
 */
function readsJavaScript(reading: Reading): boolean {
  return (
    reading.options.allowJs !== true &&
    reading.entries.some((entry) => {
      const file = entry.result.resolvedFileName;
      return typeof file === "string" && JAVASCRIPT_FILE.test(file);
    })
  );
}

/** The conditions an `exports` lookup under one configuration and one resolution mode reads. */
function conditionsOf(parsed: Parsed, mode: ResolutionMode | undefined): ReadonlySet<string> {
  const resolution = parsed.options.moduleResolution;
  const nodeLike =
    resolution === ModuleResolutionKind.Node16 || resolution === ModuleResolutionKind.NodeNext;
  return new Set([
    "types",
    mode === ModuleKind.CommonJS ? "require" : "import",
    ...(nodeLike ? ["node"] : []),
    ...(parsed.options.customConditions ?? []),
    "default",
  ]);
}

function resolutionMode(kind: ModuleKind): ResolutionMode | undefined {
  return kind === ModuleKind.CommonJS || kind === ModuleKind.ESNext ? kind : undefined;
}

/** One configuration's state across the rounds. */
interface Reading extends PlannedConfiguration {
  readonly entries: ModuleResolutionEntry[];
  readonly seen: Set<string>;
  /** Per member specifier, every file an import of it is read as. */
  readonly bound: Map<string, Set<string>>;
  readonly unresolved: UnresolvedImport[];
}

/** The directories the compiler leaves out of a configuration that names no `exclude`. */
const DEFAULT_EXCLUDES = ["node_modules", "bower_components", "jspm_packages"];

/** Why one configuration's answers cannot be `paths`: a specifier read as two files. */
function unstatable(reading: Reading): string | undefined {
  const answered = new Set(reading.entries.map((entry) => entry.moduleName));
  for (const [specifier, files] of reading.bound) {
    if (answered.has(specifier) && files.size > 1) {
      return `the imports of ${specifier} are read as ${String(files.size)} different files, which a configuration cannot state`;
    }
  }
  return undefined;
}

/** The path beside `configFile` its written configuration takes, which no file and none of `taken` has. */
export function writtenPath(
  host: Host,
  configFile: string,
  taken: ReadonlySet<string> = new Set(),
): string {
  const stem = configFile.replace(/\.json$/u, "");
  for (let counter = 0; ; counter += 1) {
    const path = `${stem}.${PRODUCT}${counter === 0 ? "" : `-${String(counter)}`}.json`;
    if (host.kindOf(path) === "absent" && !taken.has(path)) {
      return path;
    }
  }
}

/**
 * The path the snapshot holds one configuration's written form at: a formed configuration's
 * own path, else a free one beside it that no configuration of `formed` holds, because a formed
 * program in a directory with a `jsconfig.json` takes the name that file's written form would.
 */
export function writtenFileOf(
  host: Host,
  configuration: Pick<PlannedConfiguration, "configFile" | "written">,
  formed: ReadonlySet<string>,
): string {
  return configuration.written === undefined
    ? writtenPath(host, configuration.configFile, formed)
    : configuration.configFile;
}

/**
 * The configuration that reads as one configuration's program: it extends it, lays out no output
 * ({@link analysisOptions}), maps each answered specifier to its file and keeps its references.
 * Where the file list moves, the default `exclude` the dropped output directories are named in is
 * restated, and one that {@link readsJavaScript} lists its files outright, as `allowJs` widens its
 * `include` to JavaScript; a list that still differs, or answers `paths` cannot state, are a
 * reason. A formed configuration, which no file holds to extend, is its own value with `paths`.
 */
function configurationOf(
  engine: Engine,
  host: Host,
  reading: Reading,
  formed: ReadonlySet<string>,
): Written | { readonly kind: "unread"; readonly reason: string } {
  const reason = unstatable(reading);
  if (reason !== undefined) {
    return { kind: "unread", reason };
  }
  const { options } = reading;
  const references = reading.parsed.projectReferences ?? [];
  const raw: unknown = (options as Record<string, unknown>)["pathsBasePath"];
  const base = typeof raw === "string" ? raw : dirnamePath(reading.configFile);
  const paths: Record<string, string[]> = {};
  for (const [key, targets] of Object.entries(options.paths ?? {})) {
    paths[key] = targets.map((target) => resolvePath(base, target));
  }
  for (const entry of reading.entries) {
    const [file] = reading.bound.get(entry.moduleName) ?? [];
    if (file !== undefined) {
      paths[entry.moduleName] = [file];
    }
  }
  if (reading.written !== undefined) {
    const held = reading.written["compilerOptions"];
    return {
      kind: "configuration",
      value: {
        ...reading.written,
        compilerOptions: { ...(isRecord(held) ? held : {}), paths },
      },
    };
  }
  const javascript = readsJavaScript(reading);
  const json = (exclude: readonly string[] | undefined): Record<string, unknown> => ({
    extends: reading.configFile,
    compilerOptions: {
      rootDir: null,
      outDir: null,
      declarationDir: null,
      tsBuildInfoFile: null,
      ...(options.composite === true ? { composite: false, declaration: true } : {}),
      ...(javascript ? { allowJs: true } : {}),
      paths,
    },
    ...(references.length > 0
      ? { references: references.map((reference) => ({ path: reference.path })) }
      : {}),
    ...(javascript ? { files: [...reading.parsed.fileNames], include: [] } : {}),
    ...(exclude === undefined ? {} : { exclude }),
  });
  const file = writtenFileOf(host, reading, formed);
  const expected = [...reading.parsed.fileNames].sort(bytewise).join("\u0000");
  const listed = (value: Record<string, unknown>): string | undefined => {
    try {
      return [...engine.parseConfigJson(value, file).fileNames].sort(bytewise).join("\u0000");
    } catch {
      return undefined;
    }
  };
  let value = json(undefined);
  if (listed(value) !== expected) {
    value = json([
      ...DEFAULT_EXCLUDES,
      ...[options.outDir, options.declarationDir].filter((dir) => dir !== undefined),
    ]);
    if (listed(value) !== expected) {
      return {
        kind: "unread",
        reason: "its file list cannot be restated without its output directories",
      };
    }
  }
  return { kind: "configuration", value };
}

/** The program one configuration is built as, under the answers it holds so far. */
function programOf(
  engine: Engine,
  reading: Reading,
): { readonly params: CreateSnapshotProgramParams; readonly resolver: ModuleResolver } {
  const compilerOptions = analysisOptions(reading.options, readsJavaScript(reading));
  const references = reading.parsed.projectReferences ?? [];
  const resolver = engine.createModuleResolver(compilerOptions, reading.entries);
  return {
    resolver,
    params: {
      rootFiles: reading.parsed.fileNames,
      compilerOptions,
      options: {
        moduleResolver: resolver,
        configFileParsingDiagnostics: reading.parsed.errors,
        ...(references.length > 0 ? { projectReferences: references } : {}),
      },
    },
  };
}

/** One round over one program: answers the member imports no earlier round asked about. */
function scan(
  engine: Engine,
  program: Program,
  reading: Reading,
  resolver: WorkspaceResolver,
): number {
  const names = program.getSourceFileNames().filter((name) => !name.includes("/node_modules/"));
  const files = batched<string, ReturnType<Program["getSourceFile"]>>(engine, names, (name) =>
    program.getSourceFile.gen(name),
  );
  const usages: { readonly file: string; readonly node: StringLiteralLikeNode }[] = [];
  files.forEach((file, at) => {
    const name = names[at];
    if (file === undefined || name === undefined) {
      return;
    }
    for (const node of file.imports) {
      if (isStringLiteralLikeNode(node) && resolver.names(node.text)) {
        usages.push({ file: name, node });
      }
    }
  });
  const modes = batched<(typeof usages)[number], ModuleKind>(engine, usages, (usage) =>
    program.getModeForUsageLocation.gen(usage.file, usage.node),
  );
  const asked: {
    readonly usage: (typeof usages)[number];
    readonly mode: ResolutionMode | undefined;
  }[] = [];
  usages.forEach((usage, at) => {
    const mode = resolutionMode(modes[at] ?? ModuleKind.None);
    const key = [usage.node.text, dirnamePath(usage.file), String(mode)].join("\u0000");
    if (!reading.seen.has(key)) {
      reading.seen.add(key);
      asked.push({ usage, mode });
    }
  });
  const answers = batched<
    (typeof asked)[number],
    ReturnType<Program["getResolvedModuleFromModuleSpecifier"]>
  >(engine, asked, ({ usage }) =>
    program.getResolvedModuleFromModuleSpecifier.gen(usage.node, usage.file),
  );
  let added = 0;
  asked.forEach(({ usage, mode }, at) => {
    const answered = answers[at];
    const specifier = usage.node.text;
    const containingDirectory = dirnamePath(usage.file);
    const compiled =
      answered?.resolvedFileName === undefined || answered.resolvedFileName === ""
        ? undefined
        : answered;
    const answer = resolver.resolve(
      specifier,
      containingDirectory,
      conditionsOf(reading.parsed, mode),
      compiled,
    );
    if (answer.kind !== "unresolved") {
      const bound = reading.bound.get(specifier) ?? new Set<string>();
      bound.add(answer.kind === "source" ? answer.file : (compiled?.resolvedFileName ?? ""));
      reading.bound.set(specifier, bound);
    }
    if (answer.kind === "source") {
      reading.entries.push({
        moduleName: specifier,
        containingDirectory,
        resolutionMode: mode,
        result: { resolvedFileName: answer.file },
      });
      added += 1;
    } else if (answer.kind === "unresolved") {
      reading.unresolved.push({
        file: usage.file,
        specifier,
        reason: answer.reason,
      });
    }
  });
  return added;
}

/** One configuration as one round builds it. */
type Built =
  | {
      readonly kind: "program";
      readonly params: CreateSnapshotProgramParams;
      readonly resolver: ModuleResolver;
    }
  | { readonly kind: "configuration"; readonly file: string; readonly text: string };

function configurationText(value: Readonly<Record<string, unknown>>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** One configuration value as the snapshot holds it, at `file`, which no file on disk holds. */
export function writtenConfiguration(
  file: string,
  value: Readonly<Record<string, unknown>>,
): Extract<ProgramBuild, { readonly kind: "configuration" }> {
  return { kind: "configuration", file, text: configurationText(value) };
}

/**
 * Answers the member imports of every reading `build` describes, round by round, all
 * the readings still adding answers built in one snapshot per round. A reading `build`
 * gives no description for leaves the rounds.
 */
function readRounds(
  engine: Engine,
  readings: readonly Reading[],
  resolver: WorkspaceResolver,
  build: (reading: Reading) => Built | undefined,
): void {
  let pending = readings;
  while (pending.length > 0) {
    const built = pending.flatMap((reading) => {
      const one = build(reading);
      return one === undefined ? [] : [{ reading, one }];
    });
    const programs = built.flatMap(({ one }) => (one.kind === "program" ? [one.params] : []));
    const written = new Map(
      built.flatMap(({ one }) =>
        one.kind === "configuration" ? [[one.file, one.text] as const] : [],
      ),
    );
    const snapshot = engine.createSnapshot([...written.keys()], programs, written);
    try {
      const created = snapshot.operation.createdPrograms ?? [];
      const opened = new Map<string | undefined, Program>(
        snapshot.getProjects().map((project) => [project.configFileName, project.program]),
      );
      let at = 0;
      pending = built.flatMap(({ reading, one }) => {
        const program = one.kind === "program" ? created[at++] : opened.get(one.file);
        return program !== undefined && scan(engine, program, reading, resolver) > 0
          ? [reading]
          : [];
      });
    } finally {
      snapshot.dispose();
      for (const { one } of built) {
        if (one.kind === "program") {
          one.resolver[Symbol.dispose]();
        }
      }
    }
  }
}

/**
 * Reads every configuration's member imports. Where the snapshots read component files,
 * the rounds go on over each reading's configuration, which reads them, for the imports
 * only they make.
 */
export function workspacePrograms(
  engine: Engine,
  host: Host,
  configurations: readonly PlannedConfiguration[],
  resolver: WorkspaceResolver,
): WorkspacePrograms {
  const readings: Reading[] = configurations.map((configuration) => ({
    ...configuration,
    entries: [],
    seen: new Set<string>(),
    bound: new Map<string, Set<string>>(),
    unresolved: [],
  }));
  const formed = new Set(
    configurations.filter((one) => one.written !== undefined).map((one) => one.configFile),
  );
  readRounds(engine, readings, resolver, (reading) => ({
    kind: "program",
    ...programOf(engine, reading),
  }));
  if (engine.readsComponents) {
    readRounds(engine, readings, resolver, (reading) => {
      const one = configurationOf(engine, host, reading, formed);
      return one.kind === "configuration"
        ? writtenConfiguration(writtenFileOf(host, reading, formed), one.value)
        : undefined;
    });
  }
  const programs = new Map<string, Written>();
  const unread = new Map<string, string>();
  for (const reading of readings) {
    if (reading.entries.length === 0) {
      continue;
    }
    const one = engine.readsComponents ? configurationOf(engine, host, reading, formed) : undefined;
    if (one !== undefined && one.kind !== "unread") {
      programs.set(reading.configFile, one);
      continue;
    }
    programs.set(reading.configFile, {
      kind: "program",
      params: programOf(engine, reading).params,
    });
    if (one !== undefined) {
      unread.set(reading.configFile, one.reason);
    }
  }
  return {
    programs,
    readings: readings.map((reading) => ({
      configFile: reading.configFile,
      fileNames: reading.parsed.fileNames,
      unresolved: reading.unresolved,
      componentsUnread: unread.get(reading.configFile),
    })),
  };
}
