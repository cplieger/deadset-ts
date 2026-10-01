// The declarations exemptions name. Nothing in the program references any of them but
// liveAnyway, which the entry calls, and keptByHeld, which only heldTwice calls.

export function heldTwice(): number {
  return keptByHeld();
}

function keptByHeld(): number {
  return 1;
}

export function liveAnyway(): number {
  return 2;
}

export function heldByDisabled(): number {
  return 3;
}
