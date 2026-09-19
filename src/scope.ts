import type { Host } from "./host.ts";
import { dirnamePath, isAbsolutePath, joinPath, resolvePath } from "./paths.ts";

/** The roles a scope document declares for a module. */
export const ROLE_TARGET = "target";
export const ROLE_CONSUMER = "consumer";

/**
 * A scope document above this length is refused rather than decoded. It names one
 * target and its consumers, so a larger file is not one.
 */
const MAX_DOCUMENT_LENGTH = 1 << 20;

/**
 * A scope document that cannot be read as one. It ends the run with the failure
 * code: the run could not learn what to analyze, so it produced no answer.
 */
export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

/**
 * One module the run reads: the target or a declared consumer.
 *
 * The role a document declares is not carried here, because the resolved scope
 * holds exactly one target and a list of consumers, so a module's role is where it
 * sits. What a document declares is read and refused where it contradicts that
 * position, which is the only place the declaration can be wrong.
 */
export interface Module {
  /** The package name. A document may state it; otherwise it is empty. */
  readonly id: string;
  /** An absolute filesystem path. */
  readonly path: string;
}

/** The resolved scope: exactly one target and zero or more consumers. */
export interface Scope {
  readonly target: Module;
  readonly consumers: readonly Module[];
}

const DECLARED_KEYS = new Set(["target", "workspace", "consumers"]);
const MODULE_KEYS = new Set(["id", "role", "path"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringMember(parent: Record<string, unknown>, name: string, at: string): string {
  if (!Object.hasOwn(parent, name)) {
    return "";
  }
  const value = parent[name];
  if (typeof value !== "string") {
    throw new ScopeError(`scope: ${at}.${name} is not a string`);
  }
  return value;
}

function readModule(value: unknown, at: string, role: string, documentDir: string): Module {
  if (!isRecord(value)) {
    throw new ScopeError(`scope: ${at} is not an object`);
  }
  for (const name of Object.keys(value)) {
    if (!MODULE_KEYS.has(name)) {
      throw new ScopeError(`scope: ${at}.${name} is not a declared key`);
    }
  }
  const declared = stringMember(value, "role", at);
  if (declared !== "" && declared !== role) {
    throw new ScopeError(
      `scope: ${at}.role is ${JSON.stringify(declared)}, want ${JSON.stringify(role)}`,
    );
  }
  const path = stringMember(value, "path", at);
  if (path === "") {
    throw new ScopeError(`scope: ${at}.path names nothing`);
  }
  return {
    id: stringMember(value, "id", at),
    path: isAbsolutePath(path) ? path : joinPath(documentDir, path),
  };
}

/**
 * Decodes the scope document at `file`. Decoding is strict: an undeclared key is an
 * error, and a relative path inside the document resolves against the document's
 * own directory.
 *
 * The `workspace` key the format declares is read and carries nothing here: it
 * names the file a Go consumer resolves the target through, and a TypeScript
 * project resolves one through its own compiler configuration.
 */
export function readScope(host: Host, file: string): Scope {
  const absolute = resolvePath(host.workingDirectory(), file);
  let text: string;
  try {
    text = host.readFile(absolute);
  } catch (error: unknown) {
    throw new ScopeError(
      `scope: ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (text.length > MAX_DOCUMENT_LENGTH) {
    throw new ScopeError(`scope: ${file} is longer than ${String(MAX_DOCUMENT_LENGTH)} characters`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error: unknown) {
    throw new ScopeError(
      `scope: ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(value)) {
    throw new ScopeError(`scope: ${file} is not one JSON object`);
  }
  for (const name of Object.keys(value)) {
    if (!DECLARED_KEYS.has(name)) {
      throw new ScopeError(`scope: ${file}: ${name} is not a declared key`);
    }
  }
  const documentDir = dirnamePath(absolute);
  if (!Object.hasOwn(value, "target")) {
    throw new ScopeError(`scope: ${file} names no target`);
  }
  const target = readModule(value["target"], "target", ROLE_TARGET, documentDir);
  const listed = Object.hasOwn(value, "consumers") ? value["consumers"] : [];
  if (!Array.isArray(listed)) {
    throw new ScopeError(`scope: ${file}: consumers is not an array`);
  }
  const consumers = (listed as unknown[]).map((entry, index) =>
    readModule(entry, `consumers[${String(index)}]`, ROLE_CONSUMER, documentDir),
  );
  return { target, consumers };
}

/** The single-package scope one directory is, when no scope document is given. */
export function scopeForDir(host: Host, dir: string): Scope {
  const path = resolvePath(host.workingDirectory(), dir);
  const kind = host.kindOf(path);
  if (kind === "absent") {
    throw new ScopeError(`scope: ${path} does not exist`);
  }
  if (kind !== "directory") {
    throw new ScopeError(`scope: ${path} is not a directory`);
  }
  return { target: { id: "", path }, consumers: [] };
}
