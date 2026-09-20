import { Holder, recursive } from "./middle.ts";
import type { Named } from "./middle.ts";
import { pair, reset, table } from "./declarations.ts";

const held = new Holder();
held.slot = 1;

/** Every reference form the analyzer resolves, made once each. */
export function use(label: string): Named {
  held.value += 1;
  table["key"] = held.bump();
  delete table["key"];
  pair.first = recursive(2);
  const { first } = pair;
  [pair.second] = [first];
  reset();
  return { label };
}

/** A shorthand property assignment naming two declarations of this module. */
export const bundle = { held, use };
