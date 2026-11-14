// What the barrel re-exports by a star. Nothing names starred, and the entry reads the
// barrel by member name alone, so no root reaches it or the function it calls.

export function starred(): number {
  return reachedThroughTheStar();
}

function reachedThroughTheStar(): number {
  return 5;
}
