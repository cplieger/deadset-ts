// A module a dynamic import with a literal specifier loads. Its top level calls
// lazyEffect.

function lazyEffect(): number {
  return 7;
}

lazyEffect();

export const value = 8;
