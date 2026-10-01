// A declaration an exact configured root names, which only the first project holds.

export function one(): number {
  return 1;
}

// A class whose one member is named by a character outside the basic plane, which a
// pattern's `?` stands for exactly one of.

export class Keyed {
  "🚀"(): number {
    return 1;
  }
}
