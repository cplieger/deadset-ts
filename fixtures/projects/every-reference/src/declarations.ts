/** A function that names itself, so its own body references it. */
export function recursive(depth: number): number {
  return depth <= 0 ? 0 : recursive(depth - 1);
}

/** A class whose members are referenced through a receiver and through the class. */
export class Holder {
  static total = 0;

  #hidden = 0;

  slot = 0;

  get value(): number {
    return this.#hidden;
  }

  set value(next: number) {
    this.#hidden = next;
  }

  bump(): number {
    this.slot += 1;
    Holder.total += 1;
    return this.value;
  }
}

/** A type whose member is referenced through a value of the type. */
export interface Named {
  readonly label: string;
}

/** A collection referenced through an element access. */
export const table: Record<string, number> = {};

/** A value referenced through a property access. */
export const pair = { first: 0, second: 0 };

/** A binding a compound assignment and an increment write and nothing reads. */
export let counter = 0;

/** A binding a shorthand destructuring target writes. */
export let loose = 0;

/** The writes the bindings above take, which no module but this one may make. */
export function reset(): void {
  counter += 1;
  counter++;
  ({ loose } = { loose: 0 });
}
