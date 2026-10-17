import type { CreateSnapshotProgramParams } from "@typescript/native/sync";
import type { PartialConfig } from "../config.ts";
import { readConventions, type ConventionManifest, type Conventions } from "../conventions.ts";
import { holdsManifest, inInstalledPackages, MANIFEST } from "../fs/manifest.ts";
import type { Host } from "../host.ts";
import { packageEntries, readManifest, type Manifest, type ManifestEntry } from "../manifest.ts";
import { ancestors, dirnamePath, normalizePath, relativePath, resolvePath } from "../paths.ts";
import type { Scope } from "../scope.ts";
import type { Engine, ProgramBuild } from "../session.ts";
import { bytewise } from "../text/compare.ts";
import { globExpression } from "../text/glob.ts";
import {
  discoverProjects,
  isTargetConfiguration,
  type Configuration,
  type Discovery,
  type LoadedConsumer,
  type Parsed,
} from "./discover.ts";
import { FailureExit } from "../failure.ts";
import { joinedTestFiles, joinedTests } from "./test-joins.ts";
import { testGlobals } from "./test-globals.ts";
import { findWorkspace, type Workspace } from "./workspace.ts";
import { writtenConfiguration } from "./workspace-programs.ts";
import { workspaceRun, type WorkspaceRun } from "./workspace-run.ts";

export type CompilerOptions = Parsed["options"];

/** How the snapshot builds one configuration. */
export type Build =
  /** The project the compiler opens for the configuration as it stands. */
  | { readonly kind: "project" }
  | { readonly kind: "program"; readonly params: CreateSnapshotProgramParams }
  /** A configuration only the snapshot holds, which extends the one it stands for. */
  | { readonly kind: "configuration"; readonly value: Readonly<Record<string, unknown>> };

/** One configuration of the run and how the snapshot builds it. */
export interface ProgramPlan extends Configuration {
  /** The options the program is built with, the parse's own with `paths` read as {@link baseUrlPaths} states. */
  readonly options: CompilerOptions;
  readonly build: Build;
}

/** The manifests the run reads, each once, and what they decide before any project opens. */
interface PackageSet {
  /** The target's own manifest, its targets read back to source where the target is a member. */
  readonly manifest: Manifest;
  /** The directory of every workspace member, absolute, in the workspace's order. */
  readonly members: readonly string[];
  /** The directory of every nested package, absolute, in path order. */
  readonly nested: readonly string[];
  /** The entry points the other members' and the nested packages' manifests name. */
  readonly entries: readonly ManifestEntry[];
  /** The directories of the members whose manifest is not private. */
  readonly published: ReadonlySet<string>;
}

/**
 * The workspace one consumer sits in, or the fault of a declaration that cannot be read,
 * which ends the run only where an import's membership depends on it.
 */
export type ConsumerWorkspace =
  { readonly workspace: Workspace | undefined } | { readonly fault: string };

/** What a run opens and how it builds each program, decided before the snapshot. */
export interface RunPlan {
  readonly discovery: Discovery;
  readonly plans: readonly ProgramPlan[];
  readonly packages: PackageSet;
  /** The convention rows applied per package of {@link PackageSet}. */
  readonly conventions: Conventions;
  readonly workspace: WorkspaceRun | undefined;
  /** The workspace each consumer sits in, by its directory, read from its own root. */
  readonly consumerWorkspaces: ReadonlyMap<string, ConsumerWorkspace>;
  /** The target root, absolute. */
  readonly root: string;
}

/**
 * The `paths` one configuration's resolved options map under the compilers before version
 * 7, each target absolute: a target is read against the effective `baseUrl`, and a specifier
 * no other pattern maps is looked up below it. Undefined where no `baseUrl` is set, so the
 * options' own `paths` stand. Version 7 reads no `baseUrl`:
 * https://github.com/microsoft/TypeScript/issues/62207
 */
export function baseUrlPaths(options: CompilerOptions): Record<string, string[]> | undefined {
  const baseUrl: unknown = Reflect.get(options, "baseUrl");
  if (typeof baseUrl !== "string") {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries({ "*": ["*"], ...options.paths }).map(([key, targets]) => [
      key,
      targets.map((target) => resolvePath(baseUrl, target)),
    ]),
  );
}

/** One configuration, read through the `paths` its `baseUrl` gives. */
function planned(configuration: Configuration): ProgramPlan {
  const { options } = configuration.parsed;
  const paths = baseUrlPaths(options);
  return {
    ...configuration,
    options: paths === undefined ? options : { ...options, paths },
    build:
      paths === undefined
        ? { kind: "project" }
        : {
            kind: "configuration",
            value: { extends: configuration.configFile, compilerOptions: { paths } },
          },
  };
}

/**
 * The nested packages of a run: each directory below the target root, in no `node_modules`
 * directory and none of `known`, that holds a `package.json` and lies at or above one of
 * `files`, in path order.
 */
function nestedPackageDirs(
  host: Host,
  targetRoot: string,
  files: Iterable<string>,
  known: ReadonlySet<string>,
): readonly string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const file of files) {
    for (const dir of ancestors(dirnamePath(file), targetRoot)) {
      if (seen.has(dir) || relativePath(targetRoot, dir) === undefined) {
        break;
      }
      seen.add(dir);
      const below = relativePath(targetRoot, dir) ?? "";
      if (!inInstalledPackages(below) && !known.has(dir) && holdsManifest(host, dir)) {
        found.push(dir);
      }
    }
  }
  return found.sort(bytewise);
}

/** The manifests conventions are applied from: the target's, then each member's and nested package's. */
function conventionManifests(
  host: Host,
  root: string,
  packages: PackageSet,
): readonly ConventionManifest[] {
  const found = new Map<string, ConventionManifest>();
  if (holdsManifest(host, root)) {
    found.set(root, { dir: root, path: MANIFEST });
  }
  for (const [dirs, nested] of [
    [packages.members, false],
    [packages.nested, true],
  ] as const) {
    for (const dir of dirs) {
      const below = relativePath(root, dir);
      if (below !== undefined && !found.has(dir)) {
        found.set(dir, { dir, path: `${below}/${MANIFEST}`, nested });
      }
    }
  }
  return [...found.values()];
}

/** The workspace one consumer sits in, read from its own root, the target's reused. */
function consumerWorkspace(
  host: Host,
  consumer: LoadedConsumer,
  target: Workspace | undefined,
): ConsumerWorkspace {
  try {
    return { workspace: findWorkspace(host, consumer.path, () => undefined, target) };
  } catch (error: unknown) {
    if (!(error instanceof FailureExit)) {
      throw error;
    }
    return { fault: error.failures[0].detail };
  }
}

/**
 * The plan of one run: the configurations discovery names, each built through the steps in
 * order (the `baseUrl` paths, the workspace members read from source, the test runner's
 * globals, the joined test files of a derived matrix), the package set and the convention
 * rows applied per package. A nested package is one at or above a file a target
 * configuration lists or a test file that joins it.
 */
export function planRun(engine: Engine, host: Host, scope: Scope, config: PartialConfig): RunPlan {
  const discovery = discoverProjects(engine, host, scope, config.analysis.configurations);
  const root = resolvePath(host.workingDirectory(), scope.target.path);
  const parse = (fileName: string, text: string) => engine.parseSourceFile(fileName, text);
  let plans: readonly ProgramPlan[] = discovery.configurations.map(planned);
  const targets = plans.filter(isTargetConfiguration);
  const manifest = readManifest(host, scope.target.path);
  const workspace = workspaceRun(engine, host, root, targets, manifest);
  const consumerWorkspaces = new Map(
    discovery.consumers.map((consumer) => [
      consumer.path,
      consumerWorkspace(host, consumer, workspace?.workspace),
    ]),
  );
  plans = plans.map((plan) => {
    const build = workspace?.programs.get(plan.configFile);
    return build === undefined ? plan : { ...plan, build };
  });
  plans = testGlobals(host, parse, plans);
  const joins =
    discovery.mode === "derived"
      ? joinedTestFiles(host, root, targets, config.ts.test_files.map(globExpression))
      : new Map<string, readonly string[]>();
  plans = joinedTests(plans, joins);
  const members = workspace?.memberDirs ?? [];
  const nested = nestedPackageDirs(
    host,
    normalizePath(root),
    targets.flatMap((plan) => [
      plan.configFile,
      ...plan.parsed.fileNames,
      ...(joins.get(plan.configFile) ?? []),
    ]),
    new Set(members),
  );
  const packages: PackageSet = {
    manifest: workspace?.manifest ?? manifest,
    members,
    nested,
    entries: [...(workspace?.entries ?? []), ...packageEntries(host, normalizePath(root), nested)],
    published: new Set(
      (workspace?.entries ?? []).filter((entry) => entry.published).map((entry) => entry.dir),
    ),
  };
  const conventions = readConventions(
    host,
    parse,
    conventionManifests(host, root, packages),
    config.ts.disabled_conventions,
  );
  return { discovery, plans, packages, conventions, workspace, consumerWorkspaces, root };
}

/** How the snapshot builds each planned configuration other than by opening its project. */
export function programBuilds(
  host: Host,
  plans: readonly ProgramPlan[],
): ReadonlyMap<string, ProgramBuild> {
  const builds = new Map<string, ProgramBuild>();
  for (const { configFile, build } of plans) {
    if (build.kind === "program") {
      builds.set(configFile, build);
    } else if (build.kind === "configuration") {
      builds.set(configFile, writtenConfiguration(host, configFile, build.value));
    }
  }
  return builds;
}
