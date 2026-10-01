// The declarations behind the two chains: the entry imports the first, and nothing
// imports the second.

export function relayed(): number {
  return 6;
}

export function unrelayed(): number {
  return 7;
}

// A local declaration exported by a specifier nothing imports.
const listed = 8;

export { listed };
