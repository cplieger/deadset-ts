// What the barrel re-exports by a star. Nothing names starred, and the star is the one
// path from a root to it and to the function it calls.

export function starred(): number {
  return reachedThroughTheStar();
}

function reachedThroughTheStar(): number {
  return 5;
}
