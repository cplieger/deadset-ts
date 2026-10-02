import type { Circle, Holder, Invocation, Row, Square } from "./shapes.ts";

/** Shorthand, renamed, nested, defaulted, quoted and rest elements of one parameter. */
export function invoke({
  name,
  stores: count,
  nested: { deep },
  fallback = "none",
  "quoted-key": quoted,
  ...rest
}: Invocation): string {
  return `${name} ${String(count)} ${deep} ${fallback} ${String(quoted)} ${String(rest.copied)}`;
}

/** A pattern in a function type's parameter list binds nothing when the program runs. */
export type Reader = ({ typedOnly }: Invocation) => number;

/** A member every constituent of a union declares. */
export function sizeOf(shape: Circle | Square): number {
  const { size } = shape;
  return size;
}

/** A value whose type is a parameter the interface constrains. */
export function storesOf<T extends Invocation>(value: T): number {
  const { stores } = value;
  return stores;
}

/** An instance of a class. */
export function slotOf(holder: Holder): number {
  const { slot } = holder;
  return slot;
}

/** A callback's parameter, typed by the call it is passed to. */
export function keysOf(rows: readonly Row[]): string[] {
  return rows.map(({ key }) => key);
}

/** An iteration's binding, holding a pattern nested in an array pattern. */
export function total(rows: readonly Row[]): number {
  let sum = 0;
  for (const {
    value,
    pair: [{ deep }],
  } of rows) {
    sum += value + deep.length;
  }
  return sum;
}

/** A catch clause's binding, of a type that declares no member. */
export function failure(run: () => void): string {
  try {
    run();
    return "";
  } catch ({ message }: any) {
    return String(message);
  }
}

/** Assignment targets: plain, nested through a tuple, defaulted, from an array, and iterated. */
export function assign(row: Row, rows: readonly Row[], invocation: Invocation): string {
  let key = "";
  let deep = "";
  let first = "";
  let note = "";
  let value = 0;
  ({ key } = row);
  ({
    pair: [{ deep }],
  } = row);
  ({ nested: { deep: first } = { deep: "" } } = invocation);
  ({ extra: { note } = { note: "" } } = invocation);
  [{ value }] = [row];
  for ({ key } of rows) {
    value += key.length;
  }
  return `${key} ${deep} ${first} ${note} ${String(value)}`;
}
