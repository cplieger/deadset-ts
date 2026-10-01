// The declarations the tests reference: two that only a test references, and one the
// entry references as well.

export function deadOne(): number {
  return 1;
}

export function deadTwo(): number {
  return 2;
}

export function live(): number {
  return 3;
}
