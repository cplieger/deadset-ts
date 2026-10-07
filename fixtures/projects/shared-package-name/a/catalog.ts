// Only the test file references onlyTested here, and the entry calls it in b.
export function onlyTested(): number {
  return 1;
}

export function production(): number {
  return 2;
}
