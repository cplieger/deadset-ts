import type { CreateSnapshotProgramParams } from "@typescript/native/sync";
import type { PartialConfig } from "../config.ts";
import { readConventions, type ConventionManifest, type Conventions } from "../conventions.ts";
import { holdsManifest, inInstalledPackages, MANIFEST, readManifestAt } from "../fs/manifest.ts";
import { gitIgnored } from "../git-ignore.ts";
import type { Host } from "../host.ts";
import { packageEntries, readManifest, type Manifest, type ManifestEntry } from "../manifest.ts";
import {
  ancestors,
  dirnamePath,
  joinPath,
  normalizePath,
  relativePath,
  resolvePath,
} from "../paths.ts";
import type { Scope } from "../scope.ts";
import type { Engine, ProgramBuild } from "../session.ts";
import { bytewise } from "../text/compare.ts";
import { globExpression } from "../text/glob.ts";
import {
  consumerWithoutSources,
  discoverProjects,
  isTargetConfiguration,
  targetWithoutSources,
  type Configuration,
  type Discovery,
  type LoadedConsumer,
  type Parsed,
} from "./discover.ts";
import { FailureExit } from "../failure.ts";
import {
  bundlingManifests,
  candidateFiles,
  formedGroups,
  formedPrograms,
  packageOf,
} from "./synthesize.ts";
import { joinedTestFiles, joinedTests } from "./test-joins.ts";
import { testGlobals } from "./test-globals.ts";
import { findWorkspace, withFormed, type ParsedLayout, type Workspace } from "./workspace.ts";
import { workspacePrograms, writtenConfiguration, writtenFileOf } from "./workspace-programs.ts";
import { workspaceResolver } from "./workspace-resolution.ts";
import { layoutOf, workspaceRun, type WorkspaceRun } from "./workspace-run.ts";

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
type ConsumerWorkspace = { readonly workspace: Workspace | undefined } | { readonly fault: string };

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
  /**
   * The output and declaration directories of every configuration file of the run, absolute,
   * whose paths name build output: no formed program's candidate lies below one, and no relative
   * specifier of a configuration that does not check its JavaScript naming one is noted.
   */
  readonly outputs: readonly string[];
  /** The inputs the run could not read, in the order it met them. */
  readonly unread: readonly UnreadInput[];
}

/** One input the run could not read, which the error stream names. */
export type UnreadInput =
  /**
   * A `package.json` that does not parse, or cannot be read with the read's error as `reason`,
   * whose group's manifest facts go unanswered.
   */
  | {
      readonly kind: "manifest";
      readonly configFile: string;
      readonly manifest: string;
      readonly reason: string | undefined;
    }
  /** An ignore file that cannot be read, which then ignores nothing. */
  | { readonly kind: "ignore-file"; readonly path: string; readonly reason: string };

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

function planned(configuration: Configuration): ProgramPlan {
  const { options } = configuration.parsed;
  if (configuration.written !== undefined) {
    return {
      ...configuration,
      options,
      build: { kind: "configuration", value: configuration.written },
    };
  }
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

/**
 * The manifests conventions are applied from below `root`: its own, then each member's and
 * each nested package's, each once.
 */
function conventionManifests(
  host: Host,
  root: string,
  members: readonly string[],
  nested: readonly string[],
): readonly ConventionManifest[] {
  const found = new Map<string, ConventionManifest>();
  if (holdsManifest(host, root)) {
    found.set(root, { dir: root, path: MANIFEST });
  }
  for (const [dirs, isNested] of [
    [members, false],
    [nested, true],
  ] as const) {
    for (const dir of dirs) {
      const below = relativePath(root, dir);
      if (below !== undefined && !found.has(dir)) {
        found.set(dir, { dir, path: `${below}/${MANIFEST}`, nested: isNested });
      }
    }
  }
  return [...found.values()];
}

/**
 * The workspace one consumer sits in, read from its own root with `parse` reading its members'
 * configurations, the target's reused, and any other given the programs of `formed` as
 * {@link withFormed} does.
 */
function consumerWorkspace(
  host: Host,
  consumer: LoadedConsumer,
  target: Workspace | undefined,
  parse: (configFile: string) => ParsedLayout | undefined,
  formed: ReadonlyMap<string, readonly ParsedLayout[]>,
): ConsumerWorkspace {
  try {
    const found = findWorkspace(host, consumer.path, parse, target);
    return {
      workspace: found === undefined || found === target ? found : withFormed(host, found, formed),
    };
  } catch (error: unknown) {
    if (!(error instanceof FailureExit)) {
      throw error;
    }
    return { fault: error.failures[0].detail };
  }
}

/**
 * How the snapshot builds each program formed for a consumer that sits in a workspace, its
 * member imports read from source as the target's are. A consumer's configuration read from a
 * file resolves a member through what is installed, as the compiler does.
 */
function consumerPrograms(
  engine: Engine,
  host: Host,
  plans: readonly ProgramPlan[],
  places: ReadonlyMap<string, ConsumerWorkspace>,
): ReadonlyMap<string, Exclude<Build, { readonly kind: "project" }>> {
  const byRoot = new Map<string, { workspace: Workspace; plans: ProgramPlan[] }>();
  for (const plan of plans) {
    const place = plan.consumer === undefined ? undefined : places.get(plan.consumer.path);
    if (plan.written === undefined || place === undefined || !("workspace" in place)) {
      continue;
    }
    const { workspace } = place;
    if (workspace !== undefined) {
      const held = byRoot.get(workspace.root) ?? { workspace, plans: [] };
      held.plans.push(plan);
      byRoot.set(workspace.root, held);
    }
  }
  return new Map(
    [...byRoot.values()].flatMap(({ workspace, plans: held }) => [
      ...workspacePrograms(engine, host, held, workspaceResolver(host, workspace)).programs,
    ]),
  );
}

function outputsOf({ parsed }: Configuration): readonly string[] {
  return [parsed.options.outDir, parsed.options.declarationDir].filter((dir) => dir !== undefined);
}

/**
 * The plan of one run: the configurations discovery names and the programs formed for the
 * JavaScript files none lists, each built through the steps in order (the `baseUrl` paths,
 * the workspace members read from source, the test runner's globals, the joined test files),
 * the package set and the convention rows. A formed program's files wait for the joins and
 * the rows, and its module system is fixed before any workspace round reads it. A nested
 * package is one at or above a file a target configuration lists, joins or is formed over.
 */
export function planRun(engine: Engine, host: Host, scope: Scope, config: PartialConfig): RunPlan {
  const discovery = discoverProjects(engine, host, scope, config.analysis.configurations);
  const root = resolvePath(host.workingDirectory(), scope.target.path);
  const parse = (fileName: string, text: string) => engine.parseSourceFile(fileName, text);
  const disabled = config.ts.disabled_conventions;
  const outputs = discovery.configurations.flatMap(outputsOf);
  const unread: UnreadInput[] = [];
  const ignoredBelow = (dir: string): ((path: string) => boolean) =>
    gitIgnored(host, dir, (path, reason) => {
      if (!unread.some((one) => one.kind === "ignore-file" && one.path === path)) {
        unread.push({ kind: "ignore-file", path, reason });
      }
    });
  // Before any target step, so a consumer's failure is the one named, as discoverProjects orders them.
  const consumerFormed = discovery.unconfigured.flatMap((consumer) => {
    const consumerRoot = resolvePath(host.workingDirectory(), consumer.path);
    const files = candidateFiles(host, consumerRoot, {
      covered: new Set(),
      outputs,
      ignored: ignoredBelow(consumerRoot),
    });
    const rows = readConventions(
      host,
      parse,
      conventionManifests(
        host,
        consumerRoot,
        [],
        [...new Set(files.map((file) => packageOf(host, consumerRoot, file)))].filter(
          (dir) => dir !== consumerRoot,
        ),
      ),
      disabled,
    );
    const programs = formedPrograms(engine, host, formedGroups(host, consumerRoot, files, rows), {
      root: consumerRoot,
      origin: "consumer",
      bundling: bundlingManifests(rows),
      idOf: (path) => path ?? consumerRoot,
    });
    if (programs.length === 0) {
      throw consumerWithoutSources(consumer.path);
    }
    return programs.map((one) => ({ ...one, configuration: { ...one.configuration, consumer } }));
  });
  const readTargets = discovery.configurations.filter(isTargetConfiguration);
  const manifest = readManifest(host, scope.target.path);
  const found = findWorkspace(host, root, (configFile) => layoutOf(engine, configFile));
  const joins =
    discovery.mode === "derived"
      ? joinedTestFiles(host, root, readTargets, config.ts.test_files.map(globExpression))
      : new Map<string, readonly string[]>();
  const targetIgnored = ignoredBelow(root);
  const covered = new Set([
    ...readTargets.flatMap(({ parsed }) => parsed.fileNames),
    ...[...joins.values()].flat(),
  ]);
  const trees = discovery.targets.flatMap((target) => {
    if (target.kind === "configuration") {
      return [];
    }
    const dir = target.kind === "derived" ? root : dirnamePath(target.manifest);
    const files = candidateFiles(host, dir, { covered, outputs, ignored: targetIgnored });
    return [
      {
        target,
        dir,
        files:
          target.kind === "derived"
            ? files
            : files.filter((file) => packageOf(host, dir, file) === dir),
      },
    ];
  });
  const members = found?.members.map((member) => member.dir) ?? [];
  const nested = nestedPackageDirs(
    host,
    normalizePath(root),
    [
      ...readTargets.flatMap((plan) => [
        plan.configFile,
        ...plan.parsed.fileNames,
        ...(joins.get(plan.configFile) ?? []),
      ]),
      ...trees.flatMap(({ files }) => files),
    ],
    new Set(members),
  );
  const conventions = readConventions(
    host,
    parse,
    conventionManifests(host, root, members, nested),
    disabled,
  );
  const bundling = bundlingManifests(conventions);
  const formedFor = new Map(
    trees.map(({ target, dir, files }) => {
      const groups = formedGroups(host, dir, files, conventions);
      const programs = formedPrograms(
        engine,
        host,
        target.kind === "declared"
          ? [groups[0] ?? { dir, manifest: readManifestAt(host, dir), files: [] }]
          : groups,
        {
          root,
          origin: target.kind,
          bundling,
          idOf: (path) =>
            target.kind === "declared"
              ? target.id
              : path === undefined
                ? "."
                : (relativePath(root, path) ?? path),
        },
      );
      return [target, programs] as const;
    }),
  );
  const targetFormed = [...formedFor.values()].flat();
  if (readTargets.length + targetFormed.length === 0 && discovery.notBuilt.length === 0) {
    throw targetWithoutSources(scope.target.path);
  }
  for (const { configuration, group } of [...targetFormed, ...consumerFormed]) {
    if (group.manifest.kind === "malformed" || group.manifest.kind === "unread") {
      unread.push({
        kind: "manifest",
        configFile: configuration.configFile,
        manifest: joinPath(group.dir, MANIFEST),
        reason: group.manifest.kind === "unread" ? group.manifest.reason : undefined,
      });
    }
  }
  let plans: readonly ProgramPlan[] = [
    ...discovery.targets.flatMap((target) =>
      target.kind === "configuration"
        ? [target.configuration]
        : (formedFor.get(target) ?? []).map(({ configuration }) => configuration),
    ),
    ...discovery.configurations.filter((one) => !isTargetConfiguration(one)),
    ...consumerFormed.map(({ configuration }) => configuration),
  ].map(planned);
  const formedLayouts = new Map<string, ParsedLayout[]>();
  for (const { configuration, group } of [...targetFormed, ...consumerFormed]) {
    formedLayouts.set(group.dir, [
      ...(formedLayouts.get(group.dir) ?? []),
      { fileNames: configuration.parsed.fileNames },
    ]);
  }
  const workspace = workspaceRun(
    engine,
    host,
    root,
    plans.filter(isTargetConfiguration),
    manifest,
    found === undefined ? undefined : withFormed(host, found, formedLayouts),
  );
  const consumerWorkspaces = new Map(
    discovery.consumers.map((consumer) => [
      consumer.path,
      consumerWorkspace(
        host,
        consumer,
        workspace?.workspace,
        discovery.unconfigured.includes(consumer)
          ? (configFile) => layoutOf(engine, configFile)
          : () => undefined,
        formedLayouts,
      ),
    ]),
  );
  const consumerBuilds = consumerPrograms(engine, host, plans, consumerWorkspaces);
  plans = plans.map((plan) => {
    const build = workspace?.programs.get(plan.configFile) ?? consumerBuilds.get(plan.configFile);
    return build === undefined ? plan : { ...plan, build };
  });
  plans = testGlobals(host, parse, plans);
  plans = joinedTests(plans, joins);
  const packages: PackageSet = {
    manifest: workspace?.manifest ?? manifest,
    members,
    nested,
    entries: [...(workspace?.entries ?? []), ...packageEntries(host, normalizePath(root), nested)],
    published: new Set(
      (workspace?.entries ?? []).filter((entry) => entry.published).map((entry) => entry.dir),
    ),
  };
  return {
    discovery,
    plans,
    packages,
    conventions,
    workspace,
    consumerWorkspaces,
    root,
    outputs,
    unread,
  };
}

/** How the snapshot builds each planned configuration other than by opening its project. */
export function programBuilds(
  host: Host,
  plans: readonly ProgramPlan[],
): ReadonlyMap<string, ProgramBuild> {
  const builds = new Map<string, ProgramBuild>();
  const formed = new Set(
    plans.filter((plan) => plan.written !== undefined).map((plan) => plan.configFile),
  );
  for (const plan of plans) {
    const { configFile, build } = plan;
    if (build.kind === "program") {
      builds.set(configFile, build);
    } else if (build.kind === "configuration") {
      builds.set(configFile, writtenConfiguration(writtenFileOf(host, plan, formed), build.value));
    }
  }
  return builds;
}
