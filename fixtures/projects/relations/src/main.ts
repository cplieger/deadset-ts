// The entry the manifest names. It reaches one declaration through a namespace import,
// one through a chain of re-exports and one directly.

import * as barrel from "./barrel.ts";
import { relayed } from "./front.ts";
import { live } from "./chain.ts";

if (barrel.direct() + relayed() + live() === 0) {
  throw new Error("every declaration returned zero");
}

// An export of the entry nothing imports: the manifest roots it, so what it references
// is reachable, and nothing references it.
export function entryExport(): number {
  return keptByTheEntryExport();
}

function keptByTheEntryExport(): number {
  return 1;
}
