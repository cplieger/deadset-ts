// The entry the manifest names. It imports one binding from a module whose top level
// registers a value, imports a second module for its evaluation alone, reads a third
// through its namespace, and loads a fourth and a fifth from inside a function.

import { x } from "./b.ts";
import "./c.ts";
import * as spaced from "./spaced.ts";
import { legacy } from "./legacy.cts";

if (x + spaced.read() + legacy() === 0) {
  throw new Error("every value was zero");
}

export async function later(): Promise<number> {
  const loaded = await import("./lazy.ts");
  return loaded.value;
}
