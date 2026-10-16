import type { DirectoryEntry, Host } from "../host.ts";
import { ancestors, joinPath, resolvePath } from "../paths.ts";
import { LANGUAGE_ROWS } from "../contract/contract.generated.ts";
import { LANGUAGE } from "../product.ts";
import { bytewise } from "../text/compare.ts";
import { globExpression } from "../text/glob.ts";

/** The directories no walk of the tree enters, by the patterns the language's row names. */
const SKIPPED_DIRECTORIES = LANGUAGE_ROWS[LANGUAGE].skippedDirectories.map(globExpression);

function skipped(name: string): boolean {
  return SKIPPED_DIRECTORIES.some((pattern) => pattern.test(name));
}

/** A git repository's working tree root, and the `info/exclude` file git reads for it. */
interface Repository {
  readonly root: string;
  /** Undefined where a `.git` file names no repository directory. */
  readonly exclude: string | undefined;
}

/** One file's text without its line ending, or undefined where it cannot be read. */
function lineOf(host: Host, path: string): string | undefined {
  try {
    return host.readFile(path).replace(/\r?\n$/u, "");
  } catch {
    return undefined;
  }
}

/**
 * The repository whose working tree holds `dir`: the nearest directory at or above it with a
 * `.git`. A `.git` file, which a linked worktree or a submodule holds, names the repository's
 * directory on its `gitdir:` line; that directory's `commondir` file, where it has one, names
 * the directory shared with the main worktree, which holds `info/exclude`:
 * https://git-scm.com/docs/gitrepository-layout
 */
export function repositoryOf(host: Host, dir: string): Repository | undefined {
  for (const root of ancestors(dir)) {
    const dotGit = joinPath(root, ".git");
    const kind = host.kindOf(dotGit);
    if (kind === "directory") {
      return { root, exclude: joinPath(dotGit, "info/exclude") };
    }
    if (kind === "file") {
      const named = /^gitdir: (.+)$/u.exec(lineOf(host, dotGit) ?? "")?.[1];
      const gitDir = named === undefined ? undefined : resolvePath(root, named);
      const common = gitDir === undefined ? undefined : lineOf(host, joinPath(gitDir, "commondir"));
      const shared =
        gitDir === undefined || common === undefined ? gitDir : resolvePath(gitDir, common);
      return { root, exclude: shared === undefined ? undefined : joinPath(shared, "info/exclude") };
    }
  }
  return undefined;
}

/** The entries of one directory, none where it cannot be read. */
export function entriesOf(host: Host, dir: string): readonly DirectoryEntry[] {
  try {
    return host.readDirectory(dir);
  } catch {
    return [];
  }
}

/** The names of the files directly in `dir` whose name `accepts`, in bytewise order. */
export function filesIn(
  host: Host,
  dir: string,
  accepts: (name: string) => boolean,
): readonly string[] {
  return entriesOf(host, dir)
    .filter((entry) => !entry.directory && accepts(entry.name))
    .map((entry) => entry.name)
    .sort(bytewise);
}

/** The names of the directories directly in `dir` a walk enters, in bytewise order. */
export function directoriesIn(host: Host, dir: string): readonly string[] {
  return entriesOf(host, dir)
    .filter((entry) => entry.directory && !skipped(entry.name))
    .map((entry) => entry.name)
    .sort(bytewise);
}

/**
 * Every file below `root` whose name `accepts`, by its path relative to `root` in bytewise
 * order, read in no skipped directory.
 */
export function filesBelow(
  host: Host,
  root: string,
  accepts: (name: string) => boolean,
): readonly string[] {
  const found: string[] = [];
  const pending = [""];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const entry of entriesOf(host, joinPath(root, dir))) {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (!entry.directory) {
        if (accepts(entry.name)) {
          found.push(path);
        }
      } else if (!skipped(entry.name)) {
        pending.push(path);
      }
    }
  }
  return found.sort(bytewise);
}
