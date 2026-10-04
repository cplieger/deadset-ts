/**
 * The entry points the manifests of a workspace name, read back to the members'
 * sources. Each member's manifest is read the way the target's own is, and each target
 * is read back to the source file its member's configurations compile it from. A
 * member whose manifest forbids publishing it exports nothing anyone outside the
 * workspace imports, so only its commands are entry points.
 */

import { emittedFrom } from "./emit-map.ts";
import type { Host } from "./host.ts";
import { readManifest, type Manifest, type ManifestEntry } from "./manifest.ts";
import { joinPath, relativePath } from "./paths.ts";
import type { WorkspaceMember } from "./workspace.ts";
import type { WorkspaceResolver } from "./workspace-resolution.ts";

/** The one character a subpath pattern of a manifest's `exports` holds. */
const SUBPATH_WILDCARD = "*";

/** The paths one written target stands for in its member's sources, itself included. */
function sourcesOf(
  resolver: WorkspaceResolver,
  member: WorkspaceMember,
  path: string,
): readonly string[] {
  if (!path.includes(SUBPATH_WILDCARD)) {
    const source = resolver.sourceOf(member, path);
    return source === undefined ? [path] : [source];
  }
  const patterns = member.configurations.flatMap(({ layout }) =>
    layout === undefined ? [] : emittedFrom(path, layout),
  );
  return [...new Set([path, ...patterns])];
}

/** One manifest's entries with every target read back to its member's sources. */
function sourceEntries(
  resolver: WorkspaceResolver,
  member: WorkspaceMember,
  entries: readonly ManifestEntry[],
  spelled: (entry: ManifestEntry) => string,
): readonly ManifestEntry[] {
  return entries.flatMap((entry) =>
    sourcesOf(resolver, member, entry.path).map((path) => ({
      ...entry,
      member: spelled(entry),
      path,
    })),
  );
}

/**
 * The target's own manifest with its targets read back to the sources of the member
 * the target is, where it is one.
 */
export function targetManifestIn(
  resolver: WorkspaceResolver,
  targetRoot: string,
  manifest: Manifest,
): Manifest {
  const member = resolver.workspace.members.find((one) => one.dir === targetRoot);
  return member === undefined
    ? manifest
    : {
        ...manifest,
        entries: sourceEntries(resolver, member, manifest.entries, (entry) => entry.member),
      };
}

/**
 * The entry points every other member's manifest names, each spelled as the member
 * that named it under the manifest's path below the target root, a private member's
 * `exports` left out: only the workspace imports a private package, and the workspace
 * is analyzed. An entry is published where its member is not private and the member
 * named in its own manifest is one a consumer imports.
 */
export function memberEntries(
  host: Host,
  resolver: WorkspaceResolver,
  targetRoot: string,
): readonly ManifestEntry[] {
  return resolver.workspace.members.flatMap((member) => {
    if (member.dir === targetRoot) {
      return [];
    }
    const manifest = readManifest(host, member.dir);
    const where =
      relativePath(targetRoot, joinPath(member.dir, "package.json")) ??
      joinPath(member.dir, "package.json");
    const kept = manifest.entries.flatMap((entry): ManifestEntry[] => {
      const exported = entry.member.startsWith("exports");
      if (member.private && exported) {
        return [];
      }
      const published =
        !member.private && entry.published && (manifest.declaresExports ? exported : true);
      return [{ ...entry, published }];
    });
    return sourceEntries(resolver, member, kept, (entry) => `${where} ${entry.member}`);
  });
}
