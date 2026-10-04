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
import { dirnamePath, joinPath } from "./paths.ts";
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
}

/** The programs one run builds instead of opening projects, with what reading them did. */
export interface WorkspacePrograms {
  /** Per configuration that imports a member, the program to build for it. */
  readonly programs: ReadonlyMap<string, CreateSnapshotProgramParams>;
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
  readonly unresolved: UnresolvedImport[];
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
    const answer = resolver.resolve(
      specifier,
      containingDirectory,
      conditionsOf(reading.parsed, mode),
      answered?.resolvedFileName === undefined || answered.resolvedFileName === ""
        ? undefined
        : answered,
    );
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

/**
 * Reads every configuration's member imports, round by round, all the configurations
 * still adding answers built in one snapshot per round.
 */
export function workspacePrograms(
  engine: Engine,
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
        unresolved: [],
      },
    ];
  });
  let pending: readonly Reading[] = readings;
  while (pending.length > 0) {
    const built = pending.map((reading) => programOf(engine, reading));
    const snapshot = engine.createSnapshot(
      [],
      built.map((one) => one.params),
    );
    try {
      const created = snapshot.operation.createdPrograms ?? [];
      pending = pending.filter((reading, at) => {
        const program = created[at];
        return program !== undefined && scan(engine, program, reading, resolver) > 0;
      });
    } finally {
      snapshot.dispose();
      for (const one of built) {
        one.resolver[Symbol.dispose]();
      }
    }
  }
  const programs = new Map<string, CreateSnapshotProgramParams>();
  for (const reading of readings) {
    if (reading.entries.length > 0) {
      programs.set(reading.configFile, programOf(engine, reading).params);
    }
  }
  return {
    programs,
    readings: readings.map((reading) => ({
      configFile: reading.configFile,
      fileNames: reading.parsed.fileNames,
      entries: reading.entries,
      unresolved: reading.unresolved,
    })),
  };
}
