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
import { isIdentifier } from "@typescript/native/unstable/ast";
import type { Node, SourceFile } from "@typescript/native/unstable/ast";

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
   * The symbol one node resolves to, asked for that node alone. The accessor behind
   * it takes one identifier and offers no array overload, so it is one round trip per
   * node and it answers only for the residue a batch left unresolved. A node that is
   * not an identifier has no such answer.
   */
  resolvedSymbolAt(handle: Handle<Brand>): TSSymbol | undefined;
  /**
   * The symbol the value of one shorthand property assignment names, which is the
   * declaration `{ a }` reads; the symbol the property's own name resolves to is the
   * property the literal declares. The handle names the assignment, not its name.
   */
  shorthandValueAt(handle: Handle<Brand>): TSSymbol | undefined;
  /**
   * The symbol one alias names, one link along: an import or export specifier
   * resolves to the declaration it carries forward, or to the next alias of a chain.
   * `undefined` where the symbol is no alias, or where the alias resolves to nothing.
   */
  aliasStepOf(symbol: TSSymbol): TSSymbol | undefined;
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

function viewOf<Brand>(project: Project): ProjectView<Brand> {
  // The snapshot is never updated, so a project's own file set is the same answer
  // every time it is asked for. It is read once because the question is not free:
  // deciding it consults the metadata of every file the program holds, the compiler's
  // own library files included, and a run asks for the set once per pass.
  let ownFiles: readonly SourceFile[] | undefined;
  return {
    configFile: project.configFileName,
    program: project.program,
    checker: project.checker,
    ownSourceFiles: () => {
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
    },
    handle: (node) => ({ node }),
    symbolsAt: (handles) => project.checker.getSymbolAtLocation(handles.map(({ node }) => node)),
    resolvedSymbolAt: ({ node }) =>
      isIdentifier(node) ? project.checker.getResolvedSymbol(node) : undefined,
    shorthandValueAt: ({ node }) => project.checker.getShorthandAssignmentValueSymbol(node),
    aliasStepOf: (symbol) => {
      const held = project.checker.getImmediateAliasedSymbol(symbol);
      // An alias that resolves to nothing answers with the checker's own unknown
      // symbol, which declares nothing; a symbol that is no alias answers with
      // nothing at all.
      return held === undefined || held.declarations.length === 0 ? undefined : held;
    },
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
