// Three functions that call each other in a ring, and nothing else calls.

function first(depth: number): number {
  return depth <= 0 ? 0 : second(depth - 1);
}

function second(depth: number): number {
  return third(depth);
}

function third(depth: number): number {
  return first(depth);
}
