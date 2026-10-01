// A module the entry imports one binding from. Its top level calls helper and writes
// registry, and the binding the entry imports references neither.

function helper(): number {
  return 1;
}

const registry: number[] = [];
registry.push(helper());

export const x = 2;

// Exported, and imported by nothing.
export function unimported(): number {
  return 3;
}
