import { ConfigError } from "./config.ts";
import type { Host } from "./host.ts";
import { dirnamePath, isAbsolutePath, joinPath, resolvePath } from "./paths.ts";
import { checkDocument, type KeyNode } from "./schema.ts";

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

const MODULE: KeyNode = {
  kind: "section",
  members: { id: { kind: "leaf" }, role: { kind: "leaf" }, path: { kind: "leaf" } },
};

/** The closed key list of the scope document, compared as bytes. */
const SCOPE_ROOT: KeyNode = {
  kind: "section",
  members: {
    target: MODULE,
    workspace: { kind: "leaf" },
    consumers: { kind: "list", members: MODULE.members ?? {} },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One string member, or undefined where the document omits it. A member the
 * document writes is a string holding at least one character, so `null` and `""`
 * are refused rather than read as absent.
 */
function stringMember(
  parent: Record<string, unknown>,
  name: string,
  at: string,
): string | undefined {
  if (!Object.hasOwn(parent, name)) {
    return undefined;
  }
  const value = parent[name];
  if (typeof value !== "string") {
    throw new ScopeError(`scope: ${at === "" ? name : `${at}.${name}`} is not a string`);
  }
  if (value === "") {
    throw new ScopeError(`scope: ${at === "" ? name : `${at}.${name}`} names nothing`);
  }
  return value;
}

function readModule(value: unknown, at: string, role: string, documentDir: string): Module {
  if (!isRecord(value)) {
    throw new ScopeError(`scope: ${at} is not an object`);
  }
  const declared = stringMember(value, "role", at);
  if (declared !== undefined && declared !== role) {
    throw new ScopeError(
      `scope: ${at}.role is ${JSON.stringify(declared)}, want ${JSON.stringify(role)}`,
    );
  }
  const path = stringMember(value, "path", at);
  if (path === undefined) {
    throw new ScopeError(`scope: ${at}.path names nothing`);
  }
  return {
    id: stringMember(value, "id", at) ?? "",
    path: isAbsolutePath(path) ? path : joinPath(documentDir, path),
  };
}

/**
 * Walks the document's text against the closed key list, refusing a key the list
 * does not declare, compared as bytes, and a key one object writes twice, which a
 * parse cannot report because it keeps the last value.
 */
function checkKeys(text: string, file: string): void {
  try {
    checkDocument(text, SCOPE_ROOT, `scope: ${file}`);
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      // The configuration's refusal names the nearest configuration key, which a
      // scope document does not have.
      throw new ScopeError(
        error.kind === "unimplemented-key"
          ? `scope: ${file}: ${error.key} is not a declared key`
          : error.message,
      );
    }
    throw error;
  }
}

/**
 * Decodes the scope document at `file`. Decoding is strict: an undeclared key, a
 * key written twice in one object, and a value of a type the document does not
 * admit, `null` included, are errors, and a relative path inside the document
 * resolves against the document's own directory.
 *
 * The `workspace` key the format declares is checked and carries nothing here: it
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
  checkKeys(text, file);
  stringMember(value, "workspace", "");
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
