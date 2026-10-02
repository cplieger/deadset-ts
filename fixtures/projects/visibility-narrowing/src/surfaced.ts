// Declarations the package publishes by re-exporting them from the file the manifest
// names, so the re-export stands for a consumer importing each.

export function surfaced(): number {
  return 1;
}

export const surfacedTwice = surfaced() + 1;

// Published by the re-export alone, and referenced by nothing.
export function surfacedUnused(): number {
  return 3;
}

// Published under another name by a re-export another file of the package imports.
export function relayedSource(): string {
  return "relayed";
}
