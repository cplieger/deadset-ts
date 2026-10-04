/**
 * The programs of a workspace's configurations, each reading the members it imports
 * from source. Each round builds the programs, answers their member imports, and gives
 * the answers back as static resolutions, which the compiler reads as the program's own
 * files rather than a library's, until a round adds none. A configuration with no
 * member import keeps the project the compiler opens for it.
 */

import { ModuleKind, ModuleResolutionKind } from "@typescript/native/unstable/sync";
import type {
  CreateSnapshotProgramParams,
  ModuleResolutionEntry,
  ModuleResolver,
  Program,
  ResolutionMode,
} from "@typescript/native/unstable/sync";
import { isStringLiteralLikeNode } from "@typescript/native/unstable/ast";
import type { StringLiteralLikeNode } from "@typescript/native/unstable/ast";
import type { Host } from "./host.ts";
import { dirnamePath, joinPath, resolvePath } from "./paths.ts";
import type { Engine } from "./session.ts";
import type { WorkspaceResolver } from "./workspace-resolution.ts";

/** One member import no member source answers for. */
export interface UnresolvedImport {
  /** The importing file, absolute. */
  readonly file: string;
  readonly specifier: string;
  readonly member: string;
  readonly subpath: string;
  readonly reason: string;
}

/** What reading one configuration's member imports did. */
export interface MemberReading {
  readonly configFile: string;
  /** The files the configuration itself compiles, absolute. */
  readonly fileNames: readonly string[];
  /** The static resolutions its program is built with; none for a configuration opened as a project. */
  readonly entries: readonly ModuleResolutionEntry[];
  readonly unresolved: readonly UnresolvedImport[];
  /**
   * Why the configuration's component files are not read, where the snapshots read
   * component files and its program reads none.
   */
  readonly componentsUnread: string | undefined;
}

/** How a snapshot reads one configuration that imports a member. */
export type WorkspaceProgram =
  | { readonly kind: "program"; readonly params: CreateSnapshotProgramParams }
  /** A configuration only the snapshot holds, at a path no file has. */
  | { readonly kind: "configuration"; readonly file: string; readonly text: string };

/** The programs one run builds instead of opening projects, with what reading them did. */
export interface WorkspacePrograms {
  /** Per configuration that imports a member, how the snapshot reads it. */
  readonly programs: ReadonlyMap<string, WorkspaceProgram>;
  readonly readings: readonly MemberReading[];
}

type Parsed = ReturnType<Engine["parseConfigFile"]>;

/** The most questions one round trip carries. */
const BATCH = 2048;

/**
 * The options a configuration's program is built with: its own, less the ones that
 * lay out an emitted program's inputs and outputs. The analysis emits nothing, and a
 * member's source is outside the importer's root directory by construction, which
 * the compiler refuses under such a layout.
 */
function analysisOptions(parsed: Parsed): CreateSnapshotProgramParams["compilerOptions"] {
  const {
    composite,
    rootDir: _rootDir,
    outDir: _outDir,
    declarationDir: _declarationDir,
    tsBuildInfoFile: _tsBuildInfoFile,
    ...kept
  } = parsed.options;
  return composite === true ? { ...kept, declaration: true } : kept;
}

/**
 * The references a built program can carry: only where every referenced
 * configuration reads and is composite with output, because the compiler reports a
 * broken reference at syntax a built program does not have.
 */
function carriedReferences(
  engine: Engine,
  parsed: Parsed,
): NonNullable<Parsed["projectReferences"]> {
  const references = parsed.projectReferences ?? [];
  for (const reference of references) {
    // A reference that names a directory names the `tsconfig.json` in it.
    const configFile = reference.path.endsWith(".json")
      ? reference.path
      : joinPath(reference.path, "tsconfig.json");
    let options: Parsed["options"];
    try {
      options = engine.parseConfigFile(configFile).options;
    } catch {
      return [];
    }
    if (options.composite !== true || options.noEmit === true) {
      return [];
    }
  }
  return references;
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
interface Reading {
  readonly configFile: string;
  readonly parsed: Parsed;
  readonly references: NonNullable<Parsed["projectReferences"]>;
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

/** The path beside `configFile` its written configuration takes, which no file has. */
function writtenPath(host: Host, configFile: string): string {
  const stem = configFile.replace(/\.json$/u, "");
  for (let counter = 0; ; counter += 1) {
    const path = `${stem}.deadset-ts${counter === 0 ? "" : `-${String(counter)}`}.json`;
    if (host.kindOf(path) === "absent") {
      return path;
    }
  }
}

/**
 * The configuration that reads as one configuration's program: it extends it, lays out
 * no output for the reason {@link analysisOptions} gives, maps each answered specifier
 * to its file, and carries the references the program does. The compiler's default
 * `exclude` names the output directories this drops, so where the file list moves it is
 * restated; a list that still differs, or answers `paths` cannot state, are a reason.
 */
function configurationOf(
  engine: Engine,
  host: Host,
  reading: Reading,
): WorkspaceProgram | { readonly kind: "unread"; readonly reason: string } {
  const reason = unstatable(reading);
  if (reason !== undefined) {
    return { kind: "unread", reason };
  }
  const { options } = reading.parsed;
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
  const json = (exclude: readonly string[] | undefined): Record<string, unknown> => ({
    extends: reading.configFile,
    compilerOptions: {
      rootDir: null,
      outDir: null,
      declarationDir: null,
      tsBuildInfoFile: null,
      ...(options.composite === true ? { composite: false, declaration: true } : {}),
      paths,
    },
    ...(reading.references.length > 0
      ? { references: reading.references.map((reference) => ({ path: reference.path })) }
      : {}),
    ...(exclude === undefined ? {} : { exclude }),
  });
  const file = writtenPath(host, reading.configFile);
  const expected = [...reading.parsed.fileNames].sort().join("\u0000");
  const listed = (value: Record<string, unknown>): string | undefined => {
    try {
      return [...engine.parseConfigJson(value, file).fileNames].sort().join("\u0000");
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
  return { kind: "configuration", file, text: `${JSON.stringify(value, null, 2)}\n` };
}

/** The program one configuration is built as, under the answers it holds so far. */
function programOf(
  engine: Engine,
  reading: Reading,
): { readonly params: CreateSnapshotProgramParams; readonly resolver: ModuleResolver } {
  const compilerOptions = analysisOptions(reading.parsed);
  const resolver = engine.createModuleResolver(compilerOptions, reading.entries);
  return {
    resolver,
    params: {
      rootFiles: reading.parsed.fileNames,
      compilerOptions,
      options: {
        moduleResolver: resolver,
        configFileParsingDiagnostics: reading.parsed.errors,
        ...(reading.references.length > 0 ? { projectReferences: reading.references } : {}),
      },
    },
  };
}

function chunks<T>(items: readonly T[]): readonly (readonly T[])[] {
  const found: T[][] = [];
  for (let at = 0; at < items.length; at += BATCH) {
    found.push(items.slice(at, at + BATCH));
  }
  return found;
}

/** Asks one question of every item, in round trips of at most {@link BATCH}. */
function batched<T, A>(
  engine: Engine,
  items: readonly T[],
  question: (item: T) => Parameters<Engine["batch"]>[0][number],
): A[] {
  return chunks(items).flatMap((run) => engine.batch(run.map(question)) as A[]);
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
        member: answer.member,
        subpath: answer.subpath,
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
  configFiles: readonly string[],
  resolver: WorkspaceResolver,
): WorkspacePrograms {
  const readings: Reading[] = configFiles.flatMap((configFile) => {
    let parsed: Parsed;
    try {
      parsed = engine.parseConfigFile(configFile);
    } catch {
      // A configuration that does not read is opened as a project, which states why.
      return [];
    }
    return [
      {
        configFile,
        parsed,
        references: carriedReferences(engine, parsed),
        entries: [],
        seen: new Set<string>(),
        bound: new Map<string, Set<string>>(),
        unresolved: [],
      },
    ];
  });
  readRounds(engine, readings, resolver, (reading) => ({
    kind: "program",
    ...programOf(engine, reading),
  }));
  if (engine.readsComponents) {
    readRounds(engine, readings, resolver, (reading) => {
      const one = configurationOf(engine, host, reading);
      return one.kind === "configuration" ? one : undefined;
    });
  }
  const programs = new Map<string, WorkspaceProgram>();
  const unread = new Map<string, string>();
  for (const reading of readings) {
    if (reading.entries.length === 0) {
      continue;
    }
    const one = engine.readsComponents ? configurationOf(engine, host, reading) : undefined;
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
      entries: reading.entries,
      unresolved: reading.unresolved,
      componentsUnread: unread.get(reading.configFile),
    })),
  };
}
