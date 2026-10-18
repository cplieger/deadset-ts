/**
 * The entry points a package manifest names, which are roots because something
 * outside the analyzed program reaches them: a consumer importing the package, or a
 * shell running its command or one of its scripts. {@link readManifest} reads one
 * directory's manifest, {@link packageEntries} those of the packages below the target root.
 */

import type { Host } from "./host.ts";
import { isAbsolutePath, joinPath, relativePath, resolvePath } from "./paths.ts";
import { isRecord } from "./json-document.ts";
import { MANIFEST, manifestAt, readJSON } from "./fs/manifest.ts";
import { scriptTokens } from "./text/shell.ts";

/** The manifest's own name. */

/** The three members that name an entry point beside `exports` and `bin`. */
const LEGACY_MEMBERS = ["main", "module", "types"] as const;

/** What reaches one entry the manifest names. */
type EntryRole =
  /** A consumer importing the package, which is a caller the analysis cannot see. */
  | "import"
  /** A shell running the package's command, which is a caller that exists. */
  | "run"
  /** A token of one of the package's scripts, or the whole of a command string the package runs. */
  | "script";

/** One entry point the manifest names, or the whole of one command string the package runs. */
export interface ManifestEntry {
  /**
   * The member that named it as a maintainer edits it, `main`, `bin["deadset-ts"]` or
   * `exports["."]["import"]`: what a root reports as the string that named it.
   */
  readonly member: string;
  /** The target the member carries, resolved against the manifest's directory, or that directory for a whole command string. */
  readonly path: string;
  readonly role: EntryRole;
  /**
   * Whether the member declares what a consumer may import, the surface a library's published
   * API is read from: `exports`, `browser` and the three members that preceded `exports`.
   */
  readonly published: boolean;
  /** The directory of the manifest that names it, which `path` was resolved against. */
  readonly dir: string;
  /**
   * On the entry of a whole command string, which names no entry point and whose path is the
   * manifest's directory, that string: rooting enters no file for it and holds each file
   * `spelledFiles` reads it to name.
   */
  readonly command?: string;
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

/** One member's spelling below another: `exports` then `exports["."]`. */
function below(member: string, key: string): string {
  return `${member}[${JSON.stringify(key)}]`;
}

/**
 * The command strings one manifest runs, each at the member it is written under: each of its
 * `scripts`, and the `exec` command of nodemon's configuration, in the manifest's `nodemonConfig`
 * or the `nodemon.json` beside it, which nodemon runs the watched script with:
 * https://github.com/remy/nodemon#config-files
 */
export function manifestCommands(
  host: Host,
  dir: string,
  manifest: Record<string, unknown>,
): readonly { readonly member: string; readonly command: string }[] {
  const scripts = manifest["scripts"];
  const nodemon = {
    nodemonConfig: manifest["nodemonConfig"],
    "nodemon.json": readJSON(host, joinPath(dir, "nodemon.json")),
  };
  const written = [
    ...Object.entries(isRecord(scripts) ? scripts : {}).map(
      ([name, value]) => [below("scripts", name), value] as const,
    ),
    ...Object.entries(nodemon).map(
      ([member, config]) =>
        [below(member, "exec"), isRecord(config) ? config["exec"] : undefined] as const,
    ),
  ];
  return written.flatMap(([member, command]) =>
    typeof command === "string" ? [{ member, command }] : [],
  );
}

/**
 * Every target one `exports` value carries, at the member each is written under. Every level of
 * strings, subpath or condition objects and alternative arrays is walked, because each condition
 * names its own entry file; a `null` blocks a subpath, and a key's meaning is never read.
 */
function exportTargets(value: unknown, member: string, found: Omit<ManifestEntry, "dir">[]): void {
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

/** What one manifest declares about where its package is entered. */
export interface Manifest {
  /**
   * Every entry the manifest names, by absolute path, in the order read: the entry points `main`,
   * `module`, `types`, `browser` and each file it maps, each `bin` command, every `exports` target
   * and per script each token, which names a file only where one is at its path; and per command
   * string {@link manifestCommands} reads one entry of its whole text, which is no entry point.
   */
  readonly entries: readonly ManifestEntry[];
  /**
   * Whether an `exports` member is written: then the published API is what `exports` reaches,
   * and otherwise whatever the members that preceded it name.
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
  const manifest = manifestAt(host, targetRoot);
  if (manifest === undefined) {
    return { entries: [], declaresExports: false };
  }

  const found: Omit<ManifestEntry, "dir">[] = [];
  for (const member of LEGACY_MEMBERS) {
    const value = manifest[member];
    if (typeof value === "string" && isTarget(value, false)) {
      found.push({ member, path: value, role: "import", published: true });
    }
  }

  // A `browser` string replaces `main` in a browser bundle, and an object replaces each
  // module it maps with the file it names: https://github.com/defunctzombie/package-browser-field-spec
  const browser = manifest["browser"];
  if (typeof browser === "string" && isTarget(browser, false)) {
    found.push({ member: "browser", path: browser, role: "import", published: true });
  } else if (isRecord(browser)) {
    for (const [replaced, value] of Object.entries(browser)) {
      if (typeof value === "string" && isTarget(value, true)) {
        found.push({
          member: below("browser", replaced),
          path: value,
          role: "import",
          published: true,
        });
      }
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
      const member = below("scripts", name);
      for (const path of new Set(scriptTokens(command))) {
        found.push({ member, path, role: "script", published: false });
      }
    }
  }
  for (const { member, command } of manifestCommands(host, targetRoot, manifest)) {
    found.push({ member, path: ".", role: "script", published: false, command });
  }

  return {
    entries: found.map((entry) => ({
      ...entry,
      path: resolvePath(targetRoot, entry.path),
      dir: targetRoot,
    })),
    declaresExports: manifest["exports"] !== undefined,
  };
}

/**
 * The entry points the manifests of the nested packages in `dirs` name. Each entry is
 * spelled under its manifest's path below the target root, and is published by its own
 * manifest's rule, as the target's own entries are.
 */
export function packageEntries(
  host: Host,
  targetRoot: string,
  dirs: readonly string[],
): readonly ManifestEntry[] {
  return dirs.flatMap((dir) => {
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
