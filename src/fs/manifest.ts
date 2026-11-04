import type { Host } from "../host.ts";
import { isRecord } from "../json-document.ts";
import { joinPath } from "../paths.ts";
import { message } from "../product.ts";

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

/** What one JSON file reads as: its text and decoded value, text that does not parse, or a file that cannot be read, with the read's error. */
type JSONRead =
  | { readonly kind: "read"; readonly text: string; readonly value: unknown }
  | { readonly kind: "malformed" }
  | { readonly kind: "unread"; readonly reason: string };

/** One JSON file, read and parsed, as {@link JSONRead} tells its states apart. */
export function readJSONFile(host: Host, path: string): JSONRead {
  let text: string;
  try {
    text = host.readFile(path);
  } catch (error: unknown) {
    return { kind: "unread", reason: message(error) };
  }
  try {
    return { kind: "read", text, value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "malformed" };
  }
}

/** One JSON file's text and decoded value, or undefined where it cannot be read or parsed. */
export function readDocument(
  host: Host,
  path: string,
): { text: string; value: unknown } | undefined {
  const read = readJSONFile(host, path);
  return read.kind === "read" ? { text: read.text, value: read.value } : undefined;
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

/**
 * What one directory's manifest reads as: none, an object, a file that does not parse as one,
 * or a file that cannot be read, with the read's error. Either of the last two still bounds
 * the package it would declare.
 */
export type ManifestRead =
  | { readonly kind: "absent" }
  | { readonly kind: "read"; readonly manifest: Record<string, unknown> }
  | { readonly kind: "malformed" }
  | { readonly kind: "unread"; readonly reason: string };

/** The manifest in one directory, as {@link ManifestRead} tells its states apart. */
export function readManifestAt(host: Host, dir: string): ManifestRead {
  if (!holdsManifest(host, dir)) {
    return { kind: "absent" };
  }
  const read = readJSONFile(host, joinPath(dir, MANIFEST));
  if (read.kind !== "read") {
    return read;
  }
  return isRecord(read.value) ? { kind: "read", manifest: read.value } : { kind: "malformed" };
}

/** Whether one directory holds a manifest file. */
export function holdsManifest(host: Host, dir: string): boolean {
  return host.kindOf(joinPath(dir, MANIFEST)) === "file";
}
