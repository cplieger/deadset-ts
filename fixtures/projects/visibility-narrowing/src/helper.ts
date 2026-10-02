// A file no manifest member names, under a manifest that declares `exports`, so code
// outside the package can import nothing here.

import { publishedShared, relayed } from "./index.ts";

// Referenced from another file of the package.
export function helperUsed(): string {
  return helperLocal() + publishedShared() + relayed() + wired() + configuredLocal() + Labels.label;
}

// Every reference to the namespace and to its member is inside this file, and the
// member's export is what the qualified name reads.
export namespace Labels {
  export const label = "label";
}

// Every reference is inside this file, and the configuration names it as a root.
export function configuredLocal(): string {
  return "configured";
}

// Every reference is inside this file.
export function helperLocal(): string {
  return "helper";
}

// Every reference is inside this file, and a declared edge names it.
export function wired(): string {
  return "wired";
}

// No reference at all.
export function forgotten(): string {
  return "forgotten";
}

// No reference at all, and a declared edge names it.
export function wiredUnused(): string {
  return "unused";
}

// Referenced only from a declaration that is itself dead.
export function behindForgotten(): string {
  return "behind";
}

export function deadCaller(): string {
  return behindForgotten();
}

// No reference at all: an interface nothing uses is reported as one.
export interface Unused {
  readonly name: string;
}

// Referenced only from a test file.
export function testedOnly(): string {
  return "tested";
}
