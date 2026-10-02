// What the manifest's `exports` names, so a manifest export reaches every export here.

import { helperUsed } from "./helper.ts";

// No reference in the target: a consumer is what would use it.
export function published(): string {
  return helperUsed() + publishedLocal();
}

// Every reference is inside this file.
export function publishedLocal(): string {
  return "local";
}

// The only reference is from another file of the package.
export function publishedShared(): string {
  return "shared";
}

export { surfaced, surfacedTwice, surfacedUnused } from "./surfaced.ts";

// A re-export another file of the package imports, and nothing outside it.
export { relayedSource as relayed } from "./surfaced.ts";
