// Produced by an angle-bracket assertion from a number.
export enum Angle {
  A,
  B,
}

// Produced by an assertion from a string.
export enum Named {
  X = "x",
  Y = "y",
}

// Produced by returning a number from a function the enum annotates.
export enum Returned {
  P,
  Q,
}

// Looked up by literal keys only, which name the members they spell.
export enum Keyed {
  K1,
  K2,
}

// Asserted from its own member, which converts nothing.
export enum Self {
  S1,
  S2,
}

// Looked up through a namespace import by a computed key.
export enum Spaced {
  N1,
  N2,
}

export function angleOf(n: number): Angle {
  return <Angle>n;
}

export function namedOf(s: string): Named {
  return s as Named;
}

export function returnedOf(n: number): Returned {
  return n;
}

export function keyed(): number {
  return Keyed["K1"];
}

export function self(): Self {
  return Self.S1 as Self;
}
