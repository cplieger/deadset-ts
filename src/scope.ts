import { SCOPE_SCHEMA } from "./contract/config.generated.ts";
import type { Host } from "./host.ts";
import { dotted, locatedFault, placeIn, readStrict, StrictJSONError } from "./json-document.ts";
import { dirnamePath, isAbsolutePath, joinPath, resolvePath } from "./paths.ts";
import { MARKERS } from "./load/discover.ts";
import { failureExit } from "./failure.ts";
import { message } from "./product.ts";
import { firstRefusal } from "./schema.ts";
import { UsageError } from "./usage.ts";

/**
 * A scope document above this length is refused rather than decoded. It names one
 * target and its consumers, so a larger file is not one.
 */
const MAX_DOCUMENT_LENGTH = 1 << 20;

/**
 * The bytes read of a scope document. A UTF-16 unit decodes from at most three bytes,
 * so a document past the bound is past it within these.
 */
const MAX_DOCUMENT_BYTES = 3 * (MAX_DOCUMENT_LENGTH + 1);

/**
 * One module the run reads: the target or a declared consumer. The role a document
 * declares is not carried, because a module's role is where the scope holds it.
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

interface DeclaredModule {
  readonly id?: string;
  readonly path: string;
}

function refusal(file: string, place: string, reason: string): UsageError {
  return new UsageError(`scope: ${file}: ${place === "" ? "" : `${place}: `}${reason}`);
}

/**
 * Decodes the scope document at `file`, held to the Contract's scope schema, a relative
 * path resolved against the document's own directory. A document that cannot be read or is
 * refused is a usage error, as any document the invocation names. `workspace` is read by Go consumers
 * alone: a TypeScript project resolves the target through its own compiler configuration.
 */
export function readScope(host: Host, file: string): Scope {
  const absolute = resolvePath(host.workingDirectory(), file);
  let text: string;
  try {
    text = host.readFile(absolute, MAX_DOCUMENT_BYTES);
  } catch (error: unknown) {
    throw new UsageError(`scope: ${file}: ${message(error)}`);
  }
  if (text.length > MAX_DOCUMENT_LENGTH) {
    throw new UsageError(`scope: ${file} is longer than ${String(MAX_DOCUMENT_LENGTH)} characters`);
  }
  let value: unknown;
  try {
    value = readStrict(text).value;
  } catch (error: unknown) {
    if (!(error instanceof StrictJSONError)) {
      throw error;
    }
    throw refusal(file, dotted(error.place), locatedFault(text, error));
  }
  const refused = firstRefusal(SCOPE_SCHEMA, value);
  if (refused !== undefined) {
    throw refusal(file, dotted(placeIn(value, refused.pointer, refused.member)), refused.reason);
  }
  const declared = value as { target: DeclaredModule; consumers?: readonly DeclaredModule[] };
  const documentDir = dirnamePath(absolute);
  const moduleOf = (module: DeclaredModule): Module => ({
    id: module.id ?? "",
    path: isAbsolutePath(module.path) ? module.path : joinPath(documentDir, module.path),
  });
  return { target: moduleOf(declared.target), consumers: (declared.consumers ?? []).map(moduleOf) };
}

/**
 * The single-package scope one directory is, when no scope document is given. A target that is
 * no directory holds no program.
 */
export function scopeForDir(host: Host, dir: string): Scope {
  const path = resolvePath(host.workingDirectory(), dir);
  const kind = host.kindOf(path);
  if (kind !== "directory") {
    throw failureExit(
      "no-program",
      `the target ${path} ${kind === "absent" ? "does not exist" : "is not a directory"}, so it holds no compiler configuration, no file named ${MARKERS.join(", ")}: name the directory that holds one`,
    );
  }
  return { target: { id: "", path }, consumers: [] };
}
