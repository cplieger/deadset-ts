import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Symbol as TSSymbol } from "@typescript/native/sync";
import { nodeHost } from "../bin/node-host.ts";
import { discoverProjects, isTargetConfiguration, type Discovery } from "../src/load/discover.ts";
import type { Inventory } from "../src/inventory.ts";
import { runDirectories } from "../src/entries/run-directories.ts";
import { inventory } from "../src/inventory/enumerate.ts";
import { readManifest } from "../src/roots/manifest.ts";
import { relativePath } from "../src/paths.ts";
import { references, type Reference, type References } from "../src/references.ts";
import { patternTestFile, testFilePaths } from "../src/tests/file-class.ts";
import type { Conventions } from "../src/entries/conventions.ts";
import { readSources } from "../src/entries/sources.ts";
import { rootSet, type RootOptions, type Roots } from "../src/roots/root-set.ts";
import { sourceFilesOf } from "../src/source-files.ts";
import { readWorkflows } from "../src/entries/workflow-steps.ts";
import { scopeForDir } from "../src/scope.ts";
import {
  narrowedTo,
  openEngine,
  runSession,
  type Engine,
  type ProjectView,
} from "../src/session.ts";

/**
 * A project written outside the repository, for a case whose input the committed
 * fixtures cannot hold: a tree that carries a dependency directory, and the
 * generated trees a property draws.
 */

export function targetConfigFiles(discovery: Discovery): readonly string[] {
  return discovery.configurations.filter(isTargetConfiguration).map((one) => one.configFile);
}

/** The compiler configuration a written project carries unless a case writes its own. */
export const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      strict: true,
      target: "ESNext",
      module: "NodeNext",
      moduleResolution: "nodenext",
      noEmit: true,
    },
    include: ["**/*.ts"],
  },
  null,
  2,
)}\n`;

/**
 * One project written to a fresh directory: every entry is a path below the root and
 * the text to write there. A `tsconfig.json` entry replaces the default one.
 *
 * The caller removes the directory; {@link analyzeProject} does it for its own.
 */
export function writeProject(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "deadset-ts-"));
  const written = { "tsconfig.json": TSCONFIG, ...files };
  for (const [path, text] of Object.entries(written)) {
    const at = join(root, path);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, text);
  }
  return root;
}

/**
 * Every symbol table one enumeration read, named by the symbol it was read from and
 * in the order the reads happened.
 *
 * The enumeration's own accounting states what it read; this is the same fact
 * observed where it crosses the client boundary, so a claim about the number of
 * table reads is measured rather than self-reported, and a second read of one
 * container's table is a duplicate entry naming that container.
 */
interface TableReads {
  /** One entry per `getMembers` call: a class, an interface or a type. */
  readonly members: readonly string[];
  /** One entry per `getExports` call: a module, a namespace, an enum or a class. */
  readonly exports: readonly string[];
}

interface Tally {
  readonly members: string[];
  readonly exports: string[];
}

/**
 * One symbol whose table reads are counted, delegating everything else untouched.
 *
 * Every member is read from the symbol itself and every method is invoked on it, so
 * a symbol that keeps a cache of its own behaves exactly as it does unwrapped: the
 * count is of calls the enumeration made, which is the claim, and not of round trips,
 * which the cache would hide.
 */
function recordingSymbol(symbol: TSSymbol, tally: Tally): TSSymbol {
  return new Proxy(symbol, {
    get(target, property) {
      const held: unknown = Reflect.get(target, property, target);
      if (typeof held !== "function") {
        return held;
      }
      const method = held as (...args: readonly never[]) => unknown;
      return (...args: readonly never[]): unknown => {
        if (property === "getMembers") {
          tally.members.push(target.name);
        }
        if (property === "getExports") {
          tally.exports.push(target.name);
        }
        return Reflect.apply(method, target, args);
      };
    },
  });
}

/** One project's view whose resolved symbols count the tables read from them. */
function recordingView<Brand>(project: ProjectView<Brand>, tally: Tally): ProjectView<Brand> {
  return {
    ...project,
    symbolsAt: (handles) =>
      project
        .symbolsAt(handles)
        .map((symbol) => (typeof symbol === "object" ? recordingSymbol(symbol, tally) : symbol)),
  };
}

/** The inventories of one project, every file its programs hold, and what it read. */
export interface Analyzed {
  readonly inventories: readonly Inventory[];
  /** Every file the programs hold, the compiler's own library files included. */
  readonly programFiles: readonly string[];
  /** The symbol tables every project's enumeration read, in order. */
  readonly tableReads: TableReads;
  /**
   * One entry per project, and none where no reference pass was asked for, each with the
   * files the case's test-file patterns classify, by their path below the root, ascending.
   */
  readonly references: readonly (References & { readonly testFilePaths: readonly string[] })[];
  /** Per project, the requests the reference pass put to the client, by accessor. */
  readonly referenceAsks: readonly ReadonlyMap<string, Asked>[];
  /**
   * Per project, the declarations outside the project's own files the reference pass read the
   * node of: a pass that fetches one pays a request for a declaration no inventory holds.
   */
  readonly outsideDeclarations: readonly number[];
  /** One entry per project, and none where no root set was asked for. */
  readonly roots: readonly Roots[];
  /**
   * The client requests the reference pass made, summed over the projects, measured
   * at the client's own timing counter rather than counted by the pass. It is zero
   * where no reference pass was asked for.
   */
  readonly referenceRequests: number;
}

/** What one analysis does besides enumerating the declarations. */
export interface AnalyzeOptions {
  /**
   * Resolve the references too, under these options, and measure what the pass cost.
   * Absent leaves the reference pass unrun, so a case that reads declarations alone
   * pays nothing for it.
   */
  readonly references?: ReferenceCase;
  /**
   * Resolve the root set too, under these options and the manifest at the root.
   * Absent leaves it unresolved, so a case that reads declarations alone pays nothing
   * for it.
   */
  readonly roots?: RootCase;
  /**
   * The questions the compiler server panics on, by accessor and the locations asked,
   * each location `<file>:<offset>`. Absent, every question is answered.
   */
  readonly panicsOn?: (accessor: string, locations: readonly string[]) => boolean;
  /**
   * The extensions of the files read as component files, through this analyzer's mapper.
   * Absent, no mapper runs and no file is a component file.
   */
  readonly components?: readonly string[];
}

/** The requests one accessor received: the calls, and the locations they asked about. */
interface Asked {
  readonly calls: number;
  readonly locations: number;
  /** Each location asked about, `<file>:<offset>`, in the order asked. */
  readonly at: readonly string[];
}

/** The reference options of one case: test files by pattern below the root. */
export interface ReferenceCase {
  readonly testFiles: readonly string[];
  readonly batchCap?: number;
}

/** The root options of one case: the run's, with the entry sources' inputs in place of their facts. */
type RootCase = Omit<RootOptions, "manifest" | "host" | "sources" | "skips"> & {
  readonly testFiles: readonly string[];
  readonly conventions?: Conventions | undefined;
};

/** Enumerates one project under `root`, in one client and one snapshot. */
export function analyzeRoot(root: string, options: AnalyzeOptions = {}): Analyzed {
  const host = nodeHost();
  const wanted = options.references;
  const opened = openEngine({
    collectTiming: wanted !== undefined,
    ...(options.components === undefined
      ? {}
      : { components: { extensions: options.components, host } }),
  });
  const { panicsOn } = options;
  let asks: Map<string, Asked> | undefined;
  const engine: Engine = {
    ...opened,
    ask: (accessor, locations, question) => {
      if (asks !== undefined) {
        const known = asks.get(accessor) ?? { calls: 0, locations: 0, at: [] };
        const asked = locations();
        asks.set(accessor, {
          calls: known.calls + 1,
          locations: known.locations + asked.length,
          at: [...known.at, ...asked],
        });
      }
      if (panicsOn?.(accessor, locations()) === true) {
        throw new Error(`panic: ${accessor}`);
      }
      return opened.ask(accessor, locations, question);
    },
  };
  const configFiles = targetConfigFiles(discoverProjects(engine, host, scopeForDir(host, root)));
  const programFiles: string[] = [];
  const tally: Tally = { members: [], exports: [] };
  const resolved: (References & { readonly testFilePaths: readonly string[] })[] = [];
  const referenceAsks: ReadonlyMap<string, Asked>[] = [];
  const outsideDeclarations: number[] = [];
  const rooted: Roots[] = [];
  const manifest = readManifest(host, root);
  let requests = 0;
  const { projects } = runSession(engine, configFiles, (project) => {
    programFiles.push(...project.program.getSourceFileNames());
    const held = inventory(recordingView(project, tally), host, root);
    if (wanted !== undefined) {
      const before = engine.getTimingInfo().totals.requestCount;
      const testFile = patternTestFile(wanted.testFiles, root);
      asks = new Map();
      let outside = 0;
      const counted = {
        ...project,
        declarationAt: (handle: Parameters<typeof project.declarationAt>[0]) => {
          if (!project.ownPaths().has(handle.path)) {
            outside += 1;
          }
          return project.declarationAt(handle);
        },
      };
      resolved.push({
        ...references(counted, held, root, {
          testFile,
          ...(wanted.batchCap === undefined ? {} : { batchCap: wanted.batchCap }),
          directories: runDirectories(host, root, (fileName, text) =>
            opened.parseSourceFile(fileName, text),
          ),
        }),
        testFilePaths: testFilePaths(project, root, testFile),
      });
      referenceAsks.push(asks);
      outsideDeclarations.push(outside);
      asks = undefined;
      requests += engine.getTimingInfo().totals.requestCount - before;
    }
    if (options.roots !== undefined) {
      const { testFiles, conventions, ...rest } = options.roots;
      const sources = readSources({
        host,
        targetRoot: root,
        files: sourceFilesOf(project, root),
        parse: rest.parse,
        testFiles,
        conventions,
        workflows: readWorkflows(host, root),
      });
      rooted.push(rootSet(project, held, root, { ...rest, sources, skips: [], manifest, host }));
    }
    return held;
  });
  return {
    inventories: projects,
    programFiles,
    tableReads: tally,
    references: resolved,
    referenceAsks,
    outsideDeclarations,
    roots: rooted,
    referenceRequests: requests,
  };
}

/**
 * Writes one project, analyzes it, and removes the tree. One client and one snapshot
 * per call, which is the cost a property that draws a tree pays per iteration.
 */
export function analyzeProject(
  files: Readonly<Record<string, string>>,
  options: AnalyzeOptions = {},
): Analyzed {
  const root = writeProject(files);
  try {
    return analyzeRoot(root, options);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The references one consumer's pass made, and the target declarations they name. */
interface ConsumerPass {
  readonly references: readonly Reference[];
  /** The target's declarations, enumerated over the target files the consumer's program holds. */
  readonly held: Inventory;
}

/**
 * Writes one tree holding a target directory and a consumer directory, and runs the
 * reference pass over the consumer's configuration alone, as a run reads a declared
 * consumer: the target's declarations enumerated over the target files the consumer's
 * program holds, against the target's root. Removes the tree.
 */
export function consumerPass(
  files: Readonly<Record<string, string>>,
  target: string,
  consumer: string,
): ConsumerPass {
  const root = writeProject(files);
  try {
    const host = nodeHost();
    const targetRoot = join(root, target);
    const consumerRoot = join(root, consumer);
    const passes: ConsumerPass[] = [];
    const engine = openEngine({ collectTiming: false });
    runSession(engine, [join(consumerRoot, "tsconfig.json")], (project) => {
      const held = inventory(
        narrowedTo(project, (file) => relativePath(targetRoot, file.fileName) !== undefined),
        host,
        targetRoot,
      );
      const found = references(project, held, targetRoot, {
        testFile: () => false,
        consumer: { id: "@example/consumer", root: consumerRoot },
        directories: runDirectories(host, consumerRoot, (fileName, text) =>
          engine.parseSourceFile(fileName, text),
        ),
      });
      passes.push({ references: found.references, held });
      return held;
    });
    const [pass] = passes;
    if (pass === undefined) {
      throw new Error(`no project opened at ${consumer}/tsconfig.json`);
    }
    return pass;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
