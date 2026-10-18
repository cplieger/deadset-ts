/**
 * The workspace a target sits in: the packages `pnpm-workspace.yaml` or a manifest's
 * `workspaces` declares in the nearest directory at or above the target root, up to its
 * repository root, where its patterns name the package the target is in, each with the
 * compiler configurations in its directory.
 */

import { configFilesIn } from "./discover.ts";
import { failureExit } from "../failure.ts";
import type { EmitLayout } from "./emit-map.ts";
import { commonDirectory } from "./emit-map.ts";
import type { Host } from "../host.ts";
import { ancestors, dirnamePath, joinPath, relativePath } from "../paths.ts";
import { bytewise } from "../text/compare.ts";
import { isRecord } from "../json-document.ts";
import { directoriesIn, repositoryOf } from "../fs/tree.ts";
import {
  holdsManifest,
  inInstalledPackages,
  INSTALLED_PACKAGES,
  MANIFEST,
  manifestAt,
} from "../fs/manifest.ts";
import { braceExpanded, pathMatches, segmentMatches } from "../text/glob.ts";
import { yamlKey } from "../text/yaml.ts";

/** What one compiler configuration of a member says about where it reads and writes. */
export interface ParsedLayout {
  /** The files it compiles, absolute. */
  readonly fileNames: readonly string[];
  readonly outDir?: string | undefined;
  readonly declarationDir?: string | undefined;
  readonly rootDir?: string | undefined;
}

/** One compiler configuration in a member's directory. */
interface MemberConfiguration {
  /** The files it compiles, absolute. */
  readonly fileNames: ReadonlySet<string>;
  /** Where it writes its output, where it writes any. */
  readonly layout?: EmitLayout | undefined;
}

/** One package the workspace declares. */
export interface WorkspaceMember {
  readonly name: string;
  readonly dir: string;
  readonly version?: string | undefined;
  /** Whether the manifest forbids publishing it, so nothing outside the workspace imports it. */
  readonly private: boolean;
  readonly manifest: Readonly<Record<string, unknown>>;
  /**
   * The programs the run forms in its directory, then every configuration file directly in
   * it a derived matrix opens that parses, by file name.
   */
  readonly configurations: readonly MemberConfiguration[];
}

/** The workspace one target sits in. */
export interface Workspace {
  /** The directory that declares the workspace, absolute. */
  readonly root: string;
  /** Every member, the root first, then by directory. */
  readonly members: readonly WorkspaceMember[];
  /** The members one package name names; two members may share a name. */
  readonly named: ReadonlyMap<string, readonly WorkspaceMember[]>;
  /**
   * The member one path belongs to: the member whose directory holds the nearest
   * manifest at or above the path, or `undefined` where that manifest is no member's.
   */
  memberOf(path: string): WorkspaceMember | undefined;
}

const PNPM_WORKSPACE = "pnpm-workspace.yaml";

/** The patterns one directory declares a workspace with, or `undefined` where it declares none. */
function declarationAt(
  host: Host,
  dir: string,
): { readonly file: string; readonly patterns: readonly string[] } | undefined {
  const pnpm = joinPath(dir, PNPM_WORKSPACE);
  if (host.kindOf(pnpm) === "file") {
    const read = yamlKey(host.readFile(pnpm), "packages");
    if (read.kind === "absent") {
      return { file: pnpm, patterns: [] };
    }
    const listed = read.kind === "value" ? read.value : undefined;
    if (!Array.isArray(listed) || !listed.every((entry) => typeof entry === "string")) {
      const reason =
        read.kind === "refused" ? read.reason : "packages is not a sequence of strings";
      throw failureExit(
        "no-program",
        `${pnpm}: ${reason}; the workspace's packages are read from a sequence of strings: correct the declaration`,
      );
    }
    return { file: pnpm, patterns: listed };
  }
  const manifest = manifestAt(host, dir);
  if (manifest === undefined || !Object.hasOwn(manifest, "workspaces")) {
    return undefined;
  }
  const declared = manifest["workspaces"];
  const list = isRecord(declared) ? declared["packages"] : declared;
  if (!Array.isArray(list) || !list.every((entry) => typeof entry === "string")) {
    throw failureExit(
      "no-program",
      `${joinPath(dir, MANIFEST)}: workspaces is neither an array of strings nor an object whose packages is one: correct the declaration`,
    );
  }
  return { file: joinPath(dir, MANIFEST), patterns: list };
}

/** Whether one directory declares a workspace of its own. */
function declaresWorkspace(host: Host, dir: string): boolean {
  if (host.kindOf(joinPath(dir, PNPM_WORKSPACE)) === "file") {
    return true;
  }
  const manifest = manifestAt(host, dir);
  return manifest !== undefined && Object.hasOwn(manifest, "workspaces");
}

/**
 * The segments of one pattern below the workspace root, `.` and empty segments
 * dropped and `..` taken back, or `undefined` where it leaves the root.
 */
function segmentsOf(pattern: string): readonly string[] | undefined {
  const segments: string[] = [];
  for (const segment of pattern.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.pop() === undefined) {
        return undefined;
      }
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

/**
 * Every directory below `dir` one pattern names. `**` does not descend into a
 * directory that declares a workspace of its own, whose packages are that
 * workspace's to declare.
 */
function expand(host: Host, dir: string, pattern: readonly string[], into: Set<string>): void {
  const [head, ...rest] = pattern;
  if (head === undefined) {
    into.add(dir);
    return;
  }
  if (head === "**") {
    expand(host, dir, rest, into);
    for (const name of directoriesIn(host, dir)) {
      if (name.startsWith(".")) {
        continue;
      }
      const child = joinPath(dir, name);
      expand(host, child, declaresWorkspace(host, child) ? rest : pattern, into);
    }
    return;
  }
  if (!head.includes("*") && !head.includes("?")) {
    const child = joinPath(dir, head);
    if (head !== INSTALLED_PACKAGES && host.kindOf(child) === "directory") {
      expand(host, child, rest, into);
    }
    return;
  }
  for (const name of directoriesIn(host, dir)) {
    if (segmentMatches(head, name)) {
      expand(host, joinPath(dir, name), rest, into);
    }
  }
}

/** The directories a workspace's patterns name, every `!` pattern applied after the rest. */
function memberDirectories(
  host: Host,
  root: string,
  patterns: readonly string[],
): readonly string[] {
  const included = new Set<string>([root]);
  const excluded: (readonly string[])[] = [];
  for (const written of patterns) {
    const negated = written.startsWith("!");
    for (const pattern of braceExpanded(negated ? written.slice(1) : written)) {
      const segments = segmentsOf(pattern);
      if (segments === undefined) {
        continue;
      }
      if (negated) {
        excluded.push(segments);
      } else {
        expand(host, root, segments, included);
      }
    }
  }
  return [...included].filter((dir) => {
    const below = relativePath(root, dir);
    const segments = below === undefined ? [] : below.split("/");
    return dir === root || !excluded.some((pattern) => pathMatches(pattern, segments));
  });
}

/** Whether a workspace's patterns name one directory below its root, read without listing any. */
function namesDirectory(root: string, patterns: readonly string[], dir: string): boolean {
  const below = relativePath(root, dir);
  if (below === undefined) {
    return false;
  }
  if (inInstalledPackages(below)) {
    return false;
  }
  const path = below.split("/");
  let named = false;
  for (const written of patterns) {
    const negated = written.startsWith("!");
    const matched = braceExpanded(negated ? written.slice(1) : written).some((pattern) => {
      const segments = segmentsOf(pattern);
      return segments !== undefined && pathMatches(segments, path);
    });
    if (matched && negated) {
      return false;
    }
    named ||= matched;
  }
  return named;
}

/** The layout one parsed configuration writes with, where it writes any output. */
function layoutOf(configFile: string, parsed: ParsedLayout): EmitLayout | undefined {
  if (parsed.outDir === undefined && parsed.declarationDir === undefined) {
    return undefined;
  }
  const inputs = parsed.fileNames.filter((file) => !/\.d\.[mc]?ts$/u.test(file));
  const sourceDirs =
    parsed.rootDir === undefined
      ? [...new Set([dirnamePath(configFile), commonDirectory(inputs)])].filter((dir) => dir !== "")
      : [parsed.rootDir];
  return { outDir: parsed.outDir, declarationDir: parsed.declarationDir, sourceDirs };
}

function configurationsOf(
  host: Host,
  dir: string,
  parse: (configFile: string) => ParsedLayout | undefined,
): readonly MemberConfiguration[] {
  return configFilesIn(host, dir).flatMap((name) => {
    const configFile = joinPath(dir, name);
    const parsed = parse(configFile);
    return parsed === undefined
      ? []
      : [
          {
            fileNames: new Set(parsed.fileNames),
            layout: layoutOf(configFile, parsed),
          },
        ];
  });
}

/**
 * The directory declaring the workspace nearest the target root, its patterns, and the
 * highest directory below it, at or above the target root, that holds a manifest.
 */
function nearestDeclaration(
  host: Host,
  targetRoot: string,
):
  | {
      readonly root: string;
      readonly file: string;
      readonly patterns: readonly string[];
      readonly highestPackage: string | undefined;
    }
  | undefined {
  let highestPackage: string | undefined;
  for (const dir of ancestors(targetRoot, repositoryOf(host, targetRoot)?.root)) {
    const declared = declarationAt(host, dir);
    if (declared !== undefined) {
      return { root: dir, ...declared, highestPackage };
    }
    if (holdsManifest(host, dir)) {
      highestPackage = dir;
    }
  }
  return undefined;
}

/**
 * The workspace the target sits in, or `undefined` where none holds it: no directory
 * from the target root up to its repository root declares one with a member beside
 * its root, or the nearest one does not name the highest package below it, at or
 * above the target root, among its members. `parse` reads one compiler configuration,
 * or answers `undefined` where it does not read. `known`, a workspace already read, is the
 * answer where the nearest declaration is its own, so its members are not listed again.
 */
export function findWorkspace(
  host: Host,
  targetRoot: string,
  parse: (configFile: string) => ParsedLayout | undefined,
  known?: Workspace,
): Workspace | undefined {
  const declared = nearestDeclaration(host, targetRoot);
  if (declared === undefined) {
    return undefined;
  }
  if (
    declared.highestPackage !== undefined &&
    !namesDirectory(declared.root, declared.patterns, declared.highestPackage)
  ) {
    return undefined;
  }
  if (known?.root === declared.root) {
    return known;
  }
  const members: WorkspaceMember[] = [];
  for (const dir of memberDirectories(host, declared.root, declared.patterns)) {
    const manifest = manifestAt(host, dir);
    const name = manifest?.["name"];
    if (manifest === undefined || typeof name !== "string" || name === "") {
      continue;
    }
    const version = manifest["version"];
    members.push({
      name,
      dir,
      version: typeof version === "string" ? version : undefined,
      private: manifest["private"] === true,
      manifest,
      configurations: configurationsOf(host, dir, parse),
    });
  }
  if (members.length < 2) {
    return undefined;
  }
  members.sort((a, b) =>
    a.dir === declared.root ? -1 : b.dir === declared.root ? 1 : bytewise(a.dir, b.dir),
  );
  return assembled(host, declared.root, members);
}

function assembled(host: Host, root: string, members: readonly WorkspaceMember[]): Workspace {
  const named = new Map<string, WorkspaceMember[]>();
  for (const member of members) {
    named.set(member.name, [...(named.get(member.name) ?? []), member]);
  }
  const byDir = new Map(members.map((member) => [member.dir, member]));
  const scopes = new Map<string, string | undefined>();
  const scopeOf = (dir: string): string | undefined => {
    if (scopes.has(dir)) {
      return scopes.get(dir);
    }
    const up = dirnamePath(dir);
    const found = holdsManifest(host, dir) ? dir : up === dir ? undefined : scopeOf(up);
    scopes.set(dir, found);
    return found;
  };
  return {
    root,
    members,
    named,
    memberOf: (path) => {
      const scope = scopeOf(dirnamePath(path));
      return scope === undefined ? undefined : byDir.get(scope);
    },
  };
}

/**
 * The workspace with the programs the run forms put first among each member's configurations,
 * by the member's directory: a formed program has no file on disk to list, so its file list
 * is what makes a member's JavaScript its source.
 */
export function withFormed(
  host: Host,
  workspace: Workspace,
  formed: ReadonlyMap<string, readonly ParsedLayout[]>,
): Workspace {
  return assembled(
    host,
    workspace.root,
    workspace.members.map((member) => {
      const own = formed.get(member.dir) ?? [];
      return own.length === 0
        ? member
        : {
            ...member,
            configurations: [
              ...own.map((layout) => ({ fileNames: new Set(layout.fileNames) })),
              ...member.configurations,
            ],
          };
    }),
  );
}

/**
 * Whether one configuration holds one file only for the references it makes: the file
 * belongs to a workspace package, the root included, and the configuration does not
 * compile it itself. `compiles` is the configuration's own file list.
 */
export function referenceOnlyIn(
  workspace: Workspace,
  compiles: ReadonlySet<string>,
): (file: string) => boolean {
  return (file) => !compiles.has(file) && workspace.memberOf(file) !== undefined;
}
