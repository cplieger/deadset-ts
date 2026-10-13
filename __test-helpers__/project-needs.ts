import { rmSync } from "node:fs";
import { nodeHost } from "../bin/node-host.ts";
import { writeProject } from "./projects.ts";
import { projectNeeds } from "../src/dependencies.ts";
import { discoverProjects } from "../src/discover.ts";
import { inventory } from "../src/inventory.ts";
import { relativePath } from "../src/paths.ts";
import { scopeForDir } from "../src/scope.ts";
import { openEngine, runSession, type Engine } from "../src/session.ts";

/** The bound on one case, each of which loads a whole project. */
export const LOAD_TIMEOUT = 60_000;

/** What one project's needs say, every path below the project root. */
export interface Needs {
  /** Per declaration id, `""` for the configuration, the packages used inside it. */
  readonly uses: Record<string, string[]>;
  /** Per file, the packages a use written in it names. */
  readonly at: Record<string, string[]>;
  readonly unanswered: readonly string[];
}

/**
 * The needs of the one project `files` (paths below the root) make, read through the
 * engine `engineOf` opens; `armed()` holds only while the needs are read.
 */
export function needsOf(
  files: Readonly<Record<string, string>>,
  engineOf: (armed: () => boolean) => Engine = () => openEngine({ collectTiming: false }),
): Needs {
  const root = writeProject(files);
  try {
    const host = nodeHost();
    let armed = false;
    const engine = engineOf(() => armed);
    const configFiles = discoverProjects(engine, host, scopeForDir(host, root)).configFiles;
    const found: Needs[] = [];
    runSession(engine, configFiles, (project) => {
      const held = inventory(project, host, root);
      armed = true;
      const needs = projectNeeds(project, held, host, root, (fileName, text) =>
        engine.parseSourceFile(fileName, text),
      );
      armed = false;
      const below = (path: string): string => relativePath(root, path) ?? path;
      const sorted = (named: ReadonlySet<string>): string[] => [...named].sort();
      found.push({
        uses: Object.fromEntries([...needs.uses].map(([id, named]) => [id, sorted(named)])),
        at: Object.fromEntries(
          [...needs.at].map(([path, named]) => [below(path), sorted(new Set(named.keys()))]),
        ),
        unanswered: needs.unanswered.map(below),
      });
      return held;
    });
    const [only] = found;
    if (only === undefined || found.length !== 1) {
      throw new Error(`expected one project, read ${String(found.length)}`);
    }
    return only;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
