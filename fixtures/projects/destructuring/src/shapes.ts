/** The value a nested pattern reads one member of. */
export interface Inner {
  readonly deep: string;
  readonly untouched: string;
}

/** The value of an optional member a nested assignment target reads. */
export interface Extra {
  readonly note: string;
}

/** A value every reader destructures and none reads through a property access. */
export interface Invocation {
  readonly name: string;
  readonly stores: number;
  readonly nested: Inner;
  readonly fallback?: string;
  readonly extra?: Extra;
  readonly "quoted-key": boolean;
  readonly copied: number;
  readonly typedOnly: number;
  readonly unread: number;
}

/** One side of a union every constituent of which declares the member read. */
export interface Circle {
  readonly kind: "circle";
  readonly size: number;
}

/** The other side. */
export interface Square {
  readonly kind: "square";
  readonly size: number;
}

/** A class whose instances are destructured like any other value. */
export class Holder {
  readonly slot: number = 1;
  readonly spare: number = 2;
}

/** A row an iteration and an assignment destructure. */
export interface Row {
  readonly key: string;
  readonly value: number;
  readonly pair: readonly [Inner, Inner];
}
