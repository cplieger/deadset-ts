import held from "./held.ts";
import made from "./made.ts";
import named from "./named.ts";

/** One import of each default-export form, read once each. */
export function read(): number {
  return held.a + made + named();
}
