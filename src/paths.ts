/**
 * Filesystem paths, as the supported platform spells them: a solidus separates
 * segments and a leading solidus makes a path absolute.
 *
 * They are written here rather than taken from the platform's own library because
 * every module below the command line stays free of the platform, and because the
 * supported platform set is one, so a second spelling would be a rule nothing
 * exercises.
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

/** One path resolved against a directory, absolute where that directory is. */
export function resolvePath(against: string, path: string): string {
  return isAbsolutePath(path) ? normalizePath(path) : joinPath(against, path);
}
