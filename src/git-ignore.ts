/**
 * Which files git ignores below a tree's root, read as git reads its ignore files:
 * https://git-scm.com/docs/gitignore#_pattern_format
 */

import type { Host } from "./host.ts";
import { ancestors, dirnamePath, joinPath, relativePath } from "./paths.ts";
import { message } from "./product.ts";
import { gitignoreExpression } from "./text/glob.ts";
import { repositoryOf } from "./fs/tree.ts";

/** One pattern line of an ignore file. */
interface Rule {
  readonly negated: boolean;
  /** Whether the pattern ends with `/`, so it matches a directory alone. */
  readonly directoryOnly: boolean;
  /** The expression over a path below the file's own directory. */
  readonly expression: RegExp;
}

/** The rules one ignore file's text writes, in order. */
function rulesOf(text: string): readonly Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/u)) {
    let line = raw.replace(/(?<!\\)\s+$/u, "");
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const negated = line.startsWith("!");
    line = negated ? line.slice(1) : line;
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
      expression: gitignoreExpression(anchored ? pattern : `**/${pattern}`),
    });
  }
  return rules;
}

/** Told each ignore file that exists and cannot be read, with why. */
type UnreadIgnoreFile = (path: string, reason: string) => void;

function rulesIn(host: Host, path: string, unread: UnreadIgnoreFile): readonly Rule[] {
  try {
    return rulesOf(host.readFile(path));
  } catch (error: unknown) {
    if (host.kindOf(path) !== "absent") {
      unread(path, message(error));
    }
    return [];
  }
}

/**
 * Whether git ignores one absolute path below `root`: by the repository's `info/exclude`, then
 * the `.gitignore` files from its root down to the path's directory, a later pattern overriding
 * an earlier one, though a file below an ignored directory stays ignored, as git cannot re-include
 * it. A path outside `root` is not ignored. With no repository, the files at and below `root` are
 * read; with one, the directories above `root` give patterns but are not tested. An unreadable
 * ignore file ignores nothing, and `unread` is told it.
 */
export function gitIgnored(
  host: Host,
  root: string,
  unread: UnreadIgnoreFile = () => undefined,
): (path: string) => boolean {
  const found = repositoryOf(host, root);
  const repository = found?.root;
  const above =
    repository === undefined ? [] : [...ancestors(dirnamePath(root), repository)].reverse();
  const excluded = found?.exclude === undefined ? [] : rulesIn(host, found.exclude, unread);
  const read = new Map<string, readonly Rule[]>();
  const rulesAt = (dir: string): readonly Rule[] => {
    let rules = read.get(dir);
    if (rules === undefined) {
      rules = rulesIn(host, joinPath(dir, ".gitignore"), unread);
      read.set(dir, rules);
    }
    return rules;
  };
  const decided = (path: string, directory: boolean): boolean => {
    const sources: [string, readonly Rule[]][] = [
      ...(repository === undefined ? [] : [[repository, excluded] as [string, readonly Rule[]]]),
      ...[...above, ...[...ancestors(dirnamePath(path), root)].reverse()].map(
        (dir): [string, readonly Rule[]] => [dir, rulesAt(dir)],
      ),
    ];
    let ignored = false;
    for (const [dir, rules] of sources) {
      const below = relativePath(dir, path) ?? "";
      for (const rule of rules) {
        if ((directory || !rule.directoryOnly) && rule.expression.test(below)) {
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
