// A module no manifest export reaches, so nothing outside the target can name it.

export function internalUnused(): number {
  return 1;
}

/** @deprecated Use internalUnused. */
export function internalRetired(): number {
  return 2;
}
