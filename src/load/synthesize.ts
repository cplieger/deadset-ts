/**
 * The programs a run forms for the JavaScript files no compiler configuration lists: one per
 * package, over the files git would track that are no build output, each written as a
 * configuration only the snapshot holds, with the module system of the runtime its package
 * is written for.
 */

import { CONVENTION_ROWS } from "../convention-rows.ts";
import type { Conventions } from "../conventions.ts";
import { holdsManifest, MANIFEST, readManifestAt, type ManifestRead } from "../fs/manifest.ts";
import { filesBelow } from "../fs/tree.ts";
import type { Host } from "../host.ts";
import { JAVASCRIPT_FILE, minified, minifiedByName } from "../javascript-file.ts";
import { isRecord } from "../json-document.ts";
import { ancestors, dirnamePath, joinPath, relativePath } from "../paths.ts";
import type { Engine } from "../session.ts";
import { bytewise } from "../text/compare.ts";
import type { Configuration, Origin } from "./discover.ts";
import { writtenPath } from "./workspace-programs.ts";

/** The name a package's program is written beside, made free by {@link writtenPath}. */
const GROUP_CONFIGURATION = "jsconfig.json";

/**
 * The options of a formed program before its runtime is chosen: unchecked JavaScript, no
 * emit, no installed package's JavaScript, which is not the target's code and grows the
 * program with the depth of `node_modules`, and every type package visible.
 */
const FORMED_OPTIONS = {
  allowJs: true,
  checkJs: false,
  noEmit: true,
  skipLibCheck: true,
  maxNodeModuleJsDepth: 0,
  target: "esnext",
  jsx: "preserve",
  resolveJsonModule: true,
} as const;

interface CandidateContext {
  /** The files a configuration of the run lists or a test file joins it with, absolute. */
  readonly covered: ReadonlySet<string>;
  /** The output and declaration directories of every configuration of the run, absolute. */
  readonly outputs: readonly string[];
  /** Whether git ignores one absolute path. */
  readonly ignored: (path: string) => boolean;
}

/** Whether one file is minified build output; one that cannot be read is left to the compiler. */
function minifiedFile(host: Host, file: string): boolean {
  if (minifiedByName(file)) {
    return true;
  }
  try {
    return minified(file, host.readFile(file));
  } catch {
    return false;
  }
}

/**
 * The JavaScript files below `root` a program may be formed over: none in a skipped
 * directory, none git ignores, none minified, none `context` covers and none below one of
 * its output directories. A convention row's generated directory leaves out more, once the
 * rows are read: {@link formedGroups}.
 */
export function candidateFiles(
  host: Host,
  root: string,
  { covered, outputs, ignored }: CandidateContext,
): readonly string[] {
  return filesBelow(host, root, (name) => JAVASCRIPT_FILE.test(name))
    .map((path) => joinPath(root, path))
    .filter(
      (file) =>
        !covered.has(file) &&
        !outputs.some((dir) => relativePath(dir, file) !== undefined) &&
        !ignored(file) &&
        !minifiedFile(host, file),
    );
}

interface Group {
  /** The package's directory, absolute. */
  readonly dir: string;
  readonly manifest: ManifestRead;
  /** Its files, absolute, in ascending order. */
  readonly files: readonly string[];
}

/**
 * The candidates below `root` grouped by package, in directory order, less every file below a
 * directory an applied row of `conventions` names as generated: each file belongs to the
 * nearest directory at or above it, up to `root`, that holds a `package.json`, a manifest that
 * does not parse included, and to `root` where none does.
 */
export function formedGroups(
  host: Host,
  root: string,
  candidates: readonly string[],
  conventions: Conventions,
): readonly Group[] {
  const generated = conventions.generated.map(({ dir, below }) => joinPath(dir, below));
  const groups = new Map<string, string[]>();
  for (const file of candidates) {
    if (generated.some((dir) => relativePath(dir, file) !== undefined)) {
      continue;
    }
    const dir = packageOf(host, root, file);
    groups.set(dir, [...(groups.get(dir) ?? []), file]);
  }
  return [...groups]
    .sort(([a], [b]) => bytewise(a, b))
    .map(([dir, files]) => ({
      dir,
      manifest: readManifestAt(host, dir),
      files: files.sort(bytewise),
    }));
}

/** The directory whose `package.json` groups one file: the nearest at or above it, up to `root`. */
export function packageOf(host: Host, root: string, file: string): string {
  return ancestors(dirnamePath(file), root).find((at) => holdsManifest(host, at)) ?? root;
}

type Runtime = "bundler" | "node";

const RUNTIME_OPTIONS = {
  bundler: { module: "preserve", moduleResolution: "bundler" },
  node: { module: "nodenext", moduleResolution: "nodenext" },
} as const satisfies Record<Runtime, Readonly<Record<string, string>>>;

/** The manifest members that say a package is written for Node. */
const NODE_MEMBERS = ["main", "exports", "bin", "type"] as const;

/** Whether one manifest says its package runs under Node, `engines.node` included; its scripts are not read. */
function writtenForNode(manifest: Readonly<Record<string, unknown>>): boolean {
  const { engines } = manifest;
  return (
    NODE_MEMBERS.some((member) => manifest[member] !== undefined) ||
    (isRecord(engines) && engines["node"] !== undefined)
  );
}

/**
 * The manifests, by path as `conventions` names them, an applied row of a tool that bundles
 * applies through.
 */
export function bundlingManifests(conventions: Conventions): ReadonlySet<string> {
  return new Set(
    conventions.applied
      .filter((one) => CONVENTION_ROWS.some((row) => row.name === one.name && row.bundles === true))
      .map((one) => one.manifest),
  );
}

interface FormedProgram {
  readonly configuration: Configuration;
  readonly group: Group;
}

interface Forming {
  /** The tree's root, absolute, which the manifest paths of `bundling` are read below. */
  readonly root: string;
  readonly origin: Origin;
  /** The manifests a bundling row applies through, as {@link bundlingManifests} names them. */
  readonly bundling: ReadonlySet<string>;
  /** The name one group's program is given, by the group's manifest path, `undefined` for none. */
  readonly idOf: (manifest: string | undefined) => string;
}

/**
 * Each group's program, given the module system of the runtime its package is written for: a
 * bundler's where a row of a tool that bundles applies through the group's manifest or the
 * root's, else Node's where its manifest says the package runs under Node, under which a file's
 * extension and its package's `type` decide its module format, else a bundler's, which reads a
 * file with no module syntax as a classic script, as a browser loads it.
 */
export function formedPrograms(
  engine: Engine,
  host: Host,
  groups: readonly Group[],
  { root, origin, bundling, idOf }: Forming,
): readonly FormedProgram[] {
  return groups.map((group) => {
    const manifest = group.manifest.kind === "absent" ? undefined : joinPath(group.dir, MANIFEST);
    const below = manifest === undefined ? undefined : relativePath(root, manifest);
    const runtime: Runtime =
      !bundling.has(MANIFEST) &&
      (below === undefined || !bundling.has(below)) &&
      group.manifest.kind === "read" &&
      writtenForNode(group.manifest.manifest)
        ? "node"
        : "bundler";
    const configFile = writtenPath(host, joinPath(group.dir, GROUP_CONFIGURATION));
    const written = {
      compilerOptions: { ...FORMED_OPTIONS, ...RUNTIME_OPTIONS[runtime] },
      files: group.files,
    };
    return {
      group,
      configuration: {
        id: idOf(manifest),
        configFile,
        origin,
        parsed: engine.parseConfigJson(written, configFile),
        written,
      },
    };
  });
}
