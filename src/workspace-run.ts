/**
 * What one run reads of the workspace its target sits in: the programs that read
 * member imports from source, the configurations whose member imports have no source,
 * the files each configuration holds only for their references, and the entry points
 * the members' manifests name. A target in no workspace reads none of it.
 */

import type { LocatedDiagnostic } from "./discover.ts";
import type { Host } from "./host.ts";
import type { Manifest, ManifestEntry } from "./manifest.ts";
import { relativePath } from "./paths.ts";
import type { Engine } from "./session.ts";
import { findWorkspace, referenceOnlyIn, type ParsedLayout } from "./workspace.ts";
import { memberEntries, targetManifestIn } from "./workspace-manifests.ts";
import {
  workspacePrograms,
  type MemberReading,
  type WorkspaceProgram,
} from "./workspace-programs.ts";
import { workspaceResolver } from "./workspace-resolution.ts";

/** One run's workspace. */
export interface WorkspaceRun {
  /** Per configuration that imports a member, how the snapshot reads it. */
  readonly programs: ReadonlyMap<string, WorkspaceProgram>;
  /**
   * Per configuration whose component files the run cannot read, the reason, in the
   * order the configurations are named.
   */
  readonly componentsUnread: readonly { readonly configFile: string; readonly reason: string }[];
  /**
   * Why one configuration cannot be analyzed, a member it imports having no source, or
   * `undefined` where every member import it makes has one.
   */
  unbuildable(configFile: string): string | undefined;
  /**
   * Whether one configuration holds one file only for the references it makes: a
   * member's file neither its parsed file list nor `compiled` names, the files its
   * project names once opened.
   */
  referenceOnly(configFile: string, compiled?: readonly string[]): (file: string) => boolean;
  /**
   * Whether one file a target configuration's program holds is the target's own. A
   * workspace package's file is by its path alone, whichever import reached it: the
   * compiler's answer for a file reached both through `node_modules` and from source
   * depends on which import it followed first. Any other file is unless the compiler
   * reached it as a library's.
   */
  ownFile(file: string, fromExternalLibrary: boolean): boolean;
  /** The target's own manifest, its targets read back to source. */
  readonly manifest: Manifest;
  /** The entry points the other members' manifests name. */
  readonly entries: readonly ManifestEntry[];
}

function layoutOf(engine: Engine, configFile: string): ParsedLayout | undefined {
  try {
    const parsed = engine.parseConfigFile(configFile);
    return {
      fileNames: parsed.fileNames,
      outDir: parsed.options.outDir,
      declarationDir: parsed.options.declarationDir,
      rootDir: parsed.options.rootDir,
    };
  } catch {
    return undefined;
  }
}

/**
 * The setup failure one configuration's unresolved member imports state, with the fix.
 * An import in a file the configuration holds only for its references is that file's
 * own configuration's to answer for, like any other error there.
 */
function unbuildableReason(
  reading: MemberReading,
  referenceOnly: (file: string) => boolean,
  targetRoot: string,
): string | undefined {
  const own = reading.unresolved.filter((one) => !referenceOnly(one.file));
  const [first] = own;
  if (first === undefined) {
    return undefined;
  }
  const where = relativePath(targetRoot, first.file) ?? first.file;
  const more = own.length > 1 ? ` (and ${String(own.length - 1)} more)` : "";
  return `${where} imports ${first.specifier}, a package of the workspace with no source to read: ${first.reason}${more}`;
}

/**
 * The workspace the target at `targetRoot` sits in, read for the configurations named,
 * or `undefined` where the target sits in none.
 */
export function workspaceRun(
  engine: Engine,
  host: Host,
  targetRoot: string,
  configFiles: readonly string[],
  manifest: Manifest,
): WorkspaceRun | undefined {
  const workspace = findWorkspace(host, targetRoot, (configFile) => layoutOf(engine, configFile));
  if (workspace === undefined) {
    return undefined;
  }
  const resolver = workspaceResolver(host, workspace);
  const read = workspacePrograms(engine, host, configFiles, resolver);
  const readings = new Map(read.readings.map((reading) => [reading.configFile, reading]));
  const referenceOnly = (
    configFile: string,
    compiled: readonly string[] = [],
  ): ((file: string) => boolean) =>
    referenceOnlyIn(
      workspace,
      new Set([...(readings.get(configFile)?.fileNames ?? []), ...compiled]),
    );
  return {
    programs: read.programs,
    componentsUnread: read.readings.flatMap(({ configFile, componentsUnread }) =>
      componentsUnread === undefined ? [] : [{ configFile, reason: componentsUnread }],
    ),
    unbuildable: (configFile) => {
      const reading = readings.get(configFile);
      return reading === undefined
        ? undefined
        : unbuildableReason(reading, referenceOnly(configFile), targetRoot);
    },
    referenceOnly,
    ownFile: (file, fromExternalLibrary) =>
      workspace.memberOf(file) !== undefined
        ? relativePath(targetRoot, file) !== undefined
        : !fromExternalLibrary,
    manifest: targetManifestIn(resolver, targetRoot, manifest),
    entries: memberEntries(host, resolver, targetRoot),
  };
}

/** The errors one configuration answers for: none in a file it holds only for its references. */
export function ownErrors(
  errors: readonly LocatedDiagnostic[],
  referenceOnly: (file: string) => boolean,
): readonly LocatedDiagnostic[] {
  return errors.filter(
    ({ diagnostic }) => diagnostic.fileName === undefined || !referenceOnly(diagnostic.fileName),
  );
}
