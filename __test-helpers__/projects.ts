import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Symbol as TSSymbol } from "@typescript/native/unstable/sync";
import { nodeHost } from "../bin/node-host.ts";
import { discoverProjects } from "../src/discover.ts";
import { inventory, type Inventory } from "../src/inventory.ts";
import { scopeForDir } from "../src/scope.ts";
import { openEngine, runSession, type ProjectView } from "../src/session.ts";

/**
 * A project written outside the repository, for a case whose input the committed
 * fixtures cannot hold: a tree that carries a dependency directory, and the
 * generated trees a property draws.
 */

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
export interface TableReads {
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
        .map((symbol) => (symbol === undefined ? undefined : recordingSymbol(symbol, tally))),
  };
}

/** The inventories of one project, every file its programs hold, and what it read. */
export interface Analyzed {
  readonly inventories: readonly Inventory[];
  /** Every file the programs hold, the compiler's own library files included. */
  readonly programFiles: readonly string[];
  /** The symbol tables every project's enumeration read, in order. */
  readonly tableReads: TableReads;
}

/** Enumerates one project under `root`, in one client and one snapshot. */
export function analyzeRoot(root: string): Analyzed {
  const host = nodeHost();
  const engine = openEngine({ collectTiming: false });
  const configFiles = discoverProjects(engine, host, scopeForDir(host, root)).configFiles;
  const programFiles: string[] = [];
  const tally: Tally = { members: [], exports: [] };
  const { projects } = runSession(engine, configFiles, (project) => {
    programFiles.push(...project.program.getSourceFileNames());
    return inventory(recordingView(project, tally), host, root);
  });
  return { inventories: projects, programFiles, tableReads: tally };
}

/**
 * Writes one project, enumerates it, and removes the tree. One client and one
 * snapshot per call, which is the cost a property that draws a tree pays per
 * iteration.
 */
export function analyzeProject(files: Readonly<Record<string, string>>): Analyzed {
  const root = writeProject(files);
  try {
    return analyzeRoot(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
