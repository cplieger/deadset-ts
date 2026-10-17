import type { Host } from "../host.ts";
import { isRecord } from "../json-document.ts";
import { joinPath } from "../paths.ts";

/** The file a package's manifest is read from. */
export const MANIFEST = "package.json";

/** The directory a package manager installs packages into, whose files are no project's own. */
export const INSTALLED_PACKAGES = "node_modules";

/** The manifest members a package declares the packages it depends on under. */
export const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/** Whether one path passes through an installed-packages directory. */
export function inInstalledPackages(path: string): boolean {
  return path.split("/").includes(INSTALLED_PACKAGES);
}

/** One JSON file's text and decoded value, or undefined where it cannot be read or parsed. */
export function readDocument(
  host: Host,
  path: string,
): { text: string; value: unknown } | undefined {
  let text: string;
  try {
    text = host.readFile(path);
  } catch {
    return undefined;
  }
  try {
    return { text, value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

/** One JSON file's decoded value, or undefined where it cannot be read or parsed. */
export function readJSON(host: Host, path: string): unknown {
  return readDocument(host, path)?.value;
}

/**
 * The manifest in one directory, decoded, or undefined where none reads as an object. A
 * manifest this program cannot read declares nothing, the same answer as an absent one:
 * the package manager owns the refusal of a manifest it rejects.
 */
export function manifestAt(host: Host, dir: string): Record<string, unknown> | undefined {
  const value = readJSON(host, joinPath(dir, MANIFEST));
  return isRecord(value) ? value : undefined;
}

/** Whether one directory holds a manifest file. */
export function holdsManifest(host: Host, dir: string): boolean {
  return host.kindOf(joinPath(dir, MANIFEST)) === "file";
}
