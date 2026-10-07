// The entry calls onlyTested here, and only the test file references it in a.
export function onlyTested(): number {
  return 1;
}

export function production(): number {
  return 2;
}
