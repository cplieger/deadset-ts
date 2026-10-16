/**
 * Filesystem paths as the supported platform spells them: a solidus between segments, a
 * leading one for an absolute path. They are written here rather than taken from the
 * platform's library so every module below the command line stays free of the platform.
 */

const SEPARATOR = "/";

/** Whether one path names a place without a directory to resolve it against. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith(SEPARATOR);
}

/**
 * One path with `.` removed, `..` applied to the segment before it, and repeated
 * separators collapsed. A `..` that walks past the root of an absolute path is
 * dropped, because the root has no parent; one at the head of a relative path is
 * kept, because the path names a place above its own start.
 */
export function normalizePath(path: string): string {
  const absolute = isAbsolutePath(path);
  const segments: string[] = [];
  for (const segment of path.split(SEPARATOR)) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment !== "..") {
      segments.push(segment);
      continue;
    }
    const last = segments[segments.length - 1];
    if (last !== undefined && last !== "..") {
      segments.pop();
      continue;
    }
    if (!absolute) {
      segments.push("..");
    }
  }
  const joined = segments.join(SEPARATOR);
  if (absolute) {
    return SEPARATOR + joined;
  }
  return joined === "" ? "." : joined;
}

/** One path below another, normalized. */
export function joinPath(...parts: readonly string[]): string {
  const joined = parts.filter((part) => part !== "").join(SEPARATOR);
  return joined === "" ? "." : normalizePath(joined);
}

/**
 * The directory one path sits in. A path with one segment sits in the directory it
 * is resolved against, which is `.`; the root sits in itself.
 */
export function dirnamePath(path: string): string {
  const normalized = normalizePath(path);
  const cut = normalized.lastIndexOf(SEPARATOR);
  if (cut < 0) {
    return ".";
  }
  return cut === 0 ? SEPARATOR : normalized.slice(0, cut);
}

/**
 * `dir` and every directory above it, nearest first, normalized. With `top`, the list ends
 * at `top` and is empty where `dir` is neither `top` nor below it; without, it ends at the
 * root of the path.
 */
export function ancestors(dir: string, top?: string): readonly string[] {
  const end = top === undefined ? undefined : normalizePath(top);
  const found: string[] = [];
  for (let at = normalizePath(dir); ; at = dirnamePath(at)) {
    if (end !== undefined && at !== end && relativePath(end, at) === undefined) {
      return [];
    }
    found.push(at);
    if (at === end || dirnamePath(at) === at) {
      return found;
    }
  }
}

/**
 * The extension of one path's last segment, from its last full stop, or the empty string
 * where it has none. A segment that only starts with a full stop has none.
 */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf(SEPARATOR) + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot);
}

/** One path resolved against a directory, absolute where that directory is. */
export function resolvePath(against: string, path: string): string {
  return isAbsolutePath(path) ? normalizePath(path) : joinPath(against, path);
}

/**
 * The relative path before the query of a relative module specifier such as
 * `./worker.ts?worker`, the module a bundler loads; undefined for a specifier with no
 * query, one that is not relative, and one whose query has a `raw` parameter, which
 * reads the file as text and so evaluates nothing.
 */
export function queriedModulePath(specifier: string): string | undefined {
  const query = specifier.indexOf("?");
  if (query < 0 || !(specifier.startsWith("./") || specifier.startsWith("../"))) {
    return undefined;
  }
  const raw = specifier
    .slice(query + 1)
    .split("&")
    .some((parameter) => parameter.split("=")[0] === "raw");
  return raw ? undefined : specifier.slice(0, query);
}

/**
 * One path as it reads below a root, or undefined when it is not strictly below the root:
 * the root itself is not below itself. Both are normalized, then compared lexically, so a
 * root and a path spelled through different symbolic links name nothing in common. The
 * caller resolves both against the same directory first: a relative root and an absolute
 * path cannot be reconciled.
 */
export function relativePath(root: string, path: string): string | undefined {
  const at = normalizePath(root);
  const prefix = at.endsWith(SEPARATOR) ? at : at + SEPARATOR;
  const under = normalizePath(path);
  if (!under.startsWith(prefix) || under.length === prefix.length) {
    return undefined;
  }
  return under.slice(prefix.length);
}
