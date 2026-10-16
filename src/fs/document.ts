/**
 * The one read of a document the target holds at its root, which a checkout under analysis
 * controls: the repository configuration, the ignore file, the baseline and the edges
 * document. The read stays inside the target root, takes a regular file alone, and holds no
 * more of it than the Contract's document bound.
 */

import { CONFIG_MAX_BYTES } from "../contract/config.generated.ts";
import type { Host } from "../host.ts";
import { joinPath, relativePath } from "../paths.ts";
import { message } from "../product.ts";
import { UsageError } from "../usage.ts";

/**
 * A document at the target root that is not one to read: its name resolves outside the
 * target root or to anything but a regular file, or the read fails. Nothing is read from
 * it, and the run ends with the failure code.
 */
export class TargetDocumentError extends Error {
  constructor(label: string, reason: string) {
    super(`${label}: ${reason}`);
    this.name = "TargetDocumentError";
  }
}

/** Refuses a document past the Contract's bound with the usage code, naming it `label`. */
export function refuseOverBound(label: string, text: string): void {
  if (new TextEncoder().encode(text).length > CONFIG_MAX_BYTES) {
    throw new UsageError(`${label}: holds more than ${String(CONFIG_MAX_BYTES)} bytes`);
  }
}

/** What `read` returns, or its throw as the document's {@link TargetDocumentError}. */
function attempt<T>(label: string, read: () => T): T {
  try {
    return read();
  } catch (error: unknown) {
    throw new TargetDocumentError(label, message(error));
  }
}

/**
 * The text of the document `name` at the absolute `targetRoot`, undefined where nothing is
 * there, each refusal naming it `label`. A document past the bound is read one byte past
 * it and refused as {@link refuseOverBound} refuses it.
 */
export function readTargetDocument(
  host: Host,
  targetRoot: string,
  name: string,
  label = name,
): string | undefined {
  const path = joinPath(targetRoot, name);
  const kind = attempt(label, () => host.kindOf(path));
  if (kind === "absent") {
    return undefined;
  }
  const real = attempt(label, () => host.realPath(path));
  if (
    relativePath(
      attempt(label, () => host.realPath(targetRoot)),
      real,
    ) === undefined
  ) {
    throw new TargetDocumentError(label, `resolves to ${real}, outside the target root`);
  }
  if (kind !== "file") {
    throw new TargetDocumentError(label, "is not a regular file");
  }
  const text = attempt(label, () => host.readFile(real, CONFIG_MAX_BYTES + 1));
  refuseOverBound(label, text);
  return text;
}
