import { manifestAt } from "../fs/manifest.ts";
import type { Host } from "../host.ts";
import { dirnamePath, joinPath } from "../paths.ts";
import type { Module } from "../ref.ts";

/** One manifest that names a package, and the directory below the root that holds it. */
interface Named {
  readonly name: string;
  readonly at: string;
}

/**
 * Resolves each file's package scope: the name of the nearest manifest at or above its
 * directory up to the target root, and the file's path below that manifest. Where no
 * manifest up to the root carries a name, the package is a single dot and the path is read
 * from the root, which cannot collide, because a package name never starts with a dot. One
 * directory is read at most once.
 */
export function packageScope(host: Host, root: string): (path: string) => Module {
  const named = new Map<string, Named | undefined>();

  const manifestName = (dir: string): string | undefined => {
    const name = manifestAt(host, joinPath(root, dir))?.["name"];
    return typeof name === "string" && name !== "" ? name : undefined;
  };

  const nearest = (dir: string): Named | undefined => {
    if (named.has(dir)) {
      return named.get(dir);
    }
    const name = manifestName(dir);
    const found =
      name !== undefined ? { name, at: dir } : dir === "" ? undefined : nearest(parentOf(dir));
    named.set(dir, found);
    return found;
  };

  return (path) => {
    const found = nearest(parentOf(path));
    if (found === undefined) {
      return { package: ".", path };
    }
    return { package: found.name, path: found.at === "" ? path : path.slice(found.at.length + 1) };
  };
}

/**
 * Whether Node reads each file's `.js` siblings as ECMAScript modules: the `type` of the
 * nearest manifest at or above its directory up to the target root is `module`
 * (https://nodejs.org/api/packages.html#type). One directory is read at most once.
 */
export function packageTypeIsModule(host: Host, root: string): (path: string) => boolean {
  const typed = new Map<string, boolean>();

  const nearest = (dir: string): boolean => {
    const known = typed.get(dir);
    if (known !== undefined) {
      return known;
    }
    const manifest = manifestAt(host, joinPath(root, dir));
    const found =
      manifest !== undefined ? manifest["type"] === "module" : dir !== "" && nearest(parentOf(dir));
    typed.set(dir, found);
    return found;
  };

  return (path) => nearest(parentOf(path));
}

/** The directory one path below the root sits in, and the root itself as the empty path. */
function parentOf(path: string): string {
  const dir = dirnamePath(path);
  return dir === "." ? "" : dir;
}
