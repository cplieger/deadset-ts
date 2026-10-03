import { API, SymbolFlags } from "@typescript/native/unstable/sync";
import type {
  APIRequestGenerator,
  Diagnostic,
  DocumentIdentifier,
  NodeHandle,
  Project,
  Program,
  Snapshot,
  Symbol as TSSymbol,
  TimingInfo,
} from "@typescript/native/unstable/sync";
import type { Node, SourceFile } from "@typescript/native/unstable/ast";
import { DiscoveryError } from "./discover.ts";
import {
  queriesOf,
  UnansweredLog,
  type Answer,
  type Queries,
  type UnansweredQuestion,
} from "./query.ts";

/**
 * The compiler the analysis reads through. It is a client over a protocol to a
 * separate process, so every accessor call is a round trip and a run holds one
 * client and one snapshot.
 *
 * It is an interface because the run's own accounting for that lifetime is not on
 * the client's surface: a snapshot reports whether it is disposed and not how many
 * a client opened, so the count is observed at this seam.
 */
export interface Engine {
  /**
   * Resolves one compiler configuration file, or throws with the reason it cannot
   * be read. The result is spelled through the client's own signature: the type
   * the compiler package returns here is not one of its exported names.
   */
  parseConfigFile(file: DocumentIdentifier): ReturnType<API["parseConfigFile"]>;
  /** Opens one snapshot holding every project named. */
  createSnapshot(openProjects: readonly string[]): Snapshot;
  /** Sends many questions in one round trip and answers each, in order. */
  batch<T>(questions: readonly APIRequestGenerator<T>[]): T[];
  /**
   * Puts one question to a project's checker, by the accessor's name and the locations
   * it asks about. Every guarded question passes through here, so a caller that
   * observes or fails questions does it at this seam.
   */
  ask<T>(accessor: string, locations: () => readonly string[], question: () => T): T;
  /** Round-trip latency, bytes transferred and server time, when collection is on. */
  getTimingInfo(): TimingInfo;
  /** Releases the client and the process behind it. */
  close(): void;
}

/** How a run opens its compiler client. */
export interface EngineOptions {
  /** Collect per-request timing, which the calibration record reads. */
  readonly collectTiming: boolean;
}

/**
 * Opens the compiler client the analysis reads through.
 *
 * Closing twice releases once: a run that fails before its snapshot opens closes
 * the client where it failed, and the outer release runs whatever happened, so the
 * second call has nothing left to do.
 */
export function openEngine(options: EngineOptions): Engine {
  const api = new API({ collectTiming: options.collectTiming });
  let closed = false;
  return {
    parseConfigFile: (file) => api.parseConfigFile(file),
    createSnapshot: (openProjects) => api.createSnapshot({ openProjects: [...openProjects] }),
    batch: <T>(questions: readonly APIRequestGenerator<T>[]) =>
      api.batch<readonly APIRequestGenerator<T>[]>(...questions),
    ask: (_accessor, _locations, question) => question(),
    getTimingInfo: () => api.getTimingInfo(),
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      api.close();
    },
  };
}

/**
 * A node of one project's program, carried with that project's identity.
 *
 * `Brand` is a type parameter and never a value: a view is handed to a visitor
 * that introduces its own `Brand`, so two projects' views have handle types the
 * compiler will not exchange and a handle cannot reach another project's checker.
 * Handles are only meaningful inside the program that produced them, and the
 * cross-project step of the analysis compares rendered positions rather than
 * handles.
 */
export interface Handle<Brand> {
  readonly node: Node;
  /** Present only in the type: the project this handle belongs to. */
  readonly project?: Brand;
}

/** One project's program and checker, together with the handles they accept. */
export interface ProjectView<Brand> {
  /** The compiler configuration file this project was opened from. */
  readonly configFile: string;
  /** The project's program, whose walk is local to this process. */
  readonly program: Program;
  /**
   * The questions the project's checker answers, each guarded. Every one is a round
   * trip, and one may go unanswered.
   */
  readonly queries: Queries;
  /** The source files the program holds that are the target's own. */
  ownSourceFiles(): readonly SourceFile[];
  /**
   * The keys of the target's own files, which is how a declaration handle names the
   * file it is in.
   */
  ownPaths(): ReadonlySet<string>;
  /** A handle to one node of this project's program. */
  handle(node: Node): Handle<Brand>;
  /**
   * The symbols a batch of this project's nodes resolve to, in the order the handles
   * were given, in runs of at most `cap`. The batch is how a file's identifiers reach
   * the checker, and `undefined` marks a node the batch did not resolve.
   */
  symbolsAt(handles: readonly Handle<Brand>[], cap?: number): Answer<TSSymbol | undefined>[];
  /**
   * The symbol one node resolves to, asked for that node alone. The accessor behind
   * it takes one identifier and offers no array form, so it answers only for the
   * residue a batch left unresolved. A node that is not an identifier has no such
   * answer.
   */
  resolvedSymbolAt(handle: Handle<Brand>): Answer<TSSymbol | undefined>;
  /**
   * The symbol the value of one shorthand property assignment names, which is the
   * declaration `{ a }` reads; the symbol the property's own name resolves to is the
   * property the literal declares. The handle names the assignment, not its name.
   */
  shorthandValueAt(handle: Handle<Brand>): Answer<TSSymbol | undefined>;
  /**
   * The symbol one alias names, one link along: an import or export specifier
   * resolves to the declaration it carries forward, or to the next alias of a chain.
   * `undefined` where the symbol is no alias, or where the alias resolves to nothing.
   */
  aliasStepOf(symbol: TSSymbol): Answer<TSSymbol | undefined>;
  /**
   * The node one symbol's declaration handle names, read in this project's program,
   * or `undefined` where this project's program does not hold that file.
   *
   * A symbol is shared by every project of the snapshot and remembers the project it
   * was first seen in, so resolving its handle without saying which program to read
   * would answer out of whichever project reached the symbol first. The project is
   * named here instead, and the answer becomes a handle of this project like any
   * other. The read is local once the file has been fetched.
   */
  declarationAt(handle: NodeHandle): Handle<Brand> | undefined;
}

/**
 * What a run does with one project. It carries its own type parameter so each
 * invocation gets a distinct `Brand`: a handle taken from one invocation's view is
 * not a handle another invocation's view accepts.
 */
export type ProjectVisitor<Result> = <Brand>(project: ProjectView<Brand>) => Result;

function viewOf<Brand>(
  project: Project,
  configFile: string,
  engine: Engine,
  log: UnansweredLog,
): ProjectView<Brand> {
  const queries = queriesOf(
    project.checker,
    configFile,
    (questions) => engine.batch(questions),
    log,
    (accessor, locations, question) => engine.ask(accessor, locations, question),
  );
  // The snapshot is never updated, so a project's own file set is the same answer
  // every time it is asked for. It is read once because the question is not free:
  // deciding it consults the metadata of every file the program holds, the compiler's
  // own library files included, and a run asks for the set once per pass.
  let ownFiles: readonly SourceFile[] | undefined;
  let ownKeys: ReadonlySet<string> | undefined;
  const ownSourceFiles = (): readonly SourceFile[] => {
    ownFiles ??= project.program
      .getSourceFileNames()
      // The metadata decides which files belong to the target, and it is read by
      // name. Fetching each file first and filtering afterwards costs one round
      // trip per library file the answer then discards, and a program holds far
      // more library files than target files.
      .filter((name) => {
        const metadata = project.program.getSourceFileMetadata(name);
        return (
          metadata !== undefined && !metadata.isDefaultLibrary && !metadata.isFromExternalLibrary
        );
      })
      .map((name) => project.program.getSourceFile(name))
      .filter((file): file is SourceFile => file !== undefined);
    return ownFiles;
  };
  return {
    configFile,
    program: project.program,
    queries,
    ownSourceFiles,
    ownPaths: () => {
      ownKeys ??= new Set(ownSourceFiles().map((file) => file.path));
      return ownKeys;
    },
    handle: (node) => ({ node }),
    symbolsAt: (handles, cap) =>
      queries.symbolsAt(
        handles.map(({ node }) => node),
        cap,
      ),
    resolvedSymbolAt: ({ node }) => queries.resolvedSymbol(node),
    shorthandValueAt: ({ node }) => queries.shorthandValue(node),
    aliasStepOf: (symbol) => {
      // The step is asked of an alias only: asked of any other symbol, the compiler
      // fails an assertion and the session ends.
      if ((symbol.flags & SymbolFlags.Alias) === 0) {
        return undefined;
      }
      const held = queries.immediateAliased(symbol);
      // An alias that resolves to nothing answers with the checker's own unknown
      // symbol, which declares nothing; a symbol that is no alias answers with
      // nothing at all.
      return typeof held === "object" && held.declarations.length === 0 ? undefined : held;
    },
    declarationAt: (handle) => {
      const node = handle.resolve(project);
      return node === undefined ? undefined : { node };
    },
  };
}

/**
 * The same project, its own source files narrowed to the ones `keep` admits. A consumer's
 * program holds the target's files it imports beside its own, and a pass that enumerates
 * the target's declarations in that program reads those files alone.
 */
export function narrowedTo<Brand>(
  project: ProjectView<Brand>,
  keep: (file: SourceFile) => boolean,
): ProjectView<Brand> {
  let kept: readonly SourceFile[] | undefined;
  let keys: ReadonlySet<string> | undefined;
  const ownSourceFiles = (): readonly SourceFile[] => {
    kept ??= project.ownSourceFiles().filter(keep);
    return kept;
  };
  return {
    ...project,
    ownSourceFiles,
    ownPaths: () => {
      keys ??= new Set(ownSourceFiles().map((file) => file.path));
      return keys;
    },
  };
}

/** Every diagnostic set a project is refused for carrying an error in. */
export interface ProjectDiagnostics {
  readonly configFile: string;
  readonly syntactic: readonly Diagnostic[];
  readonly semantic: readonly Diagnostic[];
  readonly configParsing: readonly Diagnostic[];
  /** The line and column of one offset into one of the program's files, counted from one. */
  readonly locate: (
    fileName: string,
    offset: number,
  ) => { line: number; column: number } | undefined;
}

/** The three diagnostic sets one project carries, read before any analysis. */
export function diagnosticsOf<Brand>(project: ProjectView<Brand>): ProjectDiagnostics {
  return {
    configFile: project.configFile,
    syntactic: project.program.getSyntacticDiagnostics(),
    semantic: project.program.getSemanticDiagnostics(),
    configParsing: project.program.getConfigFileParsingDiagnostics(),
    locate: (fileName, offset) => {
      const file = project.program.getSourceFile(fileName);
      if (file === undefined || offset < 0 || offset > file.text.length) {
        return undefined;
      }
      const { line, character } = file.getLineAndCharacterOfPosition(offset);
      return { line: line + 1, column: character + 1 };
    },
  };
}

/** One run's result: what the visitor answered for each project, and what it cost. */
export interface SessionResult<Result> {
  /** One answer per configuration the snapshot opened a project for, in the order named. */
  readonly projects: readonly Result[];
  /** The configurations the snapshot opened no project for, in the order named. */
  readonly unopened: readonly string[];
  readonly timing: TimingInfo;
  /** Every question the checker could not answer, each once, in the order first asked. */
  readonly unanswered: readonly UnansweredQuestion[];
}

/** What a run does about a configuration the snapshot opened no project for. */
type Unopened = "refuse" | "record";

/**
 * Runs `visit` over every project the compiler configurations name, inside one
 * snapshot of one client, in the order they are named, and answers in that order.
 *
 * The snapshot is opened once with every configuration, so each becomes a project
 * with its own program and checker; it is never updated, because the analysis
 * reads and the tree does not change under it. The order the snapshot lists its
 * projects in is the compiler's own, so each named configuration is looked up in it
 * instead. A configuration the snapshot opened no project for ends the run under
 * `"refuse"` and is named in the result under `"record"`. The snapshot is disposed once
 * the last project has been visited, and the client is released after it, whether the
 * visit completed or threw.
 */
export function runSession<Result>(
  engine: Engine,
  configFiles: readonly string[],
  visit: ProjectVisitor<Result>,
  unopened: Unopened = "refuse",
): SessionResult<Result> {
  try {
    const snapshot = engine.createSnapshot(configFiles);
    try {
      const opened = new Map<string, Project>();
      for (const project of snapshot.getProjects()) {
        if (project.configFileName !== undefined) {
          opened.set(project.configFileName, project);
        }
      }
      const log = new UnansweredLog();
      const projects: Result[] = [];
      const missing: string[] = [];
      for (const configFile of configFiles) {
        const project = opened.get(configFile);
        if (project === undefined) {
          if (unopened === "refuse") {
            throw new DiscoveryError(`${configFile} opened no project`, []);
          }
          missing.push(configFile);
          continue;
        }
        projects.push(visit(viewOf(project, configFile, engine, log)));
      }
      return {
        projects,
        unopened: missing,
        timing: engine.getTimingInfo(),
        unanswered: log.questions,
      };
    } finally {
      snapshot.dispose();
    }
  } finally {
    engine.close();
  }
}
