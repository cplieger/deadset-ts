/**
 * Where a package an import names is installed and which manifests above an importer declare
 * it: the leaf both the expected-module reading and the workspace resolution read.
 */

import { DEPENDENCY_SECTIONS, INSTALLED_PACKAGES, manifestAt } from "../fs/manifest.ts";
import type { Host } from "../host.ts";
import { isRecord } from "../json-document.ts";
import { ancestors, joinPath } from "../paths.ts";

/**
 * The directory `node_modules/<name>` holds for an importer in `dir`: the nearest one at or
 * above `dir`, above any target root too, that is a directory, a link to one included, as the
 * compiler looks a package up. Undefined where no ancestor installs it.
 */
export function installedPackage(host: Host, dir: string, name: string): string | undefined {
  return ancestors(dir)
    .map((at) => joinPath(at, INSTALLED_PACKAGES, name))
    .find((candidate) => host.kindOf(candidate) === "directory");
}

export interface ManifestAt {
  readonly dir: string;
  readonly manifest: Record<string, unknown>;
}

/**
 * The manifests at or above `dir` and no higher than `top`, nearest first; a directory outside
 * `top` reads its own manifest alone.
 */
export function* manifestsAbove(host: Host, dir: string, top: string): Generator<ManifestAt> {
  const chain = ancestors(dir, top);
  for (const at of chain.length > 0 ? chain : [dir]) {
    const manifest = manifestAt(host, at);
    if (manifest !== undefined) {
      yield { dir: at, manifest };
    }
  }
}

/** The specifiers one manifest depends on `name` with, one per dependency section naming it. */
export function dependencySpecifiers(
  manifest: Readonly<Record<string, unknown>>,
  name: string,
): readonly unknown[] {
  return DEPENDENCY_SECTIONS.flatMap((section) => {
    const declared = manifest[section];
    return isRecord(declared) && Object.hasOwn(declared, name) ? [declared[name]] : [];
  });
}
