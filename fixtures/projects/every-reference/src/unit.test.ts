import { Holder } from "./declarations.ts";
import { use } from "./index.ts";

/** References the default pattern classifies as made by a test file. */
export function check(): boolean {
  return use("x").label !== "" && new Holder().bump() >= 0;
}
