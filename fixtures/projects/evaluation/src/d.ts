// The dependency of a module imported for its evaluation alone. Its top level calls
// sideEffect.

function sideEffect(): number {
  return 4;
}

sideEffect();
