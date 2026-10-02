// Named by value through a type assertion from a number.
export enum Tier {
  Low,
  Mid,
  High,
}

// Named by value through the reverse mapping.
export enum Flag {
  On,
  Off,
}

// Named by value through a decoded value typed as the enum.
export enum Wire {
  Text,
  Binary,
}

// Produced by no conversion: the member nothing names is reported.
export enum Mode {
  Read,
  Write,
}

// Nothing names this enum, so its members fall with it.
enum Unused {
  First,
  Second,
}

export function tierOf(n: number): Tier {
  return n as Tier;
}

export function flagName(n: number): string {
  return Flag[n] ?? "";
}

export function wireOf(text: string): Wire {
  const decoded: Wire = JSON.parse(text);
  return decoded;
}

export function describe(m: Mode): string {
  return m === Mode.Read ? "read" : "other";
}
