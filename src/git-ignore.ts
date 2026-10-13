/**
 * Which files the `.gitignore` files of a tree ignore, read as git reads them:
 * https://git-scm.com/docs/gitignore#_pattern_format
 */

import { globExpression } from "./glob.ts";
import type { Host } from "./host.ts";
import { dirnamePath, joinPath, relativePath } from "./paths.ts";

/** One pattern line of a `.gitignore` file. */
interface Rule {
  readonly negated: boolean;
  /** Whether the pattern ends with `/`, so it matches a directory alone. */
  readonly directoryOnly: boolean;
  /** The expression over a path below the file's own directory. */
  readonly expression: RegExp;
}

/** The rules one `.gitignore` text writes, in order. */
function rulesOf(text: string): readonly Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/u)) {
    let line = raw.replace(/(?<!\\)\s+$/u, "");
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const negated = line.startsWith("!");
    line = negated || line.startsWith("\\") ? line.slice(1) : line;
    const directoryOnly = line.endsWith("/");
    line = line.replace(/\/+$/u, "");
    if (line === "") {
      continue;
    }
    // A separator at the start or in the middle anchors the pattern to the file's
    // directory; with none, the pattern matches at any depth below it.
    const anchored = line.includes("/");
    const pattern = line.replace(/^\//u, "");
    rules.push({
      negated,
      directoryOnly,
      expression: globExpression(anchored ? pattern : `**/${pattern}`),
    });
  }
  return rules;
}

/**
 * Whether the `.gitignore` files at and below `root` ignore one absolute path. A path
 * outside `root` is not ignored, and a file below an ignored directory stays ignored
 * whatever a later pattern says, as git cannot re-include it.
 */
export function gitIgnored(host: Host, root: string): (path: string) => boolean {
  const read = new Map<string, readonly Rule[]>();
  const rulesAt = (dir: string): readonly Rule[] => {
    let rules = read.get(dir);
    if (rules === undefined) {
      try {
        rules = rulesOf(host.readFile(joinPath(dir, ".gitignore")));
      } catch {
        rules = [];
      }
      read.set(dir, rules);
    }
    return rules;
  };
  /** Whether the rules of `root` and of each directory down to one path's own decide it ignored. */
  const decided = (path: string, directory: boolean): boolean => {
    const dirs: string[] = [];
    for (let at = dirnamePath(path); relativePath(root, at) !== undefined; at = dirnamePath(at)) {
      dirs.unshift(at);
    }
    dirs.unshift(root);
    let ignored = false;
    for (const dir of dirs) {
      const below = relativePath(dir, path);
      for (const rule of below === undefined ? [] : rulesAt(dir)) {
        if ((directory || !rule.directoryOnly) && rule.expression.test(below ?? "")) {
          ignored = !rule.negated;
        }
      }
    }
    return ignored;
  };
  return (path) => {
    const below = relativePath(root, path);
    if (below === undefined) {
      return false;
    }
    const parts = below.split("/");
    for (let count = 1; count <= parts.length; count += 1) {
      const at = joinPath(root, parts.slice(0, count).join("/"));
      if (decided(at, count < parts.length)) {
        return true;
      }
    }
    return false;
  };
}
