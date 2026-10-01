// A chain whose head nothing references, so the two below it are referenced by a dead
// declaration alone, beside a chain the entry reaches.

export function chainHead(): number {
  return chainMiddle();
}

function chainMiddle(): number {
  return chainTail();
}

function chainTail(): number {
  return 2;
}

export function live(): number {
  return liveHelper();
}

function liveHelper(): number {
  return 3;
}
