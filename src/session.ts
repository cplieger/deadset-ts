import { API } from "@typescript/native/unstable/sync";
import type {
  Checker,
  Diagnostic,
  DocumentIdentifier,
  NodeHandle,
  Project,
  Program,
  Snapshot,
  Symbol as TSSymbol,
  TimingInfo,
} from "@typescript/native/unstable/sync";
import { SyntaxKind } from "@typescript/native/unstable/ast";
import type { Identifier, Node, SourceFile } from "@typescript/native/unstable/ast";

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
  updateSnapshot(openProjects: readonly string[]): Snapshot;
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
    updateSnapshot: (openProjects) => api.updateSnapshot({ openProjects: [...openProjects] }),
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
  /** The project's checker. Every call on it is a round trip. */
  readonly checker: Checker;
  /** The source files the program holds that are the target's own. */
  ownSourceFiles(): readonly SourceFile[];
  /** A handle to one node of this project's program. */
  handle(node: Node): Handle<Brand>;
  /**
   * The symbols a batch of this project's nodes resolve to, one round trip for
   * the batch, in the order the handles were given. The batch is how a file's
   * identifiers reach the checker, and `undefined` marks a node the batch did not
   * resolve.
   */
  symbolsAt(handles: readonly Handle<Brand>[]): readonly (TSSymbol | undefined)[];
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

/**
 * The identifiers of one source file, in source order. A file is the unit a batch
 * resolves: the walk is local to this process and the resolution is not, so one
 * file's identifiers are gathered here and handed to the checker together.
 */
export function identifiersOf(file: SourceFile): Identifier[] {
  const found: Identifier[] = [];
  const visit = (node: Node): void => {
    if (node.kind === SyntaxKind.Identifier) {
      found.push(node as Identifier);
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return found;
}

function viewOf<Brand>(project: Project): ProjectView<Brand> {
  return {
    configFile: project.configFileName,
    program: project.program,
    checker: project.checker,
    ownSourceFiles: () =>
      project.program
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
        .filter((file): file is SourceFile => file !== undefined),
    handle: (node) => ({ node }),
    symbolsAt: (handles) => project.checker.getSymbolAtLocation(handles.map(({ node }) => node)),
    declarationAt: (handle) => {
      const node = handle.resolve(project);
      return node === undefined ? undefined : { node };
    },
  };
}

/** Every diagnostic set a project is refused for carrying an error in. */
export interface ProjectDiagnostics {
  readonly configFile: string;
  readonly syntactic: readonly Diagnostic[];
  readonly semantic: readonly Diagnostic[];
  readonly configParsing: readonly Diagnostic[];
}

/** The three diagnostic sets one project carries, read before any analysis. */
export function diagnosticsOf<Brand>(project: ProjectView<Brand>): ProjectDiagnostics {
  return {
    configFile: project.configFile,
    syntactic: project.program.getSyntacticDiagnostics(),
    semantic: project.program.getSemanticDiagnostics(),
    configParsing: project.program.getConfigFileParsingDiagnostics(),
  };
}

/** One run's result: what the visitor answered for each project, and what it cost. */
export interface SessionResult<Result> {
  readonly projects: readonly Result[];
  readonly timing: TimingInfo;
}

/**
 * Runs `visit` over every project the compiler configurations name, inside one
 * snapshot of one client.
 *
 * The snapshot is opened once with every configuration, so each becomes a project
 * with its own program and checker; it is never updated, because the analysis
 * reads and the tree does not change under it. It is disposed once when the last
 * project has been visited, and the client is released after it, whether the visit
 * completed or threw.
 */
export function runSession<Result>(
  engine: Engine,
  configFiles: readonly string[],
  visit: ProjectVisitor<Result>,
): SessionResult<Result> {
  try {
    const snapshot = engine.updateSnapshot(configFiles);
    try {
      const projects = snapshot.getProjects().map((project) => visit(viewOf(project)));
      return { projects, timing: engine.getTimingInfo() };
    } finally {
      snapshot.dispose();
    }
  } finally {
    engine.close();
  }
}
