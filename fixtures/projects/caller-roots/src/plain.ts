// A module no root names, imported by the entry for one of its two exports.

export function used(): number {
  return 1;
}

export function unused(): number {
  return 2;
}
