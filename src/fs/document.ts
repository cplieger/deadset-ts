/**
 * The one read of a document the target holds at its root, which a checkout under analysis
 * controls: the repository configuration, the ignore file, the baseline and the edges
 * document. The read stays inside the target root, takes a regular file alone, and holds no
 * more of it than the Contract's document bound.
 */

import { CONFIG_MAX_BYTES } from "../contract/config.generated.ts";
import type { Host } from "../host.ts";
import { failureExit } from "../failure.ts";
import { joinPath, relativePath } from "../paths.ts";
import { message } from "../product.ts";
import { utf8Bytes } from "../reporters/sha256.ts";
import { UsageError } from "../usage.ts";

function unreadable(label: string, reason: string): Error {
  return failureExit(
    "unreadable-document",
    `${label}: ${reason}: make it a regular file inside the target root that the run can read, or remove it`,
  );
}

/** Refuses a document past the Contract's bound with the usage code, naming it `label`. */
export function refuseOverBound(label: string, text: string): void {
  if (utf8Bytes(text).length > CONFIG_MAX_BYTES) {
    throw new UsageError(`${label}: holds more than ${String(CONFIG_MAX_BYTES)} bytes`);
  }
}

/**
 * The text of the document `name` at the absolute `targetRoot`, undefined where nothing is
 * there. One whose name resolves outside the target root or to anything but a regular file,
 * or whose read fails, is refused by `refuse` naming it `label`, nothing read from it. A
 * document past the bound is read one byte past it and refused as {@link refuseOverBound} does.
 */
export function readTargetDocument(
  host: Host,
  targetRoot: string,
  name: string,
  label = name,
  refuse: (label: string, reason: string) => Error = unreadable,
): string | undefined {
  const attempt = <T>(read: () => T): T => {
    try {
      return read();
    } catch (error: unknown) {
      throw refuse(label, message(error));
    }
  };
  const path = joinPath(targetRoot, name);
  const kind = attempt(() => host.kindOf(path));
  if (kind === "absent") {
    return undefined;
  }
  const real = attempt(() => host.realPath(path));
  if (
    relativePath(
      attempt(() => host.realPath(targetRoot)),
      real,
    ) === undefined
  ) {
    throw refuse(label, `resolves to ${real}, outside the target root`);
  }
  if (kind !== "file") {
    throw refuse(label, "is not a regular file");
  }
  const text = attempt(() => host.readFile(real, CONFIG_MAX_BYTES + 1));
  refuseOverBound(label, text);
  return text;
}
