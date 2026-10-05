/**
 * The entry points a package manifest names, which are roots because something
 * outside the analyzed program reaches them: a consumer importing the package, or a
 * shell running its command or one of its scripts. {@link readManifest} reads one
 * directory's manifest, {@link packageEntries} those of the packages below the target root.
 */

import type { Host } from "./host.ts";
import { dirnamePath, isAbsolutePath, joinPath, relativePath, resolvePath } from "./paths.ts";

/** The manifest's own name. */
const MANIFEST = "package.json";

/** The three members that name an entry point beside `exports` and `bin`. */
const LEGACY_MEMBERS = ["main", "module", "types"] as const;

/** What reaches one entry point the manifest names. */
export type EntryRole =
  /** A consumer importing the package, which is a caller the analysis cannot see. */
  | "import"
  /** A shell running the package's command, which is a caller that exists. */
  | "run"
  /** A token of one of the package's scripts, which the package manager runs. */
  | "script";

/** One entry point the manifest names. */
export interface ManifestEntry {
  /**
   * The member that named it, spelled as a reader of the manifest reads one:
   * `main`, `bin["deadset-ts"]`, `exports["."]["import"]`. It is what a maintainer
   * edits, so it is what a root reports as the string that named it.
   */
  readonly member: string;
  /** The target the member carries, resolved against the manifest's directory. */
  readonly path: string;
  readonly role: EntryRole;
  /**
   * Whether the member declares what a consumer may import, which is `exports` and
   * the three members that preceded it. A command is published too, and is not this:
   * `exports` is the surface a library's published API is read from.
   */
  readonly published: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether one member's value names a file of this package rather than another
 * package or a URL. A target written with no leading dot is a path too, which is
 * how the members that preceded `exports` are written.
 */
function isTarget(value: string, requireDot: boolean): boolean {
  if (value === "" || isAbsolutePath(value) || value.includes("://")) {
    return false;
  }
  return !requireDot || value.startsWith("./");
}

/** Where a script's command line splits into tokens: white space and the shell's operators. */
const SCRIPT_SEPARATORS = /\s+|&&|\|\||;|\|/u;

/** A token written inside one pair of quotes. */
const QUOTED = /^(["'])(.*)\1$/su;

/**
 * Every token one script's command line holds, each with one pair of enclosing quotes
 * removed. A token holding a wildcard is a pattern rather than a path, and names no
 * entry point.
 */
export function scriptTokens(command: string): readonly string[] {
  return command
    .split(SCRIPT_SEPARATORS)
    .map((token) => token.replace(QUOTED, "$2"))
    .filter((token) => token !== "" && !token.includes("*"));
}

/** One member's spelling below another: `exports` then `exports["."]`. */
function below(member: string, key: string): string {
  return `${member}[${JSON.stringify(key)}]`;
}

/**
 * Every target one `exports` value carries, at the member each is written under.
 *
 * The value nests strings, subpath or condition objects and alternative arrays to
 * any depth; a `null` blocks a subpath. Every level is walked, because each
 * condition names its own entry file, and a key's meaning is never read.
 */
function exportTargets(value: unknown, member: string, found: ManifestEntry[]): void {
  if (typeof value === "string") {
    if (isTarget(value, true)) {
      found.push({ member, path: value, role: "import", published: true });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((alternative, index) => {
      exportTargets(alternative, below(member, String(index)), found);
    });
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, held] of Object.entries(value)) {
    exportTargets(held, below(member, key), found);
  }
}

/** The manifest at the target root, decoded, or undefined where there is none to read. */
function manifestOf(host: Host, targetRoot: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = host.readFile(joinPath(targetRoot, MANIFEST));
  } catch {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // A manifest this program cannot read names no entry point, which is the same
    // answer as an absent one. What a manifest's contents say is not refused here:
    // the package manager owns that refusal, and an analysis of a tree it rejects
    // is not the run's subject.
    return undefined;
  }
  return isRecord(value) ? value : undefined;
}

/** What one manifest declares about where its package is entered. */
export interface Manifest {
  /**
   * Every entry point the manifest names, in the order the members are read: `main`,
   * `module`, `types`, then each `bin` command, then every target of `exports`, then
   * every token of each script, which names a file only where one is at its path. Each
   * path is absolute.
   */
  readonly entries: readonly ManifestEntry[];
  /**
   * Whether an `exports` member is written at all. A package that declares one has
   * said exactly what a consumer may import, so its published API is what `exports`
   * reaches; a package that declares none publishes whatever the members that
   * preceded it name.
   */
  readonly declaresExports: boolean;
}

/**
 * What the manifest in `targetRoot` declares about where its package is entered.
 *
 * A target is taken as written. It is not resolved to a source file here, because
 * which file a target names is a fact about the compiler configuration that emits
 * it and there is one such configuration per project, while there is one manifest.
 */
export function readManifest(host: Host, targetRoot: string): Manifest {
  const manifest = manifestOf(host, targetRoot);
  if (manifest === undefined) {
    return { entries: [], declaresExports: false };
  }

  const found: ManifestEntry[] = [];
  for (const member of LEGACY_MEMBERS) {
    const value = manifest[member];
    if (typeof value === "string" && isTarget(value, false)) {
      found.push({ member, path: value, role: "import", published: true });
    }
  }

  const bin = manifest["bin"];
  if (typeof bin === "string" && isTarget(bin, false)) {
    found.push({ member: "bin", path: bin, role: "run", published: false });
  } else if (isRecord(bin)) {
    for (const [command, value] of Object.entries(bin)) {
      if (typeof value === "string" && isTarget(value, false)) {
        found.push({ member: below("bin", command), path: value, role: "run", published: false });
      }
    }
  }

  exportTargets(manifest["exports"], "exports", found);

  const scripts = manifest["scripts"];
  if (isRecord(scripts)) {
    for (const [name, command] of Object.entries(scripts)) {
      if (typeof command !== "string") {
        continue;
      }
      for (const token of new Set(scriptTokens(command))) {
        found.push({
          member: below("scripts", name),
          path: token,
          role: "script",
          published: false,
        });
      }
    }
  }

  return {
    entries: found.map((entry) => ({ ...entry, path: resolvePath(targetRoot, entry.path) })),
    declaresExports: manifest["exports"] !== undefined,
  };
}

/**
 * The entry points every package manifest between the target root and each compiler
 * configuration names: each directory holding a `package.json` that a configuration sits
 * in or below, the target root and `known` excluded, whose manifests the run reads
 * otherwise. Each entry is spelled under its manifest's path below the target root, and
 * is published by its own manifest's rule, as the target's own entries are.
 */
export function packageEntries(
  host: Host,
  targetRoot: string,
  configFiles: readonly string[],
  known: ReadonlySet<string>,
): readonly ManifestEntry[] {
  const dirs = new Set<string>();
  for (const configFile of configFiles) {
    for (
      let dir = dirnamePath(resolvePath(targetRoot, configFile));
      dir !== targetRoot && relativePath(targetRoot, dir) !== undefined;
      dir = dirnamePath(dir)
    ) {
      if (!known.has(dir) && host.kindOf(joinPath(dir, MANIFEST)) === "file") {
        dirs.add(dir);
      }
    }
  }
  return [...dirs].sort().flatMap((dir) => {
    const manifest = readManifest(host, dir);
    const where = `${relativePath(targetRoot, dir) ?? dir}/${MANIFEST}`;
    return manifest.entries.map((entry) => ({
      ...entry,
      member: `${where} ${entry.member}`,
      published:
        entry.published && (!manifest.declaresExports || entry.member.startsWith("exports")),
    }));
  });
}
