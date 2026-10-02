// T is named by neither the signature nor the body.
export function first<T>(values: readonly number[]): number {
  return values[0] ?? 0;
}

// T is named by the signature.
export function same<T>(value: T): T {
  return value;
}

// U is named by the body alone.
export function cast<U>(value: unknown): boolean {
  const held = value as U;
  return held !== undefined;
}

export class Box<Phantom> {
  // V is named nowhere.
  open<V>(): number {
    return 1;
  }
}

// A phantom parameter of a type declaration is never reported.
export type ID<Phantom> = string;

export interface Reader {
  // A parameter of a method signature belongs to a type declaration.
  read<W>(): number;
}
